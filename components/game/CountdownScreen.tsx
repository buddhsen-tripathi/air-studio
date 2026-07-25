"use client";

import { memo } from "react";
import { useReplayAnimation } from "@/components/broadcast";
import { HIT_LINE_Y } from "@/lib/game/lanes";

/**
 * CountdownScreen — the last three seconds of calm.
 *
 * This is the final moment a player can read anything: from the first note on,
 * their hands are up and their eyes are locked to the falling notes. So it
 * carries the round, the chart, the one rule of the game, and — most usefully —
 * a preview of where the lanes and the hit line will actually be, drawn at the
 * same proportions the highway uses, so hands are already in position when the
 * count reaches zero.
 *
 * `secondsLeft` arrives fractional, typically once per animation frame. Every
 * part of the screen that only changes per whole second is memoised on the
 * integer, so a fractional tick re-renders this function and touches nothing
 * else — the big numeral in particular is never re-mounted, which would restart
 * its animation mid-second and make the count stutter.
 */

export interface CountdownScreenProps {
  /** May be fractional. */
  secondsLeft: number;
  round: number;
  roundLabel: string;
  totalRounds: number;
  chartTitle: string;
  bpm: number;
  laneCount: number;
}

/**
 * Side padding of the lane field, as a percentage of stage width.
 * Mirrors the 3% the highway renderer reserves, so a hand parked on lane 1 here
 * is on lane 1 when the notes start falling.
 */
const FIELD_PAD_PCT = 3;

/** Deterministic ghost-note heights, as a fraction of the drop to the hit line. */
const GHOST_DROP = [0.3, 0.46, 0.62];

export function CountdownScreen({
  secondsLeft,
  round,
  roundLabel,
  totalRounds,
  chartTitle,
  bpm,
  laneCount,
}: CountdownScreenProps) {
  const tick = Math.max(0, Math.ceil(secondsLeft));
  // Progress through the current second, 0 → 1. The only value on this screen
  // that is allowed to consume the fractional part, and it lands on a transform.
  const sweep = tick <= 0 ? 1 : Math.min(1, Math.max(0, tick - secondsLeft));

  return (
    <main className="broadcast-field flex h-full min-h-screen w-full flex-col overflow-hidden">
      <RoundHeader
        round={round}
        roundLabel={roundLabel}
        totalRounds={totalRounds}
        chartTitle={chartTitle}
        bpm={bpm}
        laneCount={laneCount}
      />

      <div className="rule-h mt-5 shrink-0" aria-hidden />

      <div className="relative min-h-0 flex-1">
        <LanePreview laneCount={laneCount} />

        {/*
         * The count sits centred in the space *above* the hit line rather than
         * the middle of the screen, so it never covers the lane keys — the one
         * thing on this screen the player has to act on.
         */}
        <div
          className="absolute inset-x-0 top-0 flex flex-col items-center justify-center gap-4"
          style={{ height: `${HIT_LINE_Y * 100}%` }}
        >
          <CountFace tick={tick} />
          <span
            aria-hidden
            className="h-[2px] w-[min(14rem,40vw)] origin-left bg-ink-3 motion-reduce:hidden"
            style={{ transform: `scaleX(${sweep})` }}
          />
        </div>
      </div>

      <div className="rule-h shrink-0" aria-hidden />

      <footer className="shrink-0 px-6 py-5 text-center sm:px-10">
        <p className="text-[clamp(0.95rem,1.8vw,1.25rem)] leading-snug text-ink-2">
          Strike down through a column as its note reaches the line.{" "}
          <span className="text-ink-3">
            The chart picks the pitch — you only have to land the timing.
          </span>
        </p>
      </footer>
    </main>
  );
}

// ─────────────────────────────────────────────────────────────────── the count

/**
 * Memoised on the integer second, so the fractional stream from the parent
 * never reaches it. `useReplayAnimation` re-fires `.animate-count` on each new
 * integer without remounting the node, which keeps the element (and its layout)
 * stable across the whole countdown.
 */
const CountFace = memo(function CountFace({ tick }: { tick: number }) {
  const face = useReplayAnimation<HTMLDivElement>("animate-count", tick);
  const glyph = tick > 0 ? String(tick) : "Go";

  return (
    <>
      {/* Identical text between renders, so this announces once per second and
          not once per frame. */}
      <p role="timer" aria-live="assertive" aria-atomic className="sr-only">
        {glyph}
      </p>
      <div
        ref={face}
        aria-hidden
        className="display text-[clamp(7rem,34vh,22rem)] leading-none text-ink will-change-transform"
      >
        {glyph}
      </div>
    </>
  );
});

// ────────────────────────────────────────────────────────────────────── header

const RoundHeader = memo(function RoundHeader({
  round,
  roundLabel,
  totalRounds,
  chartTitle,
  bpm,
  laneCount,
}: Omit<CountdownScreenProps, "secondsLeft">) {
  return (
    // Asymmetric on purpose: the round reads left-to-right, the chart metadata
    // mirrors back right-to-left, the way a real scorebug frames a matchup.
    <header className="flex shrink-0 items-end justify-between gap-6 px-6 pt-6 sm:px-10 sm:pt-8">
      <div className="min-w-0">
        <p className="label">
          Round {round} of {totalRounds}
        </p>
        <h1 className="display mt-1.5 truncate text-[clamp(1.75rem,4.6vw,3.5rem)] text-ink">
          {roundLabel}
        </h1>
      </div>

      <div className="min-w-0 text-right">
        <p className="label">Chart</p>
        <p className="plate-name mt-1.5 truncate text-[clamp(0.95rem,2vw,1.5rem)] text-ink-2">
          {chartTitle}
        </p>
        <p className="numeral mt-1 text-[0.8125rem] text-ink-3">
          {bpm} BPM &middot; {laneCount} lanes
        </p>
      </div>
    </header>
  );
});

// ───────────────────────────────────────────────────────────── lane preview

/**
 * A still frame of the highway.
 *
 * Purely decorative to a screen reader — the lane count is already stated in
 * the header — but load-bearing for the player, who is about to point their
 * hands at these exact columns. Positions come from the same HIT_LINE_Y the
 * renderer and the trigger zones use, so the preview cannot drift from the
 * real thing.
 */
const LanePreview = memo(function LanePreview({
  laneCount,
}: {
  laneCount: number;
}) {
  const lanes = Array.from(
    { length: Math.max(1, Math.min(Math.round(laneCount), 8)) },
    (_, i) => i,
  );
  const edge = { left: `${FIELD_PAD_PCT}%`, right: `${FIELD_PAD_PCT}%` };

  return (
    <div aria-hidden className="absolute inset-0 overflow-hidden">
      {/* Lane columns, separated by hairlines rather than boxed in. */}
      <div className="absolute inset-y-0 flex" style={edge}>
        {lanes.map((i) => (
          <div
            key={i}
            className="relative flex-1 border-l border-rule bg-gradient-to-b from-transparent to-white/[0.025] first:border-l-0"
          >
            {/* One ghost note per lane: says "things fall down here" faster
                than any label could. */}
            <span
              className="absolute left-1/2 h-[0.9%] min-h-[6px] w-[58%] -translate-x-1/2 rounded-[2px] bg-ink/15"
              style={{
                top: `${HIT_LINE_Y * GHOST_DROP[i % GHOST_DROP.length] * 100}%`,
              }}
            />
          </div>
        ))}
      </div>

      <div
        className="absolute h-px bg-rule-bright"
        style={{ ...edge, top: `${HIT_LINE_Y * 100}%` }}
      />

      {/* Key caps straddling the hit line — the literal target for each hand. */}
      <div
        className="absolute flex -translate-y-1/2 items-start"
        style={{ ...edge, top: `${HIT_LINE_Y * 100}%` }}
      >
        {lanes.map((i) => (
          <div key={i} className="flex flex-1 flex-col items-center">
            <span className="h-1.5 w-[62%] rounded-[1px] bg-ink-2" />
            <span className="numeral mt-3 text-[0.75rem] text-ink-3">
              {i + 1}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
});
