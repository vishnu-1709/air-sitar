import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import type { CoverFit } from './coords';

/**
 * Background dimming with MediaPipe's selfie segmenter.
 *
 * The model returns a small "confidence mask" (e.g. 256×144): for each pixel,
 * how likely it is to be a person (0..1). We turn that into a dark overlay
 * whose opacity is high on the background and low on you, then stretch it
 * over the video. Stretching a small image with smoothing gives soft edges
 * for free.
 *
 * Cost control: runs every Nth frame (default 2), and the mask is blended with
 * the previous one so edges don't flicker between runs.
 */

const MP_VERSION = '1.2.3'; // keep in sync with tracking.ts / package.json
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MODELS = [
  // landscape model: 256×144, matches the 16:9 stage
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite',
  // fallback: square 256×256 model
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
];

// ---- Look knobs (URL: ?bg=0.9&me=0.25&segEvery=3) --------------------------
const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const BG_DIM = num('bg', 0.86);       // background darkness (0..1)
const ME_DIM = num('me', 0.3);        // darkness on you (0 = untouched)
const SEG_EVERY = Math.max(1, num('segEvery', 2)); // run on every Nth camera frame
export const FALLBACK_DIM = 0.55;     // uniform dim when segmentation is off/unavailable
const TINT = [4, 2, 12];              // overlay colour: near-black with a hint of violet
// --------------------------------------------------------------------------------

export class BackgroundDimmer {
  enabled = true;
  ready = false;
  ms = 0;                  // smoothed segmentation time per run
  private seg: ImageSegmenter | null = null;
  private frame = 0;
  private soft: Float32Array | null = null; // temporally smoothed mask
  private canvas = document.createElement('canvas');
  private c2d = this.canvas.getContext('2d')!;
  private img: ImageData | null = null;

  async init() {
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    for (const model of MODELS) {
      for (const delegate of ['GPU', 'CPU'] as const) {
        try {
          this.seg = await ImageSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: model, delegate },
            runningMode: 'VIDEO',
            outputConfidenceMasks: true,
            outputCategoryMask: false,
          });
          this.ready = true;
          return;
        } catch (e) {
          console.warn('segmenter failed:', model, delegate, e);
        }
      }
    }
    throw new Error('No segmentation model could be loaded');
  }

  /** Call once per camera frame; actually runs every SEG_EVERY frames */
  update(video: HTMLVideoElement, ts: number) {
    if (!this.ready || !this.enabled || this.frame++ % SEG_EVERY) return;
    const t0 = performance.now();
    this.seg!.segmentForVideo(video, ts, (res) => {
      const mask = res.confidenceMasks?.[0];
      if (!mask) return;
      const d = mask.getAsFloat32Array(); // only valid inside this callback
      const w = mask.width, h = mask.height;

      if (!this.soft || this.soft.length !== d.length) {
        this.soft = new Float32Array(d);
        this.canvas.width = w;
        this.canvas.height = h;
        this.img = this.c2d.createImageData(w, h);
      } else {
        // blend with last mask: steadier edges
        for (let i = 0; i < d.length; i++) this.soft[i] = this.soft[i] * 0.35 + d[i] * 0.65;
      }

      const px = this.img!.data;
      const s = this.soft;
      for (let i = 0; i < s.length; i++) {
        // smoothstep sharpens the uncertain middle a little
        const c = Math.min(1, Math.max(0, (s[i] - 0.25) / 0.5));
        const person = c * c * (3 - 2 * c);
        const k = i * 4;
        px[k] = TINT[0];
        px[k + 1] = TINT[1];
        px[k + 2] = TINT[2];
        px[k + 3] = 255 * (BG_DIM + (ME_DIM - BG_DIM) * person);
      }
      this.c2d.putImageData(this.img!, 0, 0);
    });
    this.ms = this.ms * 0.9 + (performance.now() - t0) * 0.1;
  }

  /** Draw the dim layer over the (already drawn, mirrored) video */
  draw(ctx: CanvasRenderingContext2D, fit: CoverFit) {
    if (!this.enabled || !this.img) {
      ctx.fillStyle = `rgba(${TINT.join(',')}, ${FALLBACK_DIM})`;
      ctx.fillRect(0, 0, fit.W, fit.H);
      return;
    }
    // the mask is in raw camera space: same mirror + cover-fit as the video
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(fit.W, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(this.canvas, fit.ox, fit.oy, fit.dw, fit.dh);
    ctx.restore();
  }
}
