/**
 * Effects: stereo ping-pong delay + reverb, then a limiter.
 *
 *   synth ──► input ─┬──────────────────────────────► limiter ─► master ─► output
 *                    └► high-pass ─┬► ping-pong delay ──┘
 *                                  └► reverb ───────────┘
 *   beat  ──► dry ─────────────────────────────────────► limiter
 *
 * The sends are high-passed so the sub-bass stays dry and tight (echoing bass = mud).
 */

export const BPM = 100;                   // the beat and the delay share this tempo
export const EIGHTH = 60 / BPM / 2;       // seconds per 1/8 note (0.3 s at 100 BPM)

// ---- Mix knobs ----------------------------------------------------------------
const DELAY_SEND = 0.32;
const DELAY_FEEDBACK = 0.45;   // how many echoes (0.45 ≈ 5–6 audible repeats)
const REVERB_SEND = 0.28;
const REVERB_SECONDS = 2.6;
// --------------------------------------------------------------------------------

export class FX {
  /** synth goes here: gets delay + reverb */
  readonly input: GainNode;
  /** beat goes here: no sends, stays punchy */
  readonly dry: GainNode;
  /** connect to speakers (and later, the recorder) */
  readonly output: GainNode;

  constructor(ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.dry = ctx.createGain();
    this.output = ctx.createGain();
    this.output.gain.value = 0.9;

    // limiter: catches peaks when strings + echoes + beat pile up
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    limiter.connect(this.output);

    this.input.connect(limiter);
    this.dry.connect(limiter);

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 180;
    this.input.connect(hp);

    // --- ping-pong delay ---
    // Mono send → left delay → right delay → (darker, quieter) back to left.
    // Left and right taps go to opposite speakers, so echoes bounce L, R, L, R…
    const send = ctx.createGain();
    send.gain.value = DELAY_SEND;
    send.channelCount = 1;            // sum to mono so the bounce is clean
    send.channelCountMode = 'explicit';
    const dl = ctx.createDelay(2);
    const dr = ctx.createDelay(2);
    dl.delayTime.value = EIGHTH;
    dr.delayTime.value = EIGHTH;
    const fb = ctx.createGain();
    fb.gain.value = DELAY_FEEDBACK;
    const damp = ctx.createBiquadFilter(); // each repeat a little darker, like tape
    damp.type = 'lowpass';
    damp.frequency.value = 3500;
    hp.connect(send).connect(dl);
    dl.connect(dr);
    dr.connect(damp).connect(fb).connect(dl);
    const merger = ctx.createChannelMerger(2);
    dl.connect(merger, 0, 0);
    dr.connect(merger, 0, 1);
    merger.connect(limiter);

    // --- reverb (convolution with a generated impulse) ---
    const rsend = ctx.createGain();
    rsend.gain.value = REVERB_SEND;
    const conv = ctx.createConvolver();
    conv.buffer = makeImpulse(ctx, REVERB_SECONDS);
    hp.connect(rsend).connect(conv).connect(limiter);
    merger.connect(rsend); // echoes also get some space
  }
}

/**
 * A reverb impulse is "what a room does to a click". A synthetic one: stereo
 * noise that decays exponentially and gets darker over time (air absorbs highs).
 * Different noise per channel → wide stereo.
 */
function makeImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      const env = Math.pow(1 - t, 3);          // decay
      const k = 0.9 - 0.8 * t;                 // low-pass gets stronger over time
      lp += k * (Math.random() * 2 - 1 - lp);
      d[i] = lp * env;
    }
    // short fade-in avoids a hard click at the very start
    for (let i = 0; i < 64; i++) d[i] *= i / 64;
  }
  return buf;
}
