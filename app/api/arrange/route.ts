import { NextResponse } from "next/server";
import { localArrange } from "@/lib/ai/fallback";
import {
  chat,
  configuredModel,
  extractJson,
  isConfigured,
} from "@/lib/ai/openrouter";
import { ARRANGE_SYSTEM, arrangeUserPrompt } from "@/lib/ai/prompts";
import {
  ArrangeRequestSchema,
  type ArrangeResponse,
} from "@/lib/ai/schemas";
import { LayoutSchema } from "@/lib/layout/types";
import { repairLayout } from "@/lib/layout/repair";

export const runtime = "nodejs";
/** Layouts are generated per request and never cached. */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const body = await request.json().catch(() => null);
  const parsed = ArrangeRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", detail: parsed.error.issues },
      { status: 400 },
    );
  }
  const input = parsed.data;

  if (!isConfigured()) {
    const payload: ArrangeResponse = {
      layout: localArrange(input),
      source: "fallback",
      warning:
        "OPENROUTER_API_KEY is not set — using the built-in offline arranger.",
    };
    return NextResponse.json(payload);
  }

  try {
    const raw = await chat({
      messages: [
        { role: "system", content: ARRANGE_SYSTEM },
        { role: "user", content: arrangeUserPrompt(input) },
      ],
      json: true,
      temperature: 0.8,
      maxTokens: 2500,
      signal: request.signal,
    });

    const candidate = extractJson<unknown>(raw);

    // The model reliably gets the musical intent right and the geometry
    // slightly wrong. Rather than rejecting a good arrangement over an
    // overlapping pad, we nudge the geometry into a playable state, then
    // validate. Only a structurally broken response falls through to the catch.
    const repaired = repairLayout(candidate);
    const layout = LayoutSchema.parse(repaired);

    const payload: ArrangeResponse = {
      layout,
      source: "model",
      model: configuredModel(),
    };
    return NextResponse.json(payload);
  } catch (err) {
    // A model failure must never leave the player without an instrument.
    const message = err instanceof Error ? err.message : "Unknown error";
    const payload: ArrangeResponse = {
      layout: localArrange(input),
      source: "fallback",
      model: configuredModel(),
      warning: `Model call failed (${message}). Fell back to the offline arranger.`,
    };
    return NextResponse.json(payload);
  }
}
