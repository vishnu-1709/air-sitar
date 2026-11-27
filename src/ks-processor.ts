/**
 * Karplus–Strong plucked string, running on the audio thread (AudioWorklet).
 *
 * The idea: a real string's vibration is a wave travelling back and forth.
 * Model it as a delay line exactly one period long (sampleRate / frequency
 * samples). Fill it with noise (the pluck), then keep feeding its output back
 * into its input through a gentle low-pass filter. Each trip around the loop
 * the high frequencies fade faster than the low ones, so the noise turns into
 * a decaying, string-like tone.
 *
 * Extras over textbook KS:
 *  - Fractional delay (cubic interpolation): the loop length doesn't have to be
 *    a whole number of samples, so pitch is exact AND can change smoothly while
 *    the note rings (meend).
 *  - Pluck position: a comb filter on the excitation removes the overtones that
 *    have a node at the pluck point, like a real string. Middle = warm/hollow,
 *    near the end = bright.
 */

// --- Worklet globals (not in TypeScript's DOM types) -----------------------
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, ctor: unknown): void;
// ----------------------------------------------------------------------------

const BUF = 4096;            // power of two → wrap with a bit-mask
const MASK = BUF - 1;
const RHO = 0.35;            // loop low-pass amount (0 = no damping, 0.5 = classic KS)

interface PluckMsg { type: 'pluck'; freq: number; velocity: number; pos: number; brightness: number }

class KSString extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'frequency', defaultValue: 220, minValue: 20, maxValue: 4000, automationRate: 'k-rate' }];
  }

  private buf = new Float32Array(BUF);
  private exc = new Float32Array(BUF); // scratch for the pluck excitation (no allocation on the audio thread)
  private exc2 = new Float32Array(BUF);
  private w = 0;        // write index
  private D = 100;      // current loop delay in samples (fractional)
  private prevX = 0;    // loop filter state
  private dcX = 0;      // DC blocker state
  private dcY = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<PluckMsg>) => {
      if (e.data.type === 'pluck') this.pluck(e.data);
    };
  }

  /** Loop length for a frequency. The loop filter adds RHO samples of delay, so subtract it. */
  private delayFor(f: number): number {
    return Math.min(BUF - 8, Math.max(4, sampleRate / f - RHO));
  }

  private pluck({ freq, velocity, pos, brightness }: PluckMsg) {
    const N = Math.min(BUF - 8, Math.round(sampleRate / freq));
    const e = this.exc;

    // 1. Noise burst, low-passed: brighter pluck = less filtering
    const a = 0.08 + 0.9 * brightness;
    let lp = 0;
    for (let i = 0; i < N; i++) {
      lp += a * (Math.random() * 2 - 1 - lp);
      e[i] = lp;
    }

    // 2. Pluck position comb: e[i] - e[i - M], M = pluck point in samples.
    //    Circular (wraps within one period), because the loop is a circle:
    //    plucking at 1/2 then cancels harmonics 2, 4, 6…; at 1/3 cancels 3, 6…
    const p = Math.min(Math.max(Math.min(pos, 1 - pos), 0.04), 0.5);
    const M = Math.max(1, Math.round(p * N));
    const e2 = this.exc2;
    for (let i = 0; i < N; i++) e2[i] = e[i] - e[(i - M + N) % N];
    e.set(e2.subarray(0, N));

    // 3. Remove DC, normalise peak to velocity
    let mean = 0;
    for (let i = 0; i < N; i++) mean += e[i];
    mean /= N;
    let peak = 1e-6;
    for (let i = 0; i < N; i++) { e[i] -= mean; peak = Math.max(peak, Math.abs(e[i])); }
    const k = velocity / peak;

    // 4. Write it into the loop (keep a bit of the old note: re-plucking a ringing string)
    for (let i = 0; i < N; i++) {
      const idx = (this.w - 1 - i) & MASK;
      this.buf[idx] = this.buf[idx] * 0.3 + e[i] * k;
    }
    this.D = this.delayFor(freq); // jump straight to the plucked pitch
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean {
    const out = outputs[0];
    const ch0 = out[0];
    const n = ch0.length;
    const f = params.frequency[0];

    // Loop gain per sample from a target decay time (T60: time to fall 60 dB).
    // Low notes ring longer, like real strings.
    const t60 = Math.min(8, Math.max(1.5, 6 * Math.sqrt(130 / f)));
    const g = Math.pow(10, -3 / (t60 * f));

    // Glide: move the delay from its old value to the new one across this block
    const D0 = this.D;
    const D1 = this.delayFor(f);
    const buf = this.buf;

    for (let i = 0; i < n; i++) {
      const D = D0 + ((D1 - D0) * (i + 1)) / n;

      // read D samples back, with cubic (Hermite) interpolation between samples
      const r = this.w - D;
      const ri = Math.floor(r);
      const fr = r - ri;
      const xm1 = buf[(ri - 1) & MASK], x0 = buf[ri & MASK];
      const x1 = buf[(ri + 1) & MASK], x2 = buf[(ri + 2) & MASK];
      const c1 = 0.5 * (x1 - xm1);
      const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
      const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
      const x = ((c3 * fr + c2) * fr + c1) * fr + x0;

      // loop filter: weighted average with the previous sample, times decay
      const y = g * ((1 - RHO) * x + RHO * this.prevX);
      this.prevX = x;
      buf[this.w] = y;
      this.w = (this.w + 1) & MASK;

      // DC blocker on the output
      const o = x - this.dcX + 0.995 * this.dcY;
      this.dcX = x;
      this.dcY = o;
      ch0[i] = o;
    }
    this.D = D1;

    for (let c = 1; c < out.length; c++) out[c].set(ch0);
    return true;
  }
}

registerProcessor('ks-string', KSString);
