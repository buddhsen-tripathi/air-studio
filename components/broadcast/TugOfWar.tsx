"use client";

import { Numeral, SEAT, varColor } from "./Numeral";

/**
 * TugOfWar — who is winning, answered in one glance and no reading.
 *
 * The bar is territory, not a gauge. Each player owns their half at rest; the
 * leader's colour pushes the front line across the centre into the loser's
 * ground, and the stolen strip is drawn at full intensity while the home ground
 * stays washed out. So the eye lands on one bright wedge whose *side* is who is
 * ahead and whose *width* is by how much — no axis, no legend, no number.
 */

/**
 * Score added to both sides before taking the share.
 *
 * A raw share is useless early: the first note of the match makes it 100/0 and
 * the bar slams to the wall over a 300-point lead that means nothing. Padding
 * both sides holds the front line near the centre until real distance opens up,
 * then fades out of the way as scores grow past it. Roughly five perfect notes
 * — the point at which a lead starts being a lead.
 */
export const TUG_STABILISER = 1500;

/** 0..1 — p1's share of the territory. Exactly 0.5 when the scores are level. */
export function scoreShare(p1Score: number, p2Score: number): number {
  const a = Math.max(0, p1Score) + TUG_STABILISER;
  const b = Math.max(0, p2Score) + TUG_STABILISER;
  return a / (a + b);
}

/**
 * The loser never gets wiped off the bar. A sliver of their colour has to
 * survive or the bar stops reading as a contest between two players and starts
 * reading as a progress meter.
 */
const FLOOR = 0.07;

export type TugOfWarSize = "sm" | "md";

export interface TugOfWarProps {
  p1Score: number;
  p2Score: number;
  p1Name?: string;
  p2Name?: string;
  /** Hide the header row entirely — for the thin strip under a scorebug. */
  bare?: boolean;
  size?: TugOfWarSize;
  className?: string;
}

export function TugOfWar({
  p1Score,
  p2Score,
  p1Name = "Player 1",
  p2Name = "Player 2",
  bare = false,
  size = "md",
  className = "",
}: TugOfWarProps) {
  const share = Math.min(
    1 - FLOOR,
    Math.max(FLOOR, scoreShare(p1Score, p2Score)),
  );
  const pct = share * 100;
  const lead = Math.round(p1Score - p2Score);
  const leader = lead === 0 ? null : lead > 0 ? 0 : 1;
  const accent = leader === null ? null : SEAT[leader];

  // The pushed-past-centre wedge. Drawn as one absolutely positioned strip
  // between the centre and the front line, so it has no width at parity.
  const wedgeLeft = Math.min(50, pct);
  const wedgeWidth = Math.abs(50 - pct);

  const valueText =
    leader === null
      ? "Scores level"
      : `${leader === 0 ? p1Name : p2Name} leads by ${Math.abs(lead)}`;

  return (
    <div
      className={`flex min-w-0 flex-col ${bare ? "" : "gap-2"} ${className}`}
    >
      {!bare && (
        <div className="flex items-center justify-between gap-3">
          <span className="label truncate" style={varColor(SEAT[0].cssVar)}>
            {p1Name}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {leader === null ? (
              <span className="label">level</span>
            ) : (
              <>
                <Numeral
                  value={Math.abs(lead)}
                  size="sm"
                  tone={leader === 0 ? "p1" : "p2"}
                  prefix="+"
                />
                {/* Redundant with the colour on purpose: direction survives
                    being seen out of the corner of an eye, hue does not. */}
                <span
                  aria-hidden
                  className="label"
                  style={accent ? varColor(accent.cssVar) : undefined}
                >
                  {leader === 0 ? "◀" : "▶"}
                </span>
              </>
            )}
          </span>
          <span className="label truncate" style={varColor(SEAT[1].cssVar)}>
            {p2Name}
          </span>
        </div>
      )}

      <div
        role="meter"
        aria-label="Score lead"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-valuetext={valueText}
        className={`relative w-full overflow-hidden bg-chrome ${size === "sm" ? "h-[3px]" : "h-2.5"}`}
      >
        <div
          className="absolute inset-y-0 left-0 bg-p1/30 transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
        <div
          className="absolute inset-y-0 right-0 bg-p2/30 transition-[width] duration-500 ease-out"
          style={{ width: `${100 - pct}%` }}
        />
        <div
          className={`absolute inset-y-0 transition-[left,width] duration-500 ease-out ${
            leader === 0 ? "bg-p1" : leader === 1 ? "bg-p2" : ""
          }`}
          style={{ left: `${wedgeLeft}%`, width: `${wedgeWidth}%` }}
        />
        {/* Origin tick: without a fixed reference the wedge has nothing to be
            measured against and the whole thing degrades into a split bar. */}
        <span
          aria-hidden
          className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-stage/90"
        />
        <span
          aria-hidden
          className={`absolute inset-y-0 w-[2px] -translate-x-1/2 bg-ink transition-[left] duration-500 ease-out ${
            accent ? accent.glow : ""
          }`}
          style={{ left: `${pct}%` }}
        />
      </div>
    </div>
  );
}
