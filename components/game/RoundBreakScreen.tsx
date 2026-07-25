"use client";

import { JUDGEMENTS, type RoundSummary } from "@/lib/game/types";
import {
  Button,
  NamePlate,
  Numeral,
  SEAT,
  StatRow,
  useReplayAnimation,
  varColor,
  type Seat,
} from "@/components/broadcast";

/**
 * RoundBreakScreen — the card between rounds.
 *
 * This is the only moment in a duel when both players are looking at the screen
 * instead of at falling notes, and it lasts a few seconds. So the order of
 * discovery is fixed: the verdict is one enormous word in the winner's colour,
 * the commentary line is the second thing the eye lands on, and the stat table
 * is there for whoever wants the detail. Nothing below the commentary may move
 * when it arrives — the line is fetched, so its space is reserved from the
 * first frame.
 *
 * Columns are ordered by SEAT, never by whose screen this is. P1 is on the left
 * on both machines, which is what lets two people point at the same screen and
 * mean the same thing.
 */

export interface RoundBreakSide extends RoundSummary {
  name: string;
  seat: Seat;
}

export interface RoundBreakScreenProps {
  /** 0-based, as in RoundSpec.index. */
  round: number;
  totalRounds: number;
  you: RoundBreakSide;
  opponent: RoundBreakSide | null;
  /** Rounds taken so far. */
  matchScore: { you: number; opponent: number };
  commentary: string | null;
  commentaryLoading: boolean;
  /** Null until both players are ready and the next round is armed. */
  secondsUntilNext: number | null;
  onReady: () => void;
  isReady: boolean;
  opponentReady: boolean;
}

export function RoundBreakScreen({
  round,
  totalRounds,
  you,
  opponent,
  matchScore,
  commentary,
  commentaryLoading,
  secondsUntilNext,
  onReady,
  isReady,
  opponentReady,
}: RoundBreakScreenProps) {
  const seat0 = you.seat === 0 ? you : opponent;
  const seat1 = you.seat === 0 ? opponent : you;

  const winnerSeat: Seat | null =
    opponent === null
      ? null
      : you.score > opponent.score
        ? you.seat
        : opponent.score > you.score
          ? opponent.seat
          : null;

  const verdict =
    opponent === null
      ? "round complete"
      : winnerSeat === null
        ? "round drawn"
        : winnerSeat === you.seat
          ? "round won"
          : "round lost";

  const margin = opponent === null ? 0 : Math.abs(you.score - opponent.score);
  const verdictColour =
    winnerSeat === null ? "var(--color-ink)" : SEAT[winnerSeat].cssVar;

  return (
    <section
      aria-label={`Round ${round + 1} summary`}
      className="broadcast-field flex min-h-full w-full flex-col px-4 py-4 sm:px-8 sm:py-6"
    >
      <header className="flex shrink-0 items-end justify-between gap-4">
        <h1 className="flex items-baseline gap-1.5">
          <span className="sr-only">{`Round ${round + 1} of ${totalRounds}`}</span>
          <span
            aria-hidden
            className="display text-[clamp(1.15rem,3.2vw,1.9rem)] text-ink"
          >
            round {round + 1}
          </span>
          <span
            aria-hidden
            className="display text-[clamp(0.75rem,1.9vw,1.05rem)] text-ink-3"
          >
            /{totalRounds}
          </span>
        </h1>

        <div className="flex items-center gap-2">
          <span className="label">rounds</span>
          <span className="sr-only">
            {`${matchScore.you} to you, ${matchScore.opponent} to your opponent`}
          </span>
          <span aria-hidden className="flex items-center gap-1.5">
            <Numeral
              value={you.seat === 0 ? matchScore.you : matchScore.opponent}
              size="md"
              tone="p1"
            />
            <span className="numeral text-sm text-ink-3">&ndash;</span>
            <Numeral
              value={you.seat === 0 ? matchScore.opponent : matchScore.you}
              size="md"
              tone="p2"
            />
          </span>
        </div>
      </header>

      <div className="rule-h mt-3 shrink-0" aria-hidden />

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto py-5 sm:gap-7 sm:py-7">
        <p
          className="display text-center text-[clamp(2.25rem,8.5vw,5.5rem)]"
          style={{ color: verdictColour }}
        >
          {verdict}
        </p>

        <Commentary
          text={commentary}
          loading={commentaryLoading}
          seat={winnerSeat}
        />

        <div className="mx-auto flex w-full max-w-4xl items-stretch gap-3 sm:gap-6">
          <SideBlock
            side={seat0}
            seat={0}
            winner={winnerSeat === 0}
            defeated={winnerSeat === 1}
            isYou={you.seat === 0}
          />
          <div className="flex w-16 shrink-0 flex-col items-center justify-center gap-1 sm:w-24">
            {winnerSeat === null ? (
              <span className="label">level</span>
            ) : (
              <>
                <span className="label">margin</span>
                <Numeral
                  value={margin}
                  size="lg"
                  tone={winnerSeat === 0 ? "p1" : "p2"}
                  prefix="+"
                />
              </>
            )}
          </div>
          <SideBlock
            side={seat1}
            seat={1}
            winner={winnerSeat === 1}
            defeated={winnerSeat === 0}
            isYou={you.seat === 1}
          />
        </div>

        <div className="mx-auto w-full max-w-4xl">
          {seat0 && seat1 ? (
            <>
              <StatRow label="score" p1={seat0.score} p2={seat1.score} size="lg" />
              <StatRow
                label="accuracy"
                p1={seat0.accuracy * 100}
                p2={seat1.accuracy * 100}
                decimals={1}
                suffix="%"
              />
              <StatRow
                label="best combo"
                p1={seat0.bestCombo}
                p2={seat1.bestCombo}
              />
              <div className="rule-h my-3" aria-hidden />
              {JUDGEMENTS.map((judgement) => (
                <StatRow
                  key={judgement}
                  label={judgement}
                  p1={seat0.counts[judgement]}
                  p2={seat1.counts[judgement]}
                  size="sm"
                  // A miss is the one stat where the smaller number wins, and
                  // the bar under it has to agree or it argues with the score.
                  higherIsBetter={judgement !== "miss"}
                />
              ))}
            </>
          ) : (
            <>
              <StatRow label="score" p1={you.score} size="lg" />
              <StatRow
                label="accuracy"
                p1={you.accuracy * 100}
                decimals={1}
                suffix="%"
              />
              <StatRow label="best combo" p1={you.bestCombo} />
              <div className="rule-h my-3" aria-hidden />
              {JUDGEMENTS.map((judgement) => (
                <StatRow
                  key={judgement}
                  label={judgement}
                  p1={you.counts[judgement]}
                  size="sm"
                />
              ))}
            </>
          )}
        </div>
      </div>

      <div className="rule-h shrink-0" aria-hidden />

      <footer className="flex shrink-0 flex-wrap items-center justify-between gap-4 pt-4">
        {opponent ? (
          <ReadyLamp
            name={opponent.name}
            seat={opponent.seat}
            ready={opponentReady}
          />
        ) : (
          <span className="label">playing solo</span>
        )}

        <div className="flex items-center gap-4 sm:gap-6">
          {secondsUntilNext !== null && <Countdown seconds={secondsUntilNext} />}
          <Button
            variant="primary"
            size="lg"
            accent={you.seat}
            onClick={onReady}
            disabled={isReady}
          >
            {isReady ? "ready" : "I'm ready"}
          </Button>
        </div>
      </footer>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────── commentary

/**
 * The one line of personality in the game.
 *
 * Its box is the same height whether it holds two skeleton bars, a line, or
 * nothing at all. The line arrives from a network call some hundreds of
 * milliseconds after this screen mounts, and a stat table that jumps down the
 * page at that moment is exactly the kind of movement that makes players stop
 * trusting the screen.
 */
function Commentary({
  text,
  loading,
  seat,
}: {
  text: string | null;
  loading: boolean;
  seat: Seat | null;
}) {
  return (
    <div
      className="mx-auto flex w-full max-w-3xl items-start gap-3"
      aria-live="polite"
      aria-busy={loading}
    >
      <span
        aria-hidden
        className={`mt-[0.35em] h-[1.1em] w-[3px] shrink-0 text-[clamp(1rem,2.4vw,1.45rem)] ${
          seat === null ? "bg-rule-bright" : SEAT[seat].fill
        }`}
      />
      <p className="min-h-[2.8em] flex-1 text-[clamp(1rem,2.4vw,1.45rem)] font-semibold leading-[1.35] [font-stretch:96%] text-ink">
        {loading ? (
          <span className="flex flex-col gap-2 pt-[0.3em]">
            <span className="animate-live block h-[0.55em] w-[85%] bg-rule-bright" />
            <span className="animate-live block h-[0.55em] w-[45%] bg-rule" />
            <span className="sr-only">Commentary loading</span>
          </span>
        ) : (
          text
        )}
      </p>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── one player

function SideBlock({
  side,
  seat,
  winner,
  defeated,
  isYou,
}: {
  side: RoundBreakSide | null;
  seat: Seat;
  winner: boolean;
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
        className="max-w-full"
      />
      <Numeral
        value={side.score}
        size="xl"
        tone={seat === 0 ? "p1" : "p2"}
        minDigits={4}
        className={defeated ? "opacity-55" : ""}
      />
      {/* Always present, so the two columns cannot end up different heights. */}
      <span className="flex h-5 items-center">
        {winner && <WinnerTag seat={seat} />}
      </span>
    </div>
  );
}

function WinnerTag({ seat }: { seat: Seat }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-[3px] ${SEAT[seat].fill}`}
    >
      <svg
        aria-hidden
        viewBox="0 0 10 10"
        width="9"
        height="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="square"
        className="text-stage"
      >
        <path d="M1 5.4 3.7 8.2 9 1.6" />
      </svg>
      <span className="label" style={varColor("var(--color-stage)")}>
        round winner
      </span>
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────── footer

function ReadyLamp({
  name,
  seat,
  ready,
}: {
  name: string;
  seat: Seat;
  ready: boolean;
}) {
  return (
    <span role="status" className="flex items-center gap-2">
      {/* Pulsing while we wait, solid the moment they commit — the same lamp
          grammar as the LIVE dot on the scorebug. */}
      <span
        aria-hidden
        className={`h-2 w-2 shrink-0 rounded-full ${
          ready ? SEAT[seat].fill : "animate-live bg-ink-3"
        }`}
      />
      <span className="label max-w-[18ch] truncate">
        {ready ? `${name} is ready` : `waiting for ${name}`}
      </span>
    </span>
  );
}

function Countdown({ seconds }: { seconds: number }) {
  // Re-kicking on every tick gives the number a heartbeat, which is what makes
  // a countdown readable out of the corner of an eye.
  const ref = useReplayAnimation<HTMLSpanElement>("animate-combo", seconds);

  return (
    <span className="flex items-center gap-2">
      <span className="sr-only">{`Next round in ${Math.max(0, Math.round(seconds))} seconds`}</span>
      <span aria-hidden className="label hidden sm:block">
        next in
      </span>
      <span ref={ref} aria-hidden className="inline-flex">
        <Numeral value={Math.max(0, Math.ceil(seconds))} size="lg" tone="ink" />
      </span>
    </span>
  );
}
