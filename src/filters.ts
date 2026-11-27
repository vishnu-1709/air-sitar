/**
 * One Euro filter (Casiez et al. 2012).
 * A low-pass filter whose cutoff rises with speed:
 *   - hand still  → low cutoff  → heavy smoothing → no jitter
 *   - hand moving → high cutoff → light smoothing → no lag
 *
 *   minCutoff (Hz): smoothing when still. Lower = less jitter, more lag.
 *   beta:           how fast the cutoff rises with speed. Higher = less lag on fast moves.
 *   dCutoff (Hz):   smoothing of the speed estimate itself (rarely needs tuning).
 */
export class OneEuro {
  private xPrev = 0;
  private dxPrev = 0;
  private tPrev = -1;

  minCutoff: number;
  beta: number;
  dCutoff: number;

  constructor(minCutoff = 1.5, beta = 8, dCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  filter(x: number, tSec: number): number {
    if (this.tPrev < 0) {
      this.tPrev = tSec;
      this.xPrev = x;
      return x;
    }
    const dt = Math.max(tSec - this.tPrev, 1e-3);
    this.tPrev = tSec;

    // smoothed speed
    const dx = (x - this.xPrev) / dt;
    const dxHat = lerp(this.dxPrev, dx, alpha(this.dCutoff, dt));
    this.dxPrev = dxHat;

    // speed-adaptive cutoff
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const xHat = lerp(this.xPrev, x, alpha(cutoff, dt));
    this.xPrev = xHat;
    return xHat;
  }
}

/** Smoothing factor for an exponential low-pass at a given cutoff frequency */
function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
