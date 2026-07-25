"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Chart, RoundSummary, ScoreState } from "@/lib/game/types";
import { emptyScore, DEFAULT_CALIBRATION_SEC } from "@/lib/game/types";
import { DuelSession, type JudgementSignal } from "@/lib/game/session";
import {
  calibrationClicks,
  computeCalibration,
  type CalibrationResult,
} from "@/lib/game/calibration";
import { scheduleCountIn } from "@/lib/game/backing";
import { expandChart, repairSpec } from "@/lib/game/chart";
import { DuelClient } from "@/lib/net/client";
import type { Player } from "@/lib/net/protocol";
import { TitleScreen } from "./TitleScreen";
import { LobbyScreen, type LobbyChartRequest } from "./LobbyScreen";
import { CalibrateScreen, type CalibratePhase } from "./CalibrateScreen";
import { CountdownScreen } from "./CountdownScreen";
import { PlayScreen } from "./PlayScreen";
import { RoundBreakScreen } from "./RoundBreakScreen";
import { ResultScreen } from "./ResultScreen";

/**
 * The orchestrator.
 *
 * Owns all state, networking, audio and vision, and drives the screens — which
 * are all purely presentational. The screens never touch the session or the
 * network client.
 *
 * ── The division of labour that keeps this playable ───────────────────────
 * DuelSession runs the game at 60fps through refs, with React nowhere in it.
 * This component polls it on a slow timer (UI_POLL_MS) and re-renders at ~12Hz.
 * That is fast enough that a score never looks stale, and slow enough that
 * React can never sit between a hand movement and a sound.
 *
 * Everything per-frame — falling notes, the hand skeleton, hit detection — is
 * canvas and plain classes. Everything a human reads at human speed is React.
 */

type Phase =
  | "title"
  | "lobby"
  | "calibrate"
  | "countdown"
  | "playing"
  | "roundBreak"
  | "result";

/** How often React reads the session. ~12Hz: smooth to the eye, cheap to render. */
const UI_POLL_MS = 80;
const CALIBRATION_BEATS = 8;
const CALIBRATION_BPM = 100;
const CALIBRATION_LEAD_SEC = 1.2;

interface SideState {
  name: string;
  seat: 0 | 1;
  score: number;
  combo: number;
  bestCombo: number;
  accuracy: number;
  connected: boolean;
}

const EMPTY_SUMMARY = (round: number): RoundSummary => ({
  round,
  score: 0,
  accuracy: 1,
  bestCombo: 0,
  counts: { perfect: 0, great: 0, good: 0, miss: 0 },
});

export function DuelShell() {
  // ── refs: the parts React must never re-render ──────────────────────────
  const sessionRef = useRef<DuelSession | null>(null);
  const clientRef = useRef<DuelClient | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const highwayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const calibrationSecRef = useRef(DEFAULT_CALIBRATION_SEC);
  const clickTimesRef = useRef<number[]>([]);
  const roundRef = useRef(0);
  /**
   * The chart, mirrored out of state.
   *
   * `beginCountdown` is a stable callback invoked from a network event, so it
   * closes over whatever `chart` was when it was created — which is null. The
   * session must be handed the *current* chart, so it reads this instead.
   */
  const chartRef = useRef<Chart | null>(null);

  // ── React state: things a human changes at human speed ──────────────────
  const [phase, setPhase] = useState<Phase>("title");
  const [connecting, setConnecting] = useState(false);
  const [netError, setNetError] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [players, setPlayers] = useState<Player[]>([]);
  const [youId, setYouId] = useState("");
  const [hostId, setHostId] = useState("");

  const [chart, setChart] = useState<Chart | null>(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);

  const [cameraReady, setCameraReady] = useState(false);
  const [calibrated, setCalibrated] = useState(false);
  const [calibratePhase, setCalibratePhase] = useState<CalibratePhase>("intro");
  const [calibrationResult, setCalibrationResult] =
    useState<CalibrationResult | null>(null);
  const [beatsElapsed, setBeatsElapsed] = useState(0);
  const [tapsMatched, setTapsMatched] = useState(0);

  const [countdownLeft, setCountdownLeft] = useState(3);
  const [round, setRound] = useState(0);
  const [chartTimeSec, setChartTimeSec] = useState(0);
  const [score, setScore] = useState<ScoreState>(emptyScore());
  const [lastJudgement, setLastJudgement] = useState<JudgementSignal | null>(
    null,
  );
  const [paused, setPaused] = useState(false);

  const [opponent, setOpponent] = useState<SideState | null>(null);
  const [roundSummaries, setRoundSummaries] = useState<
    { you: RoundSummary; opponent: RoundSummary | null }[]
  >([]);
  const [commentary, setCommentary] = useState<string | null>(null);
  const [commentaryLoading, setCommentaryLoading] = useState(false);
  const [roundReady, setRoundReady] = useState(false);
  const [opponentReady, setOpponentReady] = useState(false);
  const [winnerId, setWinnerId] = useState<string | null>(null);

  /** Phases where seeing your own camera actually helps you get set up. */
  const showPreview =
    phase === "lobby" || phase === "calibrate" || phase === "countdown";

  useEffect(() => {
    chartRef.current = chart;
  }, [chart]);


  // Readiness is authoritative on the server, so derive it from the room state
  // rather than tracking a second copy that can drift out of sync.
  useEffect(() => {
    const other = players.find((p) => p.id !== youId);
    setOpponentReady(other?.ready ?? false);
  }, [players, youId]);

  const you = players.find((p) => p.id === youId);
  const opp = players.find((p) => p.id !== youId) ?? null;
  const isHost = youId !== "" && youId === hostId;

  // ── session polling: the only bridge from the 60fps world to React ───────
  useEffect(() => {
    if (phase !== "playing" && phase !== "calibrate" && phase !== "countdown") {
      return;
    }
    const id = window.setInterval(() => {
      const session = sessionRef.current;
      if (!session) return;

      setChartTimeSec(session.chartTimeSec());
      setScore(session.getScore());

      const j = session.takeJudgement();
      if (j) setLastJudgement((prev) => (prev?.id === j.id ? prev : j));

      if (phase === "calibrate" && calibratePhase === "running") {
        setTapsMatched(session.tapCount);
        const elapsed = Math.max(
          0,
          Math.floor(
            (session.chartTimeSec() - CALIBRATION_LEAD_SEC) /
              (60 / CALIBRATION_BPM),
          ) + 1,
        );
        setBeatsElapsed(Math.min(CALIBRATION_BEATS, elapsed));
      }
    }, UI_POLL_MS);
    return () => window.clearInterval(id);
  }, [phase, calibratePhase]);

  /**
   * Rebind the session to whichever screen is now mounted.
   *
   * Each phase renders its own <video> and canvases, so the DOM nodes behind
   * these refs change on every transition. Without this the session would keep
   * drawing into the previous screen's detached canvas — which is exactly the
   * bug that made the highway and the camera render as black rectangles.
   *
   * Layout-effect timing matters: it runs after the new screen has committed to
   * the DOM but before paint, so there is never a frame drawn into the old node.
   */
  useLayoutEffect(() => {
    const session = sessionRef.current;
    if (!session?.ready) return;
    const video = videoRef.current;
    const highway = highwayCanvasRef.current;
    const overlay = overlayCanvasRef.current;
    if (!video || !highway || !overlay) return;
    void session.attach({
      video,
      highwayCanvas: highway,
      overlayCanvas: overlay,
    });
  }, [phase]);

  // Push our score to the opponent. The client coalesces to SCORE_PUSH_HZ, so
  // calling this every poll is cheap and keeps their bar smooth.
  useEffect(() => {
    if (phase !== "playing") return;
    clientRef.current?.sendScore({
      round: roundRef.current,
      score: score.score,
      combo: score.combo,
      bestCombo: score.bestCombo,
      accuracy: score.accuracy,
    });
  }, [phase, score]);

  // ── networking ──────────────────────────────────────────────────────────
  const ensureClient = useCallback((): DuelClient => {
    if (clientRef.current) return clientRef.current;
    const client = new DuelClient();
    clientRef.current = client;

    client.on("welcome", (m) => setYouId(m.playerId));
    client.on("room", (m) => {
      setCode(m.code);
      setHostId(m.hostId);
      setPlayers(m.players);
      setPhase((p) => (p === "title" ? "lobby" : p));
    });
    client.on("chart", (m) => {
      setChart(m.chart);
      setChartLoading(false);
    });
    client.on("countdown", (m) => {
      setRound(m.round);
      roundRef.current = m.round;
      beginCountdown(m.startAtServerMs);
    });
    client.on("opponentScore", (m) =>
      setOpponent((prev) =>
        prev
          ? { ...prev, ...m.update, connected: true }
          : {
              name: opp?.name ?? "Challenger",
              seat: (opp?.seat ?? 1) as 0 | 1,
              connected: true,
              ...m.update,
            },
      ),
    );
    client.on("roundResult", (m) => handleRoundResult(m));
    client.on("matchResult", (m) => {
      setWinnerId(m.winnerId);
      setPhase("result");
    });
    client.on("opponentLeft", () =>
      setOpponent((prev) => (prev ? { ...prev, connected: false } : prev)),
    );
    client.on("error", (m) => setNetError(m.message));

    return client;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opp?.name, opp?.seat]);

  const connect = useCallback(
    async (then: (c: DuelClient) => void) => {
      setConnecting(true);
      setNetError(null);
      try {
        const client = ensureClient();
        await client.connect(playerName());
        then(client);
      } catch (err) {
        setNetError(err instanceof Error ? err.message : "Could not connect");
      } finally {
        setConnecting(false);
      }
    },
    [ensureClient],
  );

  const handleCreate = useCallback(
    () => void connect((c) => c.createRoom()),
    [connect],
  );
  const handleJoin = useCallback(
    (roomCode: string) => void connect((c) => c.joinRoom(roomCode)),
    [connect],
  );

  // ── session boot ────────────────────────────────────────────────────────
  const bootSession = useCallback(async () => {
    if (sessionRef.current) return sessionRef.current;
    const session = new DuelSession();
    sessionRef.current = session;
    try {
      await session.init({
        video: videoRef.current!,
        highwayCanvas: highwayCanvasRef.current!,
        overlayCanvas: overlayCanvasRef.current!,
      });
      setCameraReady(true);
      return session;
    } catch (err) {
      setNetError(
        err instanceof Error ? err.message : "Could not start the camera",
      );
      sessionRef.current = null;
      throw err;
    }
  }, []);

  // ── chart generation (host only) ────────────────────────────────────────
  const handleGenerateChart = useCallback(
    async (input: LobbyChartRequest) => {
      setChartLoading(true);
      setChartError(null);
      try {
        const res = await fetch("/api/chart", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        const data = await res.json();
        const built: Chart = data.chart;
        setChart(built);
        // Push it to the room so both players are guaranteed the same chart —
        // generating independently on each client would produce two different
        // songs and make the scores meaningless.
        clientRef.current?.setChart(built);
        if (data.warning) setChartError(data.warning);
      } catch (err) {
        setChartError(
          err instanceof Error ? err.message : "Chart generation failed",
        );
      } finally {
        setChartLoading(false);
      }
    },
    [],
  );

  // ── calibration ─────────────────────────────────────────────────────────
  const startCalibration = useCallback(async () => {
    const session = await bootSession();
    const ctx = session.engine.context;
    if (!ctx) return;

    // A throwaway one-lane chart so the player has something to strike.
    const spec = repairSpec({
      title: "Calibration",
      bpm: CALIBRATION_BPM,
      key: "C",
      scale: "major",
      lanes: [0, 1, 2, 3].map((i) => ({ label: `L${i}`, note: "C4" })),
      rounds: [{ label: "Tap", bars: 2, patterns: ["----------------"] }],
    });
    session.useCalibrationLayout(expandChart(spec));

    const startAt = ctx.currentTime + 0.15;
    session.startAt(startAt);
    clickTimesRef.current = calibrationClicks(
      CALIBRATION_LEAD_SEC,
      CALIBRATION_BPM,
      CALIBRATION_BEATS,
    );
    scheduleCountIn(
      session.engine,
      startAt + CALIBRATION_LEAD_SEC,
      CALIBRATION_BPM,
      CALIBRATION_BEATS,
    );
    session.beginCalibration();
    setCalibratePhase("running");
    setBeatsElapsed(0);
    setTapsMatched(0);

    const runMs =
      (CALIBRATION_LEAD_SEC + (CALIBRATION_BEATS * 60) / CALIBRATION_BPM + 0.6) *
      1000;
    window.setTimeout(() => {
      const taps = session.endCalibration();
      session.stopChart();
      const result = computeCalibration(taps, clickTimesRef.current);
      setCalibrationResult(result);
      setCalibratePhase("done");
    }, runMs);
  }, [bootSession]);

  const acceptCalibration = useCallback((offsetSec: number) => {
    calibrationSecRef.current = offsetSec;
    sessionRef.current?.setCalibration(offsetSec);
    setCalibrated(true);
    setPhase("lobby");
  }, []);

  // ── countdown → play ────────────────────────────────────────────────────
  const beginCountdown = useCallback((startAtServerMs: number) => {
    setPhase("countdown");
    const tick = () => {
      const client = clientRef.current;
      const msLeft = startAtServerMs - (client?.serverNow() ?? Date.now());
      setCountdownLeft(Math.max(0, msLeft / 1000));

      if (msLeft <= 0) {
        void (async () => {
          const session = await bootSession();
          const ctx = session.engine.context;
          const activeChart = chartRef.current;
          if (!ctx || !activeChart) return;

          // Install the chart on the SESSION, not just in React state. Without
          // this the session has no notes to draw, no lanes to strike, and
          // startAt() bails — which renders as a black highway and a dead game.
          session.setChart(activeChart, calibrationSecRef.current);
          // Give the highway a moment of lead-in so notes are already falling
          // and correctly positioned when beat one lands, rather than popping
          // into existence on top of the hit line.
          session.startAt(ctx.currentTime + 0.05);
          setPhase("playing");
        })();
        return;
      }
      window.setTimeout(tick, 60);
    };
    tick();
  }, [bootSession]);

  // Detect chart end and report the round.
  useEffect(() => {
    if (phase !== "playing") return;
    const session = sessionRef.current;
    if (!session) return;
    const id = window.setInterval(() => {
      if (!session.finished) return;
      window.clearInterval(id);
      session.stopChart();
      const summary = session.getRoundSummary(roundRef.current);
      clientRef.current?.sendRoundDone(summary);
      setPhase("roundBreak");
    }, 120);
    return () => window.clearInterval(id);
  }, [phase]);

  const handleRoundResult = useCallback(
    (m: {
      round: number;
      summaries: { playerId: string; summary: RoundSummary }[];
    }) => {
      const mine =
        m.summaries.find((s) => s.playerId === youId)?.summary ??
        EMPTY_SUMMARY(m.round);
      const theirs =
        m.summaries.find((s) => s.playerId !== youId)?.summary ?? null;
      setRoundSummaries((prev) => [...prev, { you: mine, opponent: theirs }]);
      void fetchCommentary(m.round, mine, theirs);
    },
    [youId],
  );

  const fetchCommentary = useCallback(
    async (r: number, mine: RoundSummary, theirs: RoundSummary | null) => {
      setCommentaryLoading(true);
      setCommentary(null);
      try {
        const res = await fetch("/api/commentary", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            round: r,
            totalRounds: chart?.rounds.length ?? 3,
            final: false,
            players: [
              { name: you?.name ?? "You", ...statFor(mine) },
              ...(theirs
                ? [{ name: opp?.name ?? "Challenger", ...statFor(theirs) }]
                : []),
            ],
          }),
        });
        const data = await res.json();
        setCommentary(data.line ?? null);
      } catch {
        setCommentary(null);
      } finally {
        setCommentaryLoading(false);
      }
    },
    [chart?.rounds.length, you?.name, opp?.name],
  );

  /**
   * Generate a chart automatically as soon as the host has a room.
   *
   * Nobody should have to fill in a form before they can play. The host can
   * still name a specific song or reroll from the lobby, but by the time the
   * second player has finished reading the code aloud there is already
   * something on the table.
   */
  useEffect(() => {
    if (!isHost || chart || chartLoading || !code) return;
    void handleGenerateChart({ song: pickSeed(), difficulty: "easy" });
    // Intentionally not depending on handleGenerateChart: it is stable, but
    // including it would reroll the chart if its identity ever changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, code, chart, chartLoading]);

  useEffect(() => {
    return () => {
      sessionRef.current?.dispose();
      clientRef.current?.disconnect();
    };
  }, []);

  // ── render ──────────────────────────────────────────────────────────────
  const seat = (you?.seat ?? 0) as 0 | 1;
  const oppSeat = (opp?.seat ?? 1) as 0 | 1;

  return (
    <>
      {/*
        Camera preview for the phases that need tracking but have no play
        screen. Only one screen is ever mounted, so this and PlayScreen's own
        video never coexist — the refs simply move, and `session.attach()`
        rebinds the stream and rebuilds the renderers against the new nodes.
      */}
      {phase !== "playing" && (
        <div
          className={
            showPreview
              ? "pointer-events-none fixed bottom-4 right-4 z-40 w-56 overflow-hidden rounded-lg border border-rule bg-black/70 shadow-2xl"
              : "pointer-events-none fixed -left-[9999px] top-0 w-56"
          }
        >
          <div className="relative aspect-[4/3]">
            <video
              ref={videoRef}
              playsInline
              muted
              className="absolute inset-0 h-full w-full scale-x-[-1] object-cover"
            />
            {/* Not CSS-mirrored: landmark coordinates are already view-space. */}
            <canvas
              ref={overlayCanvasRef}
              className="absolute inset-0 h-full w-full"
            />
          </div>
          {showPreview && <div className="label px-2 py-1">your camera</div>}
          {/* The highway renderer needs a canvas at all times, so it always has
              somewhere valid to bind; PlayScreen supplies the real one. */}
          <canvas ref={highwayCanvasRef} className="hidden" aria-hidden />
        </div>
      )}

      {phase === "title" && (
        <TitleScreen
          onCreate={handleCreate}
          onJoin={handleJoin}
          connecting={connecting}
          error={netError}
          onPractice={() => {
            window.location.href = "/practice";
          }}
        />
      )}

      {phase === "lobby" && (
        <LobbyScreen
          code={code}
          players={players}
          youId={youId}
          hostId={hostId}
          chart={chart}
          chartLoading={chartLoading}
          chartError={chartError}
          onGenerateChart={(i) => void handleGenerateChart(i)}
          onReady={(r) => clientRef.current?.setReady(r)}
          onStart={() => clientRef.current?.start()}
          onLeave={() => {
            clientRef.current?.disconnect();
            setPhase("title");
          }}
          cameraReady={cameraReady}
          calibrated={calibrated}
          onCalibrate={() => {
            setCalibratePhase("intro");
            setPhase("calibrate");
          }}
          onEnableCamera={() => void bootSession()}
        />
      )}

      {phase === "calibrate" && (
        <CalibrateScreen
          phase={calibratePhase}
          beatsTotal={CALIBRATION_BEATS}
          beatsElapsed={beatsElapsed}
          tapsMatched={tapsMatched}
          result={calibrationResult}
          currentOffsetSec={calibrationSecRef.current}
          onStart={() => void startCalibration()}
          onAccept={acceptCalibration}
          onManualChange={(s) => {
            calibrationSecRef.current = s;
            sessionRef.current?.setCalibration(s);
          }}
          onSkip={() => setPhase("lobby")}
        />
      )}

      {phase === "countdown" && chart && (
        <CountdownScreen
          secondsLeft={countdownLeft}
          round={round}
          roundLabel={chart.rounds[round]?.label ?? `Round ${round + 1}`}
          totalRounds={chart.rounds.length}
          chartTitle={chart.title}
          bpm={chart.bpm}
          laneCount={chart.lanes.length}
        />
      )}

      {phase === "playing" && chart && (
        <PlayScreen
          chart={chart}
          round={round}
          chartTimeSec={chartTimeSec}
          videoRef={videoRef}
          highwayCanvasRef={highwayCanvasRef}
          overlayCanvasRef={overlayCanvasRef}
          you={{
            name: you?.name ?? "You",
            seat,
            score: score.score,
            combo: score.combo,
            bestCombo: score.bestCombo,
            accuracy: score.accuracy,
          }}
          opponent={
            opponent
              ? {
                  name: opponent.name,
                  seat: oppSeat,
                  score: opponent.score,
                  combo: opponent.combo,
                  accuracy: opponent.accuracy,
                  connected: opponent.connected,
                }
              : null
          }
          lastJudgement={lastJudgement}
          paused={paused}
          onPause={() => setPaused((p) => !p)}
        />
      )}

      {phase === "roundBreak" && (
        <RoundBreakScreen
          round={round}
          totalRounds={chart?.rounds.length ?? 3}
          you={{
            ...(roundSummaries[roundSummaries.length - 1]?.you ??
              EMPTY_SUMMARY(round)),
            name: you?.name ?? "You",
            seat,
          }}
          opponent={
            roundSummaries[roundSummaries.length - 1]?.opponent
              ? {
                  ...roundSummaries[roundSummaries.length - 1]!.opponent!,
                  name: opp?.name ?? "Challenger",
                  seat: oppSeat,
                }
              : null
          }
          matchScore={countRoundsWon(roundSummaries)}
          commentary={commentary}
          commentaryLoading={commentaryLoading}
          secondsUntilNext={null}
          onReady={() => {
            setRoundReady(true);
            // A chart is one continuous run — its "rounds" are escalating
            // sections inside the same song, not separate play-throughs. So
            // reaching the break means the match is over; acknowledging it
            // reports the final score and the server decides the winner.
            const total = totalSummary(roundSummaries.map((r) => r.you));
            clientRef.current?.sendMatchDone(total);
          }}
          isReady={roundReady}
          opponentReady={opponentReady}
        />
      )}

      {phase === "result" && (
        <ResultScreen
          winnerId={winnerId}
          youId={youId}
          you={{
            ...totalSummary(roundSummaries.map((r) => r.you)),
            name: you?.name ?? "You",
            seat,
          }}
          opponent={
            roundSummaries.some((r) => r.opponent)
              ? {
                  ...totalSummary(
                    roundSummaries
                      .map((r) => r.opponent)
                      .filter((s): s is RoundSummary => s !== null),
                  ),
                  name: opp?.name ?? "Challenger",
                  seat: oppSeat,
                }
              : null
          }
          perRound={roundSummaries.map((r, i) => ({
            round: i,
            you: r.you.score,
            opponent: r.opponent?.score ?? 0,
          }))}
          commentary={commentary}
          onRematch={() => {
            setRoundSummaries([]);
            setRoundReady(false);
            setOpponentReady(false);
            setPhase("lobby");
          }}
          onExit={() => {
            clientRef.current?.disconnect();
            setPhase("title");
          }}
        />
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────── helpers

/**
 * Seeds for the auto-generated chart.
 *
 * Deliberately melodies almost everyone can hum: the Magic Piano payoff is
 * hearing something you recognise come out of your own hands, and that only
 * lands if you already know the tune. All are long out of copyright.
 */
const CHART_SEEDS = [
  "Ode to Joy",
  "Für Elise",
  "Greensleeves",
  "Clair de Lune",
  "Canon in D",
  "Moonlight Sonata",
  "In the Hall of the Mountain King",
  "Gymnopédie No.1",
  "The Entertainer",
  "Swan Lake",
  "Nocturne Op.9 No.2",
  "Prelude in C",
];

function pickSeed(): string {
  return CHART_SEEDS[Math.floor(Math.random() * CHART_SEEDS.length)];
}

function playerName(): string {
  if (typeof window === "undefined") return "Player";
  const stored = window.localStorage.getItem("air-duel-name");
  if (stored) return stored;
  const generated = `Player ${Math.floor(Math.random() * 90) + 10}`;
  window.localStorage.setItem("air-duel-name", generated);
  return generated;
}

function statFor(s: RoundSummary) {
  return {
    score: s.score,
    accuracy: s.accuracy,
    bestCombo: s.bestCombo,
    counts: s.counts,
  };
}

function countRoundsWon(
  rounds: { you: RoundSummary; opponent: RoundSummary | null }[],
) {
  let mine = 0;
  let theirs = 0;
  for (const r of rounds) {
    if (!r.opponent) continue;
    if (r.you.score > r.opponent.score) mine++;
    else if (r.opponent.score > r.you.score) theirs++;
  }
  return { you: mine, opponent: theirs };
}

/** Aggregate per-round summaries into one match-level summary. */
function totalSummary(rounds: RoundSummary[]): RoundSummary {
  const counts = { perfect: 0, great: 0, good: 0, miss: 0 };
  let score = 0;
  let bestCombo = 0;
  let weighted = 0;
  let resolved = 0;

  for (const r of rounds) {
    score += r.score;
    bestCombo = Math.max(bestCombo, r.bestCombo);
    for (const k of Object.keys(counts) as (keyof typeof counts)[]) {
      counts[k] += r.counts[k] ?? 0;
    }
    const n =
      (r.counts.perfect ?? 0) +
      (r.counts.great ?? 0) +
      (r.counts.good ?? 0) +
      (r.counts.miss ?? 0);
    weighted += r.accuracy * n;
    resolved += n;
  }

  return {
    round: 0,
    score,
    bestCombo,
    counts,
    accuracy: resolved > 0 ? weighted / resolved : 1,
  };
}
