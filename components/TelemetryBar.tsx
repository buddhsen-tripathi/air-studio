"use client";

import { useEffect, useState, type RefObject } from "react";
import type { AudioEngine } from "@/lib/audio/engine";
import type { Performer } from "@/lib/vision/performer";
import { Stat } from "./ui";

/**
 * Live latency readout.
 *
 * This component polls refs on its own timer rather than receiving props from
 * the studio, which keeps 8Hz of re-renders inside this subtree instead of
 * re-rendering the whole app. The studio's hot path never notifies React.
 *
 * The numbers matter to the player, not just to us: if the feel is off, this
 * says whether it's the webcam (capture), the model (inference), or the audio
 * device (output) — three problems with three different fixes.
 */

interface Telemetry {
  fps: number;
  inferenceMs: number;
  captureMs: number | null;
  audioMs: number;
  predictMs: number;
  level: number;
}

const POLL_MS = 125;

export function TelemetryBar({
  performerRef,
  engineRef,
  running,
}: {
  performerRef: RefObject<Performer | null>;
  engineRef: RefObject<AudioEngine | null>;
  running: boolean;
}) {
  const [t, setT] = useState<Telemetry>({
    fps: 0,
    inferenceMs: 0,
    captureMs: null,
    audioMs: 0,
    predictMs: 0,
    level: 0,
  });

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      const performer = performerRef.current;
      const engine = engineRef.current;
      if (!performer || !engine) return;
      setT({
        fps: performer.fps,
        inferenceMs: performer.lastInferenceMs,
        captureMs: performer.lastCaptureLatencyMs,
        audioMs: engine.outputLatencyMs,
        predictMs: performer.getConfig().predictMs,
        level: engine.getLevel(),
      });
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [running, performerRef, engineRef]);

  // Everything measurable, minus what prediction buys back. Prediction does not
  // reduce real latency — it front-runs it — but it is what the player feels,
  // so showing the net is more honest than showing the raw sum.
  const measured = (t.captureMs ?? 0) + t.inferenceMs + t.audioMs;
  const felt = Math.max(0, measured - t.predictMs);

  return (
    <div className="flex items-center gap-4 overflow-x-auto rounded-xl border border-edge bg-panel/80 px-3.5 py-2 backdrop-blur-sm">
      <Stat
        label="Frame"
        value={running ? t.fps.toFixed(0) : "—"}
        unit="fps"
        tone={!running ? "normal" : t.fps >= 45 ? "good" : t.fps >= 24 ? "warn" : "bad"}
      />
      <Divider />
      <Stat
        label="Capture"
        value={t.captureMs === null ? "n/a" : t.captureMs.toFixed(0)}
        unit={t.captureMs === null ? undefined : "ms"}
      />
      <Stat label="Vision" value={t.inferenceMs.toFixed(1)} unit="ms" />
      <Stat label="Audio out" value={t.audioMs.toFixed(1)} unit="ms" />
      <Divider />
      <Stat
        label="Lead"
        value={`−${t.predictMs.toFixed(0)}`}
        unit="ms"
        tone="good"
      />
      <Stat
        label="Felt"
        value={running ? felt.toFixed(0) : "—"}
        unit="ms"
        tone={!running ? "normal" : felt < 40 ? "good" : felt < 80 ? "warn" : "bad"}
      />
      <Divider />
      <div className="flex min-w-[64px] flex-1 items-center gap-2">
        <span className="text-[10px] uppercase tracking-[0.1em] text-ink-faint">
          Out
        </span>
        <div className="h-1.5 min-w-[48px] flex-1 overflow-hidden rounded-full bg-chassis">
          <div
            className="h-full rounded-full bg-signal transition-[width] duration-100"
            style={{ width: `${Math.min(100, t.level * 160)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function Divider() {
  return <span aria-hidden className="h-6 w-px shrink-0 bg-edge" />;
}
