/**
 * Scales (thaats/ragas) and note snapping.
 * Pitch is handled as MIDI note numbers (semitones): 60 = C4, +12 = one octave up.
 */

/** Sa (tonic). 48 = C3. Change to shift the whole instrument's key. */
export const SA_MIDI = 48;

export interface Scale {
  name: string;
  steps: number[];     // semitones above Sa within one octave
  labels: string[];    // swara names, same order
}

// Komal (flat) swaras written lowercase-k, tivra (sharp) Ma as "Ma'"-style "Ma(t)"
export const SCALES: Scale[] = [
  { name: 'Bilawal', steps: [0, 2, 4, 5, 7, 9, 11], labels: ['Sa', 'Re', 'Ga', 'Ma', 'Pa', 'Dha', 'Ni'] },
  { name: 'Yaman',   steps: [0, 2, 4, 6, 7, 9, 11], labels: ['Sa', 'Re', 'Ga', 'Ma(t)', 'Pa', 'Dha', 'Ni'] },
  { name: 'Kafi',    steps: [0, 2, 3, 5, 7, 9, 10], labels: ['Sa', 'Re', 'Ga(k)', 'Ma', 'Pa', 'Dha', 'Ni(k)'] },
  { name: 'Bhairav', steps: [0, 1, 4, 5, 7, 8, 11], labels: ['Sa', 'Re(k)', 'Ga', 'Ma', 'Pa', 'Dha(k)', 'Ni'] },
  { name: 'Bhupali', steps: [0, 2, 4, 7, 9],        labels: ['Sa', 'Re', 'Ga', 'Pa', 'Dha'] },
];

export const midiToFreq = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export const freqToMidi = (f: number) => 69 + 12 * Math.log2(f / 440);

/** Nearest note of the scale to a (fractional) MIDI pitch */
export function nearestInScale(p: number, scale: Scale): number {
  const rel = p - SA_MIDI;
  const oct = Math.floor(rel / 12);
  let best = SA_MIDI, bestD = Infinity;
  for (let o = oct - 1; o <= oct + 1; o++) {
    for (const st of [...scale.steps, 12]) {
      const m = SA_MIDI + o * 12 + st;
      const d = Math.abs(m - p);
      if (d < bestD) { bestD = d; best = m; }
    }
  }
  return best;
}

/**
 * Snap with hysteresis: keep the current note unless the raw pitch is clearly
 * closer to a different one. Stops a string at a note boundary from flickering
 * between two notes because of hand jitter.
 */
export function snapWithHysteresis(p: number, current: number | undefined, scale: Scale, margin = 0.2): number {
  const n = nearestInScale(p, scale);
  if (current === undefined || n === current) return n;
  if (!scaleHas(scale, current)) return n; // scale changed
  return Math.abs(p - n) + margin < Math.abs(p - current) ? n : current;
}

function scaleHas(scale: Scale, m: number): boolean {
  const st = (((m - SA_MIDI) % 12) + 12) % 12;
  return scale.steps.includes(st);
}

/**
 * Swara name for a MIDI note in this scale, with octave marks (Bhatkhande style
 * in plain text): lower octave ".Sa", middle "Sa", upper "Sa'".
 * Notes outside the scale (glide mode) get the nearest name with a ~.
 */
export function swaraName(m: number, scale: Scale): string {
  const r = Math.round(m);
  const rel = r - SA_MIDI;
  const oct = Math.floor(rel / 12);
  const st = ((rel % 12) + 12) % 12;
  let i = scale.steps.indexOf(st);
  let approx = '';
  if (i < 0) {
    // nearest scale step
    let bd = Infinity;
    scale.steps.forEach((s, j) => { const d = Math.abs(s - st); if (d < bd) { bd = d; i = j; } });
    approx = '~';
  }
  const base = scale.labels[i];
  // instrument range is centred so octave 1 (C4 upward) reads as "middle"
  const mark = oct <= 0 ? '.' : oct >= 2 ? "'" : '';
  return mark === '.' ? `${approx}.${base}` : `${approx}${base}${mark}`;
}
