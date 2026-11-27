/**
 * Phase 4 placeholder synth: oscillator + filter + decaying envelope.
 * Gets the pipeline (gesture → sound) working; replaced by Karplus–Strong in Phase 5.
 */

// Pitch from length: f = K / L  (shorter = higher, like a real string).
// L in stage heights. K chosen so L≈1.2 → C3 (131 Hz), L≈0.3 → C5 (523 Hz).
const K = 157;
const F_MIN = 98;   // G2
const F_MAX = 1047; // C6

export function freqForLength(len: number): number {
  return Math.min(F_MAX, Math.max(F_MIN, K / len));
}

export class Synth {
  private ctx: AudioContext;
  private out: GainNode;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    // master → compressor → speakers (compressor stops several notes from clipping)
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 4;
    this.out = ctx.createGain();
    this.out.gain.value = 0.8;
    this.out.connect(comp).connect(ctx.destination);
  }

  /**
   * @param freq Hz
   * @param velocity 0..1 (from finger speed)
   * @param pos 0..1 along the string (ends = brighter)
   */
  pluck(freq: number, velocity: number, pos: number) {
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    const edge = Math.abs(pos - 0.5) * 2; // 0 middle → 1 at the ends
    lp.frequency.value = 1500 + 5000 * edge;

    const env = ctx.createGain();
    const peak = 0.08 + 0.5 * velocity;
    const decay = 1.6; // seconds to (almost) silence
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(peak, t + 0.004); // 4 ms attack (no click)
    env.gain.exponentialRampToValueAtTime(0.0001, t + decay);

    osc.connect(lp).connect(env).connect(this.out);
    osc.start(t);
    osc.stop(t + decay + 0.05);
  }
}
