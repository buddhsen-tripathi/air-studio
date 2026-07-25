import { SCALES, buildScale, midiToNote, noteToMidi } from "@/lib/music/theory";
import {
  MAX_SIMULTANEOUS,
  MIN_LANE_GAP_STEPS,
  PatternSpecSchema,
  STEPS_PER_BAR,
  type PatternSpec,
} from "./spec";
import {
  MAX_LANES,
  MIN_LANES,
  type Chart,
  type ChartNote,
  type Lane,
  type RoundSpec,
} from "./types";

/**
 * PatternSpec -> Chart.
 *
 * `repairSpec` is the trust boundary: everything upstream of it is model output
 * and may be arbitrary garbage. It follows the same contract as
 * `lib/layout/repair.ts` — validate, repair, NEVER reject. A duel that falls
 * back to a canned chart because the model wrote 17 lanes is a worse experience
 * than one that quietly plays the 6 best of them.
 *
 * `expandChart` is a pure, deterministic transform of an already-valid spec:
 * both peers expand the same spec byte-for-byte identically, which is what lets
 * us ship a spec (or a chart) over the wire once and trust that the two clients
 * are judging against the same timeline. Nothing in here may consult the clock,
 * Math.random, or the environment.
 */

// ------------------------------------------------------------------ tuning

/**
 * Silence appended after the last step of the last round.
 *
 * Without it the song stops dead on the final note, which reads as a crash
 * rather than an ending — and the judge still needs a moment past the last note
 * to resolve a late hit inside HIT_WINDOW_MAX.
 */
const TAIL_SEC = 1.5;

/**
 * Effective tempo bounds (bpm * bpmScale). The schemas allow 40..220 bpm and a
 * 0.5..2 scale independently, whose product spans 20..440 — 20bpm 16ths crawl
 * and 440bpm 16ths are past the retrigger cooldown even with a 2-step gap.
 */
const MIN_EFFECTIVE_BPM = 50;
const MAX_EFFECTIVE_BPM = 240;

/**
 * Budget ceilings, kept under ChartSchema's hard limits (600s / 2000 notes) so
 * that a repaired spec always survives `ChartSchema.parse` after expansion.
 * Real charts land nowhere near these; only pathological model output does.
 */
const MAX_CHART_SEC = 360;
const MAX_CHART_NOTES = 1800;

/** Widest gap we will escalate to while thinning to fit MAX_CHART_NOTES. */
const MAX_LANE_GAP_STEPS = STEPS_PER_BAR;

/** MIDI range a lane pitch must fall in to be believed. */
const MIN_LANE_MIDI = 24;
const MAX_LANE_MIDI = 108;

// ------------------------------------------------------------------ grid

/** Internal per-step cell values. */
const REST = 0;
const HIT = 1;
const ACCENT = 2;

/**
 * Ceiling on how many *sounding steps* may be chords, outside round 1 (which is
 * forced monophonic). Chords are punctuation; when everything is a chord there
 * is no melody left to recognise.
 */
const MAX_CHORD_FRACTION = 0.22;

/**
 * Ceiling on how many notes may be accented. An accent that lands on most notes
 * is not an accent — and the highway draws accents specifically so the player
 * can feel where the bar begins.
 */
const MAX_ACCENT_FRACTION = 0.25;

/**
 * Map a step character to a cell.
 *
 * Deliberately generous: models reach for 'o', '*' and '1' as often as 'x', and
 * a bar rendered with the wrong hit glyph would otherwise silently become four
 * bars of rest. Uppercase means accent, matching the 'x'/'X' convention.
 */
function stepValue(ch: string | undefined): number {
  switch (ch) {
    case "x":
    case "o":
    case "*":
    case "+":
    case "1":
      return HIT;
    case "X":
    case "O":
    case "!":
      return ACCENT;
    default:
      return REST;
  }
}

function stepChar(v: number): string {
  return v === ACCENT ? "X" : v === HIT ? "x" : "-";
}

/** Seconds per 16th step at a given base tempo and round scale. */
function stepSeconds(bpm: number, bpmScale: number): number {
  return 60 / (bpm * bpmScale) / 4;
}

// ------------------------------------------------------------------ repair

interface RepairedLane {
  label: string;
  note: string;
  midi: number;
  /**
   * Index this lane occupied before lanes were sorted by pitch. Patterns and
   * melodies are addressed by the model's original lane order, so every lookup
   * has to go through this.
   */
  from: number;
}

interface RepairedRound {
  label: string;
  bars: number;
  bpmScale: number;
  /** One row per lane, `bars * STEPS_PER_BAR` cells wide. */
  grid: Uint8Array[];
  /** One entry per lane; empty means "use the lane's default pitch". */
  melody: string[][];
}

/**
 * Coerce arbitrary input into a spec that `PatternSpecSchema` accepts and that
 * a human can actually play in the air.
 */
export function repairSpec(input: unknown): PatternSpec {
  const raw = isRecord(input) ? input : {};

  const bpm = clamp(asNumber(raw.bpm, 100), 40, 220);
  const key = asKey(raw.key);
  const scale = asScale(raw.scale);

  const lanes = repairLanes(raw.lanes, key, scale);
  const laneOrder = lanes.map((l) => l.from);
  const laneNotes = lanes.map((l) => l.note);

  const rawRounds = Array.isArray(raw.rounds) ? raw.rounds : [];
  const rounds = (rawRounds.length > 0 ? rawRounds : [{}])
    .slice(0, 4)
    .map((r, i) => repairRound(r, i, { bpm, laneOrder, laneNotes }));

  // Duration first: trimming bars deletes notes, so doing it before the note
  // budget keeps the two passes from fighting each other.
  fitDuration(rounds, bpm);
  for (const round of rounds) {
    const steps = round.bars * STEPS_PER_BAR;
    round.grid = round.grid.map((row) => row.slice(0, steps));
    thinSimultaneous(round, steps);
  }

  // Chord and accent budgets run before the pristine snapshot so the gap
  // escalation below replays them rather than reintroducing what they removed.
  thinChords(rounds, MAX_CHORD_FRACTION);
  thinAccents(rounds, MAX_ACCENT_FRACTION);

  // Gap thinning is re-run from a pristine copy at each escalation instead of
  // being applied on top of itself: thinning an already-thinned grid biases
  // every survivor towards the front of the bar, which sounds lopsided.
  const pristine = rounds.map((r) => r.grid.map((row) => Uint8Array.from(row)));
  let total = 0;
  for (let gap = MIN_LANE_GAP_STEPS; ; gap++) {
    for (let i = 0; i < rounds.length; i++) {
      for (let l = 0; l < rounds[i].grid.length; l++) {
        rounds[i].grid[l].set(pristine[i][l]);
      }
    }
    thinLaneGaps(rounds, lanes.length, gap);
    total = countHits(rounds);
    if (total <= MAX_CHART_NOTES || gap >= MAX_LANE_GAP_STEPS) break;
  }

  // ChartSchema requires at least one note, and a chart of pure rest is not a
  // game anyway. Quarter notes on the lowest lane are trivially playable.
  if (total === 0) seedPulse(rounds[0]);

  const anyMelody = rounds.some((r) => r.melody.some((m) => m.length > 0));

  const candidate = {
    title: asString(raw.title, "Air Piano Duel").slice(0, 80),
    song: raw.song ? asString(raw.song, "").slice(0, 120) || undefined : undefined,
    blurb: raw.blurb ? asString(raw.blurb, "").slice(0, 200) || undefined : undefined,
    bpm,
    key,
    scale,
    lanes: lanes.map((l) => ({ label: l.label, note: l.note })),
    rounds: rounds.map((r) => ({
      label: r.label,
      bars: r.bars,
      bpmScale: r.bpmScale,
      // Sudden death is *defined* as the final round; see expandChart.
      suddenDeath: false,
      patterns: r.grid.map(serializeRow),
      melody: anyMelody ? r.melody : undefined,
    })),
  };

  // Last line of defence. Repair is meant to be total, so a failure here is a
  // bug in this file — but a duel that starts with a plain chart beats one that
  // 500s, so we swallow it rather than throw on the request path.
  const parsed = PatternSpecSchema.safeParse(candidate);
  return parsed.success ? parsed.data : fallbackSpec();
}

/**
 * Repair the lane set, then sort it low to high.
 *
 * Lane order is load-bearing: the highway draws lane 0 leftmost and the frozen
 * contract says lanes ascend in pitch, so an out-of-order lane list renders as
 * a scrambled keyboard. Sorting is safe because patterns and melodies travel
 * with their lane via `from`.
 */
function repairLanes(
  raw: unknown,
  key: string,
  scale: string,
): RepairedLane[] {
  const list = Array.isArray(raw) ? raw : [];
  const degrees = buildScale(key, scale, 4, MAX_LANES);
  const out: RepairedLane[] = [];

  const count = clamp(list.length, MIN_LANES, MAX_LANES);
  for (let i = 0; i < count; i++) {
    const entry = isRecord(list[i]) ? (list[i] as Record<string, unknown>) : {};
    const given = typeof entry.note === "string" ? entry.note : "";
    const midi = given ? noteToMidi(given) : null;
    // An unusable pitch falls back to this lane's scale degree, so the lane
    // still sits inside the chart's key instead of on a random pitch.
    const note =
      midi !== null && midi >= MIN_LANE_MIDI && midi <= MAX_LANE_MIDI
        ? midiToNote(midi)
        : degrees[i % degrees.length];
    out.push({
      label: asString(entry.label, note).slice(0, 8) || note,
      note,
      midi: noteToMidi(note) ?? 60,
      from: i,
    });
  }

  // Array.prototype.sort is stable, so equal pitches keep the model's order.
  out.sort((a, b) => a.midi - b.midi);
  return out;
}

function repairRound(
  raw: unknown,
  index: number,
  ctx: { bpm: number; laneOrder: number[]; laneNotes: string[] },
): RepairedRound {
  const entry = isRecord(raw) ? raw : {};
  const patterns = Array.isArray(entry.patterns) ? entry.patterns : [];
  const laneCount = ctx.laneOrder.length;

  const declared = asInt(entry.bars, 0);
  let bars = declared >= 1 && declared <= 16 ? declared : inferBars(patterns);
  // Never throw away bars the model actually wrote: a step string longer than
  // `bars` means the declared count is the wrong half of the pair.
  bars = clamp(Math.max(bars, inferBars(patterns)), 1, 16);
  const steps = bars * STEPS_PER_BAR;

  const grid: Uint8Array[] = [];
  const melody: string[][] = [];
  const rawMelody = Array.isArray(entry.melody) ? entry.melody : [];

  for (let lane = 0; lane < laneCount; lane++) {
    const src = patterns[ctx.laneOrder[lane]];
    const text = typeof src === "string" ? src : "";
    // Trailing cells stay REST, which is exactly the "pad with rests" repair;
    // anything past `steps` is dropped, which is the "trim" one.
    const row = new Uint8Array(steps);
    for (let s = 0; s < steps && s < text.length; s++) {
      row[s] = stepValue(text[s]);
    }
    grid.push(row);
    melody.push(
      repairMelodyLane(rawMelody[ctx.laneOrder[lane]], ctx.laneNotes[lane]),
    );
  }

  return {
    label: asString(entry.label, `Round ${index + 1}`).slice(0, 24),
    bpmScale: clampScale(ctx.bpm, entry.bpmScale),
    bars,
    grid,
    melody,
  };
}

/**
 * Melody pitches are replaced rather than dropped when unparseable: the
 * melody is consumed one entry per hit, so removing an entry would rotate every
 * later note onto the wrong step of the phrase.
 */
function repairMelodyLane(raw: unknown, laneNote: string): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (let i = 0; i < raw.length && out.length < 64; i++) {
    const given = typeof raw[i] === "string" ? (raw[i] as string) : "";
    const midi = given ? noteToMidi(given) : null;
    out.push(
      midi !== null && midi >= MIN_LANE_MIDI && midi <= MAX_LANE_MIDI
        ? midiToNote(midi)
        : laneNote,
    );
  }
  // All-default is indistinguishable from no melody, and costs bytes on the
  // wire plus a pointless modulo per note.
  return out.every((n) => n === laneNote) ? [] : out;
}

function inferBars(patterns: unknown[]): number {
  let longest = 0;
  for (const p of patterns) {
    if (typeof p === "string") longest = Math.max(longest, p.length);
  }
  if (longest === 0) return 4;
  return clamp(Math.ceil(longest / STEPS_PER_BAR), 1, 16);
}

/** Keep bpm * bpmScale inside the playable band without leaving 0.5..2. */
function clampScale(bpm: number, raw: unknown): number {
  const scale = clamp(asNumber(raw, 1), 0.5, 2);
  const effective = bpm * scale;
  if (effective < MIN_EFFECTIVE_BPM) return clamp(MIN_EFFECTIVE_BPM / bpm, 0.5, 2);
  if (effective > MAX_EFFECTIVE_BPM) return clamp(MAX_EFFECTIVE_BPM / bpm, 0.5, 2);
  return scale;
}

/** Shave bars (then whole rounds) until the chart fits the duration budget. */
function fitDuration(rounds: RepairedRound[], bpm: number): void {
  const seconds = (r: RepairedRound) =>
    r.bars * STEPS_PER_BAR * stepSeconds(bpm, r.bpmScale);

  // Bounded by 4 rounds * 16 bars of decrements; the guard is belt and braces.
  for (let guard = 0; guard < 512; guard++) {
    let total = TAIL_SEC;
    for (const r of rounds) total += seconds(r);
    if (total <= MAX_CHART_SEC) return;

    let worst = 0;
    for (let i = 1; i < rounds.length; i++) {
      if (seconds(rounds[i]) > seconds(rounds[worst])) worst = i;
    }
    if (rounds[worst].bars > 1) rounds[worst].bars--;
    else if (rounds.length > 1) rounds.splice(worst, 1);
    else return; // one bar at >=50bpm is 19s; a single round always fits.
  }
}

/**
 * Drop notes from over-stuffed steps, keeping the lowest and highest lanes.
 *
 * The outer voices are what the eye reads as the shape of a chord on the
 * highway, and they are the easiest pair to hit with two hands. Inner voices
 * are filled from the middle outwards so what survives stays balanced.
 */
function thinSimultaneous(round: RepairedRound, steps: number): void {
  const active: number[] = [];
  for (let s = 0; s < steps; s++) {
    active.length = 0;
    for (let l = 0; l < round.grid.length; l++) {
      if (round.grid[l][s] !== REST) active.push(l);
    }
    if (active.length <= MAX_SIMULTANEOUS) continue;

    const lowest = active[0];
    const highest = active[active.length - 1];
    const middle = (lowest + highest) / 2;
    const inner = active
      .slice(1, -1)
      .sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))
      .slice(0, MAX_SIMULTANEOUS - 2);

    for (const lane of active) {
      if (lane === lowest || lane === highest || inner.includes(lane)) continue;
      round.grid[lane][s] = REST;
    }
  }
}

/**
 * Cap how many steps are chords, and forbid them outright in round 1.
 *
 * Measured on real model output: a generated "Ode to Joy" came back with EVERY
 * one of its 38 steps as a two-lane chord and not a single lone note, so round
 * 1 was the same two lanes struck eight times — a metronome, not a melody. A
 * model asked for a chord ceiling reads it as a target.
 *
 * So the ceiling is enforced here instead. Round 1 is made strictly monophonic
 * (a first-timer has to succeed at one thing before two), and later rounds keep
 * chords for punctuation. Where a chord is thinned, the surviving voice is the
 * one carrying the melody — the highest lane — because that is the line the
 * player recognises.
 */
function thinChords(
  rounds: RepairedRound[],
  maxChordFraction: number,
): void {
  for (let r = 0; r < rounds.length; r++) {
    const round = rounds[r];
    const steps = round.grid[0]?.length ?? 0;
    if (steps === 0) continue;

    const chordSteps: number[] = [];
    let soundingSteps = 0;
    for (let s = 0; s < steps; s++) {
      let n = 0;
      for (let l = 0; l < round.grid.length; l++) {
        if (round.grid[l][s] !== REST) n++;
      }
      if (n > 0) soundingSteps++;
      if (n > 1) chordSteps.push(s);
    }

    // Round 1 teaches the instrument: one note, one target, every time.
    const allowed =
      r === 0 ? 0 : Math.floor(soundingSteps * maxChordFraction);
    if (chordSteps.length <= allowed) continue;

    // Keep chords on the strongest beats — a chord on a downbeat reads as
    // deliberate, one on an offbeat reads as noise.
    chordSteps.sort((a, b) => strength(b) - strength(a));
    for (const s of chordSteps.slice(allowed)) {
      let kept = -1;
      for (let l = round.grid.length - 1; l >= 0; l--) {
        if (round.grid[l][s] === REST) continue;
        if (kept === -1) {
          kept = l;
          continue;
        }
        round.grid[l][s] = REST;
      }
    }
  }
}

/** How musically strong a step is: bar line beats beat beats offbeats. */
function strength(step: number): number {
  if (step % STEPS_PER_BAR === 0) return 3;
  if (step % 4 === 0) return 2;
  if (step % 2 === 0) return 1;
  return 0;
}

/**
 * Cap accents so they still mean something.
 *
 * Same measurement: 80% of the notes in that chart came back accented. An
 * accent that applies to four notes in five is not an accent, it is the
 * baseline — and the highway renders accents larger with a bright cap
 * specifically so the player can feel where the bar starts. Keep them on the
 * strongest steps and demote the rest to normal hits.
 */
function thinAccents(rounds: RepairedRound[], maxFraction: number): void {
  for (const round of rounds) {
    const steps = round.grid[0]?.length ?? 0;
    const accents: { lane: number; step: number }[] = [];
    let total = 0;

    for (let l = 0; l < round.grid.length; l++) {
      for (let s = 0; s < steps; s++) {
        const cell = round.grid[l][s];
        if (cell === REST) continue;
        total++;
        if (cell === ACCENT) accents.push({ lane: l, step: s });
      }
    }

    const allowed = Math.max(1, Math.floor(total * maxFraction));
    if (accents.length <= allowed) continue;

    accents.sort((a, b) => strength(b.step) - strength(a.step));
    for (const { lane, step } of accents.slice(allowed)) {
      round.grid[lane][step] = HIT;
    }
  }
}

/**
 * Enforce the per-lane retrigger gap across the whole chart.
 *
 * The counter carries across round boundaries because rounds run back to back:
 * the last step of one round and the first of the next are adjacent in time,
 * and a lane firing on both is exactly as unplayable as it is mid-bar. Counting
 * in steps rather than seconds is conservative in the direction that matters —
 * the resulting time gap is at least `gap` times the *shorter* of the two
 * rounds' step durations.
 */
function thinLaneGaps(
  rounds: RepairedRound[],
  laneCount: number,
  gap: number,
): void {
  const since = new Int32Array(laneCount).fill(gap);
  for (const round of rounds) {
    const steps = round.bars * STEPS_PER_BAR;
    for (let s = 0; s < steps; s++) {
      for (let l = 0; l < laneCount; l++) {
        if (round.grid[l][s] === REST) continue;
        if (since[l] >= gap) since[l] = 0;
        else round.grid[l][s] = REST;
      }
      for (let l = 0; l < laneCount; l++) since[l]++;
    }
  }
}

function countHits(rounds: RepairedRound[]): number {
  let n = 0;
  for (const round of rounds) {
    for (const row of round.grid) {
      for (const cell of row) if (cell !== REST) n++;
    }
  }
  return n;
}

/** Quarter notes on the lowest lane — the minimum viable chart. */
function seedPulse(round: RepairedRound): void {
  const steps = round.bars * STEPS_PER_BAR;
  for (let s = 0; s < steps; s += 4) round.grid[0][s] = s % 16 === 0 ? ACCENT : HIT;
}

function serializeRow(row: Uint8Array): string {
  let out = "";
  for (const cell of row) out += stepChar(cell);
  return out;
}

/**
 * Used only if `repairSpec` somehow builds something the schema rejects. Built
 * as a literal rather than parsed so that it cannot itself throw.
 */
function fallbackSpec(): PatternSpec {
  const notes = buildScale("C", "major", 4, MIN_LANES);
  const bar = (offset: number) =>
    Array.from({ length: STEPS_PER_BAR }, (_, s) =>
      s % 8 === offset ? "x" : "-",
    ).join("");
  return {
    title: "Air Piano",
    bpm: 100,
    key: "C",
    scale: "major",
    lanes: notes.map((n) => ({ label: n, note: n })),
    rounds: [
      {
        label: "Round 1",
        bars: 4,
        bpmScale: 1,
        suddenDeath: false,
        patterns: notes.map((_, i) => bar(i % 8).repeat(4)),
      },
    ],
  };
}

// ------------------------------------------------------------------ expand

/**
 * Expand a spec into absolute note times.
 *
 * Pure and total for any spec that has been through `repairSpec` (or
 * `PatternSpecSchema`): every note lands on the 16th grid by construction,
 * because a step index is the only thing a spec can express.
 */
export function expandChart(spec: PatternSpec): Chart {
  const lanes: Lane[] = spec.lanes.map((lane, index) => ({
    index,
    label: lane.label,
    note: lane.note,
  }));

  const notes: ChartNote[] = [];
  const rounds: RoundSpec[] = [];
  let cursor = 0;

  for (let r = 0; r < spec.rounds.length; r++) {
    const round = spec.rounds[r];
    const isLast = r === spec.rounds.length - 1;
    // The round's own tempo, stored on the RoundSpec so the renderer and judge
    // can recover the step grid from the Chart alone.
    const roundBpm = spec.bpm * round.bpmScale;
    const stepSec = 60 / roundBpm / 4;
    const steps = round.bars * STEPS_PER_BAR;
    const startSec = cursor;

    for (let lane = 0; lane < lanes.length; lane++) {
      const pattern = round.patterns[lane] ?? "";
      const melody = round.melody?.[lane];
      // The melody cursor is per lane and per round: `melody` lives on the
      // round, so a new round restarts its phrase from the top.
      let melodyAt = 0;

      for (let s = 0; s < steps; s++) {
        const cell = stepValue(pattern[s]);
        if (cell === REST) continue;

        let pitch = lanes[lane].note;
        if (melody && melody.length > 0) {
          // Accents consume the melody too: skipping them would rotate the
          // phrase out of step with the rhythm that was written for it.
          pitch = melody[melodyAt % melody.length] || pitch;
          melodyAt++;
        }

        notes.push({
          // Stable and unique: one note per (round, lane, step). The judge
          // dedupes on this, so it must never collide across rounds.
          id: `r${r}l${lane}s${s}`,
          lane,
          timeSec: startSec + s * stepSec,
          kind: "tap",
          note: pitch,
          velocity: cell === ACCENT ? 1 : 0.8,
          round: r,
        });
      }
    }

    const endSec = startSec + steps * stepSec + (isLast ? TAIL_SEC : 0);
    rounds.push({
      index: r,
      label: round.label,
      startSec,
      endSec,
      bpm: roundBpm,
      // Sudden death is the closing stretch by definition. Honouring a flag on
      // an earlier round would apply the heavy miss penalty while the player
      // still has rounds left to recover in.
      suddenDeath: isLast,
    });
    cursor = endSec;
  }

  // Lane is the tiebreak so the order is fully determined: two peers expanding
  // the same spec must produce identical arrays, ids included.
  notes.sort((a, b) => a.timeSec - b.timeSec || a.lane - b.lane);

  return {
    id: chartId(spec),
    title: spec.title,
    song: spec.song,
    bpm: spec.bpm,
    key: spec.key,
    scale: spec.scale,
    lanes,
    notes,
    rounds,
    durationSec: cursor,
    // The caller knows the provenance; the expander does not. Routes that used
    // the model override this to "model".
    source: "fallback",
    blurb: spec.blurb,
  };
}

/** Deterministic id: the same spec must yield the same id on both peers. */
function chartId(spec: PatternSpec): string {
  const stem = slug(spec.title) || "chart";
  return `${stem}-${fnv1a(JSON.stringify(spec))}`.slice(0, 64);
}

function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

// ------------------------------------------------------------------ stats

export interface ChartStats {
  notes: number;
  byLane: number[];
  densityPerSec: number;
  maxSimultaneous: number;
}

/** Notes within this many seconds of each other count as one chord. */
const SIMULTANEOUS_EPS = 1e-3;

/** Cheap difficulty read-out for the lobby card and the chart test harness. */
export function chartStats(chart: Chart): ChartStats {
  const byLane = new Array<number>(chart.lanes.length).fill(0);
  for (const note of chart.notes) {
    if (note.lane < byLane.length) byLane[note.lane]++;
  }

  const times = chart.notes.map((n) => n.timeSec).sort((a, b) => a - b);
  let maxSimultaneous = 0;
  let i = 0;
  while (i < times.length) {
    let j = i;
    // Anchored on `times[i]` rather than chained, so a dense run of distinct
    // notes cannot snowball into one giant "chord".
    while (j < times.length && times[j] - times[i] <= SIMULTANEOUS_EPS) j++;
    maxSimultaneous = Math.max(maxSimultaneous, j - i);
    i = j;
  }

  return {
    notes: chart.notes.length,
    byLane,
    densityPerSec:
      chart.durationSec > 0 ? chart.notes.length / chart.durationSec : 0,
    maxSimultaneous,
  };
}

// ------------------------------------------------------------------ coercion

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asNumber(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? Number.parseFloat(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function asInt(v: unknown, fallback: number): number {
  const n = asNumber(v, Number.NaN);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

/** A key that `noteToMidi` cannot parse would silently detune every fallback. */
function asKey(v: unknown): string {
  const raw = asString(v, "C").slice(0, 4);
  return noteToMidi(`${raw}4`) === null ? "C" : raw;
}

/** `buildScale` falls back to minor for unknown names; major is friendlier. */
function asScale(v: unknown): string {
  const raw = asString(v, "major").slice(0, 24);
  return SCALES[raw] ? raw : "major";
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function slug(v: string): string {
  return v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
