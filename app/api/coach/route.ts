import { NextResponse } from "next/server";
import { localCoach } from "@/lib/ai/fallback";
import {
  chat,
  configuredModel,
  extractJson,
  isConfigured,
} from "@/lib/ai/openrouter";
import { COACH_SYSTEM } from "@/lib/ai/prompts";
import {
  CoachReportSchema,
  CoachRequestSchema,
  type CoachResponse,
} from "@/lib/ai/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const body = await request.json().catch(() => null);
  const parsed = CoachRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", detail: parsed.error.issues },
      { status: 400 },
    );
  }
  const input = parsed.data;

  if (!isConfigured()) {
    const payload: CoachResponse = {
      report: localCoach(input.hits, input.tempo),
      source: "fallback",
      warning:
        "OPENROUTER_API_KEY is not set — using the built-in offline coach.",
    };
    return NextResponse.json(payload);
  }

  try {
    const raw = await chat({
      messages: [
        { role: "system", content: COACH_SYSTEM },
        { role: "user", content: buildCoachPrompt(input) },
      ],
      json: true,
      temperature: 0.6,
      maxTokens: 3000,
      signal: request.signal,
    });

    const report = CoachReportSchema.parse(extractJson(raw));
    const payload: CoachResponse = {
      report,
      source: "model",
      model: configuredModel(),
    };
    return NextResponse.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const payload: CoachResponse = {
      report: localCoach(input.hits, input.tempo),
      source: "fallback",
      model: configuredModel(),
      warning: `Model call failed (${message}). Fell back to the offline coach.`,
    };
    return NextResponse.json(payload);
  }
}

function buildCoachPrompt(
  input: ReturnType<typeof CoachRequestSchema.parse>,
): string {
  // Normalize timestamps to start at zero. Absolute performance.now() values
  // are meaningless to the model and waste tokens.
  const t0 = input.hits[0]?.tMs ?? 0;
  const log = input.hits
    .map((h) => {
      const at = Math.round(h.tMs - t0);
      const pitch = h.note ? ` ${h.note}` : "";
      return `${at}ms  ${h.label}${pitch}  vel=${h.velocity.toFixed(2)}`;
    })
    .join("\n");

  const span = input.hits.length
    ? Math.round((input.hits[input.hits.length - 1].tMs - t0) / 100) / 10
    : 0;

  return [
    `Layout: ${input.layoutName}`,
    `Key: ${input.key} ${input.scale} · Tempo: ${input.tempo} BPM`,
    input.progression.length
      ? `Progression: ${input.progression.join(" - ")}`
      : "Progression: not specified",
    `Available zones: ${input.zoneLabels.join(", ") || "unknown"}`,
    "",
    `They played ${input.hits.length} notes over ${span}s:`,
    log || "(nothing)",
    "",
    "Return only the JSON object.",
  ].join("\n");
}
