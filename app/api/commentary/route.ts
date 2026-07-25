import { NextResponse } from "next/server";
import { z } from "zod";
import {
  COMMENTARY_SYSTEM,
  commentaryUserPrompt,
  type CommentaryInput,
  type CommentaryPlayer,
} from "@/lib/ai/commentaryPrompts";
import {
  chat,
  configuredModel,
  extractJson,
  isConfigured,
} from "@/lib/ai/openrouter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The round-break commentator.
 *
 * This fires the instant a round ends, while both players are staring at a card
 * with a blank line on it, so latency is the whole design: a tiny token budget,
 * and a local commentator that is good enough to ship on its own. The route
 * always answers 200 with a usable line — a slow or dead model must never leave
 * the round card empty, because the line is the only voice this game has.
 */

const CountsSchema = z.object({
  perfect: z.number().int().min(0).max(4000).default(0),
  great: z.number().int().min(0).max(4000).default(0),
  good: z.number().int().min(0).max(4000).default(0),
  miss: z.number().int().min(0).max(4000).default(0),
});

const PlayerSchema = z.object({
  name: z.string().min(1).max(24),
  score: z.number().min(-100_000).max(1_000_000),
  accuracy: z.number().min(0).max(1),
  bestCombo: z.number().int().min(0).max(4000),
  counts: CountsSchema,
});

const CommentaryRequestSchema = z.object({
  round: z.number().int().min(0).max(7),
  totalRounds: z.number().int().min(1).max(8),
  /** Seat order. One entry when the opponent never connected. */
  players: z.array(PlayerSchema).min(1).max(2),
  final: z.boolean().default(false),
});

/**
 * Generous next to the 20-word brief. Clipping a good line that ran to 23 words
 * would cost more than it saves; anything past this is the model ignoring the
 * format entirely, and falling back is the right answer there.
 */
const CommentaryLineSchema = z.object({
  line: z.string().min(1).max(240),
});

interface CommentaryResponse {
  line: string;
  source: "model" | "fallback";
  model?: string;
  warning?: string;
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = await request.json().catch(() => null);
  const parsed = CommentaryRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", detail: parsed.error.issues },
      { status: 400 },
    );
  }
  const input: CommentaryInput = parsed.data;

  if (!isConfigured()) {
    const payload: CommentaryResponse = {
      line: localCommentary(input),
      source: "fallback",
      warning:
        "OPENROUTER_API_KEY is not set — using the built-in offline commentator.",
    };
    return NextResponse.json(payload);
  }

  try {
    const raw = await chat({
      messages: [
        { role: "system", content: COMMENTARY_SYSTEM },
        { role: "user", content: commentaryUserPrompt(input) },
      ],
      json: true,
      // Higher than the coach's: this is the one place in the app allowed a
      // personality, and a deterministic commentator repeats itself.
      temperature: 0.9,
      maxTokens: 300,
      signal: request.signal,
    });

    const { line } = CommentaryLineSchema.parse(extractJson(raw));
    const payload: CommentaryResponse = {
      line: tidy(line),
      source: "model",
      model: configuredModel(),
    };
    return NextResponse.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[commentary] model call failed:", message);
    const payload: CommentaryResponse = {
      line: localCommentary(input),
      source: "fallback",
      model: configuredModel(),
      warning: `Model call failed (${message}). Fell back to the offline commentator.`,
    };
    return NextResponse.json(payload);
  }
}

/** Models like to wrap a quoted call in quotes. The card adds its own framing. */
function tidy(line: string): string {
  return line.trim().replace(/\s+/g, " ").replace(/^["'“”]+|["'“”]+$/g, "");
}

// ────────────────────────────────────────────── the offline commentator

/**
 * Rule-based commentary.
 *
 * Not a placeholder: it reads the same five stories the model is asked to look
 * for — blowout, photo finish, combo, accuracy, recovery — decides which one the
 * numbers actually support, and says it with the real figures in it. Most duels
 * never see the model at all, so this is the voice of the game by default.
 */
function localCommentary(input: CommentaryInput): string {
  const [a, b] = input.players;
  if (!a) return "Nothing to call — not a note played.";

  const stake = input.final ? "the match" : "the round";
  // Rotating on the round keeps the offline commentator from saying the same
  // sentence three times in one duel, while staying a pure function of input.
  const seed = input.round + (input.final ? 1 : 0);

  if (!b) return pick(soloLines(a, stake), seed);

  const lead = a.score >= b.score ? a : b;
  const trail = lead === a ? b : a;
  const margin = lead.score - trail.score;
  const pool = Math.max(1, Math.abs(a.score) + Math.abs(b.score));
  const share = margin / pool;
  const accGap = lead.accuracy - trail.accuracy;
  const comboGap = lead.bestCombo - trail.bestCombo;
  const notes = played(lead.counts);

  if (margin === 0) {
    return pick(
      input.final
        ? [
            `A drawn match at ${a.score} apiece. Two players who refused to lose.`,
            `${a.name} and ${b.name} split it down the middle on ${a.score}. Nobody deserved to lose that.`,
          ]
        : [
            `${a.name} and ${b.name} finish level on ${a.score}. Somebody has to blink.`,
            `Dead heat at ${a.score} apiece — not a point between them.`,
          ],
      seed,
    );
  }

  if (lead.counts.miss === 0 && notes >= 8) {
    return pick(
      [
        `${lead.name} did not miss a single note — ${lead.counts.perfect} perfects and ${stake}.`,
        `Clean sheet from ${lead.name}: ${notes} notes, none dropped, ${margin} points clear.`,
      ],
      seed,
    );
  }

  if (margin <= 250 || share < 0.035) {
    const close = [
      `${lead.name} takes ${stake} by ${margin}. ${trail.name} was one clean run away.`,
      `Photo finish — ${margin} points across ${notes} notes, and ${trail.name} will want it back.`,
    ];
    if (margin < 300) {
      close.unshift(
        `${margin} points in it. ${lead.name} edges ${trail.name} by less than one perfect note.`,
      );
    }
    return pick(close, seed);
  }

  if (share >= 0.22) {
    return pick(
      [
        `${lead.name} ran away with ${stake} — ${margin} clear on a ${lead.bestCombo}-note combo.`,
        `${margin} points of daylight. ${lead.name} never gave ${trail.name} a foothold.`,
        `Not close: ${lead.name} by ${margin}, ${lead.counts.perfect} perfects to ${trail.counts.perfect}.`,
      ],
      seed,
    );
  }

  if (lead.counts.miss >= 4 && lead.bestCombo >= 12 && comboGap >= 0) {
    return pick(
      [
        `${lead.name} dropped ${lead.counts.miss} and still strung ${lead.bestCombo} together to win it.`,
        `${lead.name} rebuilt that one mid-air: ${lead.counts.miss} misses, then ${lead.bestCombo} straight.`,
      ],
      seed,
    );
  }

  if (comboGap >= 8 && accGap <= 0.02) {
    return pick(
      [
        `${lead.name}'s ${lead.bestCombo}-note run decided it, ${comboGap} longer than ${trail.name} managed.`,
        `The multiplier won that. ${lead.name} held ${lead.bestCombo} in a row without a break.`,
      ],
      seed,
    );
  }

  if (accGap >= 0.04 && comboGap <= 4) {
    return pick(
      [
        `${lead.name} won it clean: ${percent(lead.accuracy)}% to ${percent(trail.accuracy)}%, ${lead.counts.miss} misses to ${trail.counts.miss}.`,
        `Precision over fireworks — ${lead.name} hit ${percent(lead.accuracy)}% and let the misses do the rest.`,
      ],
      seed,
    );
  }

  return pick(
    [
      `${lead.name} takes ${stake} by ${margin}, ${lead.counts.perfect} perfects against ${trail.counts.perfect}.`,
      `${margin} to ${lead.name}, built on ${percent(lead.accuracy)}% and a ${lead.bestCombo}-note run.`,
    ],
    seed,
  );
}

function soloLines(p: CommentaryPlayer, stake: string): string[] {
  if (p.counts.miss === 0 && played(p.counts) >= 8) {
    return [
      `${p.name} played ${stake} alone and did not miss once — ${p.counts.perfect} perfects.`,
    ];
  }
  return [
    `${p.name} solo: ${p.score} points at ${percent(p.accuracy)}%, best run of ${p.bestCombo}.`,
    `No opponent, no excuses — ${p.name} banked ${p.score} on a ${p.bestCombo}-note run.`,
  ];
}

function played(counts: CommentaryPlayer["counts"]): number {
  return counts.perfect + counts.great + counts.good + counts.miss;
}

function percent(accuracy: number): number {
  return Math.round(accuracy * 100);
}

function pick(lines: string[], seed: number): string {
  return lines[Math.abs(seed) % lines.length];
}
