import { z } from "zod";

/**
 * FROZEN CONTRACT — the chart, judging and scoring types.
 *
 * Every part of the game codes against this file: the AI chart route, the
 * expander, the judge, the highway renderer, and the network layer. Change it
 * only deliberately, because a change here ripples everywhere.
 *
 * ── Magic Piano semantics ──────────────────────────────────────────────────
 * The CHART owns pitch; the PLAYER owns timing. A hit on lane N sounds whatever
 * note the chart scheduled for lane N, so a recognisable melody comes out as
 * long as timing is decent. There is no such thing as a wrong note — only a
 * badly timed one. This is what makes air-playing viable: pitch precision is
 * the weakest link in hand tracking, so we simply remove it from the player's
 * responsibility.
 *
 * ── Time domain ───────────────────────────────────────────────────────────
 * Every `*Sec` field is seconds from the start of the chart, measured on the
 * AudioContext clock. Never performance.now() — the audio clock is the only one
 * that matches what the player hears. `lib/game/clock.ts` owns the bridge from
 * the vision callback's perf-clock timestamps into this domain.
 */

// ---------------------------------------------------------------- lanes

/**
 * Piano lanes run left to right, low pitch to high.
 *
 * Capped at 5, down from 6. Lane width is the single biggest factor in whether
 * a strike lands where you meant it: hand-tracking jitter is roughly fixed in
 * screen space, so every extra lane makes every target proportionally harder.
 * Four wide lanes are far more fun than six narrow ones.
 */
export const MIN_LANES = 4;
export const MAX_LANES = 5;

export const LaneSchema = z.object({
  index: z.number().int().min(0).max(MAX_LANES - 1),
  /** Short display label, e.g. "C4". */
  label: z.string().min(1).max(8),
  /**
   * Default pitch for this lane in scientific pitch notation. Individual notes
   * may override it, which is how melodies move within a lane.
   */
  note: z.string().min(1).max(8),
});
export type Lane = z.infer<typeof LaneSchema>;

// ---------------------------------------------------------------- notes

export const NOTE_KINDS = ["tap", "hold"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const ChartNoteSchema = z.object({
  /** Stable id, assigned by the expander. Judging dedupes on this. */
  id: z.string().min(1).max(32),
  lane: z.number().int().min(0).max(MAX_LANES - 1),
  /** Seconds from chart start, on the audio clock. */
  timeSec: z.number().min(0),
  kind: z.enum(NOTE_KINDS).default("tap"),
  /** For `hold` notes only. */
  durationSec: z.number().min(0).max(8).optional(),
  /** Pitch to sound when this note is hit. Overrides the lane default. */
  note: z.string().min(1).max(8),
  /** 0..1 suggested loudness, used for accents on downbeats. */
  velocity: z.number().min(0).max(1).default(0.8),
  /** Which round this note belongs to. */
  round: z.number().int().min(0).max(7).default(0),
});
export type ChartNote = z.infer<typeof ChartNoteSchema>;

// ---------------------------------------------------------------- rounds

export const RoundSpecSchema = z.object({
  index: z.number().int().min(0).max(7),
  label: z.string().min(1).max(24),
  startSec: z.number().min(0),
  endSec: z.number().min(0),
  bpm: z.number().min(40).max(260),
  /** Final round is sudden death: a miss costs far more. */
  suddenDeath: z.boolean().default(false),
});
export type RoundSpec = z.infer<typeof RoundSpecSchema>;

// ---------------------------------------------------------------- chart

export const ChartSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(80),
  /** The song this was arranged from, if the player named one. */
  song: z.string().max(120).optional(),
  bpm: z.number().min(40).max(260),
  key: z.string().max(4).default("C"),
  scale: z.string().max(24).default("major"),
  lanes: z.array(LaneSchema).min(MIN_LANES).max(MAX_LANES),
  notes: z.array(ChartNoteSchema).min(1).max(2000),
  rounds: z.array(RoundSpecSchema).min(1).max(8),
  durationSec: z.number().min(1).max(600),
  /** How this chart was produced, surfaced in the UI. */
  source: z.enum(["model", "fallback"]).default("fallback"),
  /** One-line description shown on the lobby card. */
  blurb: z.string().max(200).optional(),
});
export type Chart = z.infer<typeof ChartSchema>;

// ---------------------------------------------------------------- judging

export const JUDGEMENTS = ["perfect", "great", "good", "miss"] as const;
export type Judgement = (typeof JUDGEMENTS)[number];

/**
 * Absolute timing error, in seconds, that still earns each judgement.
 *
 * These are wider than a touchscreen rhythm game's on purpose. Hand tracking
 * has ~40-80ms of irreducible latency and a few ms of jitter even after
 * filtering, so a 25ms "perfect" window would be unhittable and read as broken.
 * Per-player latency calibration removes the systematic offset; these windows
 * absorb what's left.
 */
export const HIT_WINDOWS: Record<Exclude<Judgement, "miss">, number> = {
  perfect: 0.07,
  great: 0.13,
  good: 0.22,
};

/** Widest window that still counts as a hit at all. */
export const HIT_WINDOW_MAX = HIT_WINDOWS.good;

/** Base points before the combo multiplier. */
export const JUDGEMENT_POINTS: Record<Judgement, number> = {
  perfect: 300,
  great: 200,
  good: 100,
  miss: 0,
};

/** Combo multiplier steps: every N notes in a row raises the multiplier. */
export const COMBO_STEP = 10;
export const MAX_MULTIPLIER = 4;

/** In sudden death, a miss also subtracts this much. */
export const SUDDEN_DEATH_MISS_PENALTY = 150;

export function comboMultiplier(combo: number): number {
  return Math.min(MAX_MULTIPLIER, 1 + Math.floor(combo / COMBO_STEP));
}

/** A note that has been resolved, either by a hit or by passing un-hit. */
export interface JudgedHit {
  noteId: string;
  lane: number;
  judgement: Judgement;
  /** Signed timing error in seconds: negative = early, positive = late. */
  deltaSec: number;
  /** When it was judged, in chart time. */
  tSec: number;
  /** Points awarded after the multiplier. */
  points: number;
  /** Combo *after* this judgement. */
  combo: number;
}

export interface ScoreState {
  score: number;
  combo: number;
  bestCombo: number;
  counts: Record<Judgement, number>;
  /** Notes resolved so far (hit or missed). */
  resolved: number;
  /** 0..1, weighted by judgement quality. */
  accuracy: number;
}

export function emptyScore(): ScoreState {
  return {
    score: 0,
    combo: 0,
    bestCombo: 0,
    counts: { perfect: 0, great: 0, good: 0, miss: 0 },
    resolved: 0,
    accuracy: 1,
  };
}

/** Per-round summary, exchanged over the network at round end. */
export interface RoundSummary {
  round: number;
  score: number;
  accuracy: number;
  bestCombo: number;
  counts: Record<Judgement, number>;
}

// ---------------------------------------------------------------- calibration

/**
 * Player-specific latency offset in seconds, measured by the calibration tap
 * test and subtracted from hit timestamps before judging.
 *
 * This only compensates the player's own hardware, so it does not advantage
 * anyone — it makes two different webcams score the same performance equally.
 */
export const DEFAULT_CALIBRATION_SEC = 0.06;
export const MAX_CALIBRATION_SEC = 0.25;
