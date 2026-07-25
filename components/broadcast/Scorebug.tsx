"use client";

import { comboMultiplier } from "@/lib/game/types";
import {
  Numeral,
  SEAT,
  useReplayAnimation,
  varColor,
  type Seat,
} from "./Numeral";
import { scoreShare } from "./TugOfWar";

/**
 * Scorebug — the persistent top bar, and the thing on screen the players
 * actually check.
 *
 * Layout is the argument here. Both scores sit *inboard*, immediately either
 * side of the centre column, so comparing them is one short saccade instead of
 * a sweep across the full width of a monitor. Names sit outboard, where they
 * are needed once and then never again. P2's whole block is mirrored, so the
 * bar is a real scorebug rather than two identical widgets in a row: which side
 * the accent bar and the name sit on identifies the player pre-attentively.
 *
 * Scores deliberately have no aria-live region. They change several times a
 * second during play and an assistive tech user would be buried in
 * announcements; the round and match transitions are the events worth
 * announcing, and they belong to the screens that own those phases.
 */

export interface ScorebugSide {
  name: string;
  score: number;
  combo?: number;
  /** 0..1. Hidden below the `sm` breakpoint — it is the least urgent number. */
  accuracy?: number;
  connected?: boolean;
  you?: boolean;
}

export interface ScorebugProps {
  p1: ScorebugSide;
  p2: ScorebugSide;
  /** 0-based, as in RoundSpec.index. */
  round?: number;
  totalRounds?: number;
  /** RoundSpec.label, e.g. "VERSE" or "FINALE". */
  roundLabel?: string;
  suddenDeath?: boolean;
  live?: boolean;
  /** Seconds. Elapsed or remaining — the caller decides what it means. */
  timeSec?: number;
  timeLabel?: string;
  /** The territory strip along the bottom edge. */
  leadStrip?: boolean;
  className?: string;
}

export function Scorebug({
  p1,
  p2,
  round,
  totalRounds,
  roundLabel,
  suddenDeath = false,
  live = false,
  timeSec,
  timeLabel,
  leadStrip = true,
  className = "",
}: ScorebugProps) {
  return (
    <section
      aria-label="Scorebug"
      className={`broadcast-field relative w-full select-none ${className}`}
    >
      <div className="flex items-center gap-2 px-3 py-2 sm:gap-5 sm:px-6 sm:py-2.5">
        <Side seat={0} side={p1} />
        <Divider />
        <Centre
          round={round}
          totalRounds={totalRounds}
          roundLabel={roundLabel}
          suddenDeath={suddenDeath}
          live={live}
          timeSec={timeSec}
          timeLabel={timeLabel}
        />
        <Divider />
        <Side seat={1} side={p2} />
      </div>

      {leadStrip ? (
        <LeadStrip p1Score={p1.score} p2Score={p2.score} />
      ) : (
        <div className="rule-h" aria-hidden />
      )}
    </section>
  );
}

function Divider() {
  return (
    <span
      aria-hidden
      className="hidden h-9 w-px shrink-0 bg-rule sm:block lg:h-12"
    />
  );
}

// ──────────────────────────────────────────────────────────────────── one side

function Side({ seat, side }: { seat: Seat; side: ScorebugSide }) {
  const accent = SEAT[seat];
  const mirrored = seat === 1;
  const offline = side.connected === false;

  return (
    <div
      className={`flex min-w-0 flex-1 items-center gap-2 sm:gap-4 ${mirrored ? "flex-row-reverse" : ""}`}
    >
      <span
        aria-hidden
        className={`h-8 w-[3px] shrink-0 sm:h-10 lg:h-12 ${accent.fill} ${offline ? "opacity-30" : ""}`}
      />

      <div
        className={`flex min-w-0 flex-1 flex-col gap-0.5 ${mirrored ? "items-end text-right" : "items-start text-left"}`}
      >
        <span
          className={`plate-name w-full truncate text-[clamp(0.8rem,2vw,1.15rem)] leading-tight ${offline ? "text-ink-3" : "text-ink"}`}
        >
          {side.name}
        </span>
        <span
          className={`flex w-full min-w-0 items-center gap-2 ${mirrored ? "justify-end" : ""}`}
        >
          {side.you && (
            <span className="label shrink-0" style={varColor(accent.cssVar)}>
              you
            </span>
          )}
          {offline ? (
            <span
              className="label shrink-0"
              style={varColor("var(--color-miss)")}
            >
              offline
            </span>
          ) : (
            side.accuracy !== undefined && (
              <span className="hidden shrink-0 items-center gap-1 sm:flex">
                <Numeral
                  value={side.accuracy * 100}
                  size="sm"
                  tone="muted"
                  decimals={1}
                  suffix="%"
                />
                <span className="label">acc</span>
              </span>
            )
          )}
        </span>
      </div>

      <div
        className={`flex shrink-0 flex-col ${mirrored ? "items-start" : "items-end"}`}
      >
        <span className="sr-only">{`${side.name} score`}</span>
        {/* minDigits ghosts leading zeros so a 999 → 1000 rollover cannot shove
            the centre column sideways mid-round. */}
        <Numeral
          value={side.score}
          size="xl"
          tone={seat === 0 ? "p1" : "p2"}
          minDigits={4}
        />
        <ComboReadout seat={seat} combo={side.combo ?? 0} mirrored={mirrored} />
      </div>
    </div>
  );
}

/**
 * Combo and multiplier, always rendered even at zero.
 *
 * Fading rather than unmounting: a row that appears on the first note and
 * vanishes on the first miss would make the score above it jump every time,
 * which is exactly the kind of movement the eye chases at the worst moment.
 */
function ComboReadout({
  seat,
  combo,
  mirrored,
}: {
  seat: Seat;
  combo: number;
  mirrored: boolean;
}) {
  const accent = SEAT[seat];
  // Read the multiplier from the frozen scoring rule rather than re-deriving
  // it, so the display can never disagree with what the judge awarded.
  const multiplier = comboMultiplier(combo);
  const kickRef = useReplayAnimation<HTMLSpanElement>(
    "animate-combo",
    combo,
    combo > 0,
  );

  return (
    <span
      className={`flex items-center gap-1.5 transition-opacity duration-200 ${
        combo > 0 ? "opacity-100" : "opacity-0"
      } ${mirrored ? "flex-row-reverse" : ""}`}
      aria-hidden={combo === 0}
    >
      <span ref={kickRef} className="inline-flex items-center gap-1">
        <Numeral value={combo} size="sm" tone="ink" />
        <span className="label">combo</span>
      </span>
      <span
        className={`label transition-opacity duration-200 ${multiplier > 1 ? "opacity-100" : "opacity-0"}`}
        style={varColor(accent.cssVar)}
      >
        &times;{multiplier}
      </span>
    </span>
  );
}

// ────────────────────────────────────────────────────────────────────── centre

function Centre({
  round,
  totalRounds,
  roundLabel,
  suddenDeath,
  live,
  timeSec,
  timeLabel,
}: {
  round?: number;
  totalRounds?: number;
  roundLabel?: string;
  suddenDeath: boolean;
  live: boolean;
  timeSec?: number;
  timeLabel?: string;
}) {
  return (
    <div className="flex shrink-0 flex-col items-center gap-0.5 px-1">
      <span className="flex h-3 items-center gap-1.5">
        {suddenDeath ? (
          <span className="label" style={varColor("var(--color-miss)")}>
            sudden death
          </span>
        ) : live ? (
          <>
            <span
              aria-hidden
              className="animate-live h-[6px] w-[6px] shrink-0 rounded-full bg-live"
            />
            <span className="label" style={varColor("var(--color-live)")}>
              live
            </span>
          </>
        ) : null}
      </span>

      {round !== undefined && (
        <span className="flex items-baseline gap-0.5">
          <span className="sr-only">
            {totalRounds === undefined
              ? `Round ${round + 1}`
              : `Round ${round + 1} of ${totalRounds}`}
          </span>
          <span
            aria-hidden
            className="display text-[clamp(1.05rem,2.8vw,1.75rem)] text-ink"
          >
            R{round + 1}
          </span>
          {totalRounds !== undefined && (
            <span
              aria-hidden
              className="display text-[clamp(0.7rem,1.7vw,1.05rem)] text-ink-3"
            >
              /{totalRounds}
            </span>
          )}
        </span>
      )}

      {roundLabel && (
        <span className="label hidden max-w-[16ch] truncate md:block">
          {roundLabel}
        </span>
      )}

      {timeSec !== undefined && <Clock seconds={timeSec} label={timeLabel} />}
    </div>
  );
}

function Clock({ seconds, label }: { seconds: number; label?: string }) {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;

  return (
    <span className="flex items-center gap-1.5">
      <span className="sr-only">
        {`${label ?? "Time"} ${minutes} minutes ${rest} seconds`}
      </span>
      {label && (
        <span aria-hidden className="label hidden sm:block">
          {label}
        </span>
      )}
      <span aria-hidden className="flex items-center">
        <Numeral value={minutes} size="sm" tone="muted" />
        <span className="flex h-[1.12em] items-center px-[1px] text-[0.8125rem] font-semibold leading-none text-ink-3">
          :
        </span>
        <Numeral
          value={rest}
          size="sm"
          tone="muted"
          minDigits={2}
          ghostPad={false}
        />
      </span>
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────── lead strip

/**
 * A 3px territory strip doubling as the bar's bottom edge.
 *
 * Same maths as TugOfWar, so the two never disagree; this is the ambient
 * version — it lives in peripheral vision the whole match and only ever needs
 * to answer "which colour is winning".
 */
function LeadStrip({ p1Score, p2Score }: { p1Score: number; p2Score: number }) {
  const pct = scoreShare(p1Score, p2Score) * 100;
  return (
    <div
      aria-hidden
      className="relative h-[3px] w-full overflow-hidden bg-rule"
    >
      <div
        className="absolute inset-y-0 left-0 bg-p1 transition-[width] duration-500 ease-out"
        style={{ width: `${pct}%` }}
      />
      <div
        className="absolute inset-y-0 right-0 bg-p2 transition-[width] duration-500 ease-out"
        style={{ width: `${100 - pct}%` }}
      />
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-stage/80" />
    </div>
  );
}
