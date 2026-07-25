import { buildScale } from "@/lib/music/theory";
import { LayoutSchema, type Layout, type Zone } from "./types";

/**
 * Built-in layouts. These exist so the studio is playable the moment the camera
 * starts — the AI arranger is an enhancement, never a prerequisite.
 *
 * Zone placement follows two ergonomic rules learned from air-drumming:
 *   - Strike zones sit in the lower half of the frame. Your hands rest low and
 *     strike downward; pads near the top force you to play with raised arms.
 *   - Nothing important sits dead-centre at the top, where your face is.
 */

function drumKit(): Layout {
  // A horizontal fan, not a picture of a real kit.
  //
  // The obvious layout — kick low centre, snare above it — is unplayable here:
  // one downward stroke through the middle crosses both trigger lines and fires
  // both drums. Every strike zone therefore gets its own horizontal slot, with
  // neighbours overlapping only ~36% (under the 45% double-trigger threshold).
  // Height still varies, which is what makes it read as a kit rather than a row
  // of buttons.
  const zones: Zone[] = [
    z("openhat", "Open Hat", 0.1, 0.4, 0.18, 0.15, "openhat", "strike"),
    z("hat", "Hi-Hat", 0.214, 0.55, 0.18, 0.16, "hat", "strike"),
    z("clap", "Clap", 0.329, 0.78, 0.18, 0.15, "clap", "strike"),
    z("snare", "Snare", 0.443, 0.67, 0.18, 0.17, "snare", "strike"),
    z("kick", "Kick", 0.557, 0.87, 0.18, 0.18, "kick", "strike"),
    z("tom1", "Tom 1", 0.671, 0.6, 0.18, 0.16, "tom", "strike"),
    z("tom2", "Tom 2", 0.786, 0.74, 0.18, 0.16, "tom", "strike"),
    z("crash", "Crash", 0.9, 0.36, 0.18, 0.16, "crash", "strike"),
  ];
  return finalize({
    id: "kit",
    name: "Air Drum Kit",
    key: "C",
    scale: "minor",
    tempo: 92,
    zones,
    space: 0.18,
    howToPlay:
      "Strike downward through a pad. Hit harder for a louder note — velocity comes from how fast your hand is moving as it crosses. Sweep sideways across pads to play a fill.",
  });
}

function keyboard(): Layout {
  // One octave of a minor scale laid out left to right, struck from above.
  const notes = buildScale("C", "minor", 4, 8);
  const zones: Zone[] = notes.map((note, i) =>
    z(
      `key-${i}`,
      note,
      0.09 + i * 0.115,
      0.62,
      0.105,
      0.42,
      "keys",
      "strike",
      note,
    ),
  );
  return finalize({
    id: "keys",
    name: "Air Keys",
    key: "C",
    scale: "minor",
    tempo: 84,
    progression: ["Cm", "Ab", "Eb", "Bb"],
    zones,
    space: 0.34,
    howToPlay:
      "Each column is a note of C minor. Drop your fingertip through a column to play it. Strike near the left of a key for a mellower tone, right for a brighter one.",
  });
}

function strings(): Layout {
  // Vertical strings you strum through, low to high, left to right.
  const notes = buildScale("E", "minorPentatonic", 3, 6);
  const zones: Zone[] = notes.map((note, i) =>
    z(
      `string-${i}`,
      note,
      0.14 + i * 0.145,
      0.55,
      0.06,
      0.6,
      "pluck",
      "cross",
      note,
    ),
  );
  return finalize({
    id: "strings",
    name: "Air Strings",
    key: "E",
    scale: "minorPentatonic",
    tempo: 76,
    progression: ["Em", "C", "G", "D"],
    zones,
    space: 0.4,
    howToPlay:
      "Sweep your hand sideways through the strings to strum. Crossing in either direction plucks. Strum high in the frame for a bright attack, low for a warmer one.",
  });
}

function ambient(): Layout {
  const zones: Zone[] = [
    z("pad-lo", "Drone", 0.18, 0.5, 0.26, 0.5, "pad", "hold", "C3"),
    z("pad-mid", "Pad", 0.5, 0.5, 0.26, 0.5, "pad", "hold", "G3"),
    z("pad-hi", "Air", 0.82, 0.5, 0.26, 0.5, "pad", "hold", "Eb4"),
    z("bell-1", "Bell", 0.34, 0.14, 0.18, 0.16, "bell", "strike", "C5"),
    z("bell-2", "Bell", 0.66, 0.14, 0.18, 0.16, "bell", "strike", "G5"),
  ];
  return finalize({
    id: "ambient",
    name: "Air Ambient",
    key: "C",
    scale: "minor",
    tempo: 60,
    progression: ["Cm9", "Abmaj7", "Ebmaj7", "Bb"],
    zones,
    space: 0.7,
    howToPlay:
      "Rest a hand inside a pad column to hold the note. Move your hand up and down inside it to open and close the filter — the pad breathes with you. Tap the bells up top for accents.",
  });
}

function bassAndDrums(): Layout {
  const bassNotes = buildScale("A", "minorPentatonic", 1, 4);
  // The drums get their own horizontal slots for the same double-trigger reason
  // as the main kit. They may sit above the bass columns freely, because a zone
  // assigned to one hand is never tested against the other hand's striker.
  const zones: Zone[] = [
    z("snare", "Snare", 0.6, 0.68, 0.17, 0.17, "snare", "strike", undefined, "right"),
    z("kick", "Kick", 0.78, 0.87, 0.19, 0.18, "kick", "strike", undefined, "right"),
    z("hat", "Hat", 0.93, 0.52, 0.13, 0.17, "hat", "strike", undefined, "right"),
    ...bassNotes.map((note, i) =>
      z(
        `bass-${i}`,
        note,
        0.06 + i * 0.1,
        0.6,
        0.09,
        0.5,
        "bass",
        "strike",
        note,
        "left",
      ),
    ),
  ];
  return finalize({
    id: "bassdrums",
    name: "Bass + Drums",
    key: "A",
    scale: "minorPentatonic",
    tempo: 96,
    progression: ["Am", "G", "F", "E"],
    zones,
    space: 0.15,
    howToPlay:
      "Split kit: your left hand plays the bass columns, your right hand plays the drums. Zones only respond to their assigned hand, so you can cross over without misfiring.",
  });
}

/** Shorthand zone constructor — keeps the preset tables readable. */
function z(
  id: string,
  label: string,
  x: number,
  y: number,
  w: number,
  h: number,
  voice: Zone["voice"],
  trigger: Zone["trigger"],
  note?: string,
  hand: Zone["hand"] = "any",
): Zone {
  return { id, label, x, y, w, h, voice, trigger, note, hand, gain: 1 };
}

/** Run every preset through the same schema the AI output must satisfy. */
function finalize(input: unknown): Layout {
  return LayoutSchema.parse(input);
}

export const PRESETS: Layout[] = [
  drumKit(),
  keyboard(),
  strings(),
  ambient(),
  bassAndDrums(),
];

export const DEFAULT_LAYOUT = PRESETS[0];

export function presetById(id: string): Layout | undefined {
  return PRESETS.find((p) => p.id === id);
}
