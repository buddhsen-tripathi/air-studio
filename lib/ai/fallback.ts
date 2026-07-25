import { buildScale } from "@/lib/music/theory";
import { LayoutSchema, type Layout, type Zone } from "@/lib/layout/types";
import type { CoachReport, HitLogEntry } from "./schemas";

/**
 * Deterministic local versions of the AI features.
 *
 * These run when OPENROUTER_API_KEY is unset, so a fresh clone is fully usable
 * before anyone signs up for anything. They are also the fallback when a model
 * call fails — a dropped API request should degrade the coach, not break the
 * instrument.
 */

/** Cheap keyword read of the brief to pick a plausible instrument and mood. */
export function localArrange(input: {
  song?: string;
  brief?: string;
  difficulty: "simple" | "standard" | "advanced";
}): Layout {
  const text = `${input.song ?? ""} ${input.brief ?? ""}`.toLowerCase();

  const wantsDrums = /drum|beat|groove|percussion|kit|hip.?hop|funk/.test(text);
  const wantsStrings = /guitar|strum|string|folk|acoustic|harp|riff/.test(text);
  const wantsAmbient = /ambient|calm|chill|drone|pad|slow|sleep|space/.test(text);
  const wantsBass = /bass|low|sub|dub|reggae/.test(text);

  const minorMood = /sad|dark|minor|moody|melancholy|night/.test(text);
  const scale = minorMood ? "minor" : "minorPentatonic";

  const zoneCount =
    input.difficulty === "simple" ? 4 : input.difficulty === "advanced" ? 9 : 6;

  let zones: Zone[];
  let name: string;
  let tempo: number;
  let howToPlay: string;

  if (wantsStrings) {
    name = "Air Strings";
    tempo = 80;
    const notes = buildScale("E", scale, 3, zoneCount);
    const span = 0.72 / zoneCount;
    zones = notes.map((note, i) => ({
      id: `string-${i}`,
      label: note,
      x: 0.14 + i * span,
      y: 0.55,
      w: 0.055,
      h: 0.6,
      voice: "pluck" as const,
      note,
      trigger: "cross" as const,
      hand: "any" as const,
      gain: 1,
    }));
    howToPlay =
      "Sweep sideways through the strings to strum. Crossing in either direction plucks the note.";
  } else if (wantsAmbient) {
    name = "Air Ambient";
    tempo = 62;
    const notes = buildScale("C", "minor", 3, 3);
    zones = notes.map((note, i) => ({
      id: `pad-${i}`,
      label: note,
      x: 0.18 + i * 0.32,
      y: 0.5,
      w: 0.26,
      h: 0.52,
      voice: "pad" as const,
      note,
      trigger: "hold" as const,
      hand: "any" as const,
      gain: 1,
    }));
    zones.push(
      pitched("bell-1", "Bell", 0.34, 0.14, 0.18, 0.16, "bell", "C5"),
      pitched("bell-2", "Bell", 0.66, 0.14, 0.18, 0.16, "bell", "G5"),
    );
    howToPlay =
      "Hold a hand inside a column to sustain it, and move up and down to open the filter. Tap the bells for accents.";
  } else if (wantsBass) {
    name = "Bass + Kit";
    tempo = 90;
    const notes = buildScale("A", "minorPentatonic", 1, 4);
    zones = [
      ...notes.map((note, i) => ({
        id: `bass-${i}`,
        label: note,
        x: 0.07 + i * 0.1,
        y: 0.6,
        w: 0.09,
        h: 0.5,
        voice: "bass" as const,
        note,
        trigger: "strike" as const,
        hand: "left" as const,
        gain: 1,
      })),
      perc("kick", "Kick", 0.62, 0.86, 0.28, 0.2, "kick", "right"),
      perc("snare", "Snare", 0.7, 0.58, 0.22, 0.18, "snare", "right"),
      perc("hat", "Hat", 0.91, 0.42, 0.16, 0.2, "hat", "right"),
    ];
    howToPlay =
      "Left hand walks the bass columns, right hand plays the kit. Each side ignores the other hand.";
  } else if (wantsDrums || zoneCount <= 4) {
    name = "Air Drum Kit";
    tempo = 94;
    zones = [
      perc("kick", "Kick", 0.5, 0.86, 0.3, 0.2, "kick"),
      perc("snare", "Snare", 0.5, 0.6, 0.24, 0.18, "snare"),
      perc("hat", "Hi-Hat", 0.22, 0.55, 0.2, 0.16, "hat"),
      perc("crash", "Crash", 0.8, 0.26, 0.22, 0.16, "crash"),
      perc("tom1", "Tom 1", 0.75, 0.52, 0.18, 0.15, "tom"),
      perc("tom2", "Tom 2", 0.9, 0.68, 0.16, 0.15, "tom"),
      perc("clap", "Clap", 0.28, 0.8, 0.18, 0.15, "clap"),
      perc("openhat", "Open Hat", 0.12, 0.34, 0.18, 0.14, "openhat"),
      perc("rim", "Rim", 0.36, 0.42, 0.14, 0.14, "rim"),
    ].slice(0, zoneCount);
    howToPlay =
      "Strike downward through a pad. How fast your hand is moving as it crosses sets how loud the hit is.";
  } else {
    name = "Air Keys";
    tempo = 88;
    const notes = buildScale("C", scale, 4, zoneCount);
    const span = 0.86 / zoneCount;
    zones = notes.map((note, i) => ({
      id: `key-${i}`,
      label: note,
      x: 0.07 + span / 2 + i * span,
      y: 0.62,
      w: span * 0.9,
      h: 0.42,
      voice: "keys" as const,
      note,
      trigger: "strike" as const,
      hand: "any" as const,
      gain: 1,
    }));
    howToPlay =
      "Drop a fingertip through a column to play it. Hit the left of a key for a mellow tone, the right for a bright one.";
  }

  return LayoutSchema.parse({
    id: "local-arrangement",
    name,
    song: input.song,
    key: wantsStrings || wantsBass ? (wantsBass ? "A" : "E") : "C",
    scale,
    tempo,
    progression: minorMood ? ["Am", "F", "C", "G"] : ["Am", "G", "F", "E"],
    zones,
    space: wantsAmbient ? 0.7 : wantsDrums ? 0.18 : 0.35,
    howToPlay,
  });
}

/**
 * Rule-based coaching. Measures the same things the model is asked to judge, so
 * the offline experience is genuinely useful rather than a stub.
 */
export function localCoach(hits: HitLogEntry[], tempo: number): CoachReport {
  if (hits.length < 4) {
    return {
      headline: "Play a few more notes and I'll have something to say.",
      observations: [],
    };
  }

  const observations: CoachReport["observations"] = [];

  // --- dynamics: coefficient of variation of velocity
  const velocities = hits.map((h) => h.velocity);
  const meanVel = mean(velocities);
  const velSpread = stdev(velocities, meanVel) / Math.max(0.01, meanVel);
  if (velSpread < 0.12) {
    observations.push({
      kind: "dynamics",
      text: "Every hit is landing at almost the same volume. Try ghosting a few softer notes between the accents — it's the fastest way to make this sound played rather than programmed.",
    });
  }

  // --- timing: how consistent are the inter-onset intervals
  const gaps: number[] = [];
  for (let i = 1; i < hits.length; i++) gaps.push(hits[i].tMs - hits[i - 1].tMs);
  const usable = gaps.filter((g) => g > 40 && g < 2000);
  if (usable.length >= 3) {
    const meanGap = mean(usable);
    const jitter = stdev(usable, meanGap) / meanGap;
    const impliedBpm = Math.round(60000 / meanGap);
    if (jitter > 0.32) {
      observations.push({
        kind: "timing",
        text: `Your spacing is uneven — gaps swing from ${Math.round(Math.min(...usable))}ms to ${Math.round(Math.max(...usable))}ms. Count out loud while you play and let the beat, not your arm, decide when to strike.`,
      });
    } else if (Math.abs(impliedBpm - tempo) > tempo * 0.18) {
      const direction = impliedBpm > tempo ? "rushing" : "dragging";
      observations.push({
        kind: "timing",
        text: `You're ${direction}: playing around ${impliedBpm} BPM against a ${tempo} BPM layout.`,
      });
    } else {
      observations.push({
        kind: "praise",
        text: `Timing is solid — you're holding about ${impliedBpm} BPM with even spacing.`,
      });
    }
  }

  // --- coverage: how much of the kit is actually being used
  const used = new Set(hits.map((h) => h.label));
  if (used.size <= 2 && hits.length > 8) {
    observations.push({
      kind: "coverage",
      text: `You're staying on ${[...used].join(" and ")}. Bring in another zone to open the part up.`,
    });
  }

  if (
    hits.length > 8 &&
    !observations.some((o) => o.kind === "praise") &&
    observations.length < 3
  ) {
    observations.push({
      kind: "praise",
      text: `Good commitment — ${hits.length} notes in a row with real strikes, not taps.`,
    });
  }

  const timingIsGood = observations.some((o) => o.kind === "praise");
  const headline =
    timingIsGood && velSpread < 0.12
      ? "Solid groove — now vary how hard you hit."
      : observations.length > 0
        ? firstSentence(observations[0].text)
        : "Sounding good — keep going.";

  return {
    headline,
    observations: observations.slice(0, 3),
    tryThis:
      velSpread < 0.12
        ? "Play the same pattern again, but hit every other note at half strength."
        : "Play four bars without stopping and keep the gaps identical.",
  };
}

// ------------------------------------------------------------------ helpers

function perc(
  id: string,
  label: string,
  x: number,
  y: number,
  w: number,
  h: number,
  voice: Zone["voice"],
  hand: Zone["hand"] = "any",
): Zone {
  return { id, label, x, y, w, h, voice, trigger: "strike", hand, gain: 1 };
}

function pitched(
  id: string,
  label: string,
  x: number,
  y: number,
  w: number,
  h: number,
  voice: Zone["voice"],
  note: string,
): Zone {
  return {
    id,
    label,
    x,
    y,
    w,
    h,
    voice,
    note,
    trigger: "strike",
    hand: "any",
    gain: 1,
  };
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
}

function stdev(xs: number[], m: number): number {
  if (xs.length < 2) return 0;
  const variance = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

function firstSentence(text: string): string {
  const idx = text.indexOf(".");
  return idx === -1 ? text : text.slice(0, idx + 1);
}
