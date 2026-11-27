import type { Pt } from './hands';

/**
 * Neon laser rendering: strings, vibration, sparks, emitters.
 * Everything glowing is drawn with additive blending ('lighter'): overlapping
 * light adds up and saturates toward white, like real light. No shadowBlur
 * (slow on iPhone) — glow is built from a few wide, faint strokes under a thin
 * bright core.
 */

export interface View { W: number; H: number; s: number } // s = pixel scale (H / 720)

// ---- Look knobs ------------------------------------------------------------
const GLOW_LAYERS: [number, number][] = [[18, 0.035], [10, 0.08], [5, 0.22], [2.4, 0.65]]; // [width, alpha]
const CORE_WIDTH = 1.1;
const VIB_SEGMENTS = 28;       // polyline resolution of a vibrating string
const MAX_SPARKS = 260;
// ------------------------------------------------------------------------------

/** Pitch colour over C2–C5: deep magenta → violet → cyan → near-white */
const PALETTE: [number, number, number][] = [
  [200, 30, 160],
  [140, 60, 255],
  [40, 200, 255],
  [210, 250, 255],
];
export function pitchColor(m: number): string {
  const t = Math.min(1, Math.max(0, (m - 36) / 36)) * (PALETTE.length - 1);
  const i = Math.min(PALETTE.length - 2, Math.floor(t));
  const f = t - i;
  return PALETTE[i].map((c, k) => Math.round(c + (PALETTE[i + 1][k] - c) * f)).join(', ');
}
/** Same colour pushed toward white — for the hot core of the beam */
function hot(rgb: string, k = 0.7): string {
  return rgb.split(',').map((c) => Math.round(+c + (255 - +c) * k)).join(', ');
}

interface Vib { amp: number; t0: number; tau: number; fv: number }
interface Spark { x: number; y: number; vx: number; vy: number; life: number; max: number; rgb: string }

export class LaserFX {
  private vib = new Map<number, Vib>();
  private flash = new Map<number, { v: number; at: Pt }>();
  private sparks: Spark[] = [];

  /**
   * @param dir unit vector along the string (stage coords, aspect-corrected not needed for looks)
   * @param bass 0..1 (1 = low note: rings longer, wobbles slower)
   */
  pluck(id: number, at: Pt, dir: Pt, velocity: number, bass: number, rgb: string, now: number) {
    // Vibration amplitude and decay roughly follow the audio envelope
    this.vib.set(id, {
      amp: 0.006 + 0.022 * velocity,           // stage heights
      t0: now,
      tau: 0.22 + 0.22 * bass,                 // s, matches the amp decay
      fv: 4 + 7 * (1 - bass),                  // visual wobble Hz (slowed way down from audio)
    });
    this.flash.set(id, { v: 0.5 + 0.5 * velocity, at });

    // Sparks: mostly flung perpendicular to the string, both sides
    const n = Math.round(8 + 14 * velocity);
    const nx = -dir.y, ny = dir.x;
    for (let i = 0; i < n && this.sparks.length < MAX_SPARKS; i++) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const sp = (0.25 + Math.random() * 0.9) * (0.5 + velocity);
      const along = (Math.random() - 0.5) * 0.8;
      const life = 0.25 + Math.random() * 0.45;
      this.sparks.push({
        x: at.x, y: at.y,
        vx: (nx * side + dir.x * along) * sp,
        vy: (ny * side + dir.y * along) * sp,
        life, max: life, rgb,
      });
    }
  }

  forget(alive: Set<number>) {
    for (const id of this.vib.keys()) if (!alive.has(id)) this.vib.delete(id);
    for (const id of this.flash.keys()) if (!alive.has(id)) this.flash.delete(id);
  }

  /** Draw one string as a neon beam (vibrating if recently plucked) */
  drawString(
    ctx: CanvasRenderingContext2D, v: View, id: number, a: Pt, b: Pt,
    rgb: string, now: number, dim = 1,
  ) {
    const ax = a.x * v.W, ay = a.y * v.H, bx = b.x * v.W, by = b.y * v.H;
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;

    // vibration: standing wave sin(πu) · sin(2π f t), decaying
    const vb = this.vib.get(id);
    let ampPx = 0, phase = 0;
    if (vb) {
      const t = (now - vb.t0) / 1000;
      // longer strings swing wider, like real ones
      const lenK = Math.min(1.8, Math.max(0.5, len / (0.45 * v.H)));
      ampPx = vb.amp * v.H * lenK * Math.exp(-t / vb.tau);
      phase = Math.sin(2 * Math.PI * vb.fv * t);
      if (ampPx < 0.3) { this.vib.delete(id); ampPx = 0; }
    }
    const fl = this.flash.get(id);
    const boost = fl ? 1 + 1.6 * fl.v : 1;
    const k = dim * boost;

    // build the beam path once, stroke it several times
    const path = new Path2D();
    if (ampPx === 0) {
      path.moveTo(ax, ay);
      path.lineTo(bx, by);
    } else {
      for (let i = 0; i <= VIB_SEGMENTS; i++) {
        const u = i / VIB_SEGMENTS;
        const d = ampPx * Math.sin(Math.PI * u) * phase;
        const x = ax + dx * u + nx * d, y = ay + dy * u + ny * d;
        i ? path.lineTo(x, y) : path.moveTo(x, y);
      }
    }

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // "blur lens": the faint envelope a fast-vibrating string leaves on camera
    if (ampPx > 1) {
      const lens = new Path2D();
      for (let i = 0; i <= VIB_SEGMENTS; i++) {
        const u = i / VIB_SEGMENTS, e = ampPx * Math.sin(Math.PI * u);
        const x = ax + dx * u + nx * e, y = ay + dy * u + ny * e;
        i ? lens.lineTo(x, y) : lens.moveTo(x, y);
      }
      for (let i = VIB_SEGMENTS; i >= 0; i--) {
        const u = i / VIB_SEGMENTS, e = ampPx * Math.sin(Math.PI * u);
        lens.lineTo(ax + dx * u - nx * e, ay + dy * u - ny * e);
      }
      ctx.fillStyle = `rgba(${rgb}, ${0.13 * dim})`;
      ctx.fill(lens);
    }

    for (const [w, al] of GLOW_LAYERS) {
      ctx.strokeStyle = `rgba(${rgb}, ${Math.min(1, al * k)})`;
      ctx.lineWidth = w * v.s;
      ctx.stroke(path);
    }
    ctx.strokeStyle = `rgba(${hot(rgb)}, ${Math.min(1, 0.95 * dim)})`;
    ctx.lineWidth = CORE_WIDTH * v.s;
    ctx.stroke(path);

    // flash burst at the pluck point
    if (fl) {
      const r = (10 + 30 * (1 - fl.v)) * v.s;
      const g = ctx.createRadialGradient(fl.at.x * v.W, fl.at.y * v.H, 0, fl.at.x * v.W, fl.at.y * v.H, r);
      g.addColorStop(0, `rgba(${hot(rgb, 0.8)}, ${0.7 * fl.v})`);
      g.addColorStop(1, `rgba(${rgb}, 0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(fl.at.x * v.W, fl.at.y * v.H, r, 0, Math.PI * 2);
      ctx.fill();
      fl.v *= 0.86;
      if (fl.v < 0.03) this.flash.delete(id);
    }
    ctx.restore();
  }

  /** Glowing "emitter" node at a string end. state: idle / hover (grabbable) / grabbed */
  drawEmitter(ctx: CanvasRenderingContext2D, v: View, p: Pt, rgb: string, state: 'idle' | 'hover' | 'grabbed') {
    const x = p.x * v.W, y = p.y * v.H;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const r = (state === 'grabbed' ? 13 : 9) * v.s;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${hot(rgb)}, 0.9)`);
    g.addColorStop(0.35, `rgba(${rgb}, 0.35)`);
    g.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (state !== 'idle') {
      ctx.strokeStyle = `rgba(${rgb}, ${state === 'hover' ? 0.45 : 0.85})`;
      ctx.lineWidth = 1.4 * v.s;
      ctx.beginPath();
      ctx.arc(x, y, (state === 'hover' ? 16 : 12) * v.s, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Move + draw sparks. dt in seconds. */
  drawSparks(ctx: CanvasRenderingContext2D, v: View, dt: number) {
    const drag = Math.exp(-3.5 * dt);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineWidth = 1.6 * v.s;
    let w = 0;
    for (const p of this.sparks) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vx *= drag;
      p.vy = p.vy * drag + 0.9 * dt; // a little gravity
      p.x += p.vx * dt * (v.H / v.W); // velocities are in stage heights/s
      p.y += p.vy * dt;
      const a = p.life / p.max;
      // short streak along the velocity = motion blur
      const x = p.x * v.W, y = p.y * v.H;
      ctx.strokeStyle = `rgba(${hot(p.rgb, 0.5)}, ${a})`;
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
