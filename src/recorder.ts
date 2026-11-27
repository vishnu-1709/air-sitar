/**
 * Built-in recorder: the app canvas (video) + the app's own audio → one file.
 *
 *   canvas.captureStream(30)  ─┐
 *                              ├─► MediaStream ─► MediaRecorder ─► Blob ─► File
 *   audio out ─► MediaStreamAudioDestinationNode ─┘
 *
 * Only the canvas is captured, so the DOM controls (buttons, debug) never
 * appear in the video. Safari records MP4 (H.264 + AAC); Chrome records WebM.
 */

// Order matters: H.264 video is what phones, Photos and Instagram all accept.
// Note: in Chrome, plain 'video/mp4' means VP9 inside an MP4 box — many players
// refuse that — so Chrome is steered to H.264 explicitly.
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2', // Safari: H.264 + AAC
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E,opus',      // Chrome: H.264 + Opus in MP4
  'video/mp4;codecs=avc1,opus',
  ...(isSafari() ? ['video/mp4'] : []),     // Safari's plain mp4 = H.264 + AAC
  'video/webm;codecs=vp9,opus',             // fallbacks
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

function isSafari(): boolean {
  return /Apple/.test(navigator.vendor) && !/CriOS|FxiOS/.test(navigator.userAgent);
}

export class Recorder {
  private canvas: HTMLCanvasElement;
  private dest: MediaStreamAudioDestinationNode;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private videoTrack: MediaStreamTrack | null = null;
  readonly mime: string;
  startedAt = 0;

  constructor(canvas: HTMLCanvasElement, ctx: AudioContext, audioOut: AudioNode) {
    this.canvas = canvas;
    this.dest = ctx.createMediaStreamDestination();
    audioOut.connect(this.dest); // in parallel with the speakers, not instead of them
    this.mime = MIME_CANDIDATES.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) ?? '';
  }

  get supported() { return !!window.MediaRecorder && !!this.mime && 'captureStream' in this.canvas; }
  get recording() { return this.rec?.state === 'recording'; }

  start() {
    if (this.recording || !this.supported) return;
    const video = this.canvas.captureStream(30);
    this.videoTrack = video.getVideoTracks()[0];
    const stream = new MediaStream([this.videoTrack, ...this.dest.stream.getAudioTracks()]);
    this.chunks = [];
    this.rec = new MediaRecorder(stream, {
      mimeType: this.mime,
      videoBitsPerSecond: 8_000_000,  // plenty for 1080p-ish neon on dark
      audioBitsPerSecond: 192_000,
    });
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start(1000); // hand over data every second (safer for long takes)
    this.startedAt = performance.now();
  }

  /** Stop and return the finished file */
  stop(): Promise<File> {
    return new Promise((resolve, reject) => {
      const rec = this.rec;
      if (!rec) return reject(new Error('not recording'));
      rec.onstop = () => {
        this.videoTrack?.stop(); // stop the canvas capture (audio dest stays for next take)
        const type = this.mime.split(';')[0];
        const ext = type.includes('mp4') ? 'mp4' : 'webm';
        const blob = new Blob(this.chunks, { type });
        this.chunks = [];
        this.rec = null;
        resolve(new File([blob], `laser-strings-${stamp()}.${ext}`, { type }));
      };
      rec.stop();
    });
  }
}

/**
 * Save the video. Phones: the share sheet (→ "Save Video" puts it in Photos).
 * Must be called from a tap — iOS only allows share() during a user gesture.
 * Laptops: a normal download.
 */
export async function saveVideo(file: File): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return 'shared';
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return 'cancelled';
      // fall through to download
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
