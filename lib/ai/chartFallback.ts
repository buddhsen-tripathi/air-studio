import {
  MAX_SIMULTANEOUS,
  MIN_LANE_GAP_STEPS,
  PatternSpecSchema,
  STEPS_PER_BAR,
  type PatternSpec,
} from "@/lib/game/spec";
import { buildScale, chordNotes, midiToNote, noteToMidi } from "@/lib/music/theory";

/**
 * Deterministic offline chart generator.
 *
 * This runs when OPENROUTER_API_KEY is unset, and again whenever a model call
 * fails. Both players are already in the room staring at a countdown by the time
 * either happens, so this cannot be a stub — it has to produce a chart worth
 * duelling over. It writes a real four-bar diatonic progression, arpeggiates it
 * across the lower lanes, and puts a fixed melodic motif on the top lane, so the
 * composite result is music rather than a metronome.
 *
 * Everything here is pure and seeded only by the input text, which matters for a
 * networked game: the host generates the chart once and pushes it to the room,
 * but a deterministic generator means a mismatched build still produces the same
 * notes rather than two players silently playing different songs.
 */

// ------------------------------------------------------------------ rhythm

/**
 * Per-lane step indices within one bar, ordered by density.
 *
 * These are hand-tuned rather than generated because the constraint that makes
 * an air chart playable is not "how many notes" but "where they land relative to
 * each other": a lane needs recovery time (MIN_LANE_GAP_STEPS) while the
 * composite rhythm still has to read as a groove. Every level below satisfies
 * both, and the composite of levels 1-4 walks up and down the lanes so the
 * player's hands travel in one continuous motion instead of teleporting.
 *
 * Levels run 5, 8, 11, 13, 15 notes per bar. Difficulty picks a window of three.
 * The ceiling is deliberately 15 and not a solid wall of sixteenths: at the top
 * tempo that is already ~8 notes a second across the lanes, and past that the
 * limit stops being the chart and starts being the tracking latency.
 */
const DENSITY_LEVELS: readonly (readonly (readonly number[])[])[] = [
  // 0 — quarter notes, one lane at a time. Nobody fails this.
  [[0, 8], [4], [12], [6]],
  // 1 — straight eighths rolling up the lanes and back down.
  [
    [0, 8],
    [2, 10],
    [4, 12],
    [6, 14],
  ],
  // 2 — eighths displaced onto the offbeat, still one lane at a time.
  [
    [0, 8, 11],
    [2, 10, 13],
    [4, 6, 12],
    [3, 14],
  ],
  // 3 — a near-continuous sixteenth line handed between the lower three lanes,
  // with the melody left sparse on top so it stays audible.
  [
    [0, 4, 8, 12],
    [2, 6, 10, 14],
    [1, 5, 13],
    [3, 11],
  ],
  // 4 — the same, tightened, plus an octave stab on every downbeat.
  [
    [0, 4, 8, 12],
    [2, 6, 10, 14],
    [0, 5, 9, 13],
    [3, 7, 11],
  ],
];

const ROUND_LABELS = ["Warm Up", "Heat", "Sudden Death"] as const;

/** Rounds get longer as they get harder: the climax should have room to breathe. */
const ROUND_BARS = [4, 6, 8] as const;

type Difficulty = "easy" | "normal" | "hard";

const LEVELS: Record<Difficulty, readonly number[]> = {
  easy: [0, 1, 2],
  normal: [1, 2, 3],
  hard: [2, 3, 4],
};

/**
 * Tempo climbs across rounds, but far less than density does. Escalating both
 * aggressively compounds: the last round of `hard` would land notes closer
 * together than a player can physically alternate hands.
 */
const BPM_SCALES: Record<Difficulty, readonly number[]> = {
  easy: [1, 1.02, 1.05],
  normal: [1, 1.04, 1.09],
  hard: [1, 1.06, 1.12],
};

const TEMPO_TRIM: Record<Difficulty, number> = {
  easy: 0.82,
  normal: 0.92,
  hard: 1,
};

// ------------------------------------------------------------------ harmony

interface Mood {
  test: RegExp;
  name: string;
  key: string;
  /** Restricted to seven-note scales so the diatonic triads below are real. */
  scale: "major" | "minor" | "dorian";
  bpm: number;
  /** Scale degrees of the four-bar progression, one per bar, 0-indexed. */
  prog: readonly number[];
}

const MOODS: readonly Mood[] = [
  {
    test: /epic|anthem|hero|battle|boss|metal|rock|power|fight/,
    name: "Thunder Run",
    key: "E",
    scale: "minor",
    bpm: 88,
    prog: [0, 5, 2, 6], // i - VI - III - VII
  },
  {
    test: /sad|dark|moody|melancholy|night|rain|lament|minor|lonely/,
    name: "Night Duel",
    key: "D",
    scale: "minor",
    bpm: 70,
    prog: [0, 5, 3, 4], // i - VI - iv - v
  },
  {
    test: /chill|lofi|lo-fi|dream|float|study|calm|slow|ambient|sleep/,
    name: "Slow Drift",
    key: "F",
    scale: "dorian",
    bpm: 60,
    prog: [0, 3, 0, 6], // i - IV - i - VII
  },
  {
    test: /dance|club|edm|house|techno|party|disco|neon/,
    name: "Neon Sprint",
    key: "A",
    scale: "minor",
    bpm: 84,
    prog: [0, 6, 5, 4], // i - VII - VI - v
  },
  {
    test: /happy|bright|sunny|pop|summer|major|sweet|love/,
    name: "Bright Trade",
    key: "G",
    scale: "major",
    bpm: 78,
    prog: [0, 4, 5, 3], // I - V - vi - IV
  },
];

const DEFAULT_MOOD: Mood = {
  test: /(?:)/,
  name: "Air Piano Duel",
  key: "C",
  scale: "major",
  bpm: 74,
  prog: [0, 4, 5, 3],
};

/** Triad quality per scale degree. Indexes match the degrees in `Mood.prog`. */
const TRIAD_QUALITY: Record<Mood["scale"], readonly string[]> = {
  major: ["", "m", "m", "", "", "m", "dim"],
  minor: ["m", "dim", "", "m", "m", "", ""],
  dorian: ["m", "m", "", "", "m", "dim", ""],
};

/** Lane pitches: root, third, fifth, octave. Low to high, left to right. */
const LANE_DEGREES = [0, 2, 4, 7] as const;

/**
 * The top lane's hook, as indices into an ascending scale run starting on the
 * tonic above the lane's own pitch. An arch up to the fifth and a stepwise fall
 * back to the tonic — it is diatonic, so it sits over every chord in every
 * progression above without ever needing to be re-voiced.
 */
const MOTIF = [0, 2, 4, 2, 3, 1, 2, 0] as const;

// ------------------------------------------------------------------ generator

export function localChart(input: {
  song?: string;
  brief?: string;
  difficulty: Difficulty;
}): PatternSpec {
  const text = `${input.song ?? ""} ${input.brief ?? ""}`.toLowerCase();
  const mood = MOODS.find((m) => m.test.test(text)) ?? DEFAULT_MOOD;
  const { key, scale, prog } = mood;

  const bpm = clamp(Math.round(mood.bpm * TEMPO_TRIM[input.difficulty]), 40, 220);

  // Two octaves of the scale: lane pitches are picked from the bottom of it and
  // the top lane's motif runs off the top.
  const spread = buildScale(key, scale, 3, 12);
  const laneNotes = LANE_DEGREES.map((d) => spread[d]);
  const laneMidis = laneNotes.map((n) => noteToMidi(n) ?? 60);
  const motifRun = buildScale(key, scale, 4, 8);
  const topLane = laneNotes.length - 1;

  const chordsByDegree = prog.map((degree) => triadMidis(key, scale, degree));

  const rounds = ROUND_LABELS.map((label, roundIndex) => {
    const bars = ROUND_BARS[roundIndex];
    const rows = buildRows(DENSITY_LEVELS[LEVELS[input.difficulty][roundIndex]], bars);

    const melody = rows.map((row, lane) => {
      const out: string[] = [];
      let hit = 0;
      for (let step = 0; step < row.length; step++) {
        if (row[step] === REST) continue;
        const chord = chordsByDegree[Math.floor(step / STEPS_PER_BAR) % prog.length];
        out.push(
          lane === topLane
            ? motifRun[MOTIF[hit % MOTIF.length]]
            : midiToNote(pitchFor(lane, hit, chord, laneMidis[lane])),
        );
        hit++;
      }
      // The spec caps a melody at 64 pitches. The tables above top out at 32,
      // but a longer round would overflow and fail validation, so clamp — on a
      // bar boundary, because wrapping mid-bar puts the arpeggio on the wrong
      // chord for the rest of the round.
      return clampToBar(out, hitsPerBar(row));
    });

    return {
      label,
      bars,
      bpmScale: BPM_SCALES[input.difficulty][roundIndex],
      // Only the final round. Sudden death everywhere would just be punishing.
      suddenDeath: roundIndex === ROUND_LABELS.length - 1,
      patterns: rows.map((row) => row.join("")),
      melody,
    };
  });

  const title = input.song ? truncate(`${input.song} — Air Duel`, 80) : mood.name;

  return PatternSpecSchema.parse({
    title,
    song: input.song ? truncate(input.song, 120) : undefined,
    blurb: truncate(
      `${key} ${scale} at ${bpm} BPM. Three rounds, and the last one is sudden death.`,
      200,
    ),
    bpm,
    key,
    scale,
    lanes: laneNotes.map((note) => ({ label: note, note })),
    rounds,
  });
}

// ------------------------------------------------------------------ helpers

const REST = "-";

/**
 * Expand one density level over `bars` bars, then enforce the playability floors.
 *
 * The levels above already satisfy both floors, so the two passes are normally
 * no-ops. They stay because a one-character typo in the tables would otherwise
 * ship an unplayable chart to two people at once, and the cost of checking is a
 * few hundred array reads at request time.
 */
function buildRows(level: readonly (readonly number[])[], bars: number): string[][] {
  const total = bars * STEPS_PER_BAR;
  const rows = level.map((laneSteps) => {
    const row = new Array<string>(total).fill(REST);
    for (let bar = 0; bar < bars; bar++) {
      for (const step of laneSteps) {
        const i = bar * STEPS_PER_BAR + step;
        // Accent the downbeat so the expander gives the player something to
        // lock onto; expandChart reads 'X' as a louder note.
        row[i] = step === 0 ? "X" : "x";
      }
    }
    return row;
  });

  for (const row of rows) enforceLaneGap(row);
  enforceMaxSimultaneous(rows);
  return rows;
}

/** A lane cannot be re-struck in the air on the very next sixteenth. */
function enforceLaneGap(row: string[]): void {
  let last = -MIN_LANE_GAP_STEPS - 1;
  for (let i = 0; i < row.length; i++) {
    if (row[i] === REST) continue;
    if (i - last < MIN_LANE_GAP_STEPS) {
      row[i] = REST;
      continue;
    }
    last = i;
  }
}

function enforceMaxSimultaneous(rows: string[][]): void {
  if (rows.length === 0) return;
  // Inner voices go first: losing an arpeggio note is invisible, losing the
  // bass or the melody is audible.
  const dropOrder: number[] = [];
  for (let i = rows.length - 2; i >= 1; i--) dropOrder.push(i);
  dropOrder.push(rows.length - 1, 0);

  const total = rows[0].length;
  for (let step = 0; step < total; step++) {
    let live = 0;
    for (const row of rows) if (row[step] !== REST) live++;
    for (const lane of dropOrder) {
      if (live <= MAX_SIMULTANEOUS) break;
      if (rows[lane][step] === REST) continue;
      rows[lane][step] = REST;
      live--;
    }
  }
}

/**
 * Which chord tone this lane plays on its `hit`-th note.
 *
 * Lane 0 alternates root and fifth, which is what a bass player does and what
 * makes the harmony legible. The inner lanes rotate through the whole triad,
 * offset by lane index so two lanes firing together land on different tones and
 * sound like a chord rather than a doubling.
 */
function pitchFor(
  lane: number,
  hit: number,
  chord: readonly number[],
  laneMidi: number,
): number {
  const tone =
    lane === 0
      ? chord[hit % 2 === 0 ? 0 : chord.length - 1]
      : chord[(hit + lane) % chord.length];
  return voiceNear(tone, laneMidi);
}

/** Octave-shift a chord tone into a lane's own register. */
function voiceNear(toneMidi: number, targetMidi: number): number {
  let m = toneMidi;
  while (m < targetMidi - 5) m += 12;
  while (m > targetMidi + 6) m -= 12;
  return m;
}

/** The diatonic triad on a scale degree, as MIDI numbers. */
function triadMidis(key: string, scale: Mood["scale"], degree: number): number[] {
  const root = buildScale(key, scale, 3, 7)[degree] ?? `${key}3`;
  const symbol = `${root.replace(/-?\d+$/, "")}${TRIAD_QUALITY[scale][degree] ?? ""}`;
  const midis = chordNotes(symbol, 3)
    .map((n) => noteToMidi(n))
    .filter((n): n is number => n !== null);
  return midis.length > 0 ? midis : [60, 64, 67];
}

function hitsPerBar(row: string[]): number {
  let n = 0;
  for (let i = 0; i < STEPS_PER_BAR && i < row.length; i++) if (row[i] !== REST) n++;
  return Math.max(1, n);
}

/** Trim a melody to the spec's 64-pitch cap, cutting only on a bar boundary. */
function clampToBar(melody: string[], perBar: number): string[] {
  if (melody.length <= 64) return melody;
  return melody.slice(0, Math.max(perBar, Math.floor(64 / perBar) * perBar));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd();
}
