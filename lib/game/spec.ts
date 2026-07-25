import { z } from "zod";
import { MAX_LANES, MIN_LANES } from "./types";

/**
 * FROZEN CONTRACT — the compact pattern spec the AI produces.
 *
 * ── Why the model does not emit notes directly ────────────────────────────
 * A 90-second chart is ~350 notes. Asking a model for an explicit list of
 * {lane, timeSec, pitch} is slow, expensive, and reliably produces off-grid
 * timings that feel wrong to play. Instead the model returns bars of step
 * strings — a few hundred tokens — and `expandChart` in lib/game/chart.ts turns
 * them into notes.
 *
 * The payoff is that output is RHYTHMICALLY VALID BY CONSTRUCTION: every note
 * lands exactly on a 16th-note grid because it cannot express anything else.
 * Difficulty escalation across rounds is a code-side transform, not something
 * the model has to reason about.
 */

/** Steps per bar. 16 = sixteenth notes in 4/4, the standard rhythm grid. */
export const STEPS_PER_BAR = 16;

/**
 * A step string is one bar per 16 characters:
 *   'x' — play a note
 *   'X' — play an accented note (louder)
 *   '-' or '.' — rest
 *
 * Length must be a multiple of STEPS_PER_BAR. `repairSpec` pads or trims.
 */
export const StepStringSchema = z.string().min(1).max(16 * 16);

export const SpecLaneSchema = z.object({
  label: z.string().min(1).max(8),
  /** Default pitch for the lane, scientific pitch notation. */
  note: z.string().min(1).max(8),
});

export const SpecRoundSchema = z.object({
  label: z.string().min(1).max(24),
  bars: z.number().int().min(1).max(16),
  /** Tempo multiplier for this round; escalation lives here. */
  bpmScale: z.number().min(0.5).max(2).default(1),
  suddenDeath: z.boolean().default(false),
  /**
   * One step string per lane, in lane order. Shorter arrays are padded with
   * rests, longer ones truncated.
   */
  patterns: z.array(StepStringSchema).min(1).max(MAX_LANES),
  /**
   * Optional melody: per lane, a list of pitches consumed in order by that
   * lane's 'x' steps. When exhausted it wraps. Omit to use the lane default.
   * This is how a lane plays a moving line instead of one repeated pitch.
   */
  melody: z.array(z.array(z.string().max(8)).max(64)).max(MAX_LANES).optional(),
});

export const PatternSpecSchema = z.object({
  title: z.string().min(1).max(80),
  song: z.string().max(120).optional(),
  blurb: z.string().max(200).optional(),
  bpm: z.number().min(40).max(220),
  key: z.string().max(4).default("C"),
  scale: z.string().max(24).default("major"),
  lanes: z.array(SpecLaneSchema).min(MIN_LANES).max(MAX_LANES),
  rounds: z.array(SpecRoundSchema).min(1).max(4),
});

export type PatternSpec = z.infer<typeof PatternSpecSchema>;
export type SpecRound = z.infer<typeof SpecRoundSchema>;
export type SpecLane = z.infer<typeof SpecLaneSchema>;

/**
 * Playability floors enforced by `repairSpec`.
 *
 * MIN_LANE_GAP_STEPS: a single lane cannot fire on consecutive 16ths — the
 * trigger engine's retrigger cooldown is 70ms and you physically cannot lift
 * and re-strike a lane that fast in the air. Two 16ths at 120bpm is 125ms,
 * which is already at the limit, so we require a gap of at least 2 steps.
 *
 * MAX_SIMULTANEOUS: more than 3 lanes at once is unplayable with one hand.
 */
/**
 * Minimum steps between two notes in the SAME lane.
 *
 * Was 2 (eighth notes). That is playable with a finger on a key and completely
 * unplayable in the air: you have to lift the whole hand clear of the zone and
 * strike again, and the trigger engine's own retrigger cooldown is 70ms. Four
 * steps is a quarter note — at the tempos we now generate that is ~600ms, which
 * a person can actually hit twice in a row.
 */
export const MIN_LANE_GAP_STEPS = 4;

/**
 * Maximum lanes firing on one step.
 *
 * Was 3. Three simultaneous lanes means a chord spanning most of the frame, and
 * because every fingertip triggers independently you end up needing a specific
 * hand shape rather than just a strike. Two reads as a chord and is reachable
 * with one hand.
 */
export const MAX_SIMULTANEOUS = 2;
