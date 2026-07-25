/**
 * The bridge between the two clocks this game runs on.
 *
 * ── Why there are two ─────────────────────────────────────────────────────
 * The chart lives on the AudioContext clock, because that is the only clock
 * that matches what the player *hears*: notes are scheduled against
 * `ctx.currentTime`, and the audio thread renders them against the sound
 * card's own oscillator. Judging against any other clock means judging against
 * something other than the music.
 *
 * But hits arrive from the vision layer stamped with `performance.now()` —
 * `HitEvent.tMs` — because that is what the video frame callback has. So every
 * hit has to be moved from the perf domain into the chart domain before it can
 * be compared to a note.
 *
 * ── How ───────────────────────────────────────────────────────────────────
 * Sample both clocks adjacently once, at start, and keep the difference. From
 * then on the conversion is a constant offset, which means:
 *
 *   - hit timing keeps the perf clock's sub-millisecond resolution. Reading
 *     `ctx.currentTime` per hit would NOT: it only advances once per render
 *     quantum (128 frames ≈ 2.7ms at 48kHz), so it would quantise every hit to
 *     a ~3ms grid and add a sawtooth error on top of the tracking jitter.
 *   - the conversion is a subtract and a multiply, safe on the hot path.
 *
 * ── Drift, and why we ignore it ───────────────────────────────────────────
 * The two clocks are driven by different oscillators — the audio device's and
 * the system's — so their rates differ by a small constant, typically single
 * digit parts per million and rarely worse than ~50ppm on consumer hardware.
 * Over a ~90 second chart that is well under a millisecond at typical rates and
 * ~4.5ms even in the pathological case, against a 50ms PERFECT window. It is
 * also a *systematic* error that grows smoothly, not jitter, so it cannot
 * produce a surprising judgement — it can at worst nudge the tail of a long
 * chart a hair late. Re-syncing mid-song would cost more than it buys: it would
 * step the offset discontinuously right where the player is mid-phrase.
 *
 * The one-off sampling skew is larger than the drift anyway: `ctx.currentTime`
 * is quantised to the last render quantum, so the captured pair can be up to
 * ~3ms stale. That is a fixed offset, and per-player latency calibration is
 * measured through this exact same path, so it is absorbed along with webcam
 * and output latency rather than being corrected here.
 */
export class ChartClock {
  private ctx: AudioContext | null = null;

  /** Audio-clock time at which chart time is zero. */
  private originSec = 0;

  /** The adjacent sample pair taken in `start()`. */
  private audioSampleSec = 0;
  private perfSampleMs = 0;

  private running = false;

  get started(): boolean {
    return this.running;
  }

  /**
   * Anchor the chart to the audio clock.
   *
   * `atAudioTime` lets the caller place chart t=0 in the future, which is what
   * the countdown does: it schedules the first bar at a known audio time and
   * starts the clock against it, so `nowSec()` counts up through negative
   * numbers to zero and the highway can scroll in before the music begins.
   */
  start(ctx: AudioContext, atAudioTime?: number): void {
    // Sampled adjacently on purpose: anything between these two reads (an
    // await, a log, a property lookup that deopts) becomes permanent error in
    // every hit timestamp for the rest of the song.
    const audioNow = ctx.currentTime;
    const perfNow = performance.now();

    this.ctx = ctx;
    this.audioSampleSec = audioNow;
    this.perfSampleMs = perfNow;
    this.originSec = atAudioTime ?? audioNow;
    this.running = true;
  }

  /** Chart time now, read from the audio clock. Negative before t=0. */
  nowSec(): number {
    if (!this.running || !this.ctx) return 0;
    return this.ctx.currentTime - this.originSec;
  }

  /**
   * Convert a `performance.now()` timestamp — e.g. `HitEvent.tMs` — into chart
   * time. Called from the vision frame callback, so it must stay allocation
   * free and must not throw; before `start()` it simply reports 0.
   */
  perfToChartSec(perfMs: number): number {
    if (!this.running) return 0;
    return (
      this.audioSampleSec + (perfMs - this.perfSampleMs) / 1000 - this.originSec
    );
  }

  /**
   * Inverse of `nowSec()`: the audio-clock time a chart position falls on.
   * The note scheduler needs this to hand times to `AudioContext` scheduling.
   */
  chartToAudioSec(chartSec: number): number {
    return this.originSec + chartSec;
  }

  stop(): void {
    this.running = false;
    this.ctx = null;
  }
}
