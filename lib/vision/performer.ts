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
 *
 * EVERY FINGER PLAYS. Each fingertip is an independent striker, so you can hold
 * a chord across four keys and strike them together, or drum with two fingers.
 * The subtlety that makes this work is in how arming is scoped — see
 * `updateStrike`.
 */

/** Striker order. `fingerCount` takes a prefix of this list. */
export const FINGER_NAMES = [
  "index",
  "middle",
  "ring",
  "pinky",
  "thumb",
] as const;
export type FingerName = (typeof FINGER_NAMES)[number];

const FINGER_LANDMARKS = [
  LM.indexTip,
  LM.middleTip,
  LM.ringTip,
  LM.pinkyTip,
  LM.thumbTip,
];
/** Middle joint of each finger, in the same order — used for curl detection. */
const FINGER_JOINTS = [
  LM.indexPip,
  LM.middlePip,
  LM.ringPip,
  LM.pinkyPip,
  LM.thumbIp,
];
const FINGER_COUNT = FINGER_NAMES.length;
/** Thumb is the last entry and needs a different curl test. */
const THUMB_INDEX = 4;

export interface PerformerConfig {
  /**
   * Milliseconds of forward prediction. We extrapolate each striker along its
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
  /** Strike with the fingertips, or with a single point at the palm centre. */
  striker: "fingers" | "palm";
  /**
   * How many fingertips are live, taking a prefix of FINGER_NAMES:
   * 1 = index only, 2 = +middle, 3 = +ring, 4 = +pinky, 5 = +thumb.
   */
  fingerCount: number;
  /**
   * Only extended fingers can trigger. This is what makes playing a *gesture*
   * rather than a matter of presence: a relaxed or curled hand drifting over a
   * pad does nothing, and you choose which fingers are live by extending them.
   */
  requireExtendedFingers: boolean;
  /**
   * Which motion counts as a strike.
   *
   * - `hand`   absolute fingertip velocity. Air-drumming: the whole arm swings.
   * - `finger` fingertip velocity *relative to the palm*. Piano-style: the hand
   *            hovers still and individual fingers press, so you can hold a
   *            chord shape and play notes independently.
   * - `either` whichever is greater. Supports both without switching modes.
   */
  strikeMotion: "hand" | "finger" | "either";
  /**
   * Who decides what a hit sounds like.
   *
   * - `direct`   the Performer sounds the zone's own note. Free-play / practice.
   * - `external` the Performer emits the hit but stays silent, leaving the
   *              caller to sound it.
   *
   * `external` exists for Magic Piano semantics in the duel game: the chart
   * owns the pitch, not the zone, so the judge looks up whichever note was
   * scheduled for that lane and plays *that*. The judge runs synchronously in
   * this same frame callback, so the note still reaches the sound card in the
   * tick it was detected — the hot path is unchanged.
   */
  audioMode: "direct" | "external";
  smoothing: OneEuroConfig;
}

export const DEFAULT_PERFORMER_CONFIG: PerformerConfig = {
  // Front-run the camera pipeline harder. 55ms cancelled roughly half of a
  // typical webcam's capture+decode+inference latency; 95ms cancels most of it.
  // This does not remove latency, it fires on where your hand is heading — so
  // the sound lands when the stroke *feels* like it arrived.
  predictMs: 95,
  // A strike is recognised earlier in the stroke rather than at full speed,
  // which shaves real milliseconds off the moment of detection.
  sensitivity: 0.72,
  cooldownMs: 55,
  striker: "fingers",
  fingerCount: FINGER_COUNT,
  requireExtendedFingers: true,
  strikeMotion: "either",
  audioMode: "direct",
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
  /** Which fingertip actually landed the hit. */
  finger: FingerName | "palm";
}

/** One striker's drawable state. */
export interface StrikerState {
  name: FingerName | "palm";
  x: number;
  y: number;
  /** Predicted position actually used for hit testing. */
  px: number;
  py: number;
  speed: number;
  /** Whether the finger is extended, i.e. currently able to trigger. */
  extended: boolean;
  /** Whether this striker can fire right now (extension gate applied). */
  armedToPlay: boolean;
}

/** Per-hand state the renderer draws. */
export interface HandState {
  slot: number;
  handedness: "left" | "right";
  present: boolean;
  pinched: boolean;
  strikers: StrikerState[];
  /** Raw landmarks for skeleton rendering. */
  landmarks: { x: number; y: number; z: number }[] | null;
}

const MAX_HANDS = 2;
const HIT_HISTORY = 128;
/** Downward speed (normalized units/sec) needed to register the softest hit. */
const MIN_STRIKE_SPEED = 0.35;
const MAX_STRIKE_SPEED = 3.2;
/** Vertical distance a striker must rise before a zone re-arms. */
const REARM_MARGIN = 0.035;
const PINCH_ON = 0.42;
const PINCH_OFF = 0.55;
/**
 * Finger-extension thresholds, as the ratio of tip-to-wrist distance over
 * joint-to-wrist distance. An extended finger measures ~1.5-1.8; a curled one
 * drops below 1.0 because the tip folds back toward the palm. Separate on/off
 * values stop a half-curled finger from flickering in and out of play.
 */
const EXTEND_ON = 1.18;
const EXTEND_OFF = 1.04;

interface HandSlot {
  handedness: "left" | "right";
  present: boolean;
  /** One smoothed point per fingertip, indexed by FINGER_NAMES. */
  fingers: SmoothedPoint[];
  /** Whether each finger is currently extended, with hysteresis applied. */
  extended: boolean[];
  palm: SmoothedPoint;
  pinched: boolean;
  landmarks: { x: number; y: number; z: number }[] | null;
  /**
   * Arm/cooldown state per zone, per HAND — deliberately not per finger.
   * See `updateStrike` for why.
   */
  zoneState: Map<string, ZoneState>;
}

interface ZoneState {
  armed: boolean;
  lastHitMs: number;
  /** For `cross` zones: which side of the string the hand was on. */
  side: number;
  /** For `hold`/`pinch` zones: whether this hand is currently sounding it. */
  holding: boolean;
}

/** Scratch object reused every frame so the hot path allocates nothing. */
interface StrikeProbe {
  /** Whether any live striker is past the trigger line at all. */
  hasHit: boolean;
  /** Highest downward velocity among strikers past the trigger line. */
  bestVy: number;
  /** Predicted x of that striker, for timbre. */
  bestX: number;
  /** Finger index, or -1 when striking with the palm. */
  bestFinger: number;
  /** True if every live striker is above the line or outside the zone. */
  allClear: boolean;
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

  /** Reused scratch, never escapes the frame. */
  private probe: StrikeProbe = {
    hasHit: false,
    bestVy: 0,
    bestX: 0,
    bestFinger: -1,
    allClear: true,
  };

  /** Optional sink for hit events (used to feed the on-screen note ribbon). */
  onHit: ((hit: HitEvent) => void) | null = null;

  constructor(private engine: AudioEngine) {
    for (let i = 0; i < MAX_HANDS; i++) {
      const fingers: SmoothedPoint[] = [];
      for (let f = 0; f < FINGER_COUNT; f++) fingers.push(new SmoothedPoint());
      this.slots.push({
        handedness: i === 0 ? "left" : "right",
        present: false,
        fingers,
        extended: new Array(FINGER_COUNT).fill(true),
        palm: new SmoothedPoint(),
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
    this.config = {
      ...config,
      fingerCount: Math.max(1, Math.min(FINGER_COUNT, config.fingerCount)),
    };
    for (const slot of this.slots) {
      for (const finger of slot.fingers) finger.setConfig(config.smoothing);
      slot.palm.setConfig(config.smoothing);
    }
  }

  getConfig(): PerformerConfig {
    return this.config;
  }

  /** Snapshot for rendering. Allocates, so call it once per *draw*, not per hit. */
  getHandStates(): HandState[] {
    const predictSec = this.config.predictMs / 1000;
    const usePalm = this.config.striker === "palm";
    const live = usePalm ? 1 : this.config.fingerCount;

    return this.slots.map((slot, i) => {
      const strikers: StrikerState[] = [];
      for (let f = 0; f < live; f++) {
        const point = usePalm ? slot.palm : slot.fingers[f];
        const extended = usePalm ? true : slot.extended[f];
        strikers.push({
          name: usePalm ? "palm" : FINGER_NAMES[f],
          x: point.x,
          y: point.y,
          px: point.x + point.vx * predictSec,
          py: point.y + point.vy * predictSec,
          speed: point.speed,
          extended,
          armedToPlay: this.canStrike(slot, f, usePalm),
        });
      }
      return {
        slot: i,
        handedness: slot.handedness,
        present: slot.present,
        pinched: slot.pinched,
        strikers,
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
      for (const finger of slot.fingers) finger.reset();
      slot.palm.reset();
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

    for (let s = 0; s < this.slots.length; s++) {
      const slot = this.slots[s];
      if (!slot.present) {
        // A hand that left the frame must not leave notes ringing.
        this.releaseAllHolds(slot, s);
        continue;
      }

      const live = this.liveStrikerCount();

      for (const zone of layout.zones) {
        if (zone.hand !== "any" && zone.hand !== slot.handedness) continue;
        const state = this.zoneStateFor(slot, zone.id);

        switch (zone.trigger) {
          case "strike":
            this.updateStrike(zone, state, slot, s, live, frame);
            break;
          case "cross":
            this.updateCross(zone, state, slot, s, live, frame);
            break;
          case "hold":
            this.updateHold(zone, state, slot, s, live, false);
            break;
          case "pinch":
            this.updateHold(zone, state, slot, s, live, true);
            break;
        }
      }
    }
  }

  // ------------------------------------------------------------------ triggers

  /**
   * Strike detection across every live fingertip.
   *
   * The important design decision is that ARMING IS PER (ZONE, HAND), not per
   * finger, while TRIGGERING is per finger. Any fingertip crossing the line can
   * fire the pad, but once it fires, the pad is disarmed for that whole hand
   * until *every* live finger has lifted back above it.
   *
   * Without that, an open hand sweeping down through one pad fires it five
   * times in a row — each fingertip crosses a few tens of milliseconds apart, so
   * a per-finger cooldown wouldn't catch it either. It would sound like a flam
   * instead of a hit.
   *
   * Chords still work, because separate zones keep separate state: index over C
   * and ring over E strike independently.
   */
  private updateStrike(
    zone: Zone,
    state: ZoneState,
    slot: HandSlot,
    slotIndex: number,
    live: number,
    frame: FrameResult,
  ): void {
    const b = zoneBounds(zone);
    const probe = this.probeStrike(
      slot,
      live,
      b.left,
      b.right,
      b.midY,
      b.bottom,
    );

    // Every live finger is clear of the pad: re-arm it. Leaving sideways counts,
    // so you can sweep across a kit and hit each pad once rather than needing to
    // lift between every drum.
    if (probe.allClear) {
      state.armed = true;
      return;
    }

    if (!state.armed) return;
    if (!probe.hasHit) return;

    const threshold = this.strikeThreshold();
    if (probe.bestVy < threshold) return;
    if (frame.timestampMs - state.lastHitMs < this.config.cooldownMs) return;

    state.armed = false;
    state.lastHitMs = frame.timestampMs;

    const velocity = this.velocityCurve(probe.bestVy, threshold);
    // Where along the pad you hit sets the timbre, like a real drum head.
    const tone = clamp01((probe.bestX - b.left) / Math.max(1e-3, zone.w));
    this.fire(zone, slot, velocity, tone, frame.timestampMs, probe.bestFinger);
  }

  /**
   * Scan the live strikers once, recording the fastest one past the trigger
   * line and whether the pad is fully clear. Writes into reusable scratch so
   * the hot path stays allocation-free.
   */
  private probeStrike(
    slot: HandSlot,
    live: number,
    left: number,
    right: number,
    midY: number,
    bottom: number,
  ): StrikeProbe {
    const probe = this.probe;
    probe.hasHit = false;
    probe.bestVy = -Infinity;
    probe.bestX = 0;
    probe.bestFinger = -1;
    probe.allClear = true;

    const predictSec = this.config.predictMs / 1000;
    const usePalm = this.config.striker === "palm";

    for (let f = 0; f < live; f++) {
      const point = usePalm ? slot.palm : slot.fingers[f];
      if (!point.live) continue;
      // A curled finger is not playing. Skipping it here also keeps it out of
      // the `allClear` test, so a folded finger resting on a pad neither fires
      // it nor blocks it from re-arming.
      if (!this.canStrike(slot, f, usePalm)) continue;

      const px = point.x + point.vx * predictSec;
      const py = point.y + point.vy * predictSec;

      const insideX = px >= left && px <= right;
      if (!insideX) continue;

      // Still within re-arm range of the line, so the pad is not clear yet.
      if (py >= midY - REARM_MARGIN) probe.allClear = false;

      if (py < midY) continue;
      if (py > bottom + 0.12) continue; // far past the pad: not a strike

      const vy = this.strikeVelocity(point.vy, slot.palm.vy, usePalm);
      if (vy > probe.bestVy) {
        probe.hasHit = true;
        probe.bestVy = vy;
        probe.bestX = px;
        probe.bestFinger = usePalm ? -1 : f;
      }
    }

    return probe;
  }

  /** Recompute per-finger extension with hysteresis. */
  private updateExtension(
    slot: HandSlot,
    lms: { x: number; y: number }[],
    wrist: { x: number; y: number },
    pinkyMcp: { x: number; y: number },
  ): void {
    for (let f = 0; f < FINGER_COUNT; f++) {
      const ratio = fingerExtensionRatio(lms, f, wrist, pinkyMcp);
      slot.extended[f] = slot.extended[f]
        ? ratio > EXTEND_OFF
        : ratio > EXTEND_ON;
    }
  }

  /** Whether a striker is currently allowed to fire. */
  private canStrike(slot: HandSlot, finger: number, usePalm: boolean): boolean {
    if (usePalm) return true;
    if (!this.config.requireExtendedFingers) return true;
    return slot.extended[finger] === true;
  }

  /**
   * Velocity that counts as a strike, per `strikeMotion`.
   *
   * Subtracting palm velocity is what lets you keep a hand still over a chord
   * and press one finger: whole-hand drift cancels out, so only the finger's
   * own movement registers.
   */
  private strikeVelocity(
    tipV: number,
    palmV: number,
    usePalm: boolean,
  ): number {
    if (usePalm) return tipV;
    switch (this.config.strikeMotion) {
      case "hand":
        return tipV;
      case "finger":
        return tipV - palmV;
      default:
        return Math.max(tipV, tipV - palmV);
    }
  }

  private updateCross(
    zone: Zone,
    state: ZoneState,
    slot: HandSlot,
    slotIndex: number,
    live: number,
    frame: FrameResult,
  ): void {
    const b = zoneBounds(zone);
    const predictSec = this.config.predictMs / 1000;
    const usePalm = this.config.striker === "palm";

    // A spread hand sweeping through a string should pluck it once, not once
    // per finger, so side tracking uses the hand's mean x. Velocity still comes
    // from the fastest finger.
    let sumX = 0;
    let counted = 0;
    let maxSpeed = 0;
    let anyInsideY = false;
    let toneY = b.top;
    let fastestFinger = -1;

    for (let f = 0; f < live; f++) {
      const point = usePalm ? slot.palm : slot.fingers[f];
      if (!point.live) continue;
      if (!this.canStrike(slot, f, usePalm)) continue;

      const px = point.x + point.vx * predictSec;
      const py = point.y + point.vy * predictSec;
      sumX += px;
      counted++;

      if (py < b.top || py > b.bottom) continue;
      anyInsideY = true;
      const speed = Math.abs(
        this.strikeVelocity(point.vx, slot.palm.vx, usePalm),
      );
      if (speed > maxSpeed) {
        maxSpeed = speed;
        toneY = py;
        fastestFinger = usePalm ? -1 : f;
      }
    }

    if (counted === 0) return;

    const meanX = sumX / counted;
    const side = meanX < b.midX ? -1 : 1;

    if (!anyInsideY) {
      // Keep tracking which side the hand is on, so re-entering the string's
      // vertical span doesn't register as a phantom crossing.
      state.side = side;
      return;
    }

    const crossed = state.side !== 0 && side !== state.side;
    state.side = side;
    if (!crossed) return;

    const threshold = this.strikeThreshold() * 0.7; // strumming is gentler
    if (maxSpeed < threshold) return;
    if (frame.timestampMs - state.lastHitMs < this.config.cooldownMs) return;

    state.lastHitMs = frame.timestampMs;
    const velocity = this.velocityCurve(maxSpeed, threshold);
    // Height on the string sets brightness: near the bridge is brighter.
    const tone = 1 - clamp01((toneY - b.top) / Math.max(1e-3, zone.h));
    this.fire(zone, slot, velocity, tone, frame.timestampMs, fastestFinger);
  }

  private updateHold(
    zone: Zone,
    state: ZoneState,
    slot: HandSlot,
    slotIndex: number,
    live: number,
    requirePinch: boolean,
  ): void {
    const b = zoneBounds(zone);
    const predictSec = this.config.predictMs / 1000;
    const usePalm = this.config.striker === "palm";

    // One voice per zone per hand: resting three fingers in a pad should sound
    // one note, not three. Any finger inside sustains it.
    let inside = false;
    let depthSum = 0;
    let depthCount = 0;

    for (let f = 0; f < live; f++) {
      const point = usePalm ? slot.palm : slot.fingers[f];
      if (!point.live) continue;
      // Holding a pad is also a deliberate act: a curled finger inside it
      // should not sustain a note.
      if (!this.canStrike(slot, f, usePalm)) continue;

      const px = point.x + point.vx * predictSec;
      const py = point.y + point.vy * predictSec;
      if (px < b.left || px > b.right || py < b.top || py > b.bottom) continue;

      inside = true;
      depthSum += 1 - clamp01((py - b.top) / Math.max(1e-3, zone.h));
      depthCount++;
    }

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
    } else if (active && depthCount > 0) {
      // Vertical position inside the zone opens the filter while you hold.
      this.engine.holdModulate(key, depthSum / depthCount);
    }
  }

  private fire(
    zone: Zone,
    slot: HandSlot,
    velocity: number,
    tone: number,
    tMs: number,
    finger: number,
  ): void {
    // In `external` mode the caller sounds the hit instead — see `audioMode`.
    if (this.config.audioMode === "direct") {
      this.engine.noteOn(zone.voice, {
        velocity,
        note: zone.note,
        gain: zone.gain,
        tone,
      });
    }
    this.zoneFlash.set(zone.id, { tMs: performance.now(), velocity });

    const event: HitEvent = {
      zoneId: zone.id,
      label: zone.label,
      voice: zone.voice,
      note: zone.note,
      velocity,
      tMs,
      hand: slot.handedness,
      finger: finger >= 0 ? FINGER_NAMES[finger] : "palm",
    };
    this.history.push(event);
    if (this.history.length > HIT_HISTORY) this.history.shift();
    this.onHit?.(event);
  }

  // ------------------------------------------------------------------ helpers

  private liveStrikerCount(): number {
    return this.config.striker === "palm" ? 1 : this.config.fingerCount;
  }

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
          for (const finger of slot.fingers) finger.reset();
          slot.palm.reset();
          slot.landmarks = null;
        }
        continue;
      }

      slot.present = true;
      slot.handedness = hand.handedness;
      slot.landmarks = hand.landmarks;

      const lms = hand.landmarks;
      for (let f = 0; f < FINGER_COUNT; f++) {
        const point = lms[FINGER_LANDMARKS[f]];
        if (point) slot.fingers[f].update(point.x, point.y, tMs);
      }

      const wrist = lms[LM.wrist];
      const indexMcp = lms[LM.indexMcp];
      const pinkyMcp = lms[LM.pinkyMcp];

      this.updateExtension(slot, lms, wrist, pinkyMcp);

      slot.palm.update(
        (wrist.x + indexMcp.x + pinkyMcp.x) / 3,
        (wrist.y + indexMcp.y + pinkyMcp.y) / 3,
        tMs,
      );

      // Normalize the pinch distance by hand size so it behaves the same
      // whether you are close to the camera or across the room.
      const tip = lms[LM.indexTip];
      const thumb = lms[LM.thumbTip];
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

/**
 * Decide which fingers are extended.
 *
 * A finger is extended when its tip is further from the wrist than its middle
 * joint is; curl it and the tip folds back toward the palm, inverting that.
 * Using a *ratio* of the two distances makes the test scale-free, so it behaves
 * identically whether the hand is close to the camera or across the room, and
 * it needs no depth information.
 *
 * The thumb folds sideways rather than inward, so it is measured against the
 * pinky knuckle instead of the wrist.
 */
function fingerExtensionRatio(
  lms: { x: number; y: number }[],
  finger: number,
  wrist: { x: number; y: number },
  pinkyMcp: { x: number; y: number },
): number {
  const tip = lms[FINGER_LANDMARKS[finger]];
  const joint = lms[FINGER_JOINTS[finger]];
  if (!tip || !joint) return 0;

  const anchor = finger === THUMB_INDEX ? pinkyMcp : wrist;
  const jointDist = Math.hypot(joint.x - anchor.x, joint.y - anchor.y);
  if (jointDist < 1e-4) return 0;
  return Math.hypot(tip.x - anchor.x, tip.y - anchor.y) / jointDist;
}

function holdKey(zoneId: string, slotIndex: number): string {
  return `${zoneId}:${slotIndex}`;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Exported for the settings UI. */
export const MAX_FINGERS = FINGER_COUNT;
