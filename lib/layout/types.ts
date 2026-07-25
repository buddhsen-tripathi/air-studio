import { z } from "zod";

/**
 * The instrument layout is the single contract shared by three producers
 * (built-in presets, the AI arranger, the layout editor) and two consumers
 * (the trigger engine, the canvas renderer). It is validated with zod at the
 * API boundary so a hallucinated field can never reach the audio path.
 *
 * Coordinates are normalized 0..1 in *mirrored view space* — the same space the
 * user sees. (0,0) is the top-left of the video as displayed, so a zone at
 * x: 0.1 appears on the left of the screen and is reached with the user's left
 * hand. The mirroring happens once, in the tracker.
 */

export const VOICE_KINDS = [
  "kick",
  "snare",
  "hat",
  "openhat",
  "tom",
  "clap",
  "rim",
  "ride",
  "crash",
  "keys",
  "pluck",
  "bass",
  "pad",
  "bell",
  "lead",
] as const;

export type VoiceKind = (typeof VOICE_KINDS)[number];

/** Percussive voices ignore `note` pitch for tuning purposes beyond timbre. */
export const PERCUSSIVE: ReadonlySet<VoiceKind> = new Set<VoiceKind>([
  "kick",
  "snare",
  "hat",
  "openhat",
  "tom",
  "clap",
  "rim",
  "ride",
  "crash",
]);

/**
 * How a zone converts hand motion into a note event.
 *
 * - `strike`  fires once when a tracked point crosses the zone's horizontal
 *             mid-line moving downward. This is the drum/key model.
 * - `cross`   fires when a point crosses the zone's vertical mid-line in either
 *             direction. This is the guitar/harp string model.
 * - `hold`    note-on while a point is inside, note-off on exit. Pads, drones.
 * - `pinch`   note-on while thumb and index are pinched inside the zone.
 */
export const TRIGGER_MODES = ["strike", "cross", "hold", "pinch"] as const;
export type TriggerMode = (typeof TRIGGER_MODES)[number];

export const ZoneSchema = z.object({
  id: z.string().min(1).max(48),
  label: z.string().min(1).max(24),
  /** Normalized centre-x of the zone in mirrored view space. */
  x: z.number().min(0).max(1),
  /** Normalized centre-y. */
  y: z.number().min(0).max(1),
  w: z.number().min(0.02).max(1),
  h: z.number().min(0.02).max(1),
  voice: z.enum(VOICE_KINDS),
  /** Scientific pitch notation. Ignored by percussive voices. */
  note: z.string().max(8).optional(),
  trigger: z.enum(TRIGGER_MODES),
  /** CSS colour used for the overlay. Defaults are assigned per voice. */
  color: z.string().max(32).optional(),
  /** Restrict the zone to one hand, e.g. a bass zone only the left hand plays. */
  hand: z.enum(["any", "left", "right"]).default("any"),
  /** Per-zone gain trim, 0..2. */
  gain: z.number().min(0).max(2).default(1),
});

export type Zone = z.infer<typeof ZoneSchema>;

export const LayoutSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  /** The song this layout was arranged for, if any. */
  song: z.string().max(120).optional(),
  key: z.string().max(4).default("C"),
  scale: z.string().max(24).default("minor"),
  tempo: z.number().min(30).max(260).default(100),
  /** Chord progression the coach reasons about, e.g. ["Am","F","C","G"]. */
  progression: z.array(z.string().max(12)).max(32).default([]),
  zones: z.array(ZoneSchema).min(1).max(24),
  /** Short human-facing note from the arranger: how to play this. */
  howToPlay: z.string().max(600).optional(),
  /** Reverb send for the whole layout, 0..1. */
  space: z.number().min(0).max(1).default(0.25),
});

export type Layout = z.infer<typeof LayoutSchema>;

/** Default overlay colours, chosen to stay legible over arbitrary webcam video. */
export const VOICE_COLORS: Record<VoiceKind, string> = {
  kick: "#ff5c7a",
  snare: "#ffa23e",
  hat: "#ffe066",
  openhat: "#d9f26b",
  tom: "#ff7a45",
  clap: "#ff9ec4",
  rim: "#ffd0a1",
  ride: "#a0e7c8",
  crash: "#7ae0ff",
  keys: "#6ec8ff",
  pluck: "#8b7cff",
  bass: "#c77dff",
  pad: "#5ce1c4",
  bell: "#9df0ff",
  lead: "#ff6fd8",
};

export function zoneColor(zone: Zone): string {
  return zone.color ?? VOICE_COLORS[zone.voice] ?? "#8fe3ff";
}

/** Axis-aligned bounds derived from centre + size, clamped to the viewport. */
export function zoneBounds(zone: Zone) {
  const left = zone.x - zone.w / 2;
  const top = zone.y - zone.h / 2;
  return {
    left,
    top,
    right: left + zone.w,
    bottom: top + zone.h,
    midX: zone.x,
    midY: zone.y,
  };
}
