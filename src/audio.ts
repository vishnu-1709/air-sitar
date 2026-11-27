/**
 * Laser synth. One persistent voice per string (so a ringing note can bend
 * while you drag — the "wub").
 *
 * Voice:
 *   3 saws, detuned ±cents, panned L/C/R ("supersaw")
 *        → low-pass filter (fast pluck envelope: bright attack, quick close;
 *          keytracks the pitch and sweeps extra while bending)
 *        → amp (pluck: 3 ms attack, medium decay)
 *   + sine sub one octave down, louder on long (low) strings, straight to amp
 *   → master → compressor → speakers
 */

// Pitch from length: f = K / L  (shorter = higher, like a real string).
// L in stage heights. K chosen so L≈1.38 → C2 (65 Hz), L≈0.17 → C5 (523 Hz).
export const K = 90;
const F_MIN = 65.41;  // C2
const F_MAX = 523.25; // C5

export function freqForLength(len: number): number {
  return Math.min(F_MAX, Math.max(F_MIN, K / len));
}

// ---- Sound design knobs ------------------------------------------------------
// Tune live via URL, e.g. ?detune=0&decay=0.2
const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const DETUNE_CENTS = num('detune', 14); // supersaw spread (0 = no wobble/chorus)
const SPREAD = 0.6;        // stereo pan of the outer saws
const GLIDE_TIME = 0.03;   // s, how fast pitch follows length (smooths hand jitter)
const AMP_DECAY = num('decay', 0.2);            // s (time constant) — short pluck
const AMP_DECAY_BASS = AMP_DECAY * 2;           // s — low notes ring longer
const FILT_DECAY = 0.08;   // s — how fast the filter closes after the pluck ("pluck" sound)
const FILT_Q = 5;          // resonance: a little peak = more synthy
const WUB_CENTS = 350;     // extra filter sweep per semitone of bend
// ------------------------------------------------------------------------------

const midiOf = (f: number) => 69 + 12 * Math.log2(f / 440);

interface Voice {
  saws: OscillatorNode[];
  sub: OscillatorNode;
  subGain: GainNode;
  filter: BiquadFilterNode;
  amp: GainNode;
  nodes: AudioNode[];   // everything, for cleanup
  pluckMidi: number;    // pitch at the last pluck (filter keytracks relative to it)
  lastMidi: number;
  wub: number;          // current extra filter sweep in cents
}

export class Synth {
  private ctx: BaseAudioContext;
  private out: GainNode;
  private voices = new Map<number, Voice>();

  constructor(ctx: BaseAudioContext, destination: AudioNode = ctx.destination) {
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    this.out = ctx.createGain();
    this.out.gain.value = 0.8;
    this.out.connect(comp).connect(destination);
  }

  /** kept for the start-up sequence; native nodes need no loading */
  async init() {}

  /** Master output (Phase 8 inserts effects after this) */
  get output(): GainNode { return this.out; }

  private createVoice(freq: number): Voice {
    const c = this.ctx;
    const amp = c.createGain();
    amp.gain.value = 0;
    amp.connect(this.out);

    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = FILT_Q;
    filter.frequency.value = 800;
    filter.connect(amp);

    const mix = c.createGain();
    mix.gain.value = 1 / 3;
    mix.connect(filter);

    const nodes: AudioNode[] = [amp, filter, mix];
    const saws = [-1, 0, 1].map((k) => {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      o.detune.value = k * DETUNE_CENTS;
      const pan = c.createStereoPanner();
      pan.pan.value = k * SPREAD;
      o.connect(pan).connect(mix);
      o.start();
      nodes.push(o, pan);
      return o;
    });

    const sub = c.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = freq / 2;
    const subGain = c.createGain();
    subGain.gain.value = subLevel(freq);
    sub.connect(subGain).connect(amp);
    sub.start();
    nodes.push(sub, subGain);

    const m = midiOf(freq);
    return { saws, sub, subGain, filter, amp, nodes, pluckMidi: m, lastMidi: m, wub: 0 };
  }

  /** Call every frame: create voices for new strings, follow pitch, remove deleted ones */
  sync(strings: { id: number; freq: number }[]) {
    const t = this.ctx.currentTime;
    const alive = new Set<number>();

    for (const s of strings) {
      alive.add(s.id);
      let v = this.voices.get(s.id);
      if (!v) { v = this.createVoice(s.freq); this.voices.set(s.id, v); }

      for (const o of v.saws) o.frequency.setTargetAtTime(s.freq, t, GLIDE_TIME);
      v.sub.frequency.setTargetAtTime(s.freq / 2, t, GLIDE_TIME);
      v.subGain.gain.setTargetAtTime(subLevel(s.freq), t, 0.05);

      // Filter follows the bend (keytracking) + extra sweep proportional to how
      // fast you're bending → the "wub". Uses the filter's detune param so it
      // stacks on top of the pluck envelope instead of fighting it.
      const m = midiOf(s.freq);
      v.wub = Math.min(2400, v.wub * 0.85 + Math.abs(m - v.lastMidi) * WUB_CENTS);
      v.lastMidi = m;
      const keytrack = (m - v.pluckMidi) * 100;
      v.filter.detune.setTargetAtTime(keytrack + v.wub, t, 0.02);
    }

    for (const [id, v] of this.voices) {
      if (alive.has(id)) continue;
      v.amp.gain.cancelScheduledValues(t);
      v.amp.gain.setTargetAtTime(0, t, 0.03);
      const all = v.nodes;
      setTimeout(() => {
        for (const n of all) {
          if (n instanceof OscillatorNode) n.stop();
          n.disconnect();
        }
      }, 400);
      this.voices.delete(id);
    }
  }

  /**
   * @param velocity 0..1 (finger speed) → loudness + filter opening
   * @param pos 0..1 along the string → brightness (ends brighter, middle darker)
   */
  pluck(id: number, freq: number, velocity: number, pos: number) {
    const v = this.voices.get(id);
    if (!v) return;
    const t = this.ctx.currentTime;
    const edge = Math.abs(pos - 0.5) * 2;                     // 0 middle → 1 ends
    const bright = Math.min(1, 0.7 * edge + 0.3 * velocity);  // 0..1

    // snap the oscillators to the plucked pitch (no glide into the attack)
    for (const o of v.saws) { hold(o.frequency, t); o.frequency.setValueAtTime(freq, t); }
    hold(v.sub.frequency, t);
    v.sub.frequency.setValueAtTime(freq / 2, t);
    v.pluckMidi = v.lastMidi = midiOf(freq);
    v.wub = 0;
    hold(v.filter.detune, t);
    v.filter.detune.setValueAtTime(0, t);

    // filter envelope: jump open, close quickly to a resting cutoff
    const rest = Math.max(freq * 1.5, 250 * Math.pow(6, bright));     // ~250 Hz … 1.5 kHz
    const peak = Math.min(16000, rest * (3 + 9 * bright) + freq * 2); // bright attack
    const fq = v.filter.frequency;
    hold(fq, t);
    fq.setValueAtTime(peak, t + 0.002);
    fq.setTargetAtTime(rest, t + 0.004, FILT_DECAY);

    // amp envelope: 3 ms attack (no click), medium decay; bass rings longer
    const decay = AMP_DECAY + (AMP_DECAY_BASS - AMP_DECAY) * subLevel(freq);
    const g = v.amp.gain;
    hold(g, t);
    g.linearRampToValueAtTime(0.12 + 0.55 * velocity, t + 0.003);
    g.setTargetAtTime(0, t + 0.003, decay);
  }
}

/** Sub-bass level: full at C2, fading out by C4 (long = deep, short = sparkly) */
function subLevel(freq: number): number {
  const m = midiOf(freq);
  return Math.min(1, Math.max(0, (60 - m) / 24)) * 0.9;
}

/**
 * Stop whatever automation is running and hold the current value, so a new
 * envelope starts from where the old one is (no clicks on re-pluck).
 */
function hold(p: AudioParam, t: number) {
  const q = p as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
  if (q.cancelAndHoldAtTime) q.cancelAndHoldAtTime(t);
  else { const val = p.value; p.cancelScheduledValues(t); p.setValueAtTime(val, t); }
}
