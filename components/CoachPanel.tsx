"use client";

import { useState, type RefObject } from "react";
import type { CoachReport, CoachResponse } from "@/lib/ai/schemas";
import type { Layout } from "@/lib/layout/types";
import type { Performer } from "@/lib/vision/performer";
import { Button, Panel } from "./ui";

/**
 * The coaching surface.
 *
 * It reads the performer's hit history on demand rather than streaming — the
 * model needs a phrase to react to, and a critique of every individual note
 * would be both expensive and useless. You play a bit, then ask.
 */

const KIND_STYLES: Record<
  CoachReport["observations"][number]["kind"],
  { label: string; className: string }
> = {
  timing: { label: "Timing", className: "text-amber border-amber/30 bg-amber/10" },
  dynamics: {
    label: "Dynamics",
    className: "text-[#8b7cff] border-[#8b7cff]/30 bg-[#8b7cff]/10",
  },
  harmony: {
    label: "Harmony",
    className: "text-[#6ec8ff] border-[#6ec8ff]/30 bg-[#6ec8ff]/10",
  },
  coverage: {
    label: "Coverage",
    className: "text-[#ff9ec4] border-[#ff9ec4]/30 bg-[#ff9ec4]/10",
  },
  praise: { label: "Nice", className: "text-signal border-signal/30 bg-signal/10" },
};

export function CoachPanel({
  performerRef,
  layout,
  running,
}: {
  performerRef: RefObject<Performer | null>;
  layout: Layout;
  running: boolean;
}) {
  const [report, setReport] = useState<CoachReport | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ask() {
    const performer = performerRef.current;
    if (!performer || busy) return;

    const history = performer.getHistory();
    if (history.length === 0) {
      setError("Play something first — I have nothing to listen to yet.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hits: history.map((h) => ({
            label: h.label,
            voice: h.voice,
            note: h.note,
            velocity: h.velocity,
            tMs: h.tMs,
          })),
          key: layout.key,
          scale: layout.scale,
          tempo: layout.tempo,
          progression: layout.progression,
          layoutName: layout.name,
          zoneLabels: layout.zones.map((z) => z.label),
        }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(detail.slice(0, 200) || `HTTP ${response.status}`);
      }
      const data = (await response.json()) as CoachResponse;
      setReport(data.report);
      setSource(data.source);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Coach"
      action={
        <Button variant="ghost" onClick={ask} disabled={busy || !running}>
          {busy ? "Listening…" : "How did I do?"}
        </Button>
      }
    >
      {!report && !error && (
        <p className="text-[12px] leading-relaxed text-ink-faint">
          Play a phrase, then ask. The coach reads your actual note timings and
          velocities — it can hear whether you&rsquo;re rushing, and whether every
          hit is landing at the same volume.
        </p>
      )}

      {error && (
        <p className="rounded-lg border border-hot/30 bg-hot/10 px-2.5 py-2 text-[12px] leading-snug text-hot">
          {error}
        </p>
      )}

      {report && (
        <div className="space-y-3">
          <p className="text-[14px] font-medium leading-snug text-ink">
            {report.headline}
          </p>

          {report.observations.length > 0 && (
            <ul className="space-y-2">
              {report.observations.map((observation, i) => {
                const style = KIND_STYLES[observation.kind];
                return (
                  <li key={i} className="flex gap-2">
                    <span
                      className={`mt-0.5 h-fit shrink-0 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${style.className}`}
                    >
                      {style.label}
                    </span>
                    <span className="text-[12px] leading-relaxed text-ink-dim">
                      {observation.text}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {report.nextChord && (
            <div className="flex items-center gap-2 rounded-lg border border-edge bg-chassis px-2.5 py-2">
              <span className="text-[11px] uppercase tracking-[0.1em] text-ink-faint">
                Try next
              </span>
              <span className="numeric text-[14px] text-signal">
                {report.nextChord}
              </span>
            </div>
          )}

          {report.tryThis && (
            <p className="border-l-2 border-edge-bright pl-2.5 text-[12px] leading-relaxed text-ink-dim">
              {report.tryThis}
            </p>
          )}

          {source === "fallback" && (
            <p className="text-[11px] text-ink-faint">
              Offline coach — set OPENROUTER_API_KEY for model-written feedback.
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}
