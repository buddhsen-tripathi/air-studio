import type { AudioEngine } from "@/lib/audio/engine";
import { buildScale } from "@/lib/music/theory";
import type { Chart } from "./types";

/**
 * The backing track: a groove for the players to lock onto.
 *
 * ── Why this uses a lookahead scheduler when nothing else does ────────────
 * Everywhere else in this codebase lookahead is banned, because for a live hit
 * it is pure added latency. Sequenced playback is the exact opposite case. A
 * metronome driven by setInterval inherits every hiccup of the main thread and
 * audibly wobbles; events queued against the AudioContext clock are
 * sample-accurate no matter what the page is doing.
 *
 * So: a timer wakes up every TICK_MS and schedules every beat that falls inside
 * the next SCHEDULE_AHEAD_SEC. The timer only has to be roughly on time — the
 * audio clock does the precise work. (This is the standard "Tale of Two Clocks"
 * pattern.)
 *
 * The groove matters for more than atmosphere: without a pulse to anchor to,
 * players drift, and a rhythm game where you cannot feel the beat is just a
 * reaction test.
 */

/** How far ahead of the audio clock we queue events. */
const SCHEDULE_AHEAD_SEC = 0.2;
/** How often the scheduler wakes. Must be well under SCHEDULE_AHEAD_SEC. */
const TICK_MS = 40;

/** Simple diatonic root movement, as scale degrees per bar. */
const PROGRESSION_DEGREES = [0, 5, 3, 4];

export class BackingTrack {
  private timer: number | null = null;
  private chart: Chart | null = null;
  private startAudioTime = 0;
  /** Index of the next eighth-note step to schedule. */
  private nextStep = 0;
  private secondsPerBeat = 0.5;
  private bassNotes: string[] = [];
  private enabled = true;

  constructor(
    private engine: AudioEngine,
    private ctx: AudioContext,
  ) {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Begin the groove. `startAudioTime` is chart time zero on the AudioContext
   * clock — the same anchor ChartClock captured, so the backing and the falling
   * notes cannot drift apart.
   */
  start(chart: Chart, startAudioTime: number): void {
    this.stop();
    this.chart = chart;
    this.startAudioTime = startAudioTime;
    this.secondsPerBeat = 60 / chart.bpm;
    this.nextStep = 0;

    // One bass note per bar, walking a simple diatonic progression in the
    // chart's own key so it never fights the melody the player is producing.
    const scale = buildScale(chart.key, chart.scale, 2, 8);
    this.bassNotes = PROGRESSION_DEGREES.map(
      (degree) => scale[degree % scale.length],
    );

    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.chart = null;
  }

  private tick(): void {
    const chart = this.chart;
    if (!chart || !this.enabled) return;

    const horizon = this.ctx.currentTime + SCHEDULE_AHEAD_SEC;
    const stepSec = this.secondsPerBeat / 2; // eighth notes

    // Schedule every step that lands before the horizon, then stop. Because we
    // only ever move forward, no event can be scheduled twice.
    while (true) {
      const when = this.startAudioTime + this.nextStep * stepSec;
      if (when >= horizon) break;
      if (when > chart.durationSec + this.startAudioTime) {
        this.stop();
        return;
      }

      this.scheduleStep(this.nextStep, when);
      this.nextStep++;
    }
  }

  private scheduleStep(step: number, when: number): void {
    const beat = Math.floor(step / 2);
    const onBeat = step % 2 === 0;
    const beatInBar = beat % 4;
    const bar = Math.floor(beat / 4);

    // Kick on 1 and 3, the spine of the groove.
    if (onBeat && (beatInBar === 0 || beatInBar === 2)) {
      this.engine.noteOn("kick", { velocity: 0.55, when });
    }

    // Snare on 2 and 4.
    if (onBeat && (beatInBar === 1 || beatInBar === 3)) {
      this.engine.noteOn("snare", { velocity: 0.32, when });
    }

    // Hats on every eighth, accented on the beat. Kept quiet — this is a bed,
    // not a performance, and it must never mask the player's own notes.
    this.engine.noteOn("hat", {
      velocity: onBeat ? 0.16 : 0.09,
      when,
    });

    // Bass at the top of each bar.
    if (onBeat && beatInBar === 0 && this.bassNotes.length > 0) {
      this.engine.noteOn("bass", {
        velocity: 0.4,
        note: this.bassNotes[bar % this.bassNotes.length],
        when,
      });
    }
  }
}

/**
 * A count-in click, used by the countdown screen and the calibration test.
 *
 * Scheduled the same way and for the same reason: the whole point of a count-in
 * is that its spacing is exact.
 */
export function scheduleCountIn(
  engine: AudioEngine,
  startAudioTime: number,
  bpm: number,
  beats = 4,
): void {
  const secondsPerBeat = 60 / bpm;
  for (let i = 0; i < beats; i++) {
    engine.noteOn(i === 0 ? "rim" : "hat", {
      velocity: i === 0 ? 0.7 : 0.45,
      when: startAudioTime + i * secondsPerBeat,
    });
  }
}
