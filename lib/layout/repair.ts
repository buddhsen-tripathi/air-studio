import { buildScale, midiToNote, noteToMidi } from "@/lib/music/theory";
import { PERCUSSIVE, VOICE_KINDS, type VoiceKind } from "./types";

/**
 * Make a model-generated layout playable.
 *
 * Language models get the *musical* judgement right — key, tempo, which
 * instrument suits a song — and the *geometry* subtly wrong. In testing the
 * recurring failures were always the same handful:
 *
 *   - zones a few percent off the edge of the frame, so part of a pad is
 *     unreachable
 *   - strike pads smaller than tracking jitter, which are simply un-hittable
 *   - two strike pads stacked vertically in the same x range, so one downward
 *     stroke fires both and it sounds broken
 *   - pitched voices with no note, or notes outside any sane octave
 *   - duplicate zone ids, which collide in the trigger engine's state maps
 *
 * Rejecting an otherwise-good arrangement over any of these would be a worse
 * experience than nudging it. So we repair, then validate. Anything still
 * invalid after this is structurally broken and correctly falls back.
 */

const MIN_STRIKE_W = 0.09;
const MIN_STRIKE_H = 0.12;
const MIN_CROSS_W = 0.04;
const MIN_CROSS_H = 0.45;
const MAX_ZONES = 24;

interface LooseZone {
  id?: unknown;
  label?: unknown;
  x?: unknown;
  y?: unknown;
  w?: unknown;
  h?: unknown;
  voice?: unknown;
  note?: unknown;
  trigger?: unknown;
  color?: unknown;
  hand?: unknown;
  gain?: unknown;
}

export function repairLayout(input: unknown): unknown {
  if (!isRecord(input)) return input;

  const key = asString(input.key, "C").slice(0, 4) || "C";
  const scale = asString(input.scale, "minor");
  const rawZones = Array.isArray(input.zones) ? input.zones : [];

  const seenIds = new Set<string>();
  const zones = rawZones
    .slice(0, MAX_ZONES)
    .map((z, i) => repairZone(z as LooseZone, i, key, scale, seenIds))
    .filter((z): z is RepairedZone => z !== null);

  separateStackedStrikes(zones);

  return {
    id: slug(asString(input.id, "ai-layout")) || "ai-layout",
    name: asString(input.name, "AI Arrangement").slice(0, 64),
    song: input.song ? asString(input.song, "").slice(0, 120) : undefined,
    key,
    scale,
    tempo: clamp(asNumber(input.tempo, 100), 30, 260),
    progression: Array.isArray(input.progression)
      ? input.progression
          .slice(0, 32)
          .map((c) => asString(c, "").slice(0, 12))
          .filter(Boolean)
      : [],
    space: clamp(asNumber(input.space, 0.3), 0, 1),
    howToPlay: input.howToPlay
      ? asString(input.howToPlay, "").slice(0, 600)
      : undefined,
    zones,
  };
}

interface RepairedZone {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  voice: VoiceKind;
  note?: string;
  trigger: "strike" | "cross" | "hold" | "pinch";
  color?: string;
  hand: "any" | "left" | "right";
  gain: number;
}

function repairZone(
  raw: LooseZone,
  index: number,
  key: string,
  scale: string,
  seenIds: Set<string>,
): RepairedZone | null {
  if (!isRecord(raw)) return null;

  const voice = asVoice(raw.voice);
  const trigger = asTrigger(raw.trigger);

  // Enforce a floor on size before positioning, so clamping accounts for the
  // final dimensions rather than the model's undersized ones.
  const isCross = trigger === "cross";
  let w = clamp(
    asNumber(raw.w, isCross ? 0.06 : 0.18),
    isCross ? MIN_CROSS_W : MIN_STRIKE_W,
    1,
  );
  let h = clamp(
    asNumber(raw.h, isCross ? 0.55 : 0.18),
    isCross ? MIN_CROSS_H : MIN_STRIKE_H,
    1,
  );

  // A zone can never be wider or taller than the frame.
  w = Math.min(w, 1);
  h = Math.min(h, 1);

  // Pull the centre in so the whole zone sits inside the view.
  const x = clamp(asNumber(raw.x, 0.5), w / 2, 1 - w / 2);
  const y = clamp(asNumber(raw.y, 0.65), h / 2, 1 - h / 2);

  let id = slug(asString(raw.id, `zone-${index}`)) || `zone-${index}`;
  // Duplicate ids would collide in the performer's per-zone state maps, making
  // two pads share one cooldown and one arm flag.
  while (seenIds.has(id)) id = `${id}-${index}`;
  seenIds.add(id);

  const label = asString(raw.label, id).slice(0, 24) || id;

  // Pitched voices must have a usable note. If the model omitted it or gave
  // something unparseable, derive one from the layout's own key and scale so
  // the zone still sounds musical rather than defaulting to a random pitch.
  let note: string | undefined;
  if (!PERCUSSIVE.has(voice)) {
    const given = typeof raw.note === "string" ? raw.note.trim() : "";
    const midi = given ? noteToMidi(given) : null;
    if (midi !== null && midi >= 24 && midi <= 108) {
      note = midiToNote(midi);
    } else {
      const octave = voice === "bass" ? 2 : voice === "bell" ? 5 : 4;
      const degrees = buildScale(key, scale, octave, 8);
      note = degrees[index % degrees.length];
    }
  }

  return {
    id,
    label,
    x,
    y,
    w,
    h,
    voice,
    note,
    trigger,
    color: typeof raw.color === "string" ? raw.color.slice(0, 32) : undefined,
    hand: asHand(raw.hand),
    gain: clamp(asNumber(raw.gain, 1), 0, 2),
  };
}

/**
 * Push apart strike zones that overlap horizontally *and* sit close vertically.
 *
 * This is the failure that sounds most broken: a single downward stroke passes
 * through two pads and fires both. We nudge the lower zone down and out of the
 * upper one's path until the stroke can only reach one.
 */
function separateStackedStrikes(zones: RepairedZone[]): void {
  const strikes = zones.filter((z) => z.trigger === "strike");

  // Moving one zone can push it into a third, so iterate. Passes are cheap
  // (zone counts are single digits) and we stop as soon as nothing moves.
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;

    for (let i = 0; i < strikes.length; i++) {
      for (let j = i + 1; j < strikes.length; j++) {
        const a = strikes[i];
        const b = strikes[j];

        // Zones bound to opposite hands can overlap freely: the trigger engine
        // only tests a zone against the hand it is assigned to, so one stroke
        // can never cross both.
        if (
          (a.hand === "left" && b.hand === "right") ||
          (a.hand === "right" && b.hand === "left")
        ) {
          continue;
        }

        const overlapX =
          Math.min(a.x + a.w / 2, b.x + b.w / 2) -
          Math.max(a.x - a.w / 2, b.x - b.w / 2);
        if (overlapX <= 0) continue;

        // Only a substantial horizontal overlap is a problem; clipping corners
        // is fine and makes a kit feel more natural to sweep across.
        if (overlapX / Math.min(a.w, b.w) < 0.45) continue;

        const upper = a.y <= b.y ? a : b;
        const lower = a.y <= b.y ? b : a;

        // Slide the lower zone AWAY from the upper one. Choosing the direction
        // by available screen room instead would happily shove it further into
        // the very zone we are trying to separate it from.
        const away = lower.x >= upper.x ? 1 : -1;
        const shift = overlapX / 2 + 0.02;
        const min = lower.w / 2;
        const max = 1 - lower.w / 2;

        const target = lower.x + away * shift;
        if (target >= min && target <= max) {
          lower.x = target;
          moved = true;
          continue;
        }

        const alternate = lower.x - away * shift;
        if (alternate >= min && alternate <= max) {
          lower.x = alternate;
          moved = true;
          continue;
        }

        // Pinned against both edges: drop it below the upper zone instead, so
        // a downward stroke can no longer reach both.
        const needed = upper.y + upper.h / 2 + 0.06 - (lower.y - lower.h / 2);
        if (needed > 0) {
          const nextY = clamp(lower.y + needed, lower.h / 2, 1 - lower.h / 2);
          if (nextY !== lower.y) {
            lower.y = nextY;
            moved = true;
          }
        }
      }
    }

    if (!moved) break;
  }
}

// ------------------------------------------------------------------ coercion

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asNumber(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? Number.parseFloat(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function asString(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

function asVoice(v: unknown): VoiceKind {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (VOICE_KINDS as readonly string[]).includes(s)
    ? (s as VoiceKind)
    : "keys";
}

function asTrigger(v: unknown): RepairedZone["trigger"] {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return s === "cross" || s === "hold" || s === "pinch" ? s : "strike";
}

function asHand(v: unknown): "any" | "left" | "right" {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return s === "left" || s === "right" ? s : "any";
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function slug(v: string): string {
  return v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
