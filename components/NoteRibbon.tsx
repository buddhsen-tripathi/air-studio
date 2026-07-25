"use client";

import { useEffect, useState, type RefObject } from "react";
import { VOICE_COLORS } from "@/lib/layout/types";
import type { HitEvent, Performer } from "@/lib/vision/performer";

/**
 * A scrolling record of what you just played.
 *
 * Like TelemetryBar, this polls a ref on its own timer. It intentionally does
 * NOT subscribe to Performer.onHit — that callback runs on the audio-critical
 * path, and calling setState from it would put a React render between a hand
 * movement and a sound.
 */

const POLL_MS = 100;
const VISIBLE = 14;

export function NoteRibbon({
  performerRef,
  running,
}: {
  performerRef: RefObject<Performer | null>;
  running: boolean;
}) {
  const [hits, setHits] = useState<HitEvent[]>([]);

  useEffect(() => {
    if (!running) {
      setHits([]);
      return;
    }
    const id = window.setInterval(() => {
      const performer = performerRef.current;
      if (!performer) return;
      const history = performer.getHistory();
      setHits((prev) => {
        const next = history.slice(-VISIBLE);
        // Cheap identity check: avoid re-rendering when nothing new was played.
        if (
          next.length === prev.length &&
          next[next.length - 1]?.tMs === prev[prev.length - 1]?.tMs
        ) {
          return prev;
        }
        return next;
      });
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [running, performerRef]);

  return (
    <div className="flex h-9 items-center gap-1.5 overflow-hidden rounded-xl border border-edge bg-panel/80 px-3 backdrop-blur-sm">
      <span className="shrink-0 text-[10px] uppercase tracking-[0.1em] text-ink-faint">
        Played
      </span>
      {hits.length === 0 ? (
        <span className="text-[12px] text-ink-faint">
          {running ? "Waiting for your first hit…" : "Not running"}
        </span>
      ) : (
        <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
          {hits.map((hit, i) => {
            const color = VOICE_COLORS[hit.voice] ?? "#8fe3ff";
            // Older hits fade, so the eye lands on what just happened.
            const recency = (i + 1) / hits.length;
            return (
              <span
                key={`${hit.tMs}-${hit.zoneId}`}
                className="numeric shrink-0 rounded-md px-1.5 py-0.5 text-[11px] leading-none"
                style={{
                  color,
                  opacity: 0.25 + recency * 0.75,
                  background: `color-mix(in srgb, ${color} ${Math.round(
                    hit.velocity * 18,
                  )}%, transparent)`,
                  border: `1px solid color-mix(in srgb, ${color} ${Math.round(
                    20 + hit.velocity * 40,
                  )}%, transparent)`,
                }}
                title={`${hit.label} · velocity ${hit.velocity.toFixed(2)} · ${hit.hand} hand`}
              >
                {hit.note ?? hit.label}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
