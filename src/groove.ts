import { BPM } from './fx';

/**
 * Optional backing groove: synthesized drums + bassline in C minor.
 *
 * Timing uses the standard Web Audio "lookahead scheduler": a JS timer wakes
 * every 25 ms and schedules any notes due in the next ~120 ms on the audio
 * clock. JS timers jitter, the audio clock doesn't, so the beat stays tight.
 */

const STEP = 60 / BPM / 4;   // one 1/16 note
const LOOKAHEAD = 0.12;      // s

// 16 steps per bar. x = hit
const KICK  = 'x.......x..x....';
const SNARE = '....x.......x...';
const HAT   = 'x.x.x.x.x.x.x.xx';
// Bass: per bar root (semitones from C1=24): C, C, Ab, Bb  → i – i – VI – VII
const BASS_ROOTS = [0, 0, -4, -2].map((s) => 36 + s); // around C2
// bass rhythm: step → octave offset (0 = root, 12 = octave up)
const BASS_STEPS: Record<number, number> = { 0: 0, 3: 0, 6: 12, 8: 0, 10: 0, 14: 12 };

const midiToFreq = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class Groove {
  private ctx: BaseAudioContext;
  private out: GainNode;
  private noise: AudioBuffer;
  private step = 0;
  private nextTime = 0;
  private timer: number | undefined;
  playing = false;

  constructor(ctx: BaseAudioContext, destination: AudioNode) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.out.gain.value = 0.55; // sits under the strings
    this.out.connect(destination);
    // one second of white noise, reused for snare + hats
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  start() {
    if (this.playing) return;
    this.playing = true;
    this.step = 0;
    this.nextTime = this.ctx.currentTime + 0.06;
    this.timer = window.setInterval(() => this.scheduleUntil(this.ctx.currentTime + LOOKAHEAD), 25);
    this.scheduleUntil(this.ctx.currentTime + LOOKAHEAD);
  }

  stop() {
    this.playing = false;
    window.clearInterval(this.timer);
  }

  toggle() { this.playing ? this.stop() : this.start(); }

  /** Schedule every step whose time falls before `until`. Public so it can be tested offline. */
  scheduleUntil(until: number) {
    while (this.nextTime < until) {
      this.playStep(this.step, this.nextTime);
      this.nextTime += STEP;
      this.step = (this.step + 1) % 64; // 4 bars
    }
  }

  private playStep(s: number, t: number) {
    const st = s % 16;
    const bar = Math.floor(s / 16);
    if (KICK[st] === 'x') this.kick(t);
    if (SNARE[st] === 'x') this.snare(t);
    if (HAT[st] === 'x') this.hat(t, st % 4 === 2 ? 1 : 0.55); // accent the off-beats
    if (st in BASS_STEPS) this.bass(t, BASS_ROOTS[bar] + BASS_STEPS[st]);
  }

  private kick(t: number) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12); // the "thump" is the pitch drop
    g.gain.setValueAtTime(1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + 0.4);
  }

  private snare(t: number) {
    const c = this.ctx;
    const n = c.createBufferSource();
    n.buffer = this.noise;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 0.8;
    const g = c.createGain();
    g.gain.setValueAtTime(0.55, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
    n.connect(bp).connect(g).connect(this.out);
    n.start(t, Math.random() * 0.5);
    n.stop(t + 0.16);
    // body
    const o = c.createOscillator();
    o.type = 'triangle';
    o.frequency.value = 190;
    const og = c.createGain();
    og.gain.setValueAtTime(0.35, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    o.connect(og).connect(this.out);
    o.start(t);
    o.stop(t + 0.1);
  }

  private hat(t: number, level: number) {
    const c = this.ctx;
    const n = c.createBufferSource();
    n.buffer = this.noise;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7500;
    const g = c.createGain();
    g.gain.setValueAtTime(0.16 * level, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    n.connect(hp).connect(g).connect(this.out);
    n.start(t, Math.random() * 0.5);
    n.stop(t + 0.05);
  }

  private bass(t: number, midi: number) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = midiToFreq(midi);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 3;
    lp.frequency.setValueAtTime(1400, t);
    lp.frequency.exponentialRampToValueAtTime(250, t + 0.15);
    const g = c.createGain();
    const dur = STEP * 1.6;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.32, t + 0.005);
    g.gain.setTargetAtTime(0, t + dur * 0.6, 0.03);
    o.connect(lp).connect(g).connect(this.out);
    o.start(t);
    o.stop(t + dur + 0.2);
  }
}
