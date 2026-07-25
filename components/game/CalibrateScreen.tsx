"use client";

import { useId } from "react";
import {
  Button,
  Numeral,
  useReplayAnimation,
  varColor,
} from "@/components/broadcast";
import type { CalibrationResult } from "@/lib/game/calibration";
import { MAX_CALIBRATION_SEC } from "@/lib/game/types";

/**
 * CalibrateScreen — the tap test, presented.
 *
 * The screen owns no timer, no audio and no measurement. The beat pulse is
 * driven purely by `beatsElapsed` changing: whatever schedules the click track
 * is already the authority on when a beat happened, and a second clock here
 * would drift against it within a few bars and show the player a pulse that
 * disagrees with what they can hear.
 *
 * The hard part of this screen is not the measurement, it's consent. Players
 * asked to do a chore before a game will skip it, so the "why" is stated once,
 * in plain language, at the top — and the escape hatches (manual slider, skip)
 * are always present rather than hidden behind a failure.
 */

export type CalibratePhase = "intro" | "running" | "done";

export interface CalibrateScreenProps {
  phase: CalibratePhase;
  beatsTotal: number;
  beatsElapsed: number;
  tapsMatched: number;
  result: CalibrationResult | null;
  currentOffsetSec: number;
  onStart: () => void;
  onAccept: (offsetSec: number) => void;
  onManualChange: (offsetSec: number) => void;
  onSkip: () => void;
}

/** The slider must not offer a value the judge would clamp away anyway. */
const MAX_MS = Math.round(MAX_CALIBRATION_SEC * 1000);

/** The click track is 4/4, so every fourth pulse is accented. */
const BEATS_PER_BAR = 4;

/** Past this the beat bar's segments are narrower than the gaps between them. */
const MAX_BEAT_SEGMENTS = 64;

const STEPS = [
  "Stand back far enough that the camera can see both of your hands.",
  "Strike downward on every click, the same way you'll play the game.",
  "Keep going to the end — one or two flubbed taps won't spoil it.",
];

const toMs = (sec: number) => Math.round(sec * 1000);
const clampMs = (ms: number) => Math.max(-MAX_MS, Math.min(MAX_MS, ms));

export function CalibrateScreen({
  phase,
  beatsTotal,
  beatsElapsed,
  tapsMatched,
  result,
  currentOffsetSec,
  onStart,
  onAccept,
  onManualChange,
  onSkip,
}: CalibrateScreenProps) {
  const sliderId = useId();
  const hintId = useId();

  const totalBeats = Math.max(1, Math.round(beatsTotal));
  const beatsDone = Math.max(0, Math.min(Math.round(beatsElapsed), totalBeats));
  const appliedMs = clampMs(toMs(currentOffsetSec));

  return (
    <main className="broadcast-field flex min-h-screen w-full flex-col">
      <header className="shrink-0 px-6 pt-7 sm:px-10 sm:pt-9">
        <p className="label">Latency calibration</p>
        <h1 className="display mt-2 text-[clamp(2.25rem,6.5vw,4.5rem)] text-ink">
          Tap the beat
        </h1>
        <p className="mt-3 max-w-[64ch] text-[clamp(0.95rem,1.5vw,1.15rem)] leading-snug text-ink-2">
          There are 40 to 80 milliseconds between your hand moving and the
          camera seeing it, that number is different on every machine, and this
          measures yours so that both of you are scored fairly.
        </p>
      </header>

      <div className="rule-h mt-6 shrink-0" aria-hidden />

      <div className="grid flex-1 grid-cols-1 items-center gap-10 px-6 py-9 sm:px-10 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1fr)] lg:gap-16">
        {/*
         * Instruction and action on the left, instrument on the right: the eye
         * lands on the pulse, then falls left to the one thing it can press.
         */}
        <section className="flex min-w-0 flex-col justify-center gap-7">
          {phase === "intro" && <Steps />}

          {phase === "running" && (
            <div className="flex flex-col gap-3">
              <p className="display text-[clamp(1.5rem,3.6vw,2.5rem)] text-ink">
                Strike on every click
              </p>
              <p className="text-[clamp(0.95rem,1.4vw,1.1rem)] text-ink-2">
                Don&rsquo;t chase it — settle into the pulse and let it run to
                the end.
              </p>
            </div>
          )}

          {phase === "done" && <Verdict result={result} />}

          <ActionRow
            phase={phase}
            result={result}
            beatsDone={beatsDone}
            totalBeats={totalBeats}
            onStart={onStart}
            onAccept={onAccept}
          />
        </section>

        <section className="flex min-h-[19rem] min-w-0 flex-col items-center justify-center">
          {phase === "done" ? (
            <Measurement result={result} />
          ) : (
            <BeatPulse
              live={phase === "running"}
              beatsElapsed={beatsElapsed}
              beatsDone={beatsDone}
              totalBeats={totalBeats}
              tapsMatched={tapsMatched}
            />
          )}
        </section>
      </div>

      <div className="rule-h shrink-0" aria-hidden />

      {/*
       * The escape hatch is permanent, not a consolation prize for a failed
       * run. Someone who calibrated yesterday, or who knows their rig, should
       * be able to dial the number in and leave without tapping anything.
       */}
      <footer className="shrink-0 px-6 py-5 sm:px-10 sm:py-6">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-5">
          <div className="shrink-0">
            <label htmlFor={sliderId} className="label block">
              Manual offset
            </label>
            <div className="mt-1">
              <Numeral value={appliedMs} size="lg" suffix="ms" />
            </div>
          </div>

          <div className="flex min-w-[15rem] flex-1 flex-col">
            <input
              id={sliderId}
              type="range"
              min={-MAX_MS}
              max={MAX_MS}
              step={1}
              value={appliedMs}
              aria-describedby={hintId}
              aria-valuetext={`${appliedMs} milliseconds`}
              onChange={(e) =>
                onManualChange(clampMs(Number(e.target.value)) / 1000)
              }
            />
            <div className="flex justify-between">
              <span className="label">&minus;{MAX_MS}</span>
              <span className="label">0</span>
              <span className="label">+{MAX_MS}</span>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <Button onClick={() => onAccept(appliedMs / 1000)}>
              Use {appliedMs} ms
            </Button>
            <Button onClick={onSkip}>Skip</Button>
          </div>
        </div>
        <p id={hintId} className="mt-3 text-[0.8125rem] text-ink-3">
          Positive means your setup reports late. Skipping uses a safe default,
          which costs you a few points a round at most.
        </p>
      </footer>

      {/*
       * Phase changes are announced, individual beats are not — a live region
       * that fires every 500ms would talk over itself for the whole test.
       */}
      <p aria-live="polite" className="sr-only">
        {phase === "intro"
          ? "Calibration ready."
          : phase === "running"
            ? "Calibration running. Tap along with the click."
            : (result?.message ?? "Calibration finished with no measurement.")}
      </p>
    </main>
  );
}

// ──────────────────────────────────────────────────────────────────── intro

function Steps() {
  return (
    <ol className="flex flex-col">
      {STEPS.map((step, i) => (
        <li key={step}>
          {i > 0 && <div className="rule-h" aria-hidden />}
          <div className="flex items-baseline gap-4 py-3.5">
            <span className="label w-4 shrink-0">{i + 1}</span>
            <p className="text-[clamp(0.95rem,1.4vw,1.1rem)] leading-snug text-ink">
              {step}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

// ─────────────────────────────────────────────────────────────── instrument

interface BeatPulseProps {
  live: boolean;
  beatsElapsed: number;
  beatsDone: number;
  totalBeats: number;
  tapsMatched: number;
}

/**
 * The pulse.
 *
 * `useReplayAnimation` re-fires the kick every time `beatsElapsed` changes, so
 * the animation is a consequence of the click track rather than a parallel
 * imitation of it. The accent-vs-offbeat colour swap is a plain transition and
 * not an animation, which is what keeps the beat visible under
 * prefers-reduced-motion once the kick has been suppressed.
 */
function BeatPulse({
  live,
  beatsElapsed,
  beatsDone,
  totalBeats,
  tapsMatched,
}: BeatPulseProps) {
  const disc = useReplayAnimation<HTMLDivElement>(
    "animate-combo",
    beatsElapsed,
    live,
  );
  const onAccent = live && beatsDone % BEATS_PER_BAR === 0;
  const segments = Math.min(totalBeats, MAX_BEAT_SEGMENTS);

  return (
    <div className="flex w-full max-w-[32rem] flex-col items-center gap-9">
      <div
        className="relative grid w-full max-w-[17rem] place-items-center"
        style={{ aspectRatio: "1" }}
      >
        {/* The target the pulse grows into — a fixed reference for the eye. */}
        <div
          aria-hidden
          className="absolute inset-0 rounded-full border border-rule"
        />
        {/*
         * The animated node's className is static on purpose: React rewrites
         * the whole attribute on re-render, which would strip a class the
         * replay hook added behind its back. All the swapping lives inside.
         */}
        <div ref={disc} aria-hidden className="absolute inset-[11%]">
          <div
            className={`h-full w-full rounded-full border-2 transition-colors duration-150 ${
              onAccent
                ? "border-ink bg-ink/[0.14]"
                : live
                  ? "border-rule-bright bg-ink/[0.04]"
                  : "border-rule bg-transparent"
            }`}
          />
        </div>
        <p className="relative flex flex-col items-center gap-1">
          <span className="display text-[clamp(2rem,5vw,3.25rem)] text-ink">
            {live ? totalBeats - beatsDone : totalBeats}
          </span>
          <span className="label">{live ? "beats left" : "beats · ready"}</span>
        </p>
      </div>

      {/* Positional, not motional: the only beat feedback that survives
          prefers-reduced-motion intact. */}
      <div aria-hidden className="flex h-3.5 w-full items-end gap-px">
        {Array.from({ length: segments }, (_, i) => (
          <span
            key={i}
            className={`flex-1 transition-colors duration-150 ${
              i % BEATS_PER_BAR === 0 ? "h-full" : "h-1/2"
            } ${i < beatsDone ? "bg-ink" : "bg-rule"}`}
          />
        ))}
      </div>

      <div className="flex w-full items-center justify-between gap-4">
        <span className="label">Taps matched</span>
        <Numeral
          value={tapsMatched}
          size="lg"
          minDigits={2}
          tone={tapsMatched > 0 ? "ink" : "faint"}
        />
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────── verdict

function Verdict({ result }: { result: CalibrationResult | null }) {
  const confident = result?.confident ?? false;

  return (
    <div className="flex flex-col gap-4">
      <span className="inline-flex items-center gap-2">
        <ConfidenceMark confident={confident} />
        <span
          className="label"
          style={varColor(
            confident ? "var(--color-perfect)" : "var(--color-good)",
          )}
        >
          {confident ? "Good measurement" : "Low confidence"}
        </span>
      </span>

      <p className="display text-[clamp(1.5rem,3.6vw,2.5rem)] text-ink">
        {confident ? "You're calibrated" : "That one was noisy"}
      </p>

      <p className="max-w-[46ch] text-[clamp(0.95rem,1.4vw,1.1rem)] leading-snug text-ink-2">
        {result?.message ??
          "I didn't get a measurement out of that run. Give it another go."}
      </p>
    </div>
  );
}

function ConfidenceMark({ confident }: { confident: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke={confident ? "var(--color-perfect)" : "var(--color-good)"}
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      {confident ? (
        <path d="M2.5 8.4 6.3 12.2 13.5 4" />
      ) : (
        <>
          <path d="M8 2.4 15 14.2H1z" />
          <path d="M8 6.6v3.2" />
          <path d="M8 12.1h.01" />
        </>
      )}
    </svg>
  );
}

function Measurement({ result }: { result: CalibrationResult | null }) {
  if (!result) {
    return (
      <p className="display text-[clamp(1.75rem,4vw,2.75rem)] text-ink-3">
        No reading
      </p>
    );
  }

  return (
    <div className="flex w-full max-w-[30rem] flex-col gap-6">
      <div>
        <p className="label">Your offset</p>
        <div className="mt-1">
          <Numeral
            value={toMs(result.offsetSec)}
            size="xl"
            suffix="ms"
            tone={result.confident ? "perfect" : "ink"}
          />
        </div>
      </div>

      <div className="rule-h" aria-hidden />

      <dl className="grid grid-cols-2 gap-x-8">
        <div>
          <dt className="label">Spread</dt>
          <dd className="mt-1">
            <Numeral
              value={toMs(result.spreadSec)}
              size="lg"
              prefix="±"
              suffix="ms"
              tone={result.confident ? "ink" : "miss"}
            />
          </dd>
        </div>
        <div>
          <dt className="label">Taps used</dt>
          <dd className="mt-1">
            <Numeral value={result.matched} size="lg" tone="muted" />
          </dd>
        </div>
      </dl>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────── actions

interface ActionRowProps {
  phase: CalibratePhase;
  result: CalibrationResult | null;
  beatsDone: number;
  totalBeats: number;
  onStart: () => void;
  onAccept: (offsetSec: number) => void;
}

/**
 * Exactly one `primary` is rendered per phase. On a low-confidence result that
 * primary is "run it again" and accepting drops to a ghost, because the
 * cheapest way to make someone re-run a bad measurement is to make re-running
 * the path of least resistance.
 */
function ActionRow({
  phase,
  result,
  beatsDone,
  totalBeats,
  onStart,
  onAccept,
}: ActionRowProps) {
  if (phase === "running") {
    return (
      <p className="flex items-baseline gap-3">
        <span className="label" style={varColor("var(--color-live)")}>
          <span className="animate-live inline-block">&#9679;</span> Recording
        </span>
        <span className="numeral text-[0.9rem] text-ink-2">
          beat {beatsDone} of {totalBeats}
        </span>
      </p>
    );
  }

  if (phase === "intro") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" size="lg" onClick={onStart}>
          Start the test
        </Button>
        <span className="text-[0.8125rem] text-ink-3">
          Takes about {Math.round(totalBeats / 2)} seconds.
        </span>
      </div>
    );
  }

  const confident = result?.confident ?? false;
  const offsetSec = result?.offsetSec ?? 0;

  return (
    <div className="flex flex-wrap items-center gap-3">
      {confident ? (
        <>
          <Button
            variant="primary"
            size="lg"
            onClick={() => onAccept(offsetSec)}
          >
            Use {toMs(offsetSec)} ms
          </Button>
          <Button onClick={onStart}>Run it again</Button>
        </>
      ) : (
        <>
          <Button variant="primary" size="lg" onClick={onStart}>
            Run it again
          </Button>
          {result && (
            <Button onClick={() => onAccept(offsetSec)}>
              Use it anyway
            </Button>
          )}
        </>
      )}
    </div>
  );
}
