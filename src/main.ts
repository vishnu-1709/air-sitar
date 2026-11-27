import './style.css';
import { HandLandmarker } from '@mediapipe/tasks-vision';
import { createHandTracker, LM, type Delegate } from './tracking';
import { coverFit, toStage, type CoverFit } from './coords';
import { HandSet, PINCH_ENTER, PINCH_EXIT, SMOOTH_BETA, SMOOTH_MIN_CUTOFF, type Hand, type Pt } from './hands';
import { StringField, MAX_STRINGS, type Str } from './strings';
import { Plucker } from './pluck';
import { Synth, freqForLength, K } from './audio';
import { FX } from './fx';
import { LaserFX, FLAGS, degreeColor, type Flag, type View } from './visuals';
import { Groove } from './groove';
import { SCALES, DEFAULT_SCALE, SONG_SPREAD, songSlotPitch, freqToMidi, midiToFreq, snapWithHysteresis, nearestInScale, noteName, inScale, degreeOf } from './music';

const startEl  = document.getElementById('start')!;
const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
const msg      = document.getElementById('msg')!;
const video    = document.getElementById('cam') as HTMLVideoElement;
const canvas   = document.getElementById('view') as HTMLCanvasElement;
const ctx      = canvas.getContext('2d')!;
// Offscreen layers. Everything is composited into the one visible canvas (#view),
// so what you see is exactly what the recorder captures.
const fxCanvas = document.createElement('canvas');   // lasers, sharp, transparent
const fctx     = fxCanvas.getContext('2d')!;
// Bloom chain: the laser layer halved 3 times (½, ¼, ⅛). Each halving averages
// 2×2 pixels, so the small copies are a proper blur; scaled back up they glow.
const bloom = [2, 4, 8].map(() => {
  const c = document.createElement('canvas');
  return { c, x: c.getContext('2d')! };
});
const BLOOM_TIGHT = 0.55; // ¼-res copy: soft halo close to the beam
const BLOOM_WIDE = 0.7;   // ⅛-res copy: wide glow
const debug    = document.getElementById('debug')!;

let audioCtx: AudioContext | null = null;
let synth: Synth | null = null;
let groove: Groove | null = null;
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
  // synth → effects → speakers; beat → effects' dry path
  const fx = new FX(audioCtx);
  fx.output.connect(audioCtx.destination);
  synth = new Synth(audioCtx, fx.input);
  groove = new Groove(audioCtx, fx.dry);
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

  // --- String synth (AudioWorklet) ---
  try {
    await synth.init();
  } catch (err) {
    startBtn.disabled = false;
    msg.textContent = 'Audio engine failed to load.';
    console.error(err);
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
  controls.classList.remove('hidden');
  startLoop();
});

// ---------------------------------------------------------------------------
// Main loop: one hand-tracking pass per new camera frame
// ---------------------------------------------------------------------------

const handSet = new HandSet();
let hands: Hand[] = [];   // smoothed, stage-normalized, mirrored
let rawHands: Pt[][] = []; // unsmoothed, for the comparison overlay
const field = new StringField();
const plucker = new Plucker();
const laser = new LaserFX();
let lastFrameT = performance.now();
let lastPluckInfo = '';
let pluckCount = 0;

// --- Pitch mode & scale -----------------------------------------------------
// snap:  every string sits exactly on a note of the scale; dragging steps
//        note-to-note with a quick slide (like frets) → melodies are playable
// glide: pitch follows length continuously → free meend between any pitches
let mode: 'snap' | 'glide' = 'snap';
let scaleIdx = DEFAULT_SCALE;
const notes = new Map<number, number>();   // string id → current pitch (MIDI, fractional in glide)

const controls = document.getElementById('controls')!;
const modeBtn  = document.getElementById('modeBtn') as HTMLButtonElement;
const scaleSel = document.getElementById('scaleSel') as HTMLSelectElement;
const beatBtn  = document.getElementById('beatBtn') as HTMLButtonElement;
beatBtn.onclick = () => {
  groove?.toggle();
  beatBtn.textContent = groove?.playing ? 'Beat ■' : 'Beat ▶';
};
modeBtn.onclick = () => {
  mode = mode === 'snap' ? 'glide' : 'snap';
  modeBtn.textContent = mode === 'snap' ? 'Snap' : 'Glide';
};
// scale picker: filled from SCALES so new scales show up automatically
SCALES.forEach((sc, i) => scaleSel.add(new Option(sc.name, String(i), i === scaleIdx, i === scaleIdx)));
scaleSel.onchange = () => { scaleIdx = Number(scaleSel.value); };

/** Colour of a note = its scale degree in the active scale (updates live as the note changes) */
function noteColour(m: number): string {
  const { i, n } = degreeOf(m, SCALES[scaleIdx]);
  return degreeColor(i, n);
}

function pitchFor(str: Str): number {
  const raw = freqToMidi(freqForLength(field.length(str)));
  const m = mode === 'snap' ? snapWithHysteresis(raw, notes.get(str.id), SCALES[scaleIdx]) : raw;
  notes.set(str.id, m);
  return m;
}
let frames = 0;        // tracking frames (camera rate, ~30/s)
let fps = 0;
let rframes = 0;       // render frames (display rate, ~60/s)
let rfps = 0;
let detectMs = 0;
let fpsT0 = performance.now();

/**
 * Two loops:
 *  - tracking: once per new camera frame (~30/s): hands, strings, plucks, sound
 *  - rendering: once per display frame (~60/s): everything you see
 * so animations (dashes, pulses, sparks) stay smooth even though the camera is slower.
 */
function startLoop() {
  const render = () => { draw(); requestAnimationFrame(render); };
  requestAnimationFrame(render);

  const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  let lastVideoTime = -1;

  const step = () => {
    // rAF fallback: skip if the camera hasn't produced a new frame yet
    if (!hasRVFC) {
      if (video.currentTime === lastVideoTime) { schedule(); return; }
      lastVideoTime = video.currentTime;
    }
    track();
    schedule();
  };
  const schedule = () =>
    hasRVFC ? video.requestVideoFrameCallback(step) : requestAnimationFrame(step);

  schedule();
}

function track() {
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
  const holding = new Set(hands.filter((h) => field.isBusy(h.id)).map((h) => h.id));
  hands = handSet.update(dets, t0, fit.W / fit.H, holding);
  field.update(hands, fit.W / fit.H, t0);

  // Every string's voice follows its current length (snapped or continuous)
  const pitches = new Map(field.strings.map((str) => [str.id, pitchFor(str)]));
  for (const id of notes.keys()) if (!pitches.has(id)) notes.delete(id);
  synth?.sync(field.strings.map((str) => ({ id: str.id, freq: midiToFreq(pitches.get(str.id)!) })));

  // Plucks → sound
  for (const ev of plucker.update(hands, field.strings, (id) => field.isBusy(id), t0, fit.W / fit.H)) {
    const m = pitches.get(ev.str.id)!;
    const freq = midiToFreq(m);
    const name = noteName(m);
    const velocity = Math.min(1, (ev.speed - 0.15) / 2.5);
    synth?.pluck(ev.str.id, freq, velocity, ev.pos);
    const sa = ev.str.a, sb = ev.str.b;
    const dl = Math.hypot(sb.x - sa.x, sb.y - sa.y) || 1;
    const bass = Math.min(1, Math.max(0, (60 - m) / 24));
    laser.pluck(ev.str.id, ev.pos, ev.at, { x: (sb.x - sa.x) / dl, y: (sb.y - sa.y) / dl },
      velocity, bass, noteColour(m), t0);
    pluckCount++;
    lastPluckInfo = `pluck #${pluckCount}: ${name} ${freq.toFixed(0)} Hz  pos ${ev.pos.toFixed(2)}  speed ${ev.speed.toFixed(2)}  vel ${velocity.toFixed(2)}`;
  }

  frames++;
}

function draw() {
  const fit = resizeCanvas();
  if (!fit) return;
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastFrameT) / 1000);
  lastFrameT = now;

  // bottom layer: camera + hands
  drawVideo(fit);
  drawHands(fit);

  // laser layer (offscreen, transparent)
  fctx.clearRect(0, 0, fit.W, fit.H);
  laser.forget(new Set(field.strings.map((x) => x.id)));
  drawStrings(fit, now, dt);
  laser.drawParticles(fctx, view(fit), now, dt);

  // bloom: downsample chain
  if (FLAGS.bloom) {
    let src: HTMLCanvasElement = fxCanvas;
    for (const b of bloom) {
      b.x.clearRect(0, 0, b.c.width, b.c.height);
      b.x.drawImage(src, 0, 0, b.c.width, b.c.height);
      src = b.c;
    }
  }

  // composite lasers + bloom over the camera with 'screen' (light adds, dark does nothing)
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(fxCanvas, 0, 0);
  if (FLAGS.bloom) {
    ctx.globalAlpha = BLOOM_TIGHT;
    ctx.drawImage(bloom[1].c, 0, 0, fit.W, fit.H);
    ctx.globalAlpha = BLOOM_WIDE;
    ctx.drawImage(bloom[2].c, 0, 0, fit.W, fit.H);
  }
  ctx.restore();

  rframes++;
  if (now - fpsT0 >= 500) {
    fps = (frames * 1000) / (now - fpsT0);
    rfps = (rframes * 1000) / (now - fpsT0);
    frames = rframes = 0;
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
    canvas.width = fxCanvas.width = W;
    canvas.height = fxCanvas.height = H;
    [2, 4, 8].forEach((d, i) => {
      bloom[i].c.width = Math.max(1, Math.round(W / d));
      bloom[i].c.height = Math.max(1, Math.round(H / d));
    });
  }
  return coverFit(video.videoWidth, video.videoHeight, W, H);
}

function drawVideo(fit: CoverFit) {
  ctx.save();
  ctx.translate(fit.W, 0);
  ctx.scale(-1, 1); // mirror
  ctx.drawImage(video, fit.ox, fit.oy, fit.dw, fit.dh);
  ctx.restore();
  // darken the camera so the lasers pop (Phase 10: segmentation keeps you brighter than the room)
  ctx.fillStyle = `rgba(4, 2, 12, ${CAMERA_DIM})`;
  ctx.fillRect(0, 0, fit.W, fit.H);
}

const CAMERA_DIM = 0.55;
const view = (fit: CoverFit): View => ({ W: fit.W, H: fit.H, s: fit.H / 720 });

// Press "r" on the laptop to overlay the raw (unsmoothed) points in red
let showRaw = false;
window.addEventListener('keydown', (e) => { if (e.key === 'r') showRaw = !showRaw; });

const BONES = HandLandmarker.HAND_CONNECTIONS;

const RED = '255, 60, 70';

// Fret ticks: the string length at which each semitone C2…C5 would sound (f = K / L)
const FRET_MIDI = Array.from({ length: 37 }, (_, i) => 36 + i);
const FRET_LEN = FRET_MIDI.map((m) => K / midiToFreq(m));

function drawStrings(fit: CoverFit, now: number, dt: number) {
  const v = view(fit);
  const aspect = fit.W / fit.H;
  const scale = SCALES[scaleIdx];
  let frets = FRET_LEN;
  let scaleFret = FRET_MIDI.map((m) => inScale(m, scale));
  if (scale.kind === 'song' && SONG_SPREAD) {
    // song notes sit at evenly spread positions, not their physical pitch lengths:
    // show one tick per song note, and ticks halfway between (where it switches)
    const n = scale.notes.length;
    frets = []; scaleFret = [];
    for (let i = 0; i < n; i++) {
      frets.push(K / midiToFreq(songSlotPitch(i, n)));
      scaleFret.push(true);
    }
  }
  for (const str of field.strings) {
    const doomed = field.isHeld(str) && field.shouldDelete(str); // release now = delete
    const m = notes.get(str.id) ?? 48;
    const held = field.heldEnd(str);
    laser.drawString(fctx, v, {
      id: str.id, a: str.a, b: str.b, midi: m, rgb: noteColour(m),
      len: field.length(str),
      anchor: held === 'a' ? 'b' : 'a',   // ticks measured from the end you're NOT moving
      frets, scaleFret, doomed,
    }, now, dt);
    const col = noteColour(m);
    laser.drawEmitter(fctx, v, str.a, m, col, field.endpointState(str, 'a', hands), now, str.id, doomed);
    laser.drawEmitter(fctx, v, str.b, m, col, field.endpointState(str, 'b', hands), now, str.id, doomed);

    // note name beside the left-hand emitter, pushed outward along the string
    const [p, q] = str.a.x <= str.b.x ? [str.a, str.b] : [str.b, str.a];
    const ox = (p.x - q.x) * aspect, oy = p.y - q.y;
    const ol = Math.hypot(ox, oy) || 1;
    laser.drawLabel(fctx, v, p, { x: ox / ol, y: oy / ol }, noteName(m), str.id);
  }

  // preview while pulling a new string: dashed, in the colour of the note it will be
  const pv = field.preview;
  if (pv) {
    const raw = freqToMidi(freqForLength(Math.hypot((pv.b.x - pv.a.x) * aspect, pv.b.y - pv.a.y)));
    const m = mode === 'snap' ? nearestInScale(raw, scale) : raw; // the note it will become
    fctx.save();
    fctx.globalCompositeOperation = 'lighter';
    fctx.setLineDash([10 * v.s, 8 * v.s]);
    fctx.strokeStyle = pv.ok ? `rgba(${noteColour(m)}, 0.85)` : `rgba(${RED}, 0.6)`;
    fctx.lineWidth = 2 * v.s;
    fctx.beginPath();
    fctx.moveTo(pv.a.x * fit.W, pv.a.y * fit.H);
    fctx.lineTo(pv.b.x * fit.W, pv.b.y * fit.H);
    fctx.stroke();
    fctx.restore();
  }
}

// "c" on the laptop clears all strings (proper button comes in Phase 12)
window.addEventListener('keydown', (e) => { if (e.key === 'c') field.clear(); });

function drawHands(fit: CoverFit) {
  const s = fit.H / 720; // scale sizes with resolution

  if (showRaw) {
    for (const pts of rawHands) drawSkeleton(pts, fit, s, 'rgba(255,80,80,0.8)');
  }

  for (const h of hands) {
    drawSkeleton(h.pts, fit, s, 'rgba(255,255,255,0.55)');

    // pinch feedback: thumb + index tips light up
    if (h.pinching) {
      for (const i of [LM.THUMB_TIP, LM.INDEX_TIP]) {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        dot(h.pts[i].x * fit.W, h.pts[i].y * fit.H, 7 * s);
        ctx.fillStyle = '#7fe8ff';
        dot(h.pts[i].x * fit.W, h.pts[i].y * fit.H, 5 * s);
      }
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

// Debug box: hidden unless ?debug in the URL; "d" toggles it on the laptop
let showDebug = new URLSearchParams(location.search).has('debug');
window.addEventListener('keydown', (e) => { if (e.key === 'd') { showDebug = !showDebug; updateDebug(); } });

// Effect toggles (performance testing): checkbox panel when ?debug, or ?off=bloom,frets
const flagPanel = document.getElementById('flags')!;
function buildFlagPanel() {
  flagPanel.innerHTML = '';
  flagPanel.style.display = showDebug ? '' : 'none';
  for (const k of Object.keys(FLAGS) as Flag[]) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = FLAGS[k];
    box.onchange = () => { FLAGS[k] = box.checked; };
    label.append(box, ' ' + k);
    flagPanel.append(label);
  }
}
buildFlagPanel();
window.addEventListener('keydown', (e) => { if (e.key === 'd') buildFlagPanel(); });

function updateDebug() {
  if (!showDebug) { debug.textContent = ''; return; }
  const a = audioCtx!;
  debug.textContent = [
    `pinch: enter < ${PINCH_ENTER}, exit > ${PINCH_EXIT}   smooth: mc ${SMOOTH_MIN_CUTOFF} b ${SMOOTH_BETA}`,
    `strings: ${field.strings.length}/${MAX_STRINGS}  ${mode} · ${SCALES[scaleIdx].name}  ` +
      field.strings.map((x) => noteName(notes.get(x.id) ?? 60)).join(' '),
    lastPluckInfo,
    `render: ${rfps.toFixed(0)} fps   tracking: ${fps.toFixed(0)} fps   detect: ${detectMs.toFixed(1)} ms (${delegate})`,
    ...hands.map((h) =>
      `hand ${h.id}: ratio ${h.pinchRatio.toFixed(2)} ${h.pinching ? 'PINCH' : ''}${field.isBusy(h.id) ? ' HOLD' : ''}`),
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
