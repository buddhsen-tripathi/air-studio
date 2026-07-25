"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AudioEngine } from "@/lib/audio/engine";
import { DEFAULT_LAYOUT } from "@/lib/layout/presets";
import type { Layout } from "@/lib/layout/types";
import { StageRenderer } from "@/lib/render/stage";
import { HandTracker } from "@/lib/vision/handTracker";
import {
  DEFAULT_PERFORMER_CONFIG,
  Performer,
  type PerformerConfig,
} from "@/lib/vision/performer";
import { ArrangePanel } from "./ArrangePanel";
import { CoachPanel } from "./CoachPanel";
import { ControlRail, type StudioSettings } from "./ControlRail";
import { NoteRibbon } from "./NoteRibbon";
import { TelemetryBar } from "./TelemetryBar";
import { Button } from "./ui";

/**
 * Studio orchestrator.
 *
 * The central architectural rule of this app lives here:
 *
 *     camera frame -> Performer.update() -> AudioEngine.noteOn()
 *
 * runs entirely through refs, synchronously, inside the video frame callback.
 * React is never in that path. React state holds only what a human reads and
 * changes at human speed — the layout, the sliders, the AI panels. Drawing runs
 * on a separate requestAnimationFrame loop that reads the same refs.
 *
 * If a hit ever had to wait for a re-render, the instrument would be unplayable
 * on a bad day and merely mushy on a good one.
 */

type Status = "idle" | "starting" | "running" | "error";

const DEFAULT_SETTINGS: StudioSettings = {
  masterGain: 0.9,
  space: DEFAULT_LAYOUT.space,
  cameraDim: 0.4,
  showSkeleton: true,
  showPrediction: true,
};

export default function Studio() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const engineRef = useRef<AudioEngine | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);
  const performerRef = useRef<Performer | null>(null);
  const rendererRef = useRef<StageRenderer | null>(null);
  const rafRef = useRef<number | null>(null);

  /** Hot-path mirrors of React state, read by the render loop each frame. */
  const layoutRef = useRef<Layout>(DEFAULT_LAYOUT);
  const settingsRef = useRef<StudioSettings>(DEFAULT_SETTINGS);

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [layout, setLayout] = useState<Layout>(DEFAULT_LAYOUT);
  const [layoutSource, setLayoutSource] = useState<string>("preset");
  const [notice, setNotice] = useState<string | null>(null);
  const [config, setConfig] = useState<PerformerConfig>(
    DEFAULT_PERFORMER_CONFIG,
  );
  const [settings, setSettings] = useState<StudioSettings>(DEFAULT_SETTINGS);

  // ------------------------------------------------------------------ startup

  const start = useCallback(async () => {
    if (status === "starting" || status === "running") return;
    setStatus("starting");
    setError(null);

    try {
      // Create the AudioContext FIRST, synchronously within the click handler.
      // Browsers only allow it during a user gesture, and awaiting the model
      // load before this would spend the gesture and leave us muted.
      const engine = engineRef.current ?? new AudioEngine();
      engineRef.current = engine;
      await engine.init();
      engine.setMasterGain(settingsRef.current.masterGain);
      engine.setSpace(settingsRef.current.space);

      const performer = performerRef.current ?? new Performer(engine);
      performerRef.current = performer;
      performer.setConfig(config);
      performer.setLayout(layoutRef.current);

      const tracker = trackerRef.current ?? new HandTracker({ mirror: true });
      trackerRef.current = tracker;

      await tracker.load();

      const video = videoRef.current;
      if (!video) throw new Error("Video element is not mounted");
      await tracker.startCamera(video);

      // The hot path. Synchronous, ref-only, no React.
      tracker.start((frame) => performer.update(frame));

      const canvas = canvasRef.current;
      if (canvas) {
        rendererRef.current = new StageRenderer(canvas, performer);
      }

      setStatus("running");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(explainStartupError(message));
      setStatus("error");
    }
  }, [config, status]);

  const stop = useCallback(() => {
    trackerRef.current?.stop();
    performerRef.current?.panic();
    const video = videoRef.current;
    if (video) {
      const stream = video.srcObject as MediaStream | null;
      for (const track of stream?.getTracks() ?? []) track.stop();
      video.srcObject = null;
    }
    setStatus("idle");
  }, []);

  // -------------------------------------------------------------- render loop

  useEffect(() => {
    if (status !== "running") return;

    const draw = () => {
      const renderer = rendererRef.current;
      const stage = stageRef.current;
      if (renderer && stage) {
        renderer.resize(stage.clientWidth, stage.clientHeight);
        renderer.draw(layoutRef.current, {
          showSkeleton: settingsRef.current.showSkeleton,
          showPrediction: settingsRef.current.showPrediction,
          showLabels: true,
        });
      }
      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [status]);

  // Release the camera and audio device when the studio unmounts. Without this,
  // the webcam light stays on after navigating away.
  useEffect(() => {
    return () => {
      trackerRef.current?.dispose();
      void engineRef.current?.dispose();
    };
  }, []);

  // Pause cleanly when the tab is hidden: inference on a background tab is
  // throttled to ~1fps, which produces wild velocities and phantom hits.
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) performerRef.current?.panic();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // ---------------------------------------------------------------- mutations

  const applyLayout = useCallback(
    (next: Layout, meta: { source: string; warning?: string }) => {
      layoutRef.current = next;
      setLayout(next);
      setLayoutSource(meta.source);
      setNotice(meta.warning ?? null);
      performerRef.current?.setLayout(next);
      performerRef.current?.clearHistory();

      // Each layout carries its own sense of space; adopt it, and keep the
      // slider in sync so the user sees what changed.
      const merged = { ...settingsRef.current, space: next.space };
      settingsRef.current = merged;
      setSettings(merged);
      engineRef.current?.setSpace(next.space);
    },
    [],
  );

  const applyConfig = useCallback((next: PerformerConfig) => {
    setConfig(next);
    performerRef.current?.setConfig(next);
  }, []);

  const applySettings = useCallback((next: StudioSettings) => {
    settingsRef.current = next;
    setSettings(next);
    engineRef.current?.setMasterGain(next.masterGain);
    engineRef.current?.setSpace(next.space);
  }, []);

  const running = status === "running";

  return (
    <main className="mx-auto flex min-h-screen max-w-[1500px] flex-col gap-3 p-3 lg:p-4">
      <Header
        status={status}
        layout={layout}
        layoutSource={layoutSource}
        onStart={() => void start()}
        onStop={stop}
      />

      <div className="grid flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-3">
          <div
            ref={stageRef}
            className="stage-vignette relative aspect-video w-full overflow-hidden rounded-xl border border-edge bg-black"
          >
            <video
              ref={videoRef}
              playsInline
              muted
              // Mirrored so the player sees themselves as in a mirror. Landmark
              // coordinates are mirrored to match inside HandTracker, so the
              // canvas on top needs no transform of its own. Dimming is applied
              // to the video only — the zone overlay above keeps full contrast.
              style={{ filter: `brightness(${1 - settings.cameraDim})` }}
              className="absolute inset-0 h-full w-full scale-x-[-1] object-cover"
            />
            <canvas
              ref={canvasRef}
              className="pointer-events-none absolute inset-0 h-full w-full"
            />

            {!running && (
              <StageOverlay
                status={status}
                error={error}
                onStart={() => void start()}
              />
            )}
          </div>

          <TelemetryBar
            performerRef={performerRef}
            engineRef={engineRef}
            running={running}
          />
          <NoteRibbon performerRef={performerRef} running={running} />

          {layout.howToPlay && (
            <div className="rounded-xl border border-edge bg-panel/60 px-3.5 py-3">
              <span className="mb-1 block text-[10px] uppercase tracking-[0.12em] text-ink-faint">
                How to play {layout.name}
              </span>
              <p className="text-[13px] leading-relaxed text-ink-dim">
                {layout.howToPlay}
              </p>
            </div>
          )}

          {notice && (
            <p className="rounded-xl border border-amber/30 bg-amber/10 px-3.5 py-2.5 text-[12px] leading-snug text-amber">
              {notice}
            </p>
          )}
        </div>

        <aside className="flex flex-col gap-3">
          <ArrangePanel onLayout={applyLayout} currentLayoutId={layout.id} />
          <CoachPanel
            performerRef={performerRef}
            layout={layout}
            running={running}
          />
          <ControlRail
            config={config}
            onConfig={applyConfig}
            settings={settings}
            onSettings={applySettings}
          />
        </aside>
      </div>
    </main>
  );
}

// -------------------------------------------------------------------- chrome

function Header({
  status,
  layout,
  layoutSource,
  onStart,
  onStop,
}: {
  status: Status;
  layout: Layout;
  layoutSource: string;
  onStart: () => void;
  onStop: () => void;
}) {
  const running = status === "running";
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-edge bg-panel/80 px-3.5 py-2.5 backdrop-blur-sm">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span
            className={`rec-dot relative block h-2 w-2 rounded-full ${
              running ? "bg-signal text-signal" : "bg-edge-bright text-transparent"
            }`}
          />
          <h1 className="text-[15px] font-semibold tracking-tight">
            Air Studio
          </h1>
        </div>
        <span className="hidden text-[12px] text-ink-faint sm:inline">
          play the air
        </span>
      </div>

      <div className="flex min-w-0 items-center gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[13px] text-ink">{layout.name}</span>
          <span className="numeric shrink-0 text-[11px] text-ink-faint">
            {layout.key} {layout.scale} · {layout.tempo} BPM
          </span>
          {layoutSource === "model" && (
            <span className="shrink-0 rounded border border-signal/30 bg-signal/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-signal">
              AI
            </span>
          )}
        </div>

        {running ? (
          <Button variant="danger" onClick={onStop}>
            Stop
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={onStart}
            disabled={status === "starting"}
          >
            {status === "starting" ? "Starting…" : "Start camera"}
          </Button>
        )}
      </div>
    </header>
  );
}

function StageOverlay({
  status,
  error,
  onStart,
}: {
  status: Status;
  error: string | null;
  onStart: () => void;
}) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-chassis/85 px-6 text-center backdrop-blur-sm">
      {status === "starting" ? (
        <>
          <Spinner />
          <p className="text-[13px] text-ink-dim">
            Loading the hand tracking model…
          </p>
        </>
      ) : status === "error" ? (
        <>
          <p className="max-w-md text-[13px] leading-relaxed text-hot">
            {error}
          </p>
          <Button onClick={onStart}>Try again</Button>
        </>
      ) : (
        <>
          <div className="max-w-md space-y-2">
            <h2 className="text-[17px] font-semibold text-ink">
              Play instruments in the air
            </h2>
            <p className="text-[13px] leading-relaxed text-ink-dim">
              Your webcam tracks your hands. Strike through the pads to play
              them. Name a song and the AI will build you an instrument to play
              along with it.
            </p>
          </div>
          <Button variant="primary" onClick={onStart}>
            Start camera
          </Button>
          <p className="text-[11px] text-ink-faint">
            Video is processed entirely in your browser and never uploaded.
          </p>
        </>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <span
      aria-hidden
      className="block h-6 w-6 animate-spin rounded-full border-2 border-edge-bright border-t-signal"
    />
  );
}

/** Turn raw getUserMedia / model-load failures into something actionable. */
function explainStartupError(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("permission") || lower.includes("notallowed")) {
    return "Camera access was blocked. Allow camera permission for this site in your browser settings, then try again.";
  }
  if (lower.includes("notfound") || lower.includes("devicenotfound")) {
    return "No camera found. Connect a webcam and try again.";
  }
  if (lower.includes("notreadable") || lower.includes("trackstart")) {
    return "Your camera is already in use by another app. Close it and try again.";
  }
  if (lower.includes("fetch") || lower.includes("network")) {
    return "Could not download the hand tracking model. Check your connection, or run `npm run vendor:vision` to host it locally.";
  }
  if (lower.includes("secure") || lower.includes("ssl")) {
    return "Camera access requires HTTPS or localhost.";
  }
  return message;
}
