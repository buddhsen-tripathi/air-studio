import { MAX_CALIBRATION_SEC } from "./types";

/**
 * Latency calibration.
 *
 * ── Why a rhythm game cannot skip this ────────────────────────────────────
 * There is 40-80ms between a hand physically moving and us seeing it, and the
 * exact figure depends on the webcam, the USB path, the browser and the machine.
 * Two players on different laptops can differ by 40ms — which is most of a
 * PERFECT window. Without correction one of them simply cannot score well, and
 * it reads as the game being broken rather than their hardware being slow.
 *
 * So each player taps along to a click track, we measure their systematic
 * offset, and subtract it before judging. It compensates only their own
 * hardware, so it advantages nobody: it makes two different webcams score the
 * same performance the same way.
 */

export interface CalibrationResult {
  /** Seconds to subtract from hit timestamps. Positive = the player reads late. */
  offsetSec: number;
  /** Spread of the samples; high spread means the measurement is unreliable. */
  spreadSec: number;
  /** How many taps were successfully matched to a click. */
  matched: number;
  /** Whether we trust the result enough to apply it without warning. */
  confident: boolean;
  /** Human-facing explanation for the calibration screen. */
  message: string;
}

/** A tap further than this from any click is a stray, not a data point. */
const MATCH_WINDOW_SEC = 0.35;
/** Below this many matched taps the measurement is noise. */
const MIN_SAMPLES = 5;
/** Above this spread the player was not tapping steadily enough to trust. */
const MAX_TRUSTED_SPREAD_SEC = 0.075;

/**
 * Compute the offset from a run of taps against a known click track.
 *
 * Both arrays are in the same time domain (seconds, audio clock).
 *
 * The statistic is the MEDIAN, not the mean. A calibration run almost always
 * contains one or two flubbed taps — a double-tap, a late start, a missed beat —
 * and a single 300ms outlier drags a mean far enough to make the correction
 * worse than no correction at all. The median ignores them entirely.
 */
export function computeCalibration(
  tapTimes: number[],
  clickTimes: number[],
): CalibrationResult {
  const deltas: number[] = [];

  for (const tap of tapTimes) {
    let best = Infinity;
    for (const click of clickTimes) {
      const delta = tap - click;
      if (Math.abs(delta) < Math.abs(best)) best = delta;
    }
    if (Math.abs(best) <= MATCH_WINDOW_SEC) deltas.push(best);
  }

  if (deltas.length < MIN_SAMPLES) {
    return {
      offsetSec: 0,
      spreadSec: 0,
      matched: deltas.length,
      confident: false,
      message:
        deltas.length === 0
          ? "I didn't catch any taps. Check your hands are visible and try again."
          : `Only caught ${deltas.length} taps — I need at least ${MIN_SAMPLES}. Try again, tapping right on each click.`,
    };
  }

  deltas.sort((a, b) => a - b);
  const offsetSec = median(deltas);
  // Interquartile range rather than standard deviation, for the same
  // outlier-resistance reason the median is used above.
  const spreadSec = iqr(deltas);

  const clamped = Math.max(
    -MAX_CALIBRATION_SEC,
    Math.min(MAX_CALIBRATION_SEC, offsetSec),
  );
  const confident = spreadSec <= MAX_TRUSTED_SPREAD_SEC;

  return {
    offsetSec: clamped,
    spreadSec,
    matched: deltas.length,
    confident,
    message: confident
      ? `Locked in. Your setup runs about ${Math.round(clamped * 1000)}ms behind, and I'll account for it.`
      : `Measured ${Math.round(clamped * 1000)}ms, but your taps were uneven (±${Math.round(spreadSec * 1000)}ms). Run it again for a tighter result.`,
  };
}

function median(sorted: number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function iqr(sorted: number[]): number {
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  return Math.abs(q3 - q1);
}

/** Click track for the calibration screen. */
export function calibrationClicks(
  startSec: number,
  bpm: number,
  beats: number,
): number[] {
  const spb = 60 / bpm;
  return Array.from({ length: beats }, (_, i) => startSec + i * spb);
}
