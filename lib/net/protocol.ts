import { z } from "zod";
import { ChartSchema, JUDGEMENTS } from "@/lib/game/types";

/**
 * FROZEN CONTRACT — the wire protocol between the two clients and the relay.
 *
 * ── The rule that shapes all of this ──────────────────────────────────────
 * HITS ARE NEVER JUDGED OVER THE NETWORK. Each client judges its own player
 * locally against the shared chart using its own audio clock, and sends only
 * *results*. Network jitter therefore cannot corrupt hit timing; the worst it
 * can do is make the opponent's score display a few hundred ms stale, which is
 * imperceptible. That is why there is no input message in this protocol, and no
 * rollback, lockstep or server-side simulation anywhere in the codebase.
 *
 * The server is a dumb relay plus a room registry. It never simulates the game.
 *
 * Consequence, stated plainly: clients self-report scores, so this is trivially
 * cheatable. That is an acceptable trade for a party game between friends.
 */

export const PROTOCOL_VERSION = 1;

/** Room codes are 4 chars from an unambiguous alphabet (no O/0, I/1). */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 4;
export const RoomCodeSchema = z
  .string()
  .length(ROOM_CODE_LENGTH)
  .transform((s) => s.toUpperCase())
  .refine((s) => [...s].every((c) => ROOM_CODE_ALPHABET.includes(c)), {
    message: "Invalid room code",
  });

export const WS_PATH = "/ws";

// ---------------------------------------------------------------- shared

export const RoomPhaseSchema = z.enum([
  "lobby",
  "loading",
  "countdown",
  "playing",
  "roundBreak",
  "finished",
]);
export type RoomPhase = z.infer<typeof RoomPhaseSchema>;

export const PlayerSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(16),
  ready: z.boolean(),
  connected: z.boolean(),
  /** Assigned by join order; drives which accent colour the UI uses. */
  seat: z.union([z.literal(0), z.literal(1)]),
});
export type Player = z.infer<typeof PlayerSchema>;

const ScoreUpdateSchema = z.object({
  round: z.number().int().min(0),
  score: z.number(),
  combo: z.number().int().min(0),
  bestCombo: z.number().int().min(0),
  accuracy: z.number().min(0).max(1),
  lastJudgement: z.enum(JUDGEMENTS).optional(),
});
export type ScoreUpdate = z.infer<typeof ScoreUpdateSchema>;

const RoundSummarySchema = z.object({
  round: z.number().int().min(0),
  score: z.number(),
  accuracy: z.number().min(0).max(1),
  bestCombo: z.number().int().min(0),
  counts: z.record(z.enum(JUDGEMENTS), z.number()),
});

// ---------------------------------------------------------------- client → server

export const ClientMessageSchema = z.discriminatedUnion("type", [
  /** First message on every connection. */
  z.object({
    type: z.literal("hello"),
    version: z.number().int(),
    name: z.string().min(1).max(16),
  }),
  z.object({ type: z.literal("create") }),
  z.object({ type: z.literal("join"), code: RoomCodeSchema }),
  z.object({ type: z.literal("leave") }),
  z.object({ type: z.literal("ready"), ready: z.boolean() }),
  /**
   * Host only. The host generates the chart (one AI call, not two) and pushes
   * it to the room so both players are guaranteed the identical chart.
   */
  z.object({ type: z.literal("setChart"), chart: ChartSchema }),
  /** Host only. Starts the countdown. */
  z.object({ type: z.literal("start") }),
  z.object({ type: z.literal("score"), update: ScoreUpdateSchema }),
  z.object({ type: z.literal("roundDone"), summary: RoundSummarySchema }),
  z.object({ type: z.literal("matchDone"), summary: RoundSummarySchema }),
  /** Clock sync probe; `t` is the client's performance.now() at send. */
  z.object({ type: z.literal("ping"), t: z.number() }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---------------------------------------------------------------- server → client

export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("welcome"),
    playerId: z.string(),
    version: z.number().int(),
  }),
  /** Full room state. Sent on every membership or phase change. */
  z.object({
    type: z.literal("room"),
    code: z.string(),
    hostId: z.string(),
    phase: RoomPhaseSchema,
    players: z.array(PlayerSchema),
  }),
  z.object({ type: z.literal("chart"), chart: ChartSchema }),
  /**
   * Both clients start when their own synced clock reaches `startAtServerMs`.
   * With the ping-derived offset this lands within a few tens of ms, which is
   * only ever a cosmetic concern — scoring is independent per client.
   */
  z.object({
    type: z.literal("countdown"),
    startAtServerMs: z.number(),
    round: z.number().int().min(0),
  }),
  z.object({
    type: z.literal("opponentScore"),
    playerId: z.string(),
    update: ScoreUpdateSchema,
  }),
  z.object({
    type: z.literal("roundResult"),
    round: z.number().int().min(0),
    summaries: z.array(
      z.object({ playerId: z.string(), summary: RoundSummarySchema }),
    ),
  }),
  z.object({
    type: z.literal("matchResult"),
    winnerId: z.string().nullable(),
    summaries: z.array(
      z.object({ playerId: z.string(), summary: RoundSummarySchema }),
    ),
  }),
  z.object({ type: z.literal("opponentLeft"), playerId: z.string() }),
  /** `t` echoes the client's send time; `serverMs` is Date.now() at handling. */
  z.object({
    type: z.literal("pong"),
    t: z.number(),
    serverMs: z.number(),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// ---------------------------------------------------------------- helpers

export function encode(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

/** Parse and validate an inbound frame. Returns null on anything malformed. */
export function decodeServer(raw: string): ServerMessage | null {
  try {
    const parsed = ServerMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function decodeClient(raw: string): ClientMessage | null {
  try {
    const parsed = ClientMessageSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** How often clients push score updates. 10Hz is smooth and near-free. */
export const SCORE_PUSH_HZ = 10;
/** Lead time between the countdown message and chart start. */
export const COUNTDOWN_LEAD_MS = 3200;
