import { z } from "zod";
import { LayoutSchema } from "@/lib/layout/types";

/** Request/response contracts for the AI routes, shared by client and server. */

export const ArrangeRequestSchema = z.object({
  song: z.string().max(120).optional(),
  brief: z.string().max(400).optional(),
  difficulty: z.enum(["simple", "standard", "advanced"]).default("standard"),
});
export type ArrangeRequest = z.infer<typeof ArrangeRequestSchema>;

export const ArrangeResponseSchema = z.object({
  layout: LayoutSchema,
  /** Whether this came from the model or the offline fallback. */
  source: z.enum(["model", "fallback"]),
  model: z.string().optional(),
  /** Set when the model was tried and failed, so the UI can say why. */
  warning: z.string().optional(),
});
export type ArrangeResponse = z.infer<typeof ArrangeResponseSchema>;

export const HitLogEntrySchema = z.object({
  label: z.string().max(24),
  voice: z.string().max(16),
  note: z.string().max(8).optional(),
  velocity: z.number().min(0).max(1),
  tMs: z.number(),
});
export type HitLogEntry = z.infer<typeof HitLogEntrySchema>;

export const CoachRequestSchema = z.object({
  hits: z.array(HitLogEntrySchema).max(128),
  key: z.string().max(4).default("C"),
  scale: z.string().max(24).default("minor"),
  tempo: z.number().min(30).max(260).default(100),
  progression: z.array(z.string().max(12)).max(32).default([]),
  layoutName: z.string().max(64).default("Layout"),
  zoneLabels: z.array(z.string().max(24)).max(24).default([]),
});
export type CoachRequest = z.infer<typeof CoachRequestSchema>;

export const CoachReportSchema = z.object({
  headline: z.string().max(200),
  observations: z
    .array(
      z.object({
        kind: z.enum(["timing", "dynamics", "harmony", "coverage", "praise"]),
        text: z.string().max(400),
      }),
    )
    .max(3)
    .default([]),
  nextChord: z.string().max(12).optional(),
  tryThis: z.string().max(300).optional(),
});
export type CoachReport = z.infer<typeof CoachReportSchema>;

export const CoachResponseSchema = z.object({
  report: CoachReportSchema,
  source: z.enum(["model", "fallback"]),
  model: z.string().optional(),
  warning: z.string().optional(),
});
export type CoachResponse = z.infer<typeof CoachResponseSchema>;
