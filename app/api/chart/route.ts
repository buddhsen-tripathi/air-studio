import { NextResponse } from "next/server";
import { z } from "zod";
import { localChart } from "@/lib/ai/chartFallback";
import { CHART_SYSTEM, chartUserPrompt } from "@/lib/ai/chartPrompts";
import {
  chat,
  configuredModel,
  extractJson,
  isConfigured,
} from "@/lib/ai/openrouter";
import { expandChart, repairSpec } from "@/lib/game/chart";
import { ChartSchema, type Chart } from "@/lib/game/types";

export const runtime = "nodejs";
/** Charts are generated per duel and never cached. */
export const dynamic = "force-dynamic";

const ChartRequestSchema = z.object({
  song: z.string().max(120).optional(),
  brief: z.string().max(400).optional(),
  difficulty: z.enum(["easy", "normal", "hard"]).default("normal"),
});
type ChartRequest = z.infer<typeof ChartRequestSchema>;

interface ChartResponse {
  chart: Chart;
  source: "model" | "fallback";
  model?: string;
  warning?: string;
}

export async function POST(request: Request): Promise<NextResponse> {
  const body = await request.json().catch(() => null);
  const parsed = ChartRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", detail: parsed.error.issues },
      { status: 400 },
    );
  }
  const input = parsed.data;

  if (!isConfigured()) {
    const payload: ChartResponse = {
      chart: offlineChart(input),
      source: "fallback",
      warning:
        "OPENROUTER_API_KEY is not set — using the built-in offline chart generator.",
    };
    return NextResponse.json(payload);
  }

  try {
    const raw = await chat({
      messages: [
        { role: "system", content: CHART_SYSTEM },
        { role: "user", content: chartUserPrompt(input) },
      ],
      json: true,
      // Lower than the arranger's. A chart that wanders off its own groove is
      // worse to play than a plain one, and the interesting variation lives in
      // the melody arrays rather than the rhythm.
      temperature: 0.7,
      maxTokens: 4000,
      signal: request.signal,
    });

    const candidate = extractJson<unknown>(raw);

    // Same bargain as the arranger: the model gets the music right and the grid
    // subtly wrong — a stray "xx" in one lane, four lanes stacked on one step,
    // a pattern string one bar short. Those are repairable, and throwing away a
    // good chart over them would be the worse outcome. Repair, then validate;
    // only a structurally broken response reaches the catch.
    const spec = repairSpec(candidate);
    const chart = ChartSchema.parse({ ...expandChart(spec), source: "model" });

    const payload: ChartResponse = {
      chart,
      source: "model",
      model: configuredModel(),
    };
    return NextResponse.json(payload);
  } catch (err) {
    // Two players are already in the room watching a countdown, and there is no
    // second chance to ask them for a song. Any model failure ships the offline
    // chart instead — a duel on a plainer chart beats no duel at all.
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[chart] model call failed:", message);
    const payload: ChartResponse = {
      chart: offlineChart(input),
      source: "fallback",
      model: configuredModel(),
      warning: `Model call failed (${message}). Fell back to the offline chart generator.`,
    };
    return NextResponse.json(payload);
  }
}

function offlineChart(input: ChartRequest): Chart {
  return { ...expandChart(localChart(input)), source: "fallback" };
}
