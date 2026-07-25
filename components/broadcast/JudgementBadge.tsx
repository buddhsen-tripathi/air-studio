"use client";

import type { Judgement } from "@/lib/game/types";
import { useReplayAnimation } from "./Numeral";

/**
 * JudgementBadge — the PERFECT / GREAT / GOOD / MISS callout.
 *
 * Judgements are read in peripheral vision while the player's eyes are on the
 * falling notes, so the *colour* has to carry the meaning before the word does:
 * green reads as good, pink-red as bad, at any distance and any glance length.
 * The word is the confirmation, not the signal.
 */

export type JudgementBadgeSize = "sm" | "md" | "lg";

const SIZE: Record<JudgementBadgeSize, string> = {
  sm: "text-[0.7rem] px-2 py-[3px] gap-1.5",
  md: "text-[clamp(0.9rem,2vw,1.15rem)] px-3 py-1 gap-2",
  lg: "text-[clamp(1.5rem,5vw,2.75rem)] px-5 py-1.5 gap-3",
};

const TONE: Record<Judgement, { text: string; wash: string; dot: string }> = {
  perfect: { text: "text-perfect", wash: "bg-perfect/12", dot: "bg-perfect" },
  great: { text: "text-great", wash: "bg-great/12", dot: "bg-great" },
  good: { text: "text-good", wash: "bg-good/12", dot: "bg-good" },
  miss: { text: "text-miss", wash: "bg-miss/14", dot: "bg-miss" },
};

export interface JudgementBadgeProps {
  judgement: Judgement;
  size?: JudgementBadgeSize;
  /**
   * Bump on every new hit to replay the pop. Without it, two PERFECTs in a row
   * would render identical props and the animation would never re-fire.
   */
  seq?: number;
  /**
   * `animate` runs the pop, which ends at opacity 0 — right for a floating
   * in-play callout, wrong for a static badge on a summary screen.
   */
  animate?: boolean;
  className?: string;
}

export function JudgementBadge({
  judgement,
  size = "md",
  seq = 0,
  animate = true,
  className = "",
}: JudgementBadgeProps) {
  const tone = TONE[judgement];
  // The animated class is added imperatively, so this wrapper's className must
  // stay constant across renders or React will strip it on the next patch.
  const ref = useReplayAnimation<HTMLSpanElement>(
    "animate-judgement",
    `${judgement}:${seq}`,
    animate,
  );

  return (
    <span ref={ref} className={`inline-block ${className}`}>
      {/*
       * No live region. Judgements land several times a second, so announcing
       * them would drown out everything else an assistive tech user needs to
       * hear; the round and match summaries are where the outcome gets read.
       */}
      <span
        className={`inline-flex items-center ${SIZE[size]} ${tone.wash} ${tone.text} display`}
      >
        <span
          aria-hidden
          className={`h-[0.4em] w-[0.4em] shrink-0 ${tone.dot}`}
        />
        {judgement}
      </span>
    </span>
  );
}
