/**
 * Coordinate system used everywhere in the app:
 *   "stage-normalized" — (0,0) top-left of the 16:9 stage, (1,1) bottom-right,
 *   already MIRRORED (your right hand appears on the right, like a mirror).
 *
 * MediaPipe gives landmarks normalized to the raw (unmirrored) camera frame.
 * The camera frame is drawn with object-fit: cover, so it may be cropped.
 * This module converts between the two.
 */

export interface CoverFit {
  /** where the video is drawn, in stage pixels (may extend past the stage) */
  ox: number; oy: number; dw: number; dh: number;
  W: number; H: number;
}

export function coverFit(vw: number, vh: number, W: number, H: number): CoverFit {
  const scale = Math.max(W / vw, H / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  return { ox: (W - dw) / 2, oy: (H - dh) / 2, dw, dh, W, H };
}

/** raw camera-normalized landmark → mirrored stage-normalized point */
export function toStage(fit: CoverFit, vx: number, vy: number): { x: number; y: number } {
  const px = fit.ox + vx * fit.dw;
  const py = fit.oy + vy * fit.dh;
  return { x: 1 - px / fit.W, y: py / fit.H };
}
