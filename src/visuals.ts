import type { Pt } from './hands';

/**
 * Laser string rendering.
 *
 * Canvas stack (index.html):
 *   #view  — camera + hands
 *   #fx    — lasers, sharp (transparent background, CSS mix-blend-mode: screen)
 *   #bloom — a half-res copy of #fx, CSS blur + screen → GPU bloom, nearly free
 *
 * Everything glowing is drawn with 'lighter' (additive): overlapping light adds
 * up toward white, like real light.
 *
 * Every effect has a flag (FLAGS) so each can be switched off for performance
 * testing: URL ?off=bloom,frets  or the checkbox panel shown with ?debug.
 */

export interface View { W: number; H: number; s: number } // s = pixel scale (H / 720)

export const FLAGS = {
  bloom: true,     // CSS blur copy on top
  glow: true,      // outer + inner glow strokes
  texture: true,   // wound/ribbed marks on low strings
  flow: true,      // light dashes travelling along strings
  frets: true,     // semitone ticks
  pulses: true,    // travelling light pulses after a pluck
  vibration: true, // standing-wave bow after a pluck
  lens: true,      // faint offset copies (blur of a vibrating string)
  shock: true,     // expanding ring at the pluck point
  sparks: true,
  breathe: true,   // idle glow breathing
  hum: true,       // tiny idle wobble
  labels: true,    // note name by the emitter
};
export type Flag = keyof typeof FLAGS;
for (const k of (new URLSearchParams(location.search).get('off') ?? '').split(',')) {
  if (k in FLAGS) FLAGS[k as Flag] = false;
}

// ---------------------------------------------------------------------------
// Per-note identity
// ---------------------------------------------------------------------------

const LOW = 36, HIGH = 72; // C2 … C5
const pitch01 = (m: number) => Math.min(1, Math.max(0, (m - LOW) / (HIGH - LOW)));

/**
 * Hue sweeps a big arc of the colour wheel so neighbouring notes look clearly
 * different: magenta (320°) → violet → blue → cyan → teal (165°), and gets
 * lighter (toward white) as pitch rises.
 */
export function pitchColor(m: number): string {
  const t = pitch01(m);
  const hue = 320 - 155 * t;
  const light = 0.55 + 0.25 * t * t;
  return hsl(hue, 0.95, light);
}

export interface StringStyle {
  rgb: string;      // main colour
  hot: string;      // colour pushed toward white (core)
  w: number;        // core width in px (thick low → thin high)
  wound: number;    // 0..1 how "wound" (ribbed) the string looks
  flowSpeed: number;// px/s of the travelling dashes
}

export function styleFor(m: number, s: number): StringStyle {
  const t = pitch01(m);
  const rgb = pitchColor(m);
  return {
    rgb,
    hot: mixWhite(rgb, 0.7),
    w: (3.6 - 2.6 * t) * s,
    wound: Math.min(1, Math.max(0, (57 - m) / 15)), // C2–A3 wound, fading out by A3
    flowSpeed: (35 + 220 * t) * s,
  };
}

// ---------------------------------------------------------------------------

interface Pluck { t0: number; u0: number; amp: number; tau: number; fv: number; vel: number }
interface Spark { x: number; y: number; vx: number; vy: number; life: number; max: number; rgb: string }
interface Shock { x: number; y: number; t0: number; rgb: string; vel: number }

export interface StringDraw {
  id: number;
  a: Pt; b: Pt;
  midi: number;
  len: number;                 // stage heights (for fret ticks)
  anchor: 'a' | 'b';           // fret ticks are measured from this end
  frets: number[];             // lengths (stage heights) where each semitone falls
  scaleFret: boolean[];        // which of those are scale notes (longer ticks)
  doomed: boolean;             // release now = delete → red
}

const N = 40;          // polyline segments per string
const PULSE_LIFE = 0.55;
const SHOCK_LIFE = 0.45;
const MAX_SPARKS = 260;

export class LaserFX {
  private plucks = new Map<number, Pluck>();
  private flash = new Map<number, number>(); // id → 0..1
  private sparks: Spark[] = [];
  private shocks: Shock[] = [];

  pluck(id: number, u0: number, at: Pt, dir: Pt, velocity: number, bass: number, rgb: string, now: number) {
    this.plucks.set(id, {
      t0: now, u0, vel: velocity,
      amp: 0.006 + 0.022 * velocity,   // stage heights
      tau: 0.22 + 0.22 * bass,         // matches the audio decay
      fv: 4 + 7 * (1 - bass),          // visible wobble Hz (slowed way down)
    });
    this.flash.set(id, 0.5 + 0.5 * velocity);
    if (FLAGS.shock) this.shocks.push({ x: at.x, y: at.y, t0: now, rgb, vel: velocity });
    if (!FLAGS.sparks) return;
    const n = Math.round(8 + 14 * velocity);
    const nx = -dir.y, ny = dir.x;
    for (let i = 0; i < n && this.sparks.length < MAX_SPARKS; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const sp = (0.25 + Math.random() * 0.9) * (0.5 + velocity);
      const along = (Math.random() - 0.5) * 0.8;
      const life = 0.25 + Math.random() * 0.45;
      this.sparks.push({
        x: at.x, y: at.y,
        vx: (nx * side + dir.x * along) * sp, vy: (ny * side + dir.y * along) * sp,
        life, max: life, rgb,
      });
    }
  }

  forget(alive: Set<number>) {
    for (const id of this.plucks.keys()) if (!alive.has(id)) this.plucks.delete(id);
    for (const id of this.flash.keys()) if (!alive.has(id)) this.flash.delete(id);
  }

  /** Brightness of the label/emitter after a pluck (0..1) */
  flashOf(id: number) { return this.flash.get(id) ?? 0; }

  drawString(ctx: CanvasRenderingContext2D, v: View, d: StringDraw, now: number, dt: number) {
    const st = styleFor(d.midi, v.s);
    const rgb = d.doomed ? '255, 60, 70' : st.rgb;
    const hot = d.doomed ? '255, 170, 170' : st.hot;
    const w = st.w;
    const sec = now / 1000;

    const ax = d.a.x * v.W, ay = d.a.y * v.H, bx = d.b.x * v.W, by = d.b.y * v.H;
    const dx = bx - ax, dy = by - ay;
    const L = Math.hypot(dx, dy) || 1;
    const tx = dx / L, ty = dy / L;   // along
    const nx = -ty, ny = tx;          // across

    // ---- displacement along the string: pluck vibration + idle hum ----
    const pk = this.plucks.get(d.id);
    let vibAmp = 0, vibPhase = 0, age = 1e9;
    if (pk) {
      age = sec - pk.t0 / 1000;
      const lenK = Math.min(1.8, Math.max(0.5, L / (0.45 * v.H))); // long strings swing wider
      vibAmp = FLAGS.vibration ? pk.amp * v.H * lenK * Math.exp(-age / pk.tau) : 0;
      vibPhase = Math.sin(2 * Math.PI * pk.fv * age);
      if (vibAmp < 0.3 && age > PULSE_LIFE) { this.plucks.delete(d.id); vibAmp = 0; }
    }
    const humAmp = FLAGS.hum ? 0.7 * v.s : 0;
    const humPhase = Math.sin(2 * Math.PI * 2.2 * sec + d.id * 1.9);
    const disp = (u: number) => Math.sin(Math.PI * u) * (vibAmp * vibPhase + humAmp * humPhase);
    const at = (u: number): [number, number] => {
      const o = disp(u);
      return [ax + dx * u + nx * o, ay + dy * u + ny * o];
    };
    const beam = new Path2D();
    for (let i = 0; i <= N; i++) {
      const [x, y] = at(i / N);
      i ? beam.lineTo(x, y) : beam.moveTo(x, y);
    }

    // ---- brightness: breathing + pluck flash ----
    let fl = this.flash.get(d.id) ?? 0;
    const breathe = FLAGS.breathe ? 0.88 + 0.12 * Math.sin(2 * Math.PI * 0.3 * sec + d.id * 1.7) : 1;
    const k = (d.doomed ? 0.6 : 1) * breathe * (1 + 1.6 * fl);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // blur-lens: faint copies across the vibration envelope
    if (FLAGS.lens && vibAmp > 1) {
      ctx.strokeStyle = `rgba(${rgb}, 0.1)`;
      ctx.lineWidth = w * 1.4;
      for (const c of [-1, -0.55, 0.55, 1]) {
        const p = new Path2D();
        for (let i = 0; i <= N; i++) {
          const u = i / N, e = vibAmp * c * Math.sin(Math.PI * u);
          const x = ax + dx * u + nx * e, y = ay + dy * u + ny * e;
          i ? p.lineTo(x, y) : p.moveTo(x, y);
        }
        ctx.stroke(p);
      }
    }

    // glow layers: wide soft outer → coloured inner
    if (FLAGS.glow) {
      ctx.strokeStyle = `rgba(${rgb}, ${Math.min(1, 0.07 * k)})`;
      ctx.lineWidth = w * 7;
      ctx.stroke(beam);
      ctx.strokeStyle = `rgba(${rgb}, ${Math.min(1, 0.3 * k)})`;
      ctx.lineWidth = w * 2.6;
      ctx.stroke(beam);
    }
    // core: coloured-hot body + white-hot centre
    ctx.strokeStyle = `rgba(${hot}, ${Math.min(1, 0.9 * k)})`;
    ctx.lineWidth = w;
    ctx.stroke(beam);
    ctx.strokeStyle = `rgba(255, 255, 255, ${Math.min(1, 0.85 * k)})`;
    ctx.lineWidth = Math.max(0.6, w * 0.4);
    ctx.stroke(beam);

    // wound texture: diagonal marks carved out of the beam (low strings only)
    if (FLAGS.texture && st.wound > 0.02) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = `rgba(0, 0, 0, ${0.55 * st.wound})`;
      ctx.lineWidth = Math.max(0.8, w * 0.35);
      const step = Math.max(4, w * 1.8);
      const marks = new Path2D();
      for (let s = step / 2; s < L; s += step) {
        const [x, y] = at(s / L);
        const hx = (nx * 1.2 + tx * 0.9) * w, hy = (ny * 1.2 + ty * 0.9) * w; // diagonal
        marks.moveTo(x - hx, y - hy);
        marks.lineTo(x + hx, y + hy);
      }
      ctx.stroke(marks);
      ctx.globalCompositeOperation = 'lighter';
    }

    // energy flow: dashes travelling a → b, faster on high notes
    if (FLAGS.flow) {
      ctx.setLineDash([3 * v.s + w, 26 * v.s]);
      ctx.lineDashOffset = -sec * st.flowSpeed;
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.5 * breathe})`;
      ctx.lineWidth = Math.max(0.8, w * 0.7);
      ctx.stroke(beam);
      ctx.setLineDash([]);
    }

    // fret ticks: where each semitone would fall, measured from the anchor end
    if (FLAGS.frets && d.frets.length) {
      const ticks = new Path2D(), major = new Path2D();
      d.frets.forEach((fLen, i) => {
        if (fLen >= d.len * 0.995) return;
        let u = fLen / d.len;
        if (d.anchor === 'b') u = 1 - u;
        const [x, y] = at(u);
        const h = (d.scaleFret[i] ? 7 : 3.5) * v.s + w * 0.5;
        const p = d.scaleFret[i] ? major : ticks;
        p.moveTo(x - nx * h, y - ny * h);
        p.lineTo(x + nx * h, y + ny * h);
      });
      ctx.lineWidth = 1 * v.s;
      ctx.strokeStyle = `rgba(${hot}, 0.13)`;
      ctx.stroke(ticks);
      ctx.strokeStyle = `rgba(${hot}, 0.5)`;
      ctx.stroke(major);
    }

    // travelling pulses: from the pluck point toward both ends, reflecting back
    if (FLAGS.pulses && pk && age < PULSE_LIFE) {
      const life = 1 - age / PULSE_LIFE;
      for (const sgn of [-1, 1]) {
        const u = reflect01(pk.u0 + sgn * 2.2 * age); // 2.2 string-lengths / s
        const [x, y] = at(u);
        const r = w * (4 + 3 * pk.vel);
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(255, 255, 255, ${0.95 * life})`);
        g.addColorStop(0.4, `rgba(${hot}, ${0.5 * life})`);
        g.addColorStop(1, `rgba(${rgb}, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    // flash fades (frame-rate independent)
    if (fl > 0) {
      fl *= Math.exp(-dt / 0.12);
      if (fl < 0.02) this.flash.delete(d.id); else this.flash.set(d.id, fl);
    }
  }

  /** Emitter: glowing ring with a gentle pulse; bigger/brighter when grabbable/grabbed */
  drawEmitter(
    ctx: CanvasRenderingContext2D, v: View, p: Pt, midi: number,
    state: 'idle' | 'hover' | 'grabbed', now: number, id: number, doomed: boolean,
  ) {
    const st = styleFor(midi, v.s);
    const rgb = doomed ? '255, 60, 70' : st.rgb;
    const x = p.x * v.W, y = p.y * v.H;
    const pulse = 1 + 0.12 * Math.sin((2 * Math.PI * 1.2 * now) / 1000 + id);
    const grow = state === 'grabbed' ? 1.8 : state === 'hover' ? 1.45 : 1;
    const bright = (state === 'idle' ? 0.6 : 1) + 0.6 * this.flashOf(id);
    const r = (5 + st.w) * pulse * grow;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2.4);
    g.addColorStop(0, `rgba(${st.hot}, ${Math.min(1, 0.7 * bright)})`);
    g.addColorStop(0.45, `rgba(${rgb}, ${0.25 * bright})`);
    g.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r * 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(${st.hot}, ${Math.min(1, 0.8 * bright)})`;
    ctx.lineWidth = 1.5 * v.s;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(1, 0.9 * bright)})`;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1.2, st.w * 0.5), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Small note name beside an emitter, pushed away from the string */
  drawLabel(ctx: CanvasRenderingContext2D, v: View, p: Pt, away: Pt, text: string, id: number) {
    if (!FLAGS.labels) return;
    const x = p.x * v.W + away.x * 20 * v.s, y = p.y * v.H + away.y * 20 * v.s;
    ctx.save();
    ctx.font = `400 ${Math.round(12 * v.s)}px ui-monospace, "SF Mono", Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = `rgba(230, 245, 255, ${Math.min(1, 0.55 + 0.45 * this.flashOf(id))})`;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  /** Sparks + shockwaves. dt in seconds. */
  drawParticles(ctx: CanvasRenderingContext2D, v: View, now: number, dt: number) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';

    // shockwaves: expanding, thinning ring
    let j = 0;
    for (const sh of this.shocks) {
      const p = (now - sh.t0) / 1000 / SHOCK_LIFE;
      if (p >= 1) continue;
      const e = 1 - (1 - p) * (1 - p); // ease out
      ctx.strokeStyle = `rgba(${mixWhite(sh.rgb, 0.5)}, ${0.8 * (1 - p)})`;
      ctx.lineWidth = (2.5 * (1 - p) + 0.5) * v.s;
      ctx.beginPath();
      ctx.arc(sh.x * v.W, sh.y * v.H, (6 + (50 + 40 * sh.vel) * e) * v.s, 0, Math.PI * 2);
      ctx.stroke();
      this.shocks[j++] = sh;
    }
    this.shocks.length = j;

    // sparks: short streaks along their velocity (motion blur), drag + a bit of gravity
    const drag = Math.exp(-3.5 * dt);
    ctx.lineWidth = 1.6 * v.s;
    let w = 0;
    for (const p of this.sparks) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vx *= drag;
      p.vy = p.vy * drag + 0.9 * dt;
      p.x += p.vx * dt * (v.H / v.W); // velocities are in stage heights/s
      p.y += p.vy * dt;
      const x = p.x * v.W, y = p.y * v.H;
      ctx.strokeStyle = `rgba(${mixWhite(p.rgb, 0.5)}, ${p.life / p.max})`;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - p.vx * 0.035 * v.H, y - p.vy * 0.035 * v.H);
      ctx.stroke();
      this.sparks[w++] = p;
    }
    this.sparks.length = w;
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Fold any number into 0..1 like a ball bouncing between two walls */
function reflect01(u: number): number {
  const m = ((u % 2) + 2) % 2;
  return m <= 1 ? m : 2 - m;
}

function mixWhite(rgb: string, k: number): string {
  return rgb.split(',').map((c) => Math.round(+c + (255 - +c) * k)).join(', ');
}

function hsl(h: number, s: number, l: number): string {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return `${f(0)}, ${f(8)}, ${f(4)}`;
}
