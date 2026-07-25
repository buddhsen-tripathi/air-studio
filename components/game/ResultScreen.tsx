"use client";

import type { CSSProperties } from "react";
import type { RoundSummary } from "@/lib/game/types";
import {
  Button,
  NamePlate,
  Numeral,
  SEAT,
  StatRow,
  varColor,
  type Seat,
} from "@/components/broadcast";

/**
 * ResultScreen — the post-match card.
 *
 * A win gets the full broadcast treatment: the verdict lands first and the rest
 * of the card assembles under it on a stagger, so the screen resolves the way a
 * results package does on television. A loss gets the identical information
 * with the stagger switched off — everything arrives at once, quietly. Nobody
 * wants their defeat choreographed, and a screen that gloats is a screen people
 * close before they see the rematch button.
 *
 * The per-round chart is bars in divs on purpose. It plots at most eight pairs
 * of numbers and it has to be legible at two metres; a charting library would
 * cost more bytes than the rest of this screen and give back axes and legends
 * nobody standing that far away can read.
 */

export interface ResultSide extends RoundSummary {
  name: string;
  seat: Seat;
}

export interface ResultScreenProps {
  /** Null means a draw. */
  winnerId: string | null;
  youId: string;
  you: ResultSide;
  opponent: ResultSide | null;
  perRound: { round: number; you: number; opponent: number }[];
  commentary: string | null;
  onRematch: () => void;
  onExit: () => void;
}

const STAGGER_MS = 110;

export function ResultScreen({
  winnerId,
  youId,
  you,
  opponent,
  perRound,
  commentary,
  onRematch,
  onExit,
}: ResultScreenProps) {
  const outcome: "win" | "loss" | "draw" =
    winnerId === null ? "draw" : winnerId === youId ? "win" : "loss";
  const celebrate = outcome === "win";

  const seat0 = you.seat === 0 ? you : opponent;
  const seat1 = you.seat === 0 ? opponent : you;

  const winnerSeat: Seat | null =
    outcome === "draw"
      ? null
      : outcome === "win"
        ? you.seat
        : (opponent?.seat ?? null);

  const verdict =
    outcome === "win" ? "winner" : outcome === "loss" ? "defeat" : "draw";
  const verdictColour =
    outcome === "win" && winnerSeat !== null
      ? SEAT[winnerSeat].cssVar
      : "var(--color-ink)";

  const subtitle =
    outcome === "win"
      ? "you take the match"
      : outcome === "loss"
        ? `${opponent?.name ?? "your opponent"} takes the match`
        : "the match ends level";

  const roundsYou = perRound.filter((r) => r.you > r.opponent).length;
  const roundsOpponent = perRound.filter((r) => r.opponent > r.you).length;

  // `.animate-sweep` fills `both`, so a delayed block starts invisible and the
  // card assembles in order. Reduced motion kills the animation outright in
  // globals.css, which leaves everything painted immediately — no trap.
  const reveal = (step: number): CSSProperties | undefined =>
    celebrate ? { animationDelay: `${step * STAGGER_MS}ms` } : undefined;

  return (
    <section
      aria-label="Match result"
      className="broadcast-field flex min-h-full w-full flex-col px-4 py-4 sm:px-8 sm:py-6"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto sm:gap-7">
        <header className="animate-sweep shrink-0 text-center">
          <h1
            className="display text-[clamp(3rem,13vw,8.5rem)]"
            style={{ color: verdictColour }}
          >
            {verdict}
          </h1>
          <p className="label mt-1">{subtitle}</p>
        </header>

        {commentary && (
          <p
            className="animate-sweep mx-auto max-w-3xl text-center text-[clamp(1rem,2.4vw,1.45rem)] font-semibold leading-[1.35] [font-stretch:96%] text-ink"
            style={reveal(1)}
          >
            {commentary}
          </p>
        )}

        <div
          className="animate-sweep mx-auto flex w-full max-w-4xl items-stretch gap-3 sm:gap-6"
          style={reveal(2)}
        >
          <FinalSide
            side={seat0}
            seat={0}
            crowned={winnerSeat === 0}
            defeated={winnerSeat === 1}
            isYou={you.seat === 0}
          />
          <div className="flex w-16 shrink-0 flex-col items-center justify-center gap-1 sm:w-24">
            <span className="label">rounds</span>
            <span className="sr-only">
              {`${roundsYou} rounds to you, ${roundsOpponent} to your opponent`}
            </span>
            <span aria-hidden className="flex items-center gap-1.5">
              <Numeral
                value={you.seat === 0 ? roundsYou : roundsOpponent}
                size="lg"
                tone="p1"
              />
              <span className="numeral text-ink-3">&ndash;</span>
              <Numeral
                value={you.seat === 0 ? roundsOpponent : roundsYou}
                size="lg"
                tone="p2"
              />
            </span>
          </div>
          <FinalSide
            side={seat1}
            seat={1}
            crowned={winnerSeat === 1}
            defeated={winnerSeat === 0}
            isYou={you.seat === 1}
          />
        </div>

        <div
          className="animate-sweep mx-auto w-full max-w-4xl"
          style={reveal(3)}
        >
          {seat0 && seat1 ? (
            <>
              <StatRow
                label="accuracy"
                p1={seat0.accuracy * 100}
                p2={seat1.accuracy * 100}
                decimals={1}
                suffix="%"
                size="lg"
              />
              <StatRow
                label="best combo"
                p1={seat0.bestCombo}
                p2={seat1.bestCombo}
                size="lg"
              />
              <StatRow
                label="perfect"
                p1={seat0.counts.perfect}
                p2={seat1.counts.perfect}
                size="sm"
              />
              <StatRow
                label="miss"
                p1={seat0.counts.miss}
                p2={seat1.counts.miss}
                size="sm"
                higherIsBetter={false}
              />
            </>
          ) : (
            <>
              <StatRow
                label="accuracy"
                p1={you.accuracy * 100}
                decimals={1}
                suffix="%"
                size="lg"
              />
              <StatRow label="best combo" p1={you.bestCombo} size="lg" />
              <StatRow label="perfect" p1={you.counts.perfect} size="sm" />
              <StatRow label="miss" p1={you.counts.miss} size="sm" />
            </>
          )}
        </div>

        {perRound.length > 0 && (
          <div
            className="animate-sweep mx-auto w-full max-w-4xl"
            style={reveal(4)}
          >
            <RoundChart
              perRound={perRound}
              you={you}
              opponent={opponent}
              className="pb-1"
            />
          </div>
        )}
      </div>

      <div className="rule-h shrink-0" aria-hidden />

      <footer
        className="animate-sweep flex shrink-0 flex-wrap items-center justify-center gap-3 pt-4 sm:gap-4"
        style={reveal(5)}
      >
        <Button
          variant="primary"
          size="lg"
          accent={you.seat}
          onClick={onRematch}
        >
          rematch
        </Button>
        <Button variant="ghost" size="lg" onClick={onExit}>
          leave
        </Button>
      </footer>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────── final scores

function FinalSide({
  side,
  seat,
  crowned,
  defeated,
  isYou,
}: {
  side: ResultSide | null;
  seat: Seat;
  crowned: boolean;
  defeated: boolean;
  isYou: boolean;
}) {
  const mirrored = seat === 1;

  if (!side) {
    return (
      <div
        className={`flex min-w-0 flex-1 flex-col justify-center ${mirrored ? "items-end" : "items-start"}`}
      >
        <span className="label">no opponent</span>
      </div>
    );
  }

  return (
    <div
      className={`flex min-w-0 flex-1 flex-col gap-2 ${mirrored ? "items-end" : "items-start"}`}
    >
      <NamePlate
        name={side.name}
        seat={seat}
        subtitle={isYou ? "you" : undefined}
        active={!defeated}
        size="lg"
        className="max-w-full"
      />
      <Numeral
        value={side.score}
        size="xl"
        tone={seat === 0 ? "p1" : "p2"}
        minDigits={5}
        className={defeated ? "opacity-55" : ""}
      />
      <span className="flex h-5 items-center">
        {crowned && <ChampionTag seat={seat} />}
      </span>
    </div>
  );
}

function ChampionTag({ seat }: { seat: Seat }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-[3px] ${SEAT[seat].fill}`}
    >
      {/* A crown, drawn rather than imported — five points and a base. */}
      <svg
        aria-hidden
        viewBox="0 0 14 10"
        width="12"
        height="9"
        fill="currentColor"
        className="text-stage"
      >
        <path d="M0 1.2 3 5 7 0l4 5 3-3.8V8.4H0z" />
      </svg>
      <span className="label" style={varColor("var(--color-stage)")}>
        match winner
      </span>
    </span>
  );
}

// ────────────────────────────────────────────────────────────── round chart

/**
 * Per-round scores as paired columns.
 *
 * Height is share-of-peak rather than absolute, because the question this chart
 * answers is "where did the match turn", not "how many points is a lot". The
 * winner of each round keeps full colour and the other side drops back, so the
 * shape of the match — traded rounds, a runaway, a collapse at the end — is
 * readable without touching a single number.
 */
function RoundChart({
  perRound,
  you,
  opponent,
  className = "",
}: {
  perRound: { round: number; you: number; opponent: number }[];
  you: ResultSide;
  opponent: ResultSide | null;
  className?: string;
}) {
  const peak = Math.max(
    1,
    ...perRound.flatMap((r) => [r.you, opponent ? r.opponent : 0]),
  );
  const youOnLeft = you.seat === 0;

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="label">by round</span>
        <span className="flex items-center gap-1.5">
          <span className="label">peak</span>
          <Numeral value={peak} size="sm" tone="muted" />
        </span>
      </div>
      <div className="rule-h" aria-hidden />

      {/* The numbers, for anyone who cannot see the bars. */}
      <ul className="sr-only">
        {perRound.map((r) => (
          <li key={r.round}>
            {opponent
              ? `Round ${r.round + 1}: ${you.name} ${r.you}, ${opponent.name} ${r.opponent}`
              : `Round ${r.round + 1}: ${you.name} ${r.you}`}
          </li>
        ))}
      </ul>

      <div aria-hidden className="flex items-end gap-2 sm:gap-4">
        {perRound.map((r) => {
          const left = youOnLeft ? r.you : r.opponent;
          const right = youOnLeft ? r.opponent : r.you;
          return (
            <div
              key={r.round}
              className="flex min-w-0 flex-1 flex-col items-center gap-1.5"
            >
              <div className="flex h-[clamp(64px,13vh,140px)] w-full items-end justify-center gap-1 px-1">
                <Bar seat={0} value={left} peak={peak} dim={right > left} />
                {opponent && (
                  <Bar seat={1} value={right} peak={peak} dim={left > right} />
                )}
              </div>
              <span className="label">r{r.round + 1}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Bar({
  seat,
  value,
  peak,
  dim,
}: {
  seat: Seat;
  value: number;
  peak: number;
  dim: boolean;
}) {
  // A round nobody scored in still gets a visible stub, so the column reads as
  // "played and scored nothing" rather than "not played".
  const height = Math.max(2, (Math.max(0, value) / peak) * 100);

  return (
    <span
      className={`block max-w-8 flex-1 self-end ${SEAT[seat].fill} ${dim ? "opacity-30" : "opacity-100"}`}
      style={{ height: `${height}%` }}
    />
  );
}
