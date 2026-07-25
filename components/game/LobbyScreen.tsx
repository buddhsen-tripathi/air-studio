"use client";

import {
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Button,
  NamePlate,
  Panel,
  SEAT,
  StatRow,
  varColor,
  type Seat,
} from "@/components/broadcast";
import { chartStats } from "@/lib/game/chart";
import type { Chart } from "@/lib/game/types";
import type { Player } from "@/lib/net/protocol";

/**
 * LobbyScreen — the waiting room, and the only place the match is configured.
 *
 * Two jobs, in strict priority order. First: get the second player into the
 * room, which means the code is the largest thing on the screen and everything
 * else defers to it. Second: make it obvious at a glance what is still missing
 * before START can light up — an unexplained disabled button is the single most
 * common way a lobby wastes a minute of two people's time, so every blocker is
 * named in plain language next to the button it is blocking.
 */

export type LobbyDifficulty = "easy" | "normal" | "hard";

export interface LobbyChartRequest {
  song?: string;
  brief?: string;
  difficulty: LobbyDifficulty;
}

export interface LobbyScreenProps {
  code: string;
  players: Player[];
  youId: string;
  hostId: string;
  chart: Chart | null;
  chartLoading: boolean;
  chartError: string | null;
  onGenerateChart: (input: LobbyChartRequest) => void;
  onReady: (ready: boolean) => void;
  onStart: () => void;
  onLeave: () => void;
  cameraReady: boolean;
  calibrated: boolean;
  onCalibrate: () => void;
  /**
   * Beyond the brief: the camera prerequisite needs a way to be *fixed*, not
   * just reported. Optional, because permission is sometimes only recoverable
   * through browser chrome — without it the row explains itself instead.
   */
  onEnableCamera?: () => void;
}

const DIFFICULTIES: readonly LobbyDifficulty[] = ["easy", "normal", "hard"];

export function LobbyScreen({
  code,
  players,
  youId,
  hostId,
  chart,
  chartLoading,
  chartError,
  onGenerateChart,
  onReady,
  onStart,
  onLeave,
  cameraReady,
  calibrated,
  onCalibrate,
  onEnableCamera,
}: LobbyScreenProps) {
  const isHost = youId === hostId;
  const you = players.find((p) => p.id === youId) ?? null;
  const host = players.find((p) => p.id === hostId) ?? null;
  const reasonId = useId();

  const blockers = startBlockers(players, chart, youId, isHost);
  const canStart = blockers.length === 0;

  return (
    <div className="broadcast-field flex min-h-dvh flex-col">
      <header className="flex items-center justify-between gap-4 px-5 py-3 sm:px-8">
        <span className="label">lobby</span>
        <Button variant="danger" size="sm" onClick={onLeave}>
          Leave room
        </Button>
      </header>
      <div className="rule-h" aria-hidden />

      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-5 py-6 sm:px-8 lg:gap-10">
        <RoomCode code={code} waiting={players.length < 2} />

        <div className="rule-h" aria-hidden />

        <Seats players={players} youId={youId} hostId={hostId} />

        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] lg:gap-10">
          <ChartSection
            chart={chart}
            chartLoading={chartLoading}
            chartError={chartError}
            isHost={isHost}
            hostName={host?.name ?? "the host"}
            onGenerateChart={onGenerateChart}
          />

          <Prerequisites
            cameraReady={cameraReady}
            calibrated={calibrated}
            onCalibrate={onCalibrate}
            onEnableCamera={onEnableCamera}
          />
        </div>
      </div>

      {/*
       * Sticky: on a 13" laptop the chart picker can push START below the fold,
       * and the one control both players are waiting on must never require a
       * scroll to find.
       */}
      <div className="sticky bottom-0 z-20 border-t border-rule bg-stage/95 backdrop-blur-sm">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <div className="flex min-w-0 items-center gap-4">
            {you ? (
              <>
                <Button
                  variant={you.ready ? "ghost" : "primary"}
                  accent={you.seat}
                  size="lg"
                  onClick={() => onReady(!you.ready)}
                  aria-pressed={you.ready}
                >
                  {you.ready ? "Not ready" : "I'm ready"}
                </Button>
                <p className="max-w-[26ch] text-xs leading-snug text-ink-2">
                  {you.ready
                    ? "You're locked in. Unlock if you need a moment."
                    : cameraReady
                      ? "Ready up when you can see your hands."
                      : "Sort your camera out first — you can still ready up."}
                </p>
              </>
            ) : (
              <p className="text-sm text-ink-2">Watching this room.</p>
            )}
          </div>

          <div className="flex flex-col items-start gap-1.5 sm:items-end">
            {isHost ? (
              <>
                <Button
                  variant="primary"
                  size="lg"
                  onClick={onStart}
                  disabled={!canStart}
                  aria-describedby={reasonId}
                >
                  Start match
                </Button>
                <p
                  id={reasonId}
                  aria-live="polite"
                  className="max-w-[42ch] text-xs leading-snug text-ink-2 sm:text-right"
                >
                  {canStart
                    ? "Both players ready. Three, two, one."
                    : `Can't start yet — ${joinClauses(blockers)}.`}
                </p>
              </>
            ) : (
              <>
                <p className="text-sm leading-snug text-ink-2 sm:text-right">
                  <span className="text-ink">{host?.name ?? "The host"}</span>{" "}
                  starts the match.
                </p>
                <p
                  aria-live="polite"
                  className="max-w-[42ch] text-xs leading-snug text-ink-2 sm:text-right"
                >
                  {canStart
                    ? "Everything is set."
                    : `Can't start yet — ${joinClauses(blockers)}.`}
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────── room code

function RoomCode({ code, waiting }: { code: string; waiting: boolean }) {
  const [copyState, setCopyState] = useState<"idle" | "done" | "failed">(
    "idle",
  );

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  async function copy() {
    try {
      // Absent over plain HTTP on a LAN address, which is exactly how a second
      // device usually reaches this app — so failure is expected, not exotic.
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(code);
      setCopyState("done");
    } catch {
      setCopyState("failed");
    }
  }

  return (
    <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-5">
      <h1 className="flex min-w-0 flex-col gap-1">
        <span className="label">room code</span>
        {/* Spelled out for screen readers: "XK4M" would otherwise be read as a
            word, and this string exists to be repeated character by character. */}
        <span
          className="code-display text-ink"
          aria-label={code.split("").join(" ")}
        >
          {code}
        </span>
      </h1>

      <div className="flex flex-col items-start gap-3 pb-2 sm:items-end">
        <p className="max-w-[36ch] text-[0.9375rem] leading-snug text-ink-2 sm:text-right">
          {waiting
            ? "Read this out, or send it over. Your challenger types it on their own device."
            : "Both seats are taken. Keep the code for a reconnect."}
        </p>
        <div className="flex items-center gap-3">
          <Button size="md" onClick={copy}>
            {copyState === "done" ? <CheckIcon /> : <CopyIcon />}
            {copyState === "done" ? "Copied" : "Copy code"}
          </Button>
          <span aria-live="polite" className="label">
            {copyState === "failed" ? "copy it by hand" : ""}
          </span>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────── seats

function Seats({
  players,
  youId,
  hostId,
}: {
  players: Player[];
  youId: string;
  hostId: string;
}) {
  const seats: Seat[] = [0, 1];
  return (
    <section aria-label="Seats" className="flex flex-col gap-3">
      <div className="grid items-center gap-4 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        {seats.map((seat, i) => {
          const player = players.find((p) => p.seat === seat) ?? null;
          return (
            <div key={seat} className={i === 1 ? "md:order-3" : undefined}>
              {player ? (
                <FilledSeat
                  seat={seat}
                  player={player}
                  isYou={player.id === youId}
                  isHost={player.id === hostId}
                />
              ) : (
                <OpenSeat seat={seat} />
              )}
            </div>
          );
        })}
        <span
          aria-hidden
          className="display hidden text-[1.125rem] text-ink-3 md:order-2 md:block md:px-2"
        >
          vs
        </span>
      </div>
    </section>
  );
}

function FilledSeat({
  seat,
  player,
  isYou,
  isHost,
}: {
  seat: Seat;
  player: Player;
  isYou: boolean;
  isHost: boolean;
}) {
  const accent = SEAT[seat];
  const mirrored = seat === 1;
  const tags = [isHost ? "host" : null, isYou ? "you" : null].filter(Boolean);

  return (
    <div className="flex flex-col gap-2">
      <NamePlate
        name={player.name}
        seat={seat}
        subtitle={tags.length ? tags.join(" · ") : undefined}
        active={player.connected}
        size="lg"
        className="w-full"
      />
      <div
        className={`flex items-center gap-2 px-1 ${mirrored ? "flex-row-reverse" : ""}`}
      >
        {player.connected ? (
          <>
            <StateGlyph on={player.ready} cssVar={accent.cssVar} />
            <span
              className="label"
              style={player.ready ? varColor(accent.cssVar) : undefined}
            >
              {player.ready ? "ready" : "not ready"}
            </span>
          </>
        ) : (
          <>
            <span
              aria-hidden
              className="animate-live h-[6px] w-[6px] shrink-0 rounded-full bg-miss"
            />
            <span className="label" style={varColor("var(--color-miss)")}>
              reconnecting
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * An empty seat is an invitation, not a fault. Same silhouette as a NamePlate so
 * the two seats stay aligned, but drained of contrast and with the accent bar
 * ghosted — it reads as "not filled in yet" rather than "something went wrong".
 */
function OpenSeat({ seat }: { seat: Seat }) {
  const accent = SEAT[seat];
  const mirrored = seat === 1;

  return (
    <div className="flex flex-col gap-2">
      <div
        className={`flex min-w-0 items-center gap-3.5 bg-chrome/50 px-4 py-3 ${mirrored ? "flex-row-reverse" : ""}`}
      >
        <span
          aria-hidden
          className={`w-[6px] self-stretch opacity-25 ${accent.fill}`}
        />
        <div
          className={`flex min-w-0 flex-col ${mirrored ? "items-end text-right" : "items-start text-left"}`}
        >
          <span className="plate-name text-[clamp(1.5rem,5vw,2.5rem)] text-ink-3">
            Open seat
          </span>
          <span
            className={`flex items-baseline gap-1.5 ${mirrored ? "flex-row-reverse" : ""}`}
          >
            <span className="label" style={varColor(accent.cssVar)}>
              {accent.tag}
            </span>
            <span className="label">waiting for a challenger</span>
          </span>
        </div>
      </div>
      <div
        className={`flex items-center gap-2 px-1 ${mirrored ? "flex-row-reverse" : ""}`}
      >
        <span
          aria-hidden
          className="animate-live h-[6px] w-[6px] shrink-0 rounded-full bg-ink-3"
        />
        <span className="label">listening for a join</span>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────── chart

function ChartSection({
  chart,
  chartLoading,
  chartError,
  isHost,
  hostName,
  onGenerateChart,
}: {
  chart: Chart | null;
  chartLoading: boolean;
  chartError: string | null;
  isHost: boolean;
  hostName: string;
  onGenerateChart: (input: LobbyChartRequest) => void;
}) {
  return (
    <Panel
      title="the chart"
      action={
        chart ? (
          <span className="label">
            {chart.source === "model" ? "ai arranged" : "built in"}
          </span>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-6">
        {chart ? (
          <ChartSummary chart={chart} />
        ) : chartLoading ? (
          <Arranging />
        ) : (
          <p className="text-[0.9375rem] leading-snug text-ink-2">
            {isHost
              ? "Name a song and we'll arrange it into four to six piano lanes. Leave it blank for a surprise."
              : `${hostName} is picking the music. Nothing for you to do — get your camera framed.`}
          </p>
        )}

        {chartError && (
          <p role="alert" className="text-sm leading-snug text-miss">
            {chartError}
          </p>
        )}

        {isHost && (
          <>
            <div className="rule-h" aria-hidden />
            <ChartPicker
              busy={chartLoading}
              hasChart={chart !== null}
              onGenerateChart={onGenerateChart}
            />
          </>
        )}
      </div>
    </Panel>
  );
}

function Arranging() {
  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden
        className="animate-live h-[8px] w-[8px] shrink-0 rounded-full bg-ink-2"
      />
      <span
        aria-live="polite"
        className="display text-[clamp(1.125rem,2.4vw,1.5rem)] text-ink"
      >
        Arranging the chart
      </span>
    </div>
  );
}

function ChartSummary({ chart }: { chart: Chart }) {
  const stats = useMemo(() => chartStats(chart), [chart]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h3 className="display text-[clamp(1.5rem,3.4vw,2.25rem)] text-ink">
          {chart.title}
        </h3>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="label">
            {chart.key} {chart.scale}
          </span>
          <span aria-hidden className="h-3 w-px bg-rule-bright" />
          <span className="label">{chart.lanes.length} lanes</span>
          <span aria-hidden className="h-3 w-px bg-rule-bright" />
          <span className="label">{formatDuration(chart.durationSec)}</span>
          {chart.song && (
            <>
              <span aria-hidden className="h-3 w-px bg-rule-bright" />
              <span className="label truncate">from {chart.song}</span>
            </>
          )}
        </p>
      </div>

      {chart.blurb && (
        <p className="max-w-[54ch] text-[0.9375rem] leading-snug text-ink-2">
          {chart.blurb}
        </p>
      )}

      <div className="flex flex-col">
        <StatRow label="bpm" p1={chart.bpm} />
        <StatRow label="notes" p1={stats.notes} />
        <StatRow label="notes / sec" p1={stats.densityPerSec} decimals={1} />
        <StatRow label="rounds" p1={chart.rounds.length} />
      </div>

      <ul className="flex flex-wrap gap-x-5 gap-y-2">
        {chart.rounds.map((round) => (
          <li key={round.index} className="flex items-baseline gap-1.5">
            <span className="display text-[0.95rem] text-ink-2">
              R{round.index + 1}
            </span>
            <span className="label">{round.label}</span>
            {round.suddenDeath && (
              <span className="label" style={varColor("var(--color-miss)")}>
                sudden death
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChartPicker({
  busy,
  hasChart,
  onGenerateChart,
}: {
  busy: boolean;
  hasChart: boolean;
  onGenerateChart: (input: LobbyChartRequest) => void;
}) {
  const [song, setSong] = useState("");
  const [brief, setBrief] = useState("");
  const [difficulty, setDifficulty] = useState<LobbyDifficulty>("normal");
  const songId = useId();
  const briefId = useId();
  const groupName = useId();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    onGenerateChart({
      song: song.trim() || undefined,
      brief: brief.trim() || undefined,
      difficulty,
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field id={songId} label="song">
          <input
            id={songId}
            type="text"
            value={song}
            onChange={(e) => setSong(e.target.value)}
            disabled={busy}
            maxLength={120}
            placeholder="Für Elise"
            autoComplete="off"
            className="h-11 w-full border-b border-rule-bright bg-chrome px-3 text-[0.9375rem] text-ink transition-colors placeholder:text-ink-3 focus:border-ink-2 disabled:opacity-40"
          />
        </Field>

        <fieldset className="flex min-w-0 flex-col">
          <legend className="label pb-2">difficulty</legend>
          <div className="flex gap-px bg-rule">
            {DIFFICULTIES.map((level) => (
              <label key={level} className="min-w-0 flex-1 cursor-pointer">
                <input
                  type="radio"
                  name={groupName}
                  value={level}
                  checked={difficulty === level}
                  onChange={() => setDifficulty(level)}
                  disabled={busy}
                  className="peer sr-only"
                />
                <span className="flex h-11 items-center justify-center bg-chrome text-[11px] font-semibold uppercase leading-none tracking-[0.14em] text-ink-3 transition-colors [font-stretch:106%] hover:text-ink peer-checked:bg-ink peer-checked:text-stage peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-p1 peer-disabled:opacity-40">
                  {level}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <Field id={briefId} label="brief — optional">
        <textarea
          id={briefId}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          disabled={busy}
          maxLength={200}
          rows={2}
          placeholder="Bouncy, big chorus, save the hardest run for the last round."
          className="w-full resize-none border-b border-rule-bright bg-chrome px-3 py-2 text-[0.9375rem] leading-snug text-ink transition-colors placeholder:text-ink-3 focus:border-ink-2 disabled:opacity-40"
        />
      </Field>

      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" variant="primary" size="md" disabled={busy}>
          {busy ? "Arranging…" : hasChart ? "Arrange another" : "Arrange chart"}
        </Button>
        {hasChart && !busy && (
          <p className="max-w-[32ch] text-xs leading-snug text-ink-2">
            Both players get whatever you arrange last.
          </p>
        )}
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <label htmlFor={id} className="label pb-2">
        {label}
      </label>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────── prerequisites

/**
 * State is carried by glyph shape and ink brightness, never by hue.
 *
 * Green-for-good would be a third accent competing with the two that mean
 * "player", and amber-for-warning is a near match for P2 — at two metres either
 * one would be read as somebody's colour. Shape survives that distance intact.
 */
function Prerequisites({
  cameraReady,
  calibrated,
  onCalibrate,
  onEnableCamera,
}: {
  cameraReady: boolean;
  calibrated: boolean;
  onCalibrate: () => void;
  onEnableCamera?: () => void;
}) {
  return (
    <Panel title="before you play">
      <ul className="flex flex-col divide-y divide-rule">
        <PrereqRow
          ok={cameraReady}
          title="Camera"
          detail={
            cameraReady
              ? "Your hands are being tracked."
              : "We need your webcam to see your hands. Allow access, then frame yourself so both hands fit."
          }
          action={
            !cameraReady && onEnableCamera ? (
              <Button size="sm" onClick={onEnableCamera}>
                Enable
              </Button>
            ) : undefined
          }
        />
        <PrereqRow
          ok={calibrated}
          title="Timing"
          detail={
            calibrated
              ? "Your latency offset is measured — hits will land where you feel them."
              : "Every webcam lags differently. Tap along to four beats and we'll cancel yours out."
          }
          action={
            <Button size="sm" onClick={onCalibrate}>
              {calibrated ? "Redo" : "Calibrate"}
            </Button>
          }
        />
      </ul>
    </Panel>
  );
}

function PrereqRow({
  ok,
  title,
  detail,
  action,
}: {
  ok: boolean;
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      <span className="mt-0.5 shrink-0">
        <StateGlyph on={ok} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span
          className={`plate-name text-[0.9375rem] ${ok ? "text-ink" : "text-ink-2"}`}
        >
          {title}
        </span>
        <p className="max-w-[42ch] text-xs leading-snug text-ink-3">{detail}</p>
      </div>
      {action && <span className="shrink-0 pt-0.5">{action}</span>}
    </li>
  );
}

// ───────────────────────────────────────────────────────────────────── pieces

/** Filled tick when done, hollow ring when not — readable with no colour at all. */
function StateGlyph({ on, cssVar }: { on: boolean; cssVar?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      aria-hidden
      style={on && cssVar ? { color: cssVar } : undefined}
      className={on ? (cssVar ? undefined : "text-ink") : "text-ink-3"}
    >
      <circle
        cx="8"
        cy="8"
        r="6.4"
        stroke="currentColor"
        strokeWidth={on ? 1.5 : 1.1}
        opacity={on ? 1 : 0.75}
      />
      {on && (
        <path
          d="M5.2 8.2 7.2 10.2 10.9 6"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="5.4" y="5.4" width="8.1" height="8.1" rx="1.2" />
      <path d="M10.6 2.5H3.7a1.2 1.2 0 0 0-1.2 1.2v6.9" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M2.8 8.4 6.2 11.8 13.2 4.4" />
    </svg>
  );
}

// ────────────────────────────────────────────────────────────────────── logic

/**
 * Everything standing between here and a countdown, phrased as clauses that read
 * naturally after "can't start yet — ".
 *
 * The order matters: a chart is the host's job, so it comes first for the host
 * and last for everyone else, and the list is what the START button's
 * enabled-ness is derived from rather than a parallel condition that could drift
 * out of step with the copy.
 */
function startBlockers(
  players: Player[],
  chart: Chart | null,
  youId: string,
  isHost: boolean,
): string[] {
  const blockers: string[] = [];

  if (isHost && !chart) blockers.push("there's no chart yet");

  if (players.length < 2) {
    blockers.push("nobody has taken the second seat");
  } else {
    for (const player of players) {
      const who = player.id === youId ? "you" : player.name;
      if (!player.connected) {
        blockers.push(`${who} ${player.id === youId ? "have" : "has"} dropped out`);
      } else if (!player.ready) {
        blockers.push(`${who} ${player.id === youId ? "aren't" : "isn't"} ready`);
      }
    }
  }

  if (!isHost && !chart) blockers.push("the host hasn't picked a chart");

  return blockers;
}

/** "a", "a and b", "a, b and c" — a list a person would actually say out loud. */
function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
