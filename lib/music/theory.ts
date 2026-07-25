/**
 * Minimal music theory helpers.
 *
 * Everything here is pure and allocation-light: `noteToFreq` sits on the hot
 * path (it runs inside the vision callback, once per triggered hit), so it must
 * never allocate or throw.
 */

export const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
] as const;

const PITCH_CLASS: Record<string, number> = {
  c: 0,
  "c#": 1,
  db: 1,
  d: 2,
  "d#": 3,
  eb: 3,
  e: 4,
  fb: 4,
  "e#": 5,
  f: 5,
  "f#": 6,
  gb: 6,
  g: 7,
  "g#": 8,
  ab: 8,
  a: 9,
  "a#": 10,
  bb: 10,
  b: 11,
  cb: 11,
};

/** Semitone offsets from the tonic, one entry per scale degree. */
export const SCALES: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  melodicMinor: [0, 2, 3, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  majorPentatonic: [0, 2, 4, 7, 9],
  minorPentatonic: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

export type ScaleName = keyof typeof SCALES;

/** Chord quality -> semitone offsets from the chord root. */
export const CHORDS: Record<string, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dom7: [0, 4, 7, 10],
  min7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
  maj9: [0, 4, 7, 11, 14],
  min9: [0, 3, 7, 10, 14],
  add9: [0, 4, 7, 14],
  power: [0, 7],
};

const NOTE_RE = /^([A-Ga-g])([#b]?)(-?\d+)$/;

/**
 * Parse scientific pitch notation ("C4", "F#3", "Bb-1") to a MIDI note number.
 * Returns `null` for anything unparseable so callers can fall back rather than
 * throwing on the audio path.
 */
export function noteToMidi(note: string): number | null {
  const m = NOTE_RE.exec(note.trim());
  if (!m) return null;
  const pc = PITCH_CLASS[(m[1] + m[2]).toLowerCase()];
  if (pc === undefined) return null;
  const octave = Number.parseInt(m[3], 10);
  // MIDI 60 === C4 (Scientific Pitch Notation / Yamaha convention).
  return (octave + 1) * 12 + pc;
}

export function midiToNote(midi: number): string {
  const rounded = Math.round(midi);
  const pc = ((rounded % 12) + 12) % 12;
  const octave = Math.floor(rounded / 12) - 1;
  return `${NOTE_NAMES[pc]}${octave}`;
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Hot path. Falls back to A4 rather than throwing if the name is malformed. */
export function noteToFreq(note: string): number {
  const midi = noteToMidi(note);
  return midi === null ? 440 : midiToFreq(midi);
}

/**
 * Build an ascending run of notes in a scale.
 *
 * @param root   tonic name, e.g. "C" or "F#"
 * @param scale  key of SCALES
 * @param octave starting octave
 * @param count  how many notes to emit (wraps into higher octaves)
 */
export function buildScale(
  root: string,
  scale: string,
  octave: number,
  count: number,
): string[] {
  const steps = SCALES[scale] ?? SCALES.minor;
  const rootMidi = noteToMidi(`${root}${octave}`) ?? 60;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const degree = i % steps.length;
    const octaveShift = Math.floor(i / steps.length) * 12;
    out.push(midiToNote(rootMidi + steps[degree] + octaveShift));
  }
  return out;
}

/** Expand a chord symbol ("Am", "F#maj7", "Gsus4") into note names. */
export function chordNotes(symbol: string, octave = 3): string[] {
  const m = /^([A-Ga-g][#b]?)(.*)$/.exec(symbol.trim());
  if (!m) return [];
  const [, rootName, rawQuality] = m;
  const quality = normalizeQuality(rawQuality);
  const rootMidi = noteToMidi(`${rootName}${octave}`);
  if (rootMidi === null) return [];
  const intervals = CHORDS[quality] ?? CHORDS.maj;
  return intervals.map((i) => midiToNote(rootMidi + i));
}

function normalizeQuality(raw: string): string {
  const q = raw.trim().toLowerCase();
  if (q === "" || q === "maj" || q === "major" || q === "M") return "maj";
  if (q === "m" || q === "min" || q === "minor" || q === "-") return "min";
  if (q === "7") return "dom7";
  if (q === "m7" || q === "min7" || q === "-7") return "min7";
  if (q === "maj7" || q === "M7" || q === "Δ") return "maj7";
  if (q === "m9" || q === "min9") return "min9";
  if (q === "5") return "power";
  if (q === "°" || q === "dim") return "dim";
  if (q === "ø" || q === "m7b5") return "min7b5";
  return CHORDS[q] ? q : "maj";
}

/** Snap an arbitrary MIDI number to the nearest in-scale pitch. */
export function quantizeToScale(
  midi: number,
  root: string,
  scale: string,
): number {
  const steps = SCALES[scale] ?? SCALES.minor;
  const rootPc = noteToMidi(`${root}0`);
  if (rootPc === null) return Math.round(midi);
  const base = rootPc % 12;
  const rounded = Math.round(midi);
  for (let d = 0; d <= 6; d++) {
    for (const dir of d === 0 ? [0] : [-d, d]) {
      const candidate = rounded + dir;
      const pc = (((candidate - base) % 12) + 12) % 12;
      if (steps.includes(pc)) return candidate;
    }
  }
  return rounded;
}

/** Seconds per beat at a given tempo. */
export function beatDuration(bpm: number): number {
  return 60 / Math.max(1, bpm);
}
