import {
  comboMultiplier,
  emptyScore,
  HIT_WINDOW_MAX,
  HIT_WINDOWS,
  JUDGEMENT_POINTS,
  MAX_CALIBRATION_SEC,
  SUDDEN_DEATH_MISS_PENALTY,
  type Chart,
  type ChartNote,
  type JudgedHit,
  type Judgement,
  type RoundSummary,
  type ScoreState,
} from "./types";

/**
 * Local judging and scoring.
 *
 * ── Where this runs ───────────────────────────────────────────────────────
 * `judgeHit` is called synchronously from the vision frame callback, in the
 * same tick that will call `AudioEngine.noteOn`. It therefore does no async
 * work, touches no React state, never throws, and does not allocate per frame.
 * `update` and `visibleNotes` run once per animation frame and are allocation
 * free in steady state too.
 *
 * ── Why judging is purely local ───────────────────────────────────────────
 * Both clients hold the identical chart and each judges only its own player,
 * against its own audio clock. Nothing about a hit ever crosses the network, so
 * network jitter cannot corrupt timing — only score *results* are relayed. That
 * is the single decision this whole class exists to serve.
 *
 * ── Magic Piano semantics ────────────────────────────────────────────────
 * The chart owns pitch, the player owns timing. `judgeHit` takes a lane, not a
 * note, and hands back the ChartNote whose pitch should sound. A player cannot
 * hit a wrong note here, only a badly timed one.
 */

/** Highest round index the schema allows, +1. */
const MAX_ROUNDS = 8;

/**
 * Window comparisons are inclusive of the boundary, but the incoming time has
 * already been through a couple of float subtractions (perf→chart conversion,
 * calibration), so a hit that is exactly on a boundary arithmetically lands a
 * few ULPs outside it. This slack makes the boundary deterministic instead of
 * leaving it to rounding — a nanosecond is far below any timing we can measure.
 */
const EPS = 1e-9;

/** Accuracy weighting: a GOOD is a hit, but it is not most of a hit. */
const ACCURACY_WEIGHT: Record<Judgement, number> = {
  perfect: 1,
  great: 0.7,
  good: 0.4,
  miss: 0,
};

export interface HitResult {
  /** The note that was resolved; its `note` field is the pitch to sound. */
  note: ChartNote;
  judgement: Judgement;
  /** Signed timing error after calibration: negative early, positive late. */
  deltaSec: number;
  /** Points awarded, multiplier already applied. */
  points: number;
}

/** Per-round running totals, so a round summary needs no rescan at round end. */
interface RoundAcc {
  score: number;
  bestCombo: number;
  counts: Record<Judgement, number>;
  weighted: number;
  resolved: number;
}

function emptyRoundAcc(): RoundAcc {
  return {
    score: 0,
    bestCombo: 0,
    counts: { perfect: 0, great: 0, good: 0, miss: 0 },
    weighted: 0,
    resolved: 0,
  };
}

export class Judge {
  readonly chart: Chart;

  /** Notes sorted by time. The expander emits them sorted; we do not assume it. */
  private readonly notes: ChartNote[];

  /** Parallel to `notes`. 1 once a note has been hit or missed. */
  private readonly resolvedFlag: Uint8Array;

  /** noteId -> index into `notes`, for the renderer's resolved lookups. */
  private readonly idIndex: Map<string, number>;

  /** Per lane, indices into `notes` in ascending time. */
  private readonly laneNotes: Int32Array[];

  /** Per lane, position in `laneNotes[lane]` of the first still-hittable note. */
  private readonly laneCursor: Int32Array;

  private readonly laneCount: number;

  /** rounds[i].suddenDeath, indexed by round number. */
  private readonly suddenDeath: Uint8Array;

  /** Position in `notes` of the first note whose window has not fully passed. */
  private missCursor = 0;

  /** Position in `notes` of the first note that could still be on screen. */
  private visibleCursor = 0;
  private lastVisibleSec = -Infinity;

  private calibrationSec: number;

  private readonly state: ScoreState = emptyScore();
  private weighted = 0;
  private readonly rounds: RoundAcc[];

  /**
   * Reused output buffers. `update` and `visibleNotes` run every animation
   * frame; handing back a fresh array each time would churn one throwaway array
   * per frame per call for the entire song. Both are refilled in place, so a
   * caller must consume them before the next call rather than retaining them.
   * Neither escapes past the frame that asked for it in practice — the renderer
   * reads them straight into draw calls.
   */
  private readonly retireBuf: JudgedHit[] = [];
  private readonly visibleBuf: ChartNote[] = [];

  constructor(chart: Chart, opts: { calibrationSec: number }) {
    this.chart = chart;
    this.calibrationSec = clampCalibration(opts.calibrationSec);

    this.notes = [...chart.notes].sort((a, b) => a.timeSec - b.timeSec);
    this.resolvedFlag = new Uint8Array(this.notes.length);

    this.idIndex = new Map();
    let maxLane = chart.lanes.length - 1;
    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i];
      // Dedupe is by index, which is 1:1 with id for a well-formed chart and
      // strictly safer if the expander ever emitted a duplicate id.
      this.idIndex.set(n.id, i);
      if (n.lane > maxLane) maxLane = n.lane;
    }
    this.laneCount = Math.max(1, maxLane + 1);

    // Bucket note indices per lane once, so a hit never scans other lanes.
    const perLane = new Int32Array(this.laneCount);
    for (const n of this.notes) {
      if (n.lane >= 0 && n.lane < this.laneCount) perLane[n.lane]++;
    }
    this.laneNotes = [];
    for (let l = 0; l < this.laneCount; l++) {
      this.laneNotes.push(new Int32Array(perLane[l]));
    }
    const fill = new Int32Array(this.laneCount);
    for (let i = 0; i < this.notes.length; i++) {
      const l = this.notes[i].lane;
      if (l >= 0 && l < this.laneCount) this.laneNotes[l][fill[l]++] = i;
    }
    this.laneCursor = new Int32Array(this.laneCount);

    this.suddenDeath = new Uint8Array(MAX_ROUNDS);
    for (const r of chart.rounds) {
      if (r.index >= 0 && r.index < MAX_ROUNDS) {
        this.suddenDeath[r.index] = r.suddenDeath ? 1 : 0;
      }
    }

    this.rounds = [];
    for (let i = 0; i < MAX_ROUNDS; i++) this.rounds.push(emptyRoundAcc());
  }

  setCalibration(sec: number): void {
    this.calibrationSec = clampCalibration(sec);
  }

  /**
   * Judge a strike on `lane` at `chartTimeSec` (chart time, from ChartClock).
   * Returns the resolved note — whose pitch the caller should sound — or null
   * if nothing in that lane was within reach, in which case the strike is
   * silent and costs nothing.
   *
   * The returned object is freshly allocated. Hits are events at under ~10Hz,
   * not per-frame work, and the Performer already allocates a HitEvent on the
   * same path; a shared mutable result would buy nothing and would be a trap
   * for any caller that held on to it.
   */
  judgeHit(lane: number, chartTimeSec: number): HitResult | null {
    if (lane < 0 || lane >= this.laneCount) return null;

    // Calibration removes this player's own capture+display latency, measured
    // by the tap test. It is per-player hardware compensation, so applying it
    // makes two different webcams score the same performance the same — it
    // does not advantage anyone.
    const t = chartTimeSec - this.calibrationSec;

    const lanes = this.laneNotes[lane];
    let c = this.laneCursor[lane];

    // Walk the cursor past everything that can never be hit again: already
    // resolved, or fully past its window. This is what keeps a hit O(notes in
    // the window) instead of O(chart) — the cursor only ever moves forward, so
    // the total work across a song is linear.
    while (c < lanes.length) {
      const ni = lanes[c];
      if (
        this.resolvedFlag[ni] === 1 ||
        this.notes[ni].timeSec + HIT_WINDOW_MAX + EPS < t
      ) {
        c++;
        continue;
      }
      break;
    }
    this.laneCursor[lane] = c;

    // Nearest unresolved note wins. Scanning forward from the cursor covers at
    // most the handful of notes inside a 340ms window; MIN_LANE_GAP_STEPS keeps
    // that count tiny in a single lane.
    let bestIdx = -1;
    let bestAbs = Infinity;
    let bestDelta = 0;
    for (let i = c; i < lanes.length; i++) {
      const ni = lanes[i];
      const d = t - this.notes[ni].timeSec;
      // Notes are time ordered, so once one is too far ahead so is the rest.
      if (d < -(HIT_WINDOW_MAX + EPS)) break;
      if (this.resolvedFlag[ni] === 1) continue;
      const abs = d < 0 ? -d : d;
      if (abs <= HIT_WINDOW_MAX + EPS && abs < bestAbs) {
        bestAbs = abs;
        bestIdx = ni;
        bestDelta = d;
      }
    }
    if (bestIdx < 0) return null;

    const judgement = judgementFor(bestAbs);
    const note = this.notes[bestIdx];
    const points = this.resolve(bestIdx, judgement);
    return { note, judgement, deltaSec: bestDelta, points };
  }

  /**
   * Retire notes the player can no longer reach. Returns the misses produced
   * this frame — usually none, so the buffer is empty and nothing allocates.
   *
   * The buffer is reused; consume it before calling again.
   */
  update(chartTimeSec: number): JudgedHit[] {
    const buf = this.retireBuf;
    buf.length = 0;

    // A hit is compared at `chartTime - calibration`, so a note stays reachable
    // for `calibration` longer in wall-chart time than its raw window suggests.
    // Retiring on the raw window would silently eat every late-but-legal hit.
    // A negative calibration only ever makes notes unreachable EARLIER, and
    // retiring late is harmless, so the margin is floored at zero.
    const margin =
      HIT_WINDOW_MAX +
      (this.calibrationSec > 0 ? this.calibrationSec : 0) +
      EPS;

    while (this.missCursor < this.notes.length) {
      const i = this.missCursor;
      const n = this.notes[i];
      if (n.timeSec + margin >= chartTimeSec) break;
      this.missCursor++;
      if (this.resolvedFlag[i] === 1) continue;

      const points = this.resolve(i, "miss");
      buf.push({
        noteId: n.id,
        lane: n.lane,
        judgement: "miss",
        // There is no real timing error for a note that was never struck; the
        // window edge is the honest stand-in and reads correctly on a graph.
        deltaSec: HIT_WINDOW_MAX,
        tSec: chartTimeSec,
        points,
        combo: this.state.combo,
      });
    }
    return buf;
  }

  getScore(): ScoreState {
    // A snapshot, not the live object: this feeds React, which compares by
    // identity and would never re-render if handed the same mutated object.
    const s = this.state;
    return {
      score: s.score,
      combo: s.combo,
      bestCombo: s.bestCombo,
      counts: { ...s.counts },
      resolved: s.resolved,
      accuracy: s.accuracy,
    };
  }

  getRoundSummary(round: number): RoundSummary {
    const acc =
      round >= 0 && round < MAX_ROUNDS ? this.rounds[round] : emptyRoundAcc();
    return {
      round,
      score: acc.score,
      accuracy: acc.resolved > 0 ? acc.weighted / acc.resolved : 1,
      bestCombo: acc.bestCombo,
      counts: { ...acc.counts },
    };
  }

  /**
   * Notes the highway should draw: everything from just behind the hit line
   * (so a note that just passed can animate out) to `lookaheadSec` ahead.
   *
   * Refills one reused array rather than returning a new one, and starts from a
   * forward-only cursor rather than scanning the chart, so the per-frame cost
   * is proportional to what is on screen and the steady-state allocation is
   * zero once the buffer has grown to its working size. Resolved notes are
   * included — the renderer decides how to draw them, via `isResolved`.
   */
  visibleNotes(chartTimeSec: number, lookaheadSec: number): ChartNote[] {
    const buf = this.visibleBuf;
    buf.length = 0;

    // The cursor is forward-only, so a rewind (restart, seek in dev) has to
    // reset it or the highway would come back empty.
    if (chartTimeSec < this.lastVisibleSec) this.visibleCursor = 0;
    this.lastVisibleSec = chartTimeSec;

    const from = chartTimeSec - HIT_WINDOW_MAX;
    const to = chartTimeSec + lookaheadSec;

    while (
      this.visibleCursor < this.notes.length &&
      this.notes[this.visibleCursor].timeSec < from
    ) {
      this.visibleCursor++;
    }
    for (let i = this.visibleCursor; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.timeSec > to) break;
      buf.push(n);
    }
    return buf;
  }

  /** Whether a note has already been hit or missed. O(1), for the renderer. */
  isResolved(noteId: string): boolean {
    const i = this.idIndex.get(noteId);
    return i === undefined ? false : this.resolvedFlag[i] === 1;
  }

  reset(): void {
    this.resolvedFlag.fill(0);
    this.laneCursor.fill(0);
    this.missCursor = 0;
    this.visibleCursor = 0;
    this.lastVisibleSec = -Infinity;
    this.retireBuf.length = 0;
    this.visibleBuf.length = 0;
    this.weighted = 0;

    const fresh = emptyScore();
    this.state.score = fresh.score;
    this.state.combo = fresh.combo;
    this.state.bestCombo = fresh.bestCombo;
    this.state.counts = fresh.counts;
    this.state.resolved = fresh.resolved;
    this.state.accuracy = fresh.accuracy;

    for (let i = 0; i < this.rounds.length; i++) this.rounds[i] = emptyRoundAcc();
  }

  /**
   * Apply one resolution to the score. Returns the actual score delta, which
   * for a sudden-death miss is negative and may be smaller in magnitude than
   * the penalty because the score floors at zero.
   */
  private resolve(idx: number, judgement: Judgement): number {
    this.resolvedFlag[idx] = 1;
    const note = this.notes[idx];
    const s = this.state;
    const round = note.round >= 0 && note.round < MAX_ROUNDS ? note.round : 0;
    const acc = this.rounds[round];

    let points = 0;
    if (judgement === "miss") {
      s.combo = 0;
      if (this.suddenDeath[round] === 1) {
        // Floor at zero: the round is already brutal, and a negative score
        // would make the head-to-head bars meaningless.
        const before = s.score;
        s.score = Math.max(0, before - SUDDEN_DEATH_MISS_PENALTY);
        points = s.score - before;
        acc.score = Math.max(0, acc.score + points);
      }
    } else {
      // Combo counts this note before the multiplier is read, so the tenth
      // note of a streak is itself the one that pays at 2x.
      s.combo++;
      if (s.combo > s.bestCombo) s.bestCombo = s.combo;
      if (s.combo > acc.bestCombo) acc.bestCombo = s.combo;
      points = JUDGEMENT_POINTS[judgement] * comboMultiplier(s.combo);
      s.score += points;
      acc.score += points;
    }

    s.counts[judgement]++;
    s.resolved++;
    this.weighted += ACCURACY_WEIGHT[judgement];
    s.accuracy = s.resolved > 0 ? this.weighted / s.resolved : 1;

    acc.counts[judgement]++;
    acc.resolved++;
    acc.weighted += ACCURACY_WEIGHT[judgement];

    return points;
  }
}

function judgementFor(absDeltaSec: number): Judgement {
  if (absDeltaSec <= HIT_WINDOWS.perfect + EPS) return "perfect";
  if (absDeltaSec <= HIT_WINDOWS.great + EPS) return "great";
  return "good";
}

/**
 * Calibration is normally positive (the camera path is late), but an unusual
 * output-latency profile can legitimately push it the other way, so both signs
 * are allowed within the same magnitude bound. NaN from a half-finished tap
 * test must not poison every subsequent judgement.
 */
function clampCalibration(sec: number): number {
  if (!Number.isFinite(sec)) return 0;
  return Math.max(-MAX_CALIBRATION_SEC, Math.min(MAX_CALIBRATION_SEC, sec));
}
