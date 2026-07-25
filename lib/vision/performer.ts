import type { AudioEngine } from "@/lib/audio/engine";
import {
  zoneBounds,
  type Layout,
  type VoiceKind,
  type Zone,
} from "@/lib/layout/types";
import { DEFAULT_ONE_EURO, SmoothedPoint, type OneEuroConfig } from "./filter";
import { LM, type FrameResult, type TrackedHand } from "./handTracker";

/**
 * The trigger engine: turns smoothed hand motion into note events.
 *
 * This runs inside the camera frame callback. It is the hot path. Rules:
 *   - no allocation in steady state (all state objects are pre-created)
 *   - no React, no promises, no DOM reads
 *   - it calls AudioEngine directly so a hit reaches the sound card in the same
 *     tick it was detected
 *
 * The UI reads this object's public fields once per animation frame to draw.
 * It never drives the audio.
 */

export interface PerformerConfig {
  /**
   * Milliseconds of forward prediction. We extrapolate the striker along its
   * velocity vector before testing zone crossings.
   *
   * This is the key trick for feel. There is ~40-80ms of unavoidable latency
   * between your hand physically moving and us seeing it (sensor exposure, USB
   * transfer, decode, inference). Firing on the *predicted* position cancels
   * most of that, so the sound lands when your hand feels like it hit, not
   * ~70ms later. Too much prediction and notes fire before you arrive.
   */
  predictMs: number;
  /** 0..1. Higher = a gentler motion counts as a strike. */
  sensitivity: number;
  /** Minimum ms between two hits on the same zone by the same hand. */
  cooldownMs: number;
  /** Which landmark acts as the drumstick tip. */
  striker: "index" | "palm";
  smoothing: OneEuroConfig;
}

export const DEFAULT_PERFORMER_CONFIG: PerformerConfig = {
  predictMs: 55,
  sensitivity: 0.5,
  cooldownMs: 70,
  striker: "index",
  smoothing: DEFAULT_ONE_EURO,
};

export interface HitEvent {
  zoneId: string;
  label: string;
  voice: VoiceKind;
  note?: string;
  velocity: number;
  /** performance.now() timestamp of the hit. */
  tMs: number;
  hand: "left" | "right";
}

/** Per-hand state the renderer draws. */
export interface HandState {
  slot: number;
  handedness: "left" | "right";
  present: boolean;
  /** Smoothed striker position in view space. */
  x: number;
  y: number;
  /** Predicted position actually used for hit testing. */
  px: number;
  py: number;
  speed: number;
  pinched: boolean;
  /** Raw landmarks for skeleton rendering. */
  landmarks: { x: number; y: number; z: number }[] | null;
}

const MAX_HANDS = 2;
const HIT_HISTORY = 128;
/** Downward speed (normalized units/sec) needed to register the softest hit. */
const MIN_STRIKE_SPEED = 0.35;
const MAX_STRIKE_SPEED = 3.2;
/** Vertical distance the striker must rise before a zone re-arms. */
const REARM_MARGIN = 0.035;
const PINCH_ON = 0.42;
const PINCH_OFF = 0.55;

interface HandSlot {
  handedness: "left" | "right";
  present: boolean;
  tip: SmoothedPoint;
  palm: SmoothedPoint;
  thumb: SmoothedPoint;
  pinched: boolean;
  landmarks: { x: number; y: number; z: number }[] | null;
  /** Per-zone arm/cooldown state, keyed by zone id. */
  zoneState: Map<string, ZoneState>;
}

interface ZoneState {
  armed: boolean;
  lastHitMs: number;
  /** For `cross` zones: which side of the string the striker was on. */
  side: number;
  /** For `hold`/`pinch` zones: whether this hand is currently sounding it. */
  holding: boolean;
}

export class Performer {
  private layout: Layout | null = null;
  private config: PerformerConfig = DEFAULT_PERFORMER_CONFIG;
  private slots: HandSlot[] = [];

  /** Ring buffer of recent hits, read by the coach panel at a low rate. */
  private history: HitEvent[] = [];

  /** zoneId -> performance.now() of last hit, read by the renderer for glow. */
  readonly zoneFlash = new Map<string, { tMs: number; velocity: number }>();

  /** Rolling stats surfaced in the HUD. */
  lastInferenceMs = 0;
  lastCaptureLatencyMs: number | null = null;
  fps = 0;
  private lastFrameMs = 0;

  /** Optional sink for hit events (used to feed the on-screen note ribbon). */
  onHit: ((hit: HitEvent) => void) | null = null;

  constructor(private engine: AudioEngine) {
    for (let i = 0; i < MAX_HANDS; i++) {
      this.slots.push({
        handedness: i === 0 ? "left" : "right",
        present: false,
        tip: new SmoothedPoint(),
        palm: new SmoothedPoint(),
        thumb: new SmoothedPoint(),
        pinched: false,
        landmarks: null,
        zoneState: new Map(),
      });
    }
  }

  setLayout(layout: Layout | null): void {
    // Release anything currently sounding before the zone map changes, or a
    // held pad would be orphaned with no way to stop it.
    this.engine.allNotesOff();
    for (const slot of this.slots) slot.zoneState.clear();
    this.zoneFlash.clear();
    this.layout = layout;
  }

  setConfig(config: PerformerConfig): void {
    this.config = config;
    for (const slot of this.slots) {
      slot.tip.setConfig(config.smoothing);
      slot.palm.setConfig(config.smoothing);
      slot.thumb.setConfig(config.smoothing);
    }
  }

  getConfig(): PerformerConfig {
    return this.config;
  }

  /** Snapshot for rendering. Allocates, so call it once per *draw*, not per hit. */
  getHandStates(): HandState[] {
    const predictSec = this.config.predictMs / 1000;
    return this.slots.map((slot, i) => {
      const p = this.strikerPoint(slot);
      return {
        slot: i,
        handedness: slot.handedness,
        present: slot.present,
        x: p.x,
        y: p.y,
        px: p.x + p.vx * predictSec,
        py: p.y + p.vy * predictSec,
        speed: p.speed,
        pinched: slot.pinched,
        landmarks: slot.landmarks,
      };
    });
  }

  /** Most recent hits, newest last. */
  getHistory(): readonly HitEvent[] {
    return this.history;
  }

  clearHistory(): void {
    this.history.length = 0;
  }

  /** Release everything — call when the camera stops. */
  panic(): void {
    this.engine.allNotesOff();
    for (const slot of this.slots) {
      slot.present = false;
      slot.tip.reset();
      slot.palm.reset();
      slot.thumb.reset();
      for (const state of slot.zoneState.values()) state.holding = false;
    }
  }

  // ------------------------------------------------------------------ hot path

  update(frame: FrameResult): void {
    this.lastInferenceMs = frame.inferenceMs;
    this.lastCaptureLatencyMs = frame.captureLatencyMs;
    if (this.lastFrameMs > 0) {
      const dt = frame.timestampMs - this.lastFrameMs;
      if (dt > 0) this.fps = this.fps * 0.9 + (1000 / dt) * 0.1;
    }
    this.lastFrameMs = frame.timestampMs;

    this.assignHands(frame.hands, frame.timestampMs);

    const layout = this.layout;
    if (!layout) return;

    const predictSec = this.config.predictMs / 1000;

    for (let s = 0; s < this.slots.length; s++) {
      const slot = this.slots[s];
      if (!slot.present) {
        // A hand that left the frame must not leave notes ringing.
        this.releaseAllHolds(slot, s);
        continue;
      }

      const point = this.strikerPoint(slot);
      const px = point.x + point.vx * predictSec;
      const py = point.y + point.vy * predictSec;

      for (const zone of layout.zones) {
        if (zone.hand !== "any" && zone.hand !== slot.handedness) continue;
        const state = this.zoneStateFor(slot, zone.id);

        switch (zone.trigger) {
          case "strike":
            this.updateStrike(zone, state, slot, s, px, py, point.vy, frame);
            break;
          case "cross":
            this.updateCross(zone, state, slot, s, px, py, point.vx, frame);
            break;
          case "hold":
            this.updateHold(zone, state, slot, s, px, py, false);
            break;
          case "pinch":
            this.updateHold(zone, state, slot, s, px, py, true);
            break;
        }
      }
    }
  }

  // ------------------------------------------------------------------ triggers

  private updateStrike(
    zone: Zone,
    state: ZoneState,
    slot: HandSlot,
    slotIndex: number,
    px: number,
    py: number,
    vy: number,
    frame: FrameResult,
  ): void {
    const b = zoneBounds(zone);
    const insideX = px >= b.left && px <= b.right;

    if (!insideX) {
      // Leaving sideways re-arms, so you can sweep across a kit and hit each
      // pad once rather than needing to lift between every drum.
      state.armed = true;
      return;
    }

    if (py < b.midY - REARM_MARGIN) {
      state.armed = true;
      return;
    }

    if (!state.armed) return;
    if (py < b.midY) return;
    if (py > b.bottom + 0.12) return; // far past the pad: not a strike

    const threshold = this.strikeThreshold();
    if (vy < threshold) return;
    if (frame.timestampMs - state.lastHitMs < this.config.cooldownMs) return;

    state.armed = false;
    state.lastHitMs = frame.timestampMs;

    const velocity = this.velocityCurve(vy, threshold);
    // Where along the pad you hit sets the timbre, like a real drum head.
    const tone = clamp01((px - b.left) / Math.max(1e-3, zone.w));
    this.fire(zone, slot, velocity, tone, frame.timestampMs);
  }

  private updateCross(
    zone: Zone,
    state: ZoneState,
    slot: HandSlot,
    slotIndex: number,
    px: number,
    py: number,
    vx: number,
    frame: FrameResult,
  ): void {
    const b = zoneBounds(zone);
    const insideY = py >= b.top && py <= b.bottom;
    const side = px < b.midX ? -1 : 1;

    if (!insideY) {
      state.side = side;
      return;
    }

    const crossed = state.side !== 0 && side !== state.side;
    state.side = side;
    if (!crossed) return;

    const speed = Math.abs(vx);
    const threshold = this.strikeThreshold() * 0.7; // strumming is gentler
    if (speed < threshold) return;
    if (frame.timestampMs - state.lastHitMs < this.config.cooldownMs) return;

    state.lastHitMs = frame.timestampMs;
    const velocity = this.velocityCurve(speed, threshold);
    // Height on the string sets brightness: near the bridge is brighter.
    const tone = 1 - clamp01((py - b.top) / Math.max(1e-3, zone.h));
    this.fire(zone, slot, velocity, tone, frame.timestampMs);
  }

  private updateHold(
    zone: Zone,
    state: ZoneState,
    slot: HandSlot,
    slotIndex: number,
    px: number,
    py: number,
    requirePinch: boolean,
  ): void {
    const b = zoneBounds(zone);
    const inside = px >= b.left && px <= b.right && py >= b.top && py <= b.bottom;
    const active = inside && (!requirePinch || slot.pinched);
    const key = holdKey(zone.id, slotIndex);

    if (active && !state.holding) {
      state.holding = true;
      this.engine.holdOn(key, zone.voice, {
        velocity: 0.8,
        note: zone.note,
        gain: zone.gain,
      });
      this.zoneFlash.set(zone.id, { tMs: performance.now(), velocity: 0.8 });
    } else if (!active && state.holding) {
      state.holding = false;
      this.engine.holdOff(key);
    } else if (active) {
      // Vertical position inside the zone opens the filter while you hold.
      const depth = 1 - clamp01((py - b.top) / Math.max(1e-3, zone.h));
      this.engine.holdModulate(key, depth);
    }
  }

  private fire(
    zone: Zone,
    slot: HandSlot,
    velocity: number,
    tone: number,
    tMs: number,
  ): void {
    this.engine.noteOn(zone.voice, {
      velocity,
      note: zone.note,
      gain: zone.gain,
      tone,
    });
    this.zoneFlash.set(zone.id, { tMs: performance.now(), velocity });

    const event: HitEvent = {
      zoneId: zone.id,
      label: zone.label,
      voice: zone.voice,
      note: zone.note,
      velocity,
      tMs,
      hand: slot.handedness,
    };
    this.history.push(event);
    if (this.history.length > HIT_HISTORY) this.history.shift();
    this.onHit?.(event);
  }

  // ------------------------------------------------------------------ helpers

  /** Sensitivity 1.0 -> easiest to trigger. */
  private strikeThreshold(): number {
    const s = clamp01(this.config.sensitivity);
    return MIN_STRIKE_SPEED + (1 - s) * 1.1;
  }

  /**
   * Map hand speed to note velocity. The curve is deliberately convex: soft
   * strokes stay soft (so ghost notes are possible) while the top of the range
   * compresses, which stops a single fast flail from being twice as loud as a
   * committed hit.
   */
  private velocityCurve(speed: number, threshold: number): number {
    const t = clamp01(
      (speed - threshold) / Math.max(0.1, MAX_STRIKE_SPEED - threshold),
    );
    return 0.32 + 0.68 * Math.pow(t, 0.65);
  }

  private strikerPoint(slot: HandSlot): SmoothedPoint {
    return this.config.striker === "palm" ? slot.palm : slot.tip;
  }

  private zoneStateFor(slot: HandSlot, zoneId: string): ZoneState {
    let state = slot.zoneState.get(zoneId);
    if (!state) {
      state = { armed: true, lastHitMs: 0, side: 0, holding: false };
      slot.zoneState.set(zoneId, state);
    }
    return state;
  }

  private releaseAllHolds(slot: HandSlot, slotIndex: number): void {
    for (const [zoneId, state] of slot.zoneState) {
      if (!state.holding) continue;
      state.holding = false;
      this.engine.holdOff(holdKey(zoneId, slotIndex));
    }
  }

  /**
   * Map detections to stable slots by handedness, so zone state (arm flags,
   * cooldowns) follows the same physical hand between frames. Without this,
   * a frame where MediaPipe reorders its output would scramble every zone's
   * armed state and drop hits.
   */
  private assignHands(hands: TrackedHand[], tMs: number): void {
    const claimed = [false, false];
    const assignment: (TrackedHand | null)[] = [null, null];

    for (const hand of hands) {
      const preferred = hand.handedness === "left" ? 0 : 1;
      if (!claimed[preferred]) {
        claimed[preferred] = true;
        assignment[preferred] = hand;
      } else {
        const other = preferred === 0 ? 1 : 0;
        if (!claimed[other]) {
          claimed[other] = true;
          assignment[other] = hand;
        }
      }
    }

    for (let i = 0; i < MAX_HANDS; i++) {
      const slot = this.slots[i];
      const hand = assignment[i];

      if (!hand) {
        if (slot.present) {
          slot.present = false;
          slot.tip.reset();
          slot.palm.reset();
          slot.thumb.reset();
          slot.landmarks = null;
        }
        continue;
      }

      slot.present = true;
      slot.handedness = hand.handedness;
      slot.landmarks = hand.landmarks;

      const lms = hand.landmarks;
      const tip = lms[LM.indexTip];
      const thumb = lms[LM.thumbTip];
      const wrist = lms[LM.wrist];
      const indexMcp = lms[LM.indexMcp];
      const pinkyMcp = lms[LM.pinkyMcp];

      slot.tip.update(tip.x, tip.y, tMs);
      slot.thumb.update(thumb.x, thumb.y, tMs);
      slot.palm.update(
        (wrist.x + indexMcp.x + pinkyMcp.x) / 3,
        (wrist.y + indexMcp.y + pinkyMcp.y) / 3,
        tMs,
      );

      // Normalize the pinch distance by hand size so it behaves the same
      // whether you are close to the camera or across the room.
      const palmSpan = Math.max(
        1e-3,
        Math.hypot(wrist.x - indexMcp.x, wrist.y - indexMcp.y),
      );
      const pinchDist =
        Math.hypot(tip.x - thumb.x, tip.y - thumb.y) / palmSpan;
      // Hysteresis: separate on/off thresholds stop a pinch held near the
      // boundary from stuttering the note on and off every frame.
      slot.pinched = slot.pinched
        ? pinchDist < PINCH_OFF
        : pinchDist < PINCH_ON;
    }
  }
}

function holdKey(zoneId: string, slotIndex: number): string {
  return `${zoneId}:${slotIndex}`;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
