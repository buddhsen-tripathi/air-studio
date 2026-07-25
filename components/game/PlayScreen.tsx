"use client";

import { memo, type RefObject } from "react";
import {
  Button,
  JudgementBadge,
  NamePlate,
  Numeral,
  SEAT,
  Scorebug,
  TugOfWar,
  useReplayAnimation,
  varColor,
  type ScorebugSide,
  type Seat,
} from "@/components/broadcast";
import { HIT_LINE_Y } from "@/lib/game/lanes";
import { comboMultiplier } from "@/lib/game/types";
import type { Chart, Judgement, RoundSpec } from "@/lib/game/types";
import { LaneOverlay } from "./LaneOverlay";

/**
 * PlayScreen — the match itself.
 *
 * Three registers, ranked by how much of the player's attention they may take:
 *
 *   1. THE HIGHWAY. Centred, portrait, height-driven. Everything else is chrome
 *      arranged around it, and nothing else is allowed to be bright.
 *   2. THE RAILS. Your combo and their score, aligned *inboard* — hard against
 *      the highway — for the same reason the Scorebug puts both scores either
 *      side of its centre column: comparing them has to be one short saccade,
 *      not a sweep across a 13" monitor. Which rail is yours follows your seat,
 *      so your colour is on the same side here as it is in the scorebug above.
 *   3. THE CONFIDENCE MONITOR. The webcam, small, dimmed, in your rail. Players
 *      need it to know they are in frame and lit — they must never be tempted to
 *      watch it, because the timing information is all on the highway.
 *
 * ── Render cost ─────────────────────────────────────────────────────────────
 * Scores arrive at roughly 10Hz, so this whole tree re-renders ten times a
 * second for the entire match. Nothing here holds per-frame state: `chartTimeSec`
 * is only ever floored to a second for the round clock, the notes and the hand
 * skeleton are drawn on canvases the orchestrator owns, and every subtree whose
 * inputs are stable (the canvas frame, the camera, the lane furniture) is
 * memoised behind refs and primitives so a score tick diffs a handful of nodes.
 */

export interface PlayScreenPlayer {
  name: string;
  seat: Seat;
  score: number;
  combo: number;
  bestCombo: number;
  accuracy: number;
}

export interface PlayScreenOpponent {
  name: string;
  seat: Seat;
  score: number;
  combo: number;
  accuracy: number;
  connected: boolean;
}

export interface PlayScreenProps {
  chart: Chart;
  /** 0-based, as in RoundSpec.index. */
  round: number;
  chartTimeSec: number;
  videoRef: RefObject<HTMLVideoElement | null>;
  highwayCanvasRef: RefObject<HTMLCanvasElement | null>;
  overlayCanvasRef: RefObject<HTMLCanvasElement | null>;
  you: PlayScreenPlayer;
  opponent: PlayScreenOpponent | null;
  /** `id` increments per judgement, so two PERFECTs in a row still re-animate. */
  lastJudgement: { judgement: Judgement; id: number } | null;
  paused: boolean;
  /** Toggle: called to pause and again to resume, since `paused` is owned above. */
  onPause: () => void;
  /**
   * Per-lane strike counters, forwarded to LaneOverlay. Optional because the
   * screen is fully legible without it — the keybed simply stops kicking.
   */
  laneFlashIds?: number[];
}

/** Hoisted so the default never breaks LaneOverlay's element-wise memo check. */
const NO_FLASHES: number[] = [];

export function PlayScreen({
  chart,
  round,
  chartTimeSec,
  videoRef,
  highwayCanvasRef,
  overlayCanvasRef,
  you,
  opponent,
  lastJudgement,
  paused,
  onPause,
  laneFlashIds = NO_FLASHES,
}: PlayScreenProps) {
  const spec = roundAt(chart, round);
  const youOnLeft = you.seat === 0;

  const youSide: ScorebugSide = {
    name: you.name,
    score: you.score,
    combo: you.combo,
    accuracy: you.accuracy,
    connected: true,
    you: true,
  };
  const oppSide: ScorebugSide = opponent
    ? {
        name: opponent.name,
        score: opponent.score,
        combo: opponent.combo,
        accuracy: opponent.accuracy,
        connected: opponent.connected,
      }
    : { name: "Open seat", score: 0, connected: false };

  const youRail = (
    <YouRail
      you={you}
      side={youOnLeft ? "left" : "right"}
      videoRef={videoRef}
      overlayCanvasRef={overlayCanvasRef}
    />
  );
  const oppRail = (
    <OpponentRail opponent={opponent} side={youOnLeft ? "right" : "left"} />
  );

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-stage">
      <Scorebug
        p1={you.seat === 0 ? youSide : oppSide}
        p2={you.seat === 0 ? oppSide : youSide}
        round={round}
        totalRounds={chart.rounds.length}
        roundLabel={spec.label}
        suddenDeath={spec.suddenDeath}
        live={!paused}
        // Time *left in this round* rather than elapsed: it is the only number
        // here a player can act on, and it is what makes a finale feel like one.
        timeSec={Math.max(0, spec.endSec - chartTimeSec)}
        timeLabel="left"
        className="shrink-0"
      />

      <main className="relative flex min-h-0 flex-1 items-stretch gap-2 px-2 py-2 sm:gap-4 sm:px-4 sm:py-3 lg:gap-7 lg:px-6">
        {youOnLeft ? youRail : oppRail}

        <section
          aria-label="Note highway"
          className="flex h-full min-h-0 min-w-0 flex-1 justify-center"
        >
          {/*
           * Height-driven: the box takes all the vertical space there is and
           * derives its width, so the playfield is as tall as the screen allows
           * on any monitor. `max-w-full` is the release valve — on a narrow
           * window the box simply gets more portrait rather than overflowing,
           * and the renderer lays out from the CSS box it is given, so a taller
           * ratio costs nothing and nothing is ever letterboxed.
           */}
          <div className="relative aspect-[3/4] h-full max-w-full bg-field">
            <HighwayCanvas canvasRef={highwayCanvasRef} />
            <LaneOverlay
              lanes={chart.lanes}
              hitLineY={HIT_LINE_Y}
              laneFlashIds={laneFlashIds}
            />
            {/*
             * Well above the hit line, where the renderer's own per-lane popups
             * are not. This one is the whole-screen callout — it says what just
             * happened without asking which column it happened in.
             */}
            {lastJudgement && (
              <div
                className="pointer-events-none absolute inset-x-0 flex justify-center"
                style={{ top: `${(HIT_LINE_Y - 0.26) * 100}%` }}
              >
                <JudgementBadge
                  key={lastJudgement.id}
                  judgement={lastJudgement.judgement}
                  seq={lastJudgement.id}
                  size="lg"
                />
              </div>
            )}
            {paused && <PausedVeil onResume={onPause} />}
          </div>
        </section>

        {youOnLeft ? oppRail : youRail}

        {opponent && !opponent.connected && <DisconnectBanner />}
      </main>

      <div className="rule-h shrink-0" aria-hidden />

      <footer className="flex shrink-0 items-center gap-4 px-3 py-2 sm:gap-6 sm:px-5">
        <PauseButton paused={paused} onPause={onPause} />
        {opponent && (
          <TugOfWar
            p1Score={you.seat === 0 ? you.score : opponent.score}
            p2Score={you.seat === 0 ? opponent.score : you.score}
            p1Name={you.seat === 0 ? you.name : opponent.name}
            p2Name={you.seat === 0 ? opponent.name : you.name}
            className="min-w-0 flex-1"
          />
        )}
      </footer>
    </div>
  );
}

/** Tolerates a round index that has run past the end of a repaired chart. */
function roundAt(chart: Chart, round: number): RoundSpec {
  return chart.rounds[round] ?? chart.rounds[chart.rounds.length - 1];
}

// ──────────────────────────────────────────────────────────────────── highway

/**
 * The canvas, and nothing else.
 *
 * Its only prop is a ref, so it renders exactly once per match. That matters
 * less for the DOM than for the guarantee it buys: there is no path by which a
 * score update can touch the element the renderer holds a 2d context on.
 */
const HighwayCanvas = memo(function HighwayCanvas({
  canvasRef,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
}) {
  return (
    <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" />
  );
});

function PausedVeil({ onResume }: { onResume: () => void }) {
  return (
    <div
      role="status"
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-6 bg-stage/85 backdrop-blur-[2px]"
    >
      <span className="display text-[clamp(2.25rem,9vw,4.5rem)] text-ink">
        Paused
      </span>
      {/* Not autofocused. The player's hands are in the air, not on the keys —
          they will reach for the mouse, and a stolen focus ring on resume would
          leave a highlight sitting over the playfield. */}
      <Button variant="primary" size="lg" onClick={onResume}>
        Resume
      </Button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────── your rail

const RAIL =
  "broadcast-field hidden w-[clamp(8.5rem,20vw,16rem)] shrink-0 flex-col justify-between gap-4 px-3 py-3 sm:flex lg:px-4";

const YouRail = memo(function YouRail({
  you,
  side,
  videoRef,
  overlayCanvasRef,
}: {
  you: PlayScreenPlayer;
  side: "left" | "right";
  videoRef: RefObject<HTMLVideoElement | null>;
  overlayCanvasRef: RefObject<HTMLCanvasElement | null>;
}) {
  // Inboard alignment: the combo hugs the highway, so it lands inside the same
  // glance that reads the notes.
  const inboard = side === "left" ? "items-end text-right" : "items-start";

  return (
    <aside aria-label="Your play" className={`${RAIL} ${inboard}`}>
      <ComboTower combo={you.combo} seat={you.seat} side={side} />

      <div className={`flex w-full flex-col gap-1 ${inboard}`}>
        <MicroStat label="best" value={you.bestCombo} side={side} />
        <MicroStat
          label="acc"
          value={you.accuracy * 100}
          decimals={1}
          suffix="%"
          side={side}
        />
      </div>

      <CameraMonitor
        videoRef={videoRef}
        overlayCanvasRef={overlayCanvasRef}
        seat={you.seat}
      />
    </aside>
  );
});

/**
 * The number players actually watch while playing.
 *
 * Combo is the only readout that changes on *their* action rather than on the
 * clock, so it is the one that tells them whether the last strike landed
 * without waiting for the judgement to fade. Hence the size, hence the kick,
 * hence its position hard against the highway.
 */
const ComboTower = memo(function ComboTower({
  combo,
  seat,
  side,
}: {
  combo: number;
  seat: Seat;
  side: "left" | "right";
}) {
  const accent = SEAT[seat];
  const multiplier = comboMultiplier(combo);
  const kickRef = useReplayAnimation<HTMLSpanElement>(
    "animate-combo",
    combo,
    combo > 0,
  );

  return (
    // Alignment has to be explicit: a stretched flex child would blockify the
    // numeral's span to full rail width and start it at the outboard edge.
    <div
      className={`flex w-full min-w-0 flex-col ${side === "left" ? "items-end" : "items-start"}`}
    >
      <span className="label">combo</span>
      {/*
       * The kick scales from the inboard edge, so a rising combo grows away
       * from the highway instead of nudging into it. Transform origin travels
       * as a style, not a class: the animation class is added imperatively and
       * any change to className would strip it on the next patch.
       */}
      <span
        ref={kickRef}
        className="mt-0.5 inline-flex items-center"
        style={{
          transformOrigin: side === "left" ? "right center" : "left center",
        }}
      >
        <Numeral value={combo} size="xl" tone={seat === 0 ? "p1" : "p2"} />
      </span>
      {/* Reserved height, so crossing ×2 cannot shift the rail below it. */}
      <span
        className={`label mt-1 transition-opacity duration-200 ${
          multiplier > 1 ? "opacity-100" : "opacity-0"
        }`}
        style={varColor(accent.cssVar)}
        aria-hidden={multiplier === 1}
      >
        &times;{multiplier} multiplier
      </span>
    </div>
  );
});

function MicroStat({
  label,
  value,
  decimals = 0,
  suffix,
  side,
}: {
  label: string;
  value: number;
  decimals?: number;
  suffix?: string;
  side: "left" | "right";
}) {
  return (
    // Value inboard, label outboard — the same reading order the scorebug and
    // the name plates use, so both rails scan the same way from the highway out.
    <span
      className={`flex items-center gap-2 ${side === "right" ? "flex-row-reverse" : ""}`}
    >
      <span className="label">{label}</span>
      <Numeral
        value={value}
        size="md"
        tone="muted"
        decimals={decimals}
        suffix={suffix}
      />
    </span>
  );
}

/**
 * The confidence monitor.
 *
 * Deliberately dim and deliberately small. Its whole job is to answer "am I in
 * frame, is my hand being seen" in peripheral vision; the skeleton on top is the
 * part that actually carries that, which is why the feed underneath is held at
 * half opacity — bright video next to a dark playfield pulls the eye off the
 * notes, and there is nothing to look at over here.
 *
 * The feed is mirrored so the player sees themselves as in a mirror. The overlay
 * canvas is NOT: HandTracker already mirrors landmark coordinates, so a CSS flip
 * on top would put the skeleton back on the wrong hand.
 */
const CameraMonitor = memo(function CameraMonitor({
  videoRef,
  overlayCanvasRef,
  seat,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  overlayCanvasRef: RefObject<HTMLCanvasElement | null>;
  seat: Seat;
}) {
  return (
    <figure className="hidden w-full min-w-0 md:block">
      <div aria-hidden className="relative aspect-[4/3] w-full bg-black">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className="absolute inset-0 h-full w-full scale-x-[-1] object-cover opacity-50"
        />
        <canvas
          ref={overlayCanvasRef}
          className="pointer-events-none absolute inset-0 h-full w-full"
        />
      </div>
      <figcaption className="mt-1.5 flex items-center gap-1.5">
        <span
          aria-hidden
          className={`h-[6px] w-[6px] shrink-0 ${SEAT[seat].fill}`}
        />
        <span className="label">your camera</span>
      </figcaption>
    </figure>
  );
});

// ─────────────────────────────────────────────────────────────── their rail

/**
 * Presence, not analysis.
 *
 * Their score and combo only, at a size that reads without being read — the
 * moment this rail becomes something you study, you have stopped playing. The
 * detailed comparison belongs to the round summary.
 */
const OpponentRail = memo(function OpponentRail({
  opponent,
  side,
}: {
  opponent: PlayScreenOpponent | null;
  side: "left" | "right";
}) {
  const inboard = side === "left" ? "items-end text-right" : "items-start";

  if (!opponent) {
    return (
      <aside aria-label="Opponent" className={`${RAIL} ${inboard}`}>
        <div className="flex w-full flex-col gap-1">
          <span className="label">opponent</span>
          <span className="plate-name text-[clamp(0.9rem,2vw,1.2rem)] text-ink-3">
            Open seat
          </span>
        </div>
        <span />
      </aside>
    );
  }

  const offline = !opponent.connected;

  return (
    <aside aria-label="Opponent" className={`${RAIL} ${inboard}`}>
      <div
        className={`flex w-full min-w-0 flex-col ${side === "left" ? "items-end" : "items-start"}`}
      >
        <span className="label">their score</span>
        <span
          className={`mt-0.5 inline-flex transition-opacity duration-300 ${
            offline ? "opacity-35" : ""
          }`}
        >
          <Numeral
            value={opponent.score}
            size="lg"
            tone={opponent.seat === 0 ? "p1" : "p2"}
            minDigits={4}
          />
        </span>
        <span className="label mt-2">their combo</span>
        <span
          className={`mt-0.5 inline-flex transition-opacity duration-300 ${
            offline ? "opacity-35" : ""
          }`}
        >
          <Numeral value={opponent.combo} size="lg" tone="muted" />
        </span>
      </div>

      <NamePlate
        name={opponent.name}
        seat={opponent.seat}
        subtitle={offline ? "disconnected" : "opponent"}
        active={!offline}
        size="sm"
        className="w-full"
      />
    </aside>
  );
});

/**
 * A dropped opponent is the one event during play worth interrupting for: the
 * scores stop meaning anything and the player needs to know it was the network
 * and not them. Announced once, politely — everything else in this screen is
 * deliberately silent to assistive tech.
 */
function DisconnectBanner() {
  return (
    <div
      role="status"
      className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center px-3 pt-2"
    >
      <p className="animate-sweep flex items-center gap-2.5 bg-chrome-raised/95 px-4 py-2">
        <span
          aria-hidden
          className="animate-live h-2 w-2 shrink-0 rounded-full bg-miss"
        />
        <span className="display text-[clamp(0.95rem,2.4vw,1.4rem)] text-miss">
          Opponent disconnected
        </span>
      </p>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────── pause

/**
 * Small, outboard, and in the footer — reachable but never in the path between
 * the player's eye and the hit line, and never focused by us.
 */
function PauseButton({
  paused,
  onPause,
}: {
  paused: boolean;
  onPause: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onPause}
      aria-pressed={paused}
      className="shrink-0"
    >
      <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden>
        {paused ? (
          <path d="M0 0 L10 6 L0 12 Z" fill="currentColor" />
        ) : (
          <>
            <rect x="0" y="0" width="3.5" height="12" fill="currentColor" />
            <rect x="6.5" y="0" width="3.5" height="12" fill="currentColor" />
          </>
        )}
      </svg>
      {paused ? "Resume" : "Pause"}
    </Button>
  );
}
