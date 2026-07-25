import { LayoutSchema, type Layout, type Zone } from "@/lib/layout/types";
import type { Chart } from "./types";

/**
 * Bridges a Chart's lanes to the trigger engine's zone model.
 *
 * The vision layer knows nothing about charts — it fires when a fingertip
 * crosses a Zone's horizontal mid-line. So each piano lane becomes a Zone, and
 * the zone's mid-line IS the hit line the player sees falling notes arrive at.
 * That equivalence is the whole trick: there is no separate hit detection for
 * the game, it reuses the same tested trigger engine as practice mode.
 */

/**
 * Vertical position of the hit line, as a fraction of the stage height.
 *
 * The renderer draws the line here and the zone's mid-line sits here, so what
 * the player sees and what the engine measures are the same thing. Changing
 * this moves both, together — which is why it lives in one place.
 */
export const HIT_LINE_Y = 0.78;

export const LANE_ZONE_PREFIX = "lane-";

/**
 * Horizontal gap between adjacent lanes, as a fraction of lane width.
 *
 * Kept small: this gutter is dead space where a strike registers nothing, and
 * every pixel of it is a near-miss the player experiences as the game ignoring
 * them. Lanes never double-trigger each other (they cannot overlap), so the
 * only reason for a gap at all is visual separation.
 */
const LANE_GUTTER = 0.04;

/**
 * How tall a lane zone is. Generous on purpose: the player's hand approaches
 * from above, and the strike fires on crossing the mid-line, so the height only
 * governs how far above and below the line the gesture stays "in" the lane.
 * Too short and a fast stroke can skip past between two frames.
 */
const LANE_HEIGHT = 0.42;

export function laneZoneId(index: number): string {
  return `${LANE_ZONE_PREFIX}${index}`;
}

/** Inverse of `laneZoneId`. Returns null for any zone that isn't a lane. */
export function laneIndexFromZoneId(zoneId: string): number | null {
  if (!zoneId.startsWith(LANE_ZONE_PREFIX)) return null;
  const index = Number.parseInt(zoneId.slice(LANE_ZONE_PREFIX.length), 10);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

/**
 * Build the playable zone layout for a chart.
 *
 * Lanes tile the width evenly with a small gutter, so no two lanes overlap
 * horizontally — which matters because the layout repair rules treat
 * substantially overlapping strike zones as a double-trigger hazard. Tiling
 * side by side sidesteps that entirely.
 */
export function laneLayout(chart: Chart): Layout {
  const count = chart.lanes.length;
  const pitch = 1 / count;
  const width = pitch * (1 - LANE_GUTTER);

  const zones: Zone[] = chart.lanes.map((lane, i) => ({
    id: laneZoneId(i),
    label: lane.label,
    x: pitch * (i + 0.5),
    y: HIT_LINE_Y,
    w: width,
    h: LANE_HEIGHT,
    voice: "keys" as const,
    // The note here is only a fallback. In the duel the Performer runs in
    // `external` audio mode and the judge sounds whatever pitch the chart
    // scheduled, so this value is never heard during a match.
    note: lane.note,
    trigger: "strike" as const,
    hand: "any" as const,
    gain: 1,
  }));

  return LayoutSchema.parse({
    id: `chart-${chart.id}`,
    name: chart.title,
    song: chart.song,
    key: chart.key,
    scale: chart.scale,
    tempo: chart.bpm,
    progression: [],
    zones,
    space: 0.28,
    howToPlay:
      "Strike down through a column as its note reaches the line. The chart picks the pitch — you only have to land the timing.",
  });
}

/** Map from zone id to lane index, built once per chart. */
export function laneIndexMap(chart: Chart): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < chart.lanes.length; i++) map.set(laneZoneId(i), i);
  return map;
}
