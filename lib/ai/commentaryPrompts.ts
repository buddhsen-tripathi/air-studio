import type { Judgement } from "@/lib/game/types";

/**
 * Prompt for the round-break commentator.
 *
 * The commentary line is the personality of the game — it is the only place
 * anything speaks to the players — and it fires during a break that lasts a few
 * seconds, so it has exactly one job: say the thing that decided the round,
 * fast. Everything in the system prompt below is aimed at killing the two
 * failure modes a model falls into unprompted: generic hype ("what a round!"),
 * which is worse than silence because it teaches players to stop reading, and
 * dunking on the loser, which is unbearable when the loser is standing three
 * feet away.
 *
 * The user prompt hands over pre-computed deltas rather than raw numbers alone.
 * Models are unreliable at arithmetic and a commentator who gets the margin
 * wrong is worse than no commentator at all — the players can see the scoreboard.
 */

export interface CommentaryPlayer {
  name: string;
  score: number;
  /** 0..1, as in ScoreState. */
  accuracy: number;
  bestCombo: number;
  counts: Record<Judgement, number>;
}

export interface CommentaryInput {
  /** 0-based, as in RoundSpec.index. */
  round: number;
  totalRounds: number;
  /** Seat order. One entry when the opponent never connected. */
  players: CommentaryPlayer[];
  /** The match is over, not just the round. */
  final: boolean;
}

export const COMMENTARY_SYSTEM = `You are the commentator on Air Piano Duel, a two-player webcam rhythm game.

Two players stand in front of their own webcams and strike falling notes out of
the air. A round just ended. You get their numbers and you call it — ONE line,
over the round card, while they catch their breath.

THE LINE
- One sentence. 20 words maximum. Shorter lands harder.
- Name the stat that actually decided it, with the number in it. "Ada's 42-note
  run" beats "Ada was on fire" every single time.
- Use their real names, never "Player 1".
- Confident and playful — a broadcaster enjoying the duel, not a scoreboard
  reading itself aloud.

FIND THE ONE THING THAT EXPLAINS THE RESULT
- Blowout: say how big, and say what opened it up.
- Photo finish: say how close in points. Under 300 is less than one perfect note
  — that is worth saying out loud.
- Accuracy versus combo: a round can be won by hitting everything cleanly or by
  one enormous unbroken run. Those are different stories. Tell the right one.
- Recovery: a pile of misses AND a long best combo means they fell apart and
  rebuilt mid-round. That is the best story on this list.
- A clean sheet: zero misses is worth calling on its own, whoever won.

NEVER
- Never mock, pity or scold whoever lost. Beat them with the numbers and leave
  them their dignity — they are standing next to the winner.
- Never be generic. "Great job everyone", "what a round", "both played well" are
  failures. If your line would fit any other round of any other game, it is wrong.
- Never invent a number you were not given, and never contradict one you were.

Return ONE JSON object, no prose, no markdown fences:
{ "line": "The call, max 20 words." }`;

export function commentaryUserPrompt(input: CommentaryInput): string {
  const parts: string[] = [
    input.final
      ? `FINAL — the match is over after ${input.totalRounds} round${input.totalRounds === 1 ? "" : "s"}. Call the match, not just this round.`
      : `End of round ${input.round + 1} of ${input.totalRounds}.`,
    input.players.map(statLine).join("\n"),
  ];

  const [a, b] = input.players;

  if (b) {
    const lead = a.score >= b.score ? a : b;
    const trail = lead === a ? b : a;
    const margin = lead.score - trail.score;

    parts.push(
      [
        "READ (already computed — use these, do not recalculate):",
        margin === 0
          ? `Dead level on ${lead.score} points.`
          : `${lead.name} is ahead by ${margin} points.`,
        `Accuracy gap: ${pct(lead.accuracy)}% vs ${pct(trail.accuracy)}%.`,
        `Best combo: ${lead.name} ${lead.bestCombo}, ${trail.name} ${trail.bestCombo}.`,
        `Misses: ${lead.name} ${lead.counts.miss}, ${trail.name} ${trail.counts.miss}.`,
      ].join("\n"),
    );
  } else if (a) {
    parts.push(
      "READ: they played this round alone — no opponent connected. Call their own performance.",
    );
  }

  parts.push("Return only the JSON object.");
  return parts.join("\n\n");
}

function statLine(p: CommentaryPlayer): string {
  const c = p.counts;
  return (
    `${p.name}: ${p.score} points · ${pct(p.accuracy)}% accuracy · best combo ${p.bestCombo} · ` +
    `${c.perfect} perfect, ${c.great} great, ${c.good} good, ${c.miss} miss`
  );
}

function pct(accuracy: number): string {
  return (accuracy * 100).toFixed(1);
}
