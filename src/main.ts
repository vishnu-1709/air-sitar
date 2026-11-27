import './style.css';
import { HandLandmarker } from '@mediapipe/tasks-vision';
import { createHandTracker, type Delegate } from './tracking';
import { coverFit, toStage, type CoverFit } from './coords';
import { HandSet, PINCH_ENTER, PINCH_EXIT, type Hand, type Pt } from './hands';

const startEl  = document.getElementById('start')!;
const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
const msg      = document.getElementById('msg')!;
const video    = document.getElementById('cam') as HTMLVideoElement;
const canvas   = document.getElementById('view') as HTMLCanvasElement;
const ctx      = canvas.getContext('2d')!;
const debug    = document.getElementById('debug')!;

let audioCtx: AudioContext | null = null;
let landmarker: HandLandmarker | null = null;
let delegate: Delegate = 'GPU';

// Start downloading the hand model immediately, so the tap feels fast
const trackerReady = createHandTracker().then((t) => {
  landmarker = t.landmarker;
  delegate = t.delegate;
});
trackerReady.catch(() => {}); // error is shown on tap instead

startBtn.addEventListener('click', async () => {
  msg.textContent = '';
  if (!window.isSecureContext) {
    msg.textContent = 'Needs HTTPS (or localhost).';
    return;
  }
  startBtn.disabled = true;

  // --- Audio: create + resume synchronously inside the tap (iOS rule) ---
  const nav = navigator as Navigator & { audioSession?: { type: string } };
  if (nav.audioSession) nav.audioSession.type = 'playback';
  audioCtx = new AudioContext({ latencyHint: 'interactive' });
  const resumed = audioCtx.resume();
  blip(audioCtx);

  // --- Camera ---
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    await resumed;
  } catch (err) {
    startBtn.disabled = false;
    msg.textContent = cameraError(err);
    return;
  }

  // --- Hand model ---
  try {
    msg.textContent = 'Loading hand model…';
    await trackerReady;
  } catch (err) {
    startBtn.disabled = false;
    msg.textContent = 'Could not load hand model. Check your connection and reload.';
    console.error(err);
    return;
  }

  startEl.classList.add('hidden');
  startLoop();
});

// ---------------------------------------------------------------------------
// Main loop: one hand-tracking pass per new camera frame
// ---------------------------------------------------------------------------

const handSet = new HandSet();
let hands: Hand[] = [];   // smoothed, stage-normalized, mirrored
let rawHands: Pt[][] = []; // unsmoothed, for the comparison overlay
let frames = 0;
let fps = 0;
let detectMs = 0;
let fpsT0 = performance.now();

function startLoop() {
  const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  let lastVideoTime = -1;

  const step = () => {
    // rAF fallback: skip if the camera hasn't produced a new frame yet
    if (!hasRVFC) {
      if (video.currentTime === lastVideoTime) { schedule(); return; }
      lastVideoTime = video.currentTime;
    }
    frame();
    schedule();
  };
  const schedule = () =>
    hasRVFC ? video.requestVideoFrameCallback(step) : requestAnimationFrame(step);

  schedule();
}

function frame() {
  const fit = resizeCanvas();
  if (!fit) return;

  // 1. Track
  const t0 = performance.now();
  const result = landmarker!.detectForVideo(video, t0);
  detectMs = detectMs * 0.9 + (performance.now() - t0) * 0.1; // smoothed
  const dets = result.landmarks.map((lms, i) => ({
    pts: lms.map((p) => toStage(fit, p.x, p.y)),
    world: result.worldLandmarks[i],
  }));
  rawHands = dets.map((d) => d.pts);
  hands = handSet.update(dets, t0, fit.W / fit.H);

  // 2. Draw
  drawVideo(fit);
  drawHands(fit);

  // 3. Stats
  frames++;
  const now = performance.now();
  if (now - fpsT0 >= 500) {
    fps = (frames * 1000) / (now - fpsT0);
    frames = 0;
    fpsT0 = now;
    updateDebug();
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Keep the canvas backing store matched to its on-screen size × devicePixelRatio */
function resizeCanvas(): CoverFit | null {
  const dpr = Math.min(window.devicePixelRatio || 1, 2); // cap at 2 for performance
  const W = Math.round(canvas.clientWidth * dpr);
  const H = Math.round(canvas.clientHeight * dpr);
  if (!W || !H || !video.videoWidth) return null;
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  return coverFit(video.videoWidth, video.videoHeight, W, H);
}

function drawVideo(fit: CoverFit) {
  ctx.save();
  ctx.translate(fit.W, 0);
  ctx.scale(-1, 1); // mirror
  ctx.drawImage(video, fit.ox, fit.oy, fit.dw, fit.dh);
  ctx.restore();
}

// Press "r" on the laptop to overlay the raw (unsmoothed) points in red
let showRaw = false;
window.addEventListener('keydown', (e) => { if (e.key === 'r') showRaw = !showRaw; });

const BONES = HandLandmarker.HAND_CONNECTIONS;

function drawHands(fit: CoverFit) {
  const s = fit.H / 720; // scale sizes with resolution

  if (showRaw) {
    for (const pts of rawHands) drawSkeleton(pts, fit, s, 'rgba(255,80,80,0.8)');
  }

  for (const h of hands) {
    drawSkeleton(h.pts, fit, s, '#fff');

    // debug: ring at the grab point while pinching
    if (h.pinching) {
      ctx.strokeStyle = '#ffb347';
      ctx.lineWidth = 2 * s;
      ctx.beginPath();
      ctx.arc(h.pinchPoint.x * fit.W, h.pinchPoint.y * fit.H, 12 * s, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/** Thin white bones + small joint dots, with a faint dark edge so they read on bright backgrounds */
function drawSkeleton(pts: Pt[], fit: CoverFit, s: number, color: string) {
  ctx.lineCap = 'round';
  const bones = () => {
    ctx.beginPath();
    for (const { start, end } of BONES) {
      ctx.moveTo(pts[start].x * fit.W, pts[start].y * fit.H);
      ctx.lineTo(pts[end].x * fit.W, pts[end].y * fit.H);
    }
    ctx.stroke();
  };
  // dark edge, then white on top
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 3.5 * s;
  bones();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5 * s;
  bones();

  for (const p of pts) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    dot(p.x * fit.W, p.y * fit.H, 4 * s);
    ctx.fillStyle = color;
    dot(p.x * fit.W, p.y * fit.H, 2.8 * s);
  }
}

function dot(x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function updateDebug() {
  const a = audioCtx!;
  debug.textContent = [
    `pinch: enter < ${PINCH_ENTER}, exit > ${PINCH_EXIT}`,
    `fps: ${fps.toFixed(0)}   detect: ${detectMs.toFixed(1)} ms (${delegate})`,
    ...hands.map((h) =>
      `hand ${h.id}: ratio ${h.pinchRatio.toFixed(2)} ${h.pinching ? 'PINCH' : ''}`),
    `camera: ${video.videoWidth}x${video.videoHeight}`,
    `audio: ${a.state}, ${a.sampleRate} Hz, base ${(a.baseLatency * 1000).toFixed(1)} ms`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function blip(a: AudioContext) {
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.frequency.value = 261.63; // Sa (C4)
  const t = a.currentTime;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
  osc.connect(gain).connect(a.destination);
  osc.start(t);
  osc.stop(t + 0.45);
}

function cameraError(err: unknown): string {
  const name = (err as DOMException)?.name;
  if (name === 'NotAllowedError')  return 'Camera blocked. Allow it in settings and reload.';
  if (name === 'NotFoundError')    return 'No camera found.';
  if (name === 'NotReadableError') return 'Camera is busy in another app.';
  return `Camera error: ${name ?? String(err)}`;
}
