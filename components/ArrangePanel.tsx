"use client";

import { useState } from "react";
import type { ArrangeResponse } from "@/lib/ai/schemas";
import { PRESETS } from "@/lib/layout/presets";
import type { Layout } from "@/lib/layout/types";
import { Button, Panel, SegmentedControl } from "./ui";

/**
 * The "AI builds the instrument" surface.
 *
 * Name a song and the model decides what you should be playing along to it —
 * which instrument carries that song, in what key and tempo, and where the
 * zones go so it is physically playable. Presets sit alongside it so the studio
 * is never blocked on a network call.
 */

type Difficulty = "simple" | "standard" | "advanced";

export function ArrangePanel({
  onLayout,
  currentLayoutId,
}: {
  onLayout: (layout: Layout, meta: { source: string; warning?: string }) => void;
  currentLayoutId: string;
}) {
  const [song, setSong] = useState("");
  const [brief, setBrief] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty>("standard");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function arrange() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/arrange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          song: song.trim() || undefined,
          brief: brief.trim() || undefined,
          difficulty,
        }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(detail.slice(0, 200) || `HTTP ${response.status}`);
      }
      const data = (await response.json()) as ArrangeResponse;
      onLayout(data.layout, { source: data.source, warning: data.warning });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Arrange">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void arrange();
        }}
        className="space-y-3"
      >
        <div>
          <label
            htmlFor="song"
            className="mb-1.5 block text-[12px] text-ink-dim"
          >
            Song to play along to
          </label>
          <input
            id="song"
            value={song}
            onChange={(e) => setSong(e.target.value)}
            placeholder="Seven Nation Army"
            className="w-full rounded-lg border border-edge bg-chassis px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-edge-bright focus:outline-none"
          />
        </div>

        <div>
          <label
            htmlFor="brief"
            className="mb-1.5 block text-[12px] text-ink-dim"
          >
            Or describe what you want{" "}
            <span className="text-ink-faint">(optional)</span>
          </label>
          <input
            id="brief"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="slow, dark, mostly toms"
            className="w-full rounded-lg border border-edge bg-chassis px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-edge-bright focus:outline-none"
          />
        </div>

        <SegmentedControl<Difficulty>
          label="Complexity"
          value={difficulty}
          onChange={setDifficulty}
          options={[
            { value: "simple", label: "Simple" },
            { value: "standard", label: "Standard" },
            { value: "advanced", label: "Advanced" },
          ]}
        />

        <Button type="submit" variant="primary" disabled={busy} className="w-full">
          {busy ? "Arranging…" : "Build my instrument"}
        </Button>

        {error && (
          <p className="rounded-lg border border-hot/30 bg-hot/10 px-2.5 py-2 text-[12px] leading-snug text-hot">
            {error}
          </p>
        )}
      </form>

      <div className="mt-4 border-t border-edge pt-3">
        <span className="mb-2 block text-[11px] uppercase tracking-[0.12em] text-ink-faint">
          Presets
        </span>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => onLayout(preset, { source: "preset" })}
              className={`rounded-lg border px-2.5 py-1 text-[12px] transition-colors ${
                preset.id === currentLayoutId
                  ? "border-signal/50 bg-signal/10 text-signal"
                  : "border-edge bg-panel-raised text-ink-dim hover:border-edge-bright hover:text-ink"
              }`}
            >
              {preset.name}
            </button>
          ))}
        </div>
      </div>
    </Panel>
  );
}
