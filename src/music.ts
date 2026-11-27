/**
 * Scales and note snapping. Pitch is handled as MIDI note numbers (semitones):
 * 60 = C4, +12 = one octave up.
 *
 * Two kinds of scale:
 *  - pattern: a root + interval list, repeating in every octave (normal scales)
 *  - song:    an exact list of allowed notes, nothing else (one octave, fixed)
 */

// ---- Config ------------------------------------------------------------------
/** Song mode: the ONLY notes snap mode allows. Edit this list to change songs. */
export const SONG_NOTES = ['A3', 'B3', 'C4', 'D4', 'E4'];

/**
 * true:  the song notes are spread evenly over the whole string-length range
 *        (longest string = first note, shortest = last), so every length is playable.
 * false: strict physics — a note only plays at the exact length for its pitch
 *        (A3–E4 would then only cover a narrow band of short strings).
 */
export const SONG_SPREAD = true;

/** Which scale is selected at start (index into SCALES) */
export const DEFAULT_SCALE = 0;
// --------------------------------------------------------------------------------

// (defined before SCALES: SCALES uses them at load time)
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS: Record<string, string> = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' };

export type Scale =
  | { name: string; kind: 'pattern'; root: string; intervals: number[] }
  | { name: string; kind: 'song'; notes: number[] };

export const SCALES: Scale[] = [
  { name: 'Minor pentatonic', kind: 'pattern', root: 'C', intervals: [0, 3, 5, 7, 10] },
  { name: 'A natural minor', kind: 'pattern', root: 'A', intervals: [0, 2, 3, 5, 7, 8, 10] },
  { name: 'Song mode', kind: 'song', notes: SONG_NOTES.map(noteToMidi) },
];

export const midiToFreq = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export const freqToMidi = (f: number) => 69 + 12 * Math.log2(f / 440);

/** "A3" → 57, "C#4" → 61, "Bb3" → 58  (C4 = 60, middle C) */
export function noteToMidi(name: string): number {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(name.trim());
  if (!m) throw new Error(`Bad note name: ${name}`);
  let letter = m[1].toUpperCase() + m[2];
  letter = FLATS[letter] ?? letter;
  const pc = NOTE_NAMES.indexOf(letter);
  if (pc < 0) throw new Error(`Bad note name: ${name}`);
  return 12 * (Number(m[3]) + 1) + pc;
}

export function inScale(m: number, scale: Scale): boolean {
  if (scale.kind === 'song') return scale.notes.includes(m);
  const root = NOTE_NAMES.indexOf(scale.root);
  const pc = (((m - root) % 12) + 12) % 12;
  return scale.intervals.includes(pc);
}

// Song spread: raw pitch range C2…C5 (the full length range) mapped onto note slots
const SPREAD_LO = 36, SPREAD_HI = 72;

/** Song mode (spread): where note i "sits" on the raw pitch scale. Used for fret ticks too. */
export function songSlotPitch(i: number, n: number): number {
  return n <= 1 ? (SPREAD_LO + SPREAD_HI) / 2 : SPREAD_LO + ((SPREAD_HI - SPREAD_LO) * i) / (n - 1);
}

/** Raw pitch → fractional slot index 0…n-1 */
function songSlot(p: number, n: number): number {
  const t = Math.min(1, Math.max(0, (p - SPREAD_LO) / (SPREAD_HI - SPREAD_LO)));
  return t * (n - 1);
}

/** Nearest allowed note to a (fractional) MIDI pitch */
export function nearestInScale(p: number, scale: Scale): number {
  if (scale.kind === 'song' && SONG_SPREAD) {
    const sorted = [...scale.notes].sort((a, b) => a - b);
    return sorted[Math.round(songSlot(p, sorted.length))];
  }
  if (scale.kind === 'song') {
    // only these exact notes: a very long string → lowest, very short → highest
    let best = scale.notes[0];
    for (const n of scale.notes) if (Math.abs(n - p) < Math.abs(best - p)) best = n;
    return best;
  }
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
  if (scale.kind === 'song' && SONG_SPREAD) {
    // same idea, measured in note slots instead of semitones
    const sorted = [...scale.notes].sort((a, b) => a - b);
    const q = songSlot(p, sorted.length);
    const ni = Math.round(q);
    const ci = current === undefined ? -1 : sorted.indexOf(current);
    if (ci < 0 || ni === ci) return sorted[ni];
    return Math.abs(q - ni) + margin < Math.abs(q - ci) ? sorted[ni] : sorted[ci];
  }
  const n = nearestInScale(p, scale);
  if (current === undefined || n === current || !inScale(current, scale)) return n;
  return Math.abs(p - n) + margin < Math.abs(p - current) ? n : current;
}

/** Letter name, e.g. "D#". Fractional pitches (glide mode) round to the nearest semitone. */
export function noteName(m: number): string {
  return NOTE_NAMES[((Math.round(m) % 12) + 12) % 12];
}
