import ksUrl from './ks-processor.ts?worker&url';

/**
 * One Karplus–Strong voice per string. Each string keeps its own voice for its
 * whole life, so a ringing note keeps ringing while you change the length,
 * and the pitch follows (meend).
 */

// Pitch from length: f = K / L  (shorter = higher, like a real string).
// L in stage heights. K chosen so L≈1.38 → C2 (65 Hz), L≈0.17 → C5 (523 Hz).
const K = 90;
const F_MIN = 65.41;  // C2
const F_MAX = 523.25; // C5

/** How quickly pitch follows length changes (seconds). Smooths hand jitter. */
const GLIDE_TIME = 0.03;

export function freqForLength(len: number): number {
  return Math.min(F_MAX, Math.max(F_MIN, K / len));
}

interface Voice { node: AudioWorkletNode; tone: BiquadFilterNode; gain: GainNode; freq: AudioParam }

export class Synth {
  private ctx: AudioContext;
  private out: GainNode;
  private voices = new Map<number, Voice>();
  private ready = false;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    // voices → master → compressor → speakers (compressor stops chords from clipping)
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 4;
    this.out = ctx.createGain();
    this.out.gain.value = 0.9;
    this.out.connect(comp).connect(ctx.destination);
  }

  async init() {
    await this.ctx.audioWorklet.addModule(ksUrl);
    this.ready = true;
  }

  /** Call every frame: create voices for new strings, set pitch, remove deleted strings' voices */
  sync(strings: { id: number; freq: number }[]) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const alive = new Set<number>();

    for (const s of strings) {
      alive.add(s.id);
      let v = this.voices.get(s.id);
      if (!v) {
        const node = new AudioWorkletNode(this.ctx, 'ks-string', { outputChannelCount: [1] });
        // per-string low-pass: pluck position sets its brightness
        const tone = this.ctx.createBiquadFilter();
        tone.type = 'lowpass';
        tone.Q.value = 0.8;
        const gain = this.ctx.createGain();
        node.connect(tone).connect(gain).connect(this.out);
        v = { node, tone, gain, freq: node.parameters.get('frequency')! };
        v.freq.value = s.freq;
        this.voices.set(s.id, v);
      }
      v.freq.setTargetAtTime(s.freq, t, GLIDE_TIME);
    }

    for (const [id, v] of this.voices) {
      if (alive.has(id)) continue;
      // fade out, then free it
      v.gain.gain.setTargetAtTime(0, t, 0.03);
      setTimeout(() => { v.node.disconnect(); v.tone.disconnect(); v.gain.disconnect(); }, 300);
      this.voices.delete(id);
    }
  }

  /**
   * @param velocity 0..1 (finger speed)
   * @param pos 0..1 along the string → filter cutoff (ends brighter, middle darker)
   */
  pluck(id: number, freq: number, velocity: number, pos: number) {
    const v = this.voices.get(id);
    if (!v) return;
    const t = this.ctx.currentTime;
    const edge = Math.abs(pos - 0.5) * 2; // 0 middle → 1 ends
    // cutoff 700 Hz (middle, soft) … ~9 kHz (end, hard); exponential so it sounds even
    const cutoff = 700 * Math.pow(13, Math.min(1, 0.75 * edge + 0.25 * velocity));
    v.tone.frequency.setTargetAtTime(cutoff, t, 0.005);
    const amp = 0.15 + 0.75 * velocity;
    v.freq.cancelScheduledValues(t);
    v.freq.setValueAtTime(freq, t);
    // fixed, bright excitation: tone colour now comes only from the filter
    v.node.port.postMessage({ type: 'pluck', freq, velocity: amp, pos: 0.15, brightness: 0.85 });
  }
}
