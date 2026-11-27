/**
 * Scales and note snapping. Pitch is handled as MIDI note numbers (semitones):
 * 60 = C4, +12 = one octave up.
 */

export interface Scale {
  name: string;
  intervals: number[]; // semitones above the root within one octave
}

export const SCALES: Scale[] = [
  { name: 'Minor penta', intervals: [0, 3, 5, 7, 10] },
  { name: 'Minor', intervals: [0, 2, 3, 5, 7, 8, 10] },
];

// ---- Config: change these lines to change key / default scale -------------
export const ROOT = 'C';            // any of NOTE_NAMES
export const DEFAULT_SCALE = 0;     // index into SCALES
// ----------------------------------------------------------------------------

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const ROOT_PC = NOTE_NAMES.indexOf(ROOT); // pitch class 0..11

export const midiToFreq = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export const freqToMidi = (f: number) => 69 + 12 * Math.log2(f / 440);

function inScale(m: number, scale: Scale): boolean {
  const pc = (((m - ROOT_PC) % 12) + 12) % 12;
  return scale.intervals.includes(pc);
}

/** Nearest note of the scale to a (fractional) MIDI pitch */
export function nearestInScale(p: number, scale: Scale): number {
  const c = Math.round(p);
  for (let d = 0; d <= 12; d++) {
    // check outward from the rounded pitch, closer side first
    const cands = [c + d, c - d].sort((a, b) => Math.abs(a - p) - Math.abs(b - p));
    for (const m of cands) if (inScale(m, scale)) return m;
  }
  return c;
}

/**
 * Snap with hysteresis: keep the current note unless the raw pitch is clearly
 * closer to a different one. Stops a string at a note boundary from flickering
 * between two notes because of hand jitter.
 */
export function snapWithHysteresis(p: number, current: number | undefined, scale: Scale, margin = 0.2): number {
  const n = nearestInScale(p, scale);
  if (current === undefined || n === current || !inScale(current, scale)) return n;
  return Math.abs(p - n) + margin < Math.abs(p - current) ? n : current;
}

/** Letter name, e.g. "D#". Fractional pitches (glide mode) round to the nearest semitone. */
export function noteName(m: number): string {
  return NOTE_NAMES[((Math.round(m) % 12) + 12) % 12];
}
