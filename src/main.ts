import './style.css';

const startEl  = document.getElementById('start')!;
const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
const msg      = document.getElementById('msg')!;
const video    = document.getElementById('cam') as HTMLVideoElement;
const debug    = document.getElementById('debug')!;

let audioCtx: AudioContext | null = null;

startBtn.addEventListener('click', async () => {
  msg.textContent = '';
  if (!window.isSecureContext) {
    msg.textContent = 'Needs HTTPS (or localhost).';
    return;
  }
  startBtn.disabled = true;

  // --- Audio: create + resume synchronously inside the tap (iOS rule) ---
  // Lets audio play even with the iPhone silent switch on (Safari 16.4+)
  const nav = navigator as Navigator & { audioSession?: { type: string } };
  if (nav.audioSession) nav.audioSession.type = 'playback';

  audioCtx = new AudioContext({ latencyHint: 'interactive' });
  const resumed = audioCtx.resume();
  blip(audioCtx); // audible proof that audio unlocked

  // --- Camera ---
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play();
    await resumed;
    startEl.classList.add('hidden');
    showDebug();
  } catch (err) {
    startBtn.disabled = false;
    msg.textContent = cameraError(err);
  }
});

function blip(ctx: AudioContext) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 261.63; // Sa (C4)
  const t = ctx.currentTime;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.45);
}

function showDebug() {
  const ctx = audioCtx!;
  debug.textContent = [
    `camera: ${video.videoWidth}x${video.videoHeight}`,
    `audio: ${ctx.state}, ${ctx.sampleRate} Hz`,
    `baseLatency: ${(ctx.baseLatency * 1000).toFixed(1)} ms`,
    `outputLatency: ${((ctx.outputLatency ?? 0) * 1000).toFixed(1)} ms`,
  ].join('\n');
}

function cameraError(err: unknown): string {
  const name = (err as DOMException)?.name;
  if (name === 'NotAllowedError')  return 'Camera blocked. Allow it in settings and reload.';
  if (name === 'NotFoundError')    return 'No camera found.';
  if (name === 'NotReadableError') return 'Camera is busy in another app.';
  return `Camera error: ${name ?? String(err)}`;
}
