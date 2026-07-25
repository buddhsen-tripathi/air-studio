"use client";

import { memo } from "react";
import { useReplayAnimation } from "@/components/broadcast";
import type { Lane } from "@/lib/game/types";

/**
 * LaneOverlay — the lane furniture, in DOM, laid over the highway canvas.
 *
 * The canvas owns everything that moves: notes, beat grid, strike light,
 * per-lane judgement popups. This owns everything that does NOT — the keybed
 * under the hit line and the markers that pin the line to the edges of the
 * field. Splitting it that way means the labels get real typography (Saira, the
 * app's own weight and width axes, subpixel-hinted by the browser) instead of a
 * canvas fillText that has to be re-rasterised inside the same frame budget as
 * hand inference.
 *
 * ── Lining up with the canvas ────────────────────────────────────────────────
 * There is no measuring and no ResizeObserver here. The renderer's geometry is
 * `padX = clamp(6px, 3% of width, 48px)` with the lanes tiling the rest evenly,
 * and that is expressible in CSS exactly: percentage padding resolves against
 * the containing block's inline size, and this overlay shares its box with the
 * canvas. So one padding declaration plus `flex-1` children reproduces the
 * renderer's columns at every width, for free, with no frame of lag after a
 * resize.
 */

/** Must stay in step with HighwayRenderer.ensureLayout's `padX`. */
const GUTTER = "clamp(6px, 3%, 48px)";

/**
 * How far below the hit line the keybed starts.
 *
 * The renderer keeps drawing notes for a `fallout` band past the line so a late
 * hit still has something under the striker, and prints its own small lane
 * label at up to 26px + ~14px of type below it. 3rem clears both at every
 * canvas height, so the keybed reads as a separate register rather than
 * colliding with the tail of the playfield.
 */
const KEYBED_DROP = "3rem";

const FIELD_INSET = { paddingInline: GUTTER } as const;

export interface LaneOverlayProps {
  lanes: Lane[];
  /** 0..1 fraction of the highway's height. Pass HIT_LINE_Y from lib/game/lanes. */
  hitLineY: number;
  /**
   * Per-lane monotonic strike counter. Only the *change* is read, never the
   * value, so the orchestrator can reuse whatever counter it already keeps for
   * the canvas flash rather than inventing a second one.
   */
  laneFlashIds: number[];
  className?: string;
}

function LaneOverlayImpl({
  lanes,
  hitLineY,
  laneFlashIds,
  className = "",
}: LaneOverlayProps) {
  const hitTop = `${(hitLineY * 100).toFixed(3)}%`;

  return (
    <div
      className={`pointer-events-none absolute inset-0 select-none ${className}`}
    >
      <div
        aria-hidden
        className="absolute inset-x-0"
        style={{ ...FIELD_INSET, top: hitTop }}
      >
        {/* Zero-height so `top` is the line itself, not the top of a band. */}
        <div className="relative h-0">
          <HitMarker side="left" />
          <HitMarker side="right" />
        </div>
      </div>

      <ul
        aria-label="Piano lanes, low to high"
        className="absolute inset-x-0 bottom-0 flex items-start"
        style={{ ...FIELD_INSET, top: `calc(${hitTop} + ${KEYBED_DROP})` }}
      >
        {lanes.map((lane, i) => (
          <LaneKey
            key={lane.index}
            label={lane.label}
            flashId={laneFlashIds[i] ?? 0}
          />
        ))}
      </ul>
    </div>
  );
}

/**
 * The overlay re-renders only when a lane is actually struck — a few times a
 * second at most, against the ~10Hz score churn that drives the parent.
 *
 * The element-wise comparison is the whole point: the orchestrator hands us a
 * fresh `laneFlashIds` array most frames, so the default shallow compare would
 * see a new identity every time and memo would buy nothing. The loop is bounded
 * by MAX_LANES, so it is six comparisons at worst.
 */
export const LaneOverlay = memo(LaneOverlayImpl, (a, b) => {
  if (a.lanes !== b.lanes) return false;
  if (a.hitLineY !== b.hitLineY) return false;
  if (a.className !== b.className) return false;
  const prev = a.laneFlashIds;
  const next = b.laneFlashIds;
  if (prev === next) return true;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== next[i]) return false;
  }
  return true;
});
LaneOverlay.displayName = "LaneOverlay";

// ───────────────────────────────────────────────────────────────────── keybed

/**
 * One key of the keybed: a hairline capping the lane and the note it plays.
 *
 * The kick on strike is confirmation of *which column* took the input, which is
 * the one thing the canvas flash cannot say once two lanes are lit at the same
 * time — the labels move, so the eye can count them apart.
 */
const LaneKey = memo(function LaneKey({
  label,
  flashId,
}: {
  label: string;
  flashId: number;
}) {
  // Suppressed until the first strike: an animation replayed on mount would
  // make the whole keybed twitch at the start of every round.
  const kickRef = useReplayAnimation<HTMLLIElement>(
    "animate-combo",
    flashId,
    flashId > 0,
  );

  return (
    // className must stay byte-identical across renders — the animation class is
    // added imperatively, and React rewrites the whole attribute on any change.
    <li ref={kickRef} className="flex min-w-0 flex-1 flex-col items-center">
      <span aria-hidden className="h-px w-full bg-rule-bright" />
      <span className="plate-name mt-1.5 max-w-full truncate text-[clamp(0.7rem,1.6vw,1rem)] leading-none text-ink-3">
        {label}
      </span>
    </li>
  );
});

// ──────────────────────────────────────────────────────────────────── markers

/**
 * Inward-pointing ticks in the gutters, dead on the hit line.
 *
 * The renderer already ticks every lane boundary *inside* the field; these sit
 * outside it, so the line has ends. That is what makes it read as a fixed piece
 * of furniture the notes arrive at, rather than one more horizontal thing
 * sliding down with the beat grid.
 */
function HitMarker({ side }: { side: "left" | "right" }) {
  const left = side === "left";
  return (
    <span
      className={`absolute top-0 flex -translate-y-1/2 items-center text-ink-2 ${
        left ? "left-0 -translate-x-1/2" : "right-0 translate-x-1/2"
      }`}
    >
      <svg
        width="11"
        height="13"
        viewBox="0 0 11 13"
        fill="currentColor"
        aria-hidden
      >
        <path d={left ? "M0 0 L11 6.5 L0 13 Z" : "M11 0 L0 6.5 L11 13 Z"} />
      </svg>
    </span>
  );
}
