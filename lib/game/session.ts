import { AudioEngine } from "@/lib/audio/engine";
import { HighwayRenderer, type HighwayTheme } from "@/lib/render/highway";
import { SpriteCache } from "@/lib/render/sprites";
import { StageRenderer } from "@/lib/render/stage";
import type { Layout } from "@/lib/layout/types";
import { HandTracker } from "@/lib/vision/handTracker";
import {
  DEFAULT_PERFORMER_CONFIG,
  Performer,
  type HitEvent,
} from "@/lib/vision/performer";
import { BackingTrack } from "./backing";
import { ChartClock } from "./clock";
import { Judge } from "./judge";
import { laneIndexFromZoneId, laneLayout } from "./lanes";
import type { Chart, Judgement, RoundSummary, ScoreState } from "./types";
import { emptyScore } from "./types";

/**
 * The runtime that actually plays the game.
 *
 * ── The rule this file exists to protect ──────────────────────────────────
 *   camera frame -> Performer.update() -> Judge.judgeHit() -> AudioEngine.noteOn()
 *
 * runs synchronously inside the video frame callback, through refs, with React
 * NOWHERE in it. React only reads snapshots from this object on a slow timer.
 * If a note had to wait for a re-render to sound, the game would be unplayable.
 *
 * That is why this is a plain class and not a hook: hooks tempt you into
 * putting per-frame values in state, and the first person to do it would add a
 * frame of latency to every note without noticing.
 */

/**
 * How far ahead of the hit line notes are visible, in seconds.
 *
 * Longer than a touchscreen rhythm game would use. Moving a whole arm into
 * position takes far longer than moving a thumb, so the player needs to see
 * what is coming early enough to physically get there.
 */
const LOOKAHEAD_SEC = 3;
/** Judgement popups live this long on the highway. */
const POPUP_MS = 620;
/** Max popups tracked at once; older ones are recycled. */
const MAX_POPUPS = 12;

export interface DuelSessionInit {
  video: HTMLVideoElement;
  highwayCanvas: HTMLCanvasElement;
  overlayCanvas: HTMLCanvasElement;
}

export interface JudgementSignal {
  judgement: Judgement;
  lane: number;
  /** Monotonic id so React can key a repeat judgement and re-run its animation. */
  id: number;
}

export type SessionPhase = "idle" | "armed" | "playing" | "ended";

export class DuelSession {
  readonly engine = new AudioEngine();
  readonly clock = new ChartClock();

  private tracker: HandTracker | null = null;
  private performer: Performer | null = null;
  private highway: HighwayRenderer | null = null;
  private stage: StageRenderer | null = null;
  private backing: BackingTrack | null = null;
  private sprites = new SpriteCache();

  private chart: Chart | null = null;
  private judge: Judge | null = null;
  private laneOfZone = new Map<string, number>();
  /**
   * Built once per chart and held. `laneLayout` runs a zod parse and allocates
   * a zone array, so deriving it inside the render loop would mean a schema
   * validation every single frame.
   */
  private layout: Layout | null = null;

  private rafHandle: number | null = null;
  private highwayCanvas: HTMLCanvasElement | null = null;
  private overlayCanvas: HTMLCanvasElement | null = null;
  private resizeObservers = new Map<HTMLCanvasElement, ResizeObserver>();

  private phase: SessionPhase = "idle";
  private endAtSec = Infinity;

  /** Reused per-frame render state — never reallocated. */
  private laneFlash = new Float32Array(8);
  private popups: { lane: number; judgement: Judgement; ageMs: number }[] = [];
  private theme: HighwayTheme = {
    laneColors: ["#2ea8ff", "#5cc8ff", "#8fe0ff", "#ffc46b", "#ff8a1f", "#ff6b3d"],
    accent: "#2ea8ff",
    dim: false,
  };

  private judgementSeq = 0;
  private lastJudgement: JudgementSignal | null = null;

  /**
   * Calibration tap capture. When active, hits are recorded as timestamps
   * instead of being judged — the calibration screen has no chart to judge
   * against, it only needs to know *when* the player struck.
   */
  private capturingTaps = false;
  private tapTimes: number[] = [];

  // ---------------------------------------------------------------- lifecycle

  get ready(): boolean {
    return this.tracker !== null && this.performer !== null;
  }

  get currentPhase(): SessionPhase {
    return this.phase;
  }

  get trackingFps(): number {
    return this.performer?.fps ?? 0;
  }

  get highwayFrameMs(): number {
    return this.highway?.lastFrameMs ?? 0;
  }

  /**
   * Boot audio, camera and tracking. MUST be called from a user gesture: the
   * AudioContext is created first and synchronously, because browsers only
   * allow that during a gesture and awaiting the model load first would spend
   * it and leave the game silent.
   */
  async init(opts: DuelSessionInit): Promise<void> {
    await this.engine.init();

    const performer = new Performer(this.engine);
    performer.setConfig({
      ...DEFAULT_PERFORMER_CONFIG,
      // The chart owns the pitch, so the Performer must not sound the zone's
      // own note — the judge sounds whatever the chart scheduled instead.
      audioMode: "external",
      striker: "fingers",
      fingerCount: 5,
    });
    performer.onHit = (event) => this.handleHit(event);
    this.performer = performer;

    const tracker = new HandTracker({ mirror: true, numHands: 2 });
    this.tracker = tracker;
    await tracker.load();
    await tracker.startCamera(opts.video);

    this.backing = new BackingTrack(this.engine, this.engine.context!);
    await this.attach(opts);
    this.startRenderLoop();
  }

  /**
   * (Re)bind to a set of DOM elements.
   *
   * Each screen mounts its own <video> and canvases, so the elements change
   * every time the phase changes. Renderers hold a canvas and its 2D context,
   * so they must be rebuilt against the new nodes — but the camera stream, the
   * loaded model, the AudioContext and all game state survive untouched.
   */
  async attach(opts: DuelSessionInit): Promise<void> {
    const performer = this.performer;
    const tracker = this.tracker;
    if (!performer || !tracker) return;

    await tracker.bindVideo(opts.video);
    tracker.start((frame) => performer.update(frame));

    if (this.highwayCanvas !== opts.highwayCanvas) {
      this.highwayCanvas = opts.highwayCanvas;
      this.highway = new HighwayRenderer(opts.highwayCanvas, this.sprites);
      this.observeSize(opts.highwayCanvas, (w, h) => this.highway?.resize(w, h));
    }
    if (this.overlayCanvas !== opts.overlayCanvas) {
      this.overlayCanvas = opts.overlayCanvas;
      // Share one sprite cache across both renderers: glow sprites are keyed by
      // colour and radius, so the overlay reuses whatever the highway baked.
      this.stage = new StageRenderer(opts.overlayCanvas, performer, this.sprites);
      this.observeSize(opts.overlayCanvas, (w, h) => this.stage?.resize(w, h));
    }
  }

  /**
   * Track a canvas's CSS size with ResizeObserver rather than calling
   * getBoundingClientRect in the draw loop. Reading layout every frame forces a
   * synchronous reflow — twice per frame across two canvases — which is exactly
   * the kind of cost that shows up as stutter while inference shares the thread.
   */
  private observeSize(
    el: HTMLCanvasElement,
    apply: (w: number, h: number) => void,
  ): void {
    this.resizeObservers.get(el)?.disconnect();
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.contentRect;
        if (box.width > 0 && box.height > 0) apply(box.width, box.height);
      }
    });
    ro.observe(el);
    this.resizeObservers.set(el, ro);
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) apply(rect.width, rect.height);
  }

  /** Install a chart and prepare to play it. Does not start the clock. */
  setChart(chart: Chart, calibrationSec: number): void {
    this.chart = chart;
    this.judge = new Judge(chart, { calibrationSec });

    const layout = laneLayout(chart);
    this.layout = layout;
    this.performer?.setLayout(layout);
    this.engine.setSpace(layout.space);

    this.laneOfZone.clear();
    for (const zone of layout.zones) {
      const lane = laneIndexFromZoneId(zone.id);
      if (lane !== null) this.laneOfZone.set(zone.id, lane);
    }

    if (this.laneFlash.length < chart.lanes.length) {
      this.laneFlash = new Float32Array(chart.lanes.length);
    }
    this.laneFlash.fill(Infinity);
    this.popups.length = 0;
    this.phase = "armed";
  }

  setCalibration(sec: number): void {
    this.judge?.setCalibration(sec);
  }

  /**
   * Start the chart at a specific AudioContext time.
   *
   * Passing a future time is how the countdown works: the clock counts up
   * through negative chart time, so notes are already falling and correctly
   * positioned before beat one arrives.
   */
  startAt(audioTime: number): void {
    const ctx = this.engine.context;
    if (!ctx || !this.chart) return;
    this.judge?.reset();
    this.clock.start(ctx, audioTime);
    this.backing?.start(this.chart, audioTime);
    this.endAtSec = this.chart.durationSec;
    this.phase = "playing";
  }

  stopChart(): void {
    this.backing?.stop();
    this.clock.stop();
    this.engine.allNotesOff();
    this.phase = "ended";
  }

  dispose(): void {
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
    for (const ro of this.resizeObservers.values()) ro.disconnect();
    this.resizeObservers.clear();
    this.backing?.stop();
    this.tracker?.dispose();
    this.performer?.panic();
    void this.engine.dispose();
    this.sprites.clear();
  }

  // ------------------------------------------------------------------ reading

  chartTimeSec(): number {
    return this.clock.nowSec();
  }

  getScore(): ScoreState {
    return this.judge?.getScore() ?? emptyScore();
  }

  getRoundSummary(round: number): RoundSummary {
    return (
      this.judge?.getRoundSummary(round) ?? {
        round,
        score: 0,
        accuracy: 1,
        bestCombo: 0,
        counts: { perfect: 0, great: 0, good: 0, miss: 0 },
      }
    );
  }

  takeJudgement(): JudgementSignal | null {
    return this.lastJudgement;
  }

  /** True once the chart has run past its end. */
  get finished(): boolean {
    return this.phase === "playing" && this.clock.nowSec() >= this.endAtSec;
  }

  // -------------------------------------------------------------- calibration

  beginCalibration(): void {
    this.tapTimes = [];
    this.capturingTaps = true;
  }

  /** Stop capturing and return tap times, in the same domain as the clicks. */
  endCalibration(): number[] {
    this.capturingTaps = false;
    return this.tapTimes.slice();
  }

  get tapCount(): number {
    return this.tapTimes.length;
  }

  /**
   * A bare lane layout so the player has something to strike during
   * calibration, before any chart exists.
   */
  useCalibrationLayout(chart: Chart): void {
    this.setChart(chart, 0);
    this.phase = "armed";
  }

  // ----------------------------------------------------------------- hot path

  /**
   * Called synchronously from the camera frame callback. Everything here is
   * arithmetic and a map lookup — no allocation beyond the judge's single
   * result object, no awaits, no React.
   */
  private handleHit(event: HitEvent): void {
    const lane = this.laneOfZone.get(event.zoneId);
    if (lane === undefined) return;

    if (lane < this.laneFlash.length) this.laneFlash[lane] = 0;

    if (this.capturingTaps) {
      // Calibration: record when, do not judge.
      this.tapTimes.push(this.clock.perfToChartSec(event.tMs));
      return;
    }

    const judge = this.judge;
    if (!judge || this.phase !== "playing") return;

    const chartTime = this.clock.perfToChartSec(event.tMs);
    const result = judge.judgeHit(lane, chartTime);
    if (!result) return;

    // Magic Piano: sound the pitch the CHART scheduled, not the zone's own.
    // This is why the player cannot play a wrong note.
    this.engine.noteOn("keys", {
      velocity: Math.max(0.45, event.velocity),
      note: result.note.note,
      tone: 0.55,
    });

    this.pushPopup(lane, result.judgement);
    this.judgementSeq++;
    this.lastJudgement = {
      judgement: result.judgement,
      lane,
      id: this.judgementSeq,
    };
  }

  private pushPopup(lane: number, judgement: Judgement): void {
    if (this.popups.length >= MAX_POPUPS) this.popups.shift();
    this.popups.push({ lane, judgement, ageMs: 0 });
  }

  // -------------------------------------------------------------- render loop

  private startRenderLoop(): void {
    let last = performance.now();

    const frame = (now: number) => {
      const dt = now - last;
      last = now;

      const chartTime = this.clock.nowSec();

      // Retire notes whose window has passed. Misses surface here, not on the
      // hit path, because a miss is the *absence* of an event.
      if (this.judge && this.phase === "playing") {
        const retired = this.judge.update(chartTime);
        for (const hit of retired) {
          if (hit.judgement === "miss") {
            this.pushPopup(hit.lane, "miss");
            this.judgementSeq++;
            this.lastJudgement = {
              judgement: "miss",
              lane: hit.lane,
              id: this.judgementSeq,
            };
          }
        }
      }

      for (let i = 0; i < this.laneFlash.length; i++) this.laneFlash[i] += dt;
      for (let i = this.popups.length - 1; i >= 0; i--) {
        this.popups[i].ageMs += dt;
        if (this.popups[i].ageMs > POPUP_MS) this.popups.splice(i, 1);
      }

      this.drawHighway(chartTime);
      this.drawOverlay();

      this.rafHandle = requestAnimationFrame(frame);
    };

    this.rafHandle = requestAnimationFrame(frame);
  }

  private drawHighway(chartTimeSec: number): void {
    const highway = this.highway;
    const chart = this.chart;
    if (!highway || !chart) return;

    highway.draw({
      chart,
      chartTimeSec,
      lookaheadSec: LOOKAHEAD_SEC,
      lanes: chart.lanes.length,
      laneFlash: this.laneFlash,
      popups: this.popups,
      theme: this.theme,
    });
  }

  private drawOverlay(): void {
    const stage = this.stage;
    if (!stage) return;

    // The camera view is a confidence monitor, not the playfield: labels would
    // just be clutter at picture-in-picture size.
    stage.draw(this.layout, {
      showSkeleton: true,
      showPrediction: false,
      showLabels: false,
    });
  }
}
