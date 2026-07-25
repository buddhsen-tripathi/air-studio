import { NextResponse } from "next/server";
import type { AudioEngine } from "@/lib/audio/engine";
import { LayoutSchema, type Layout } from "@/lib/layout/types";
import {
  DEFAULT_PERFORMER_CONFIG,
  Performer,
  type PerformerConfig,
} from "@/lib/vision/performer";
import type { FrameResult, TrackedHand } from "@/lib/vision/handTracker";

/** Records what the engine was asked to play. */
function fakeEngine() {
  const hits: { voice: string; velocity: number }[] = [];
  const holds: string[] = [];
  const engine = {
    noteOn: (voice: string, opts: { velocity: number }) =>
      hits.push({ voice, velocity: opts.velocity }),
    holdOn: (key: string) => holds.push(`on:${key}`),
    holdOff: (key: string) => holds.push(`off:${key}`),
    holdModulate: () => {},
    allNotesOff: () => {},
  };
  return { engine: engine as unknown as AudioEngine, hits, holds };
}

const LAYOUT: Layout = LayoutSchema.parse({
  id: "test",
  name: "Test",
  key: "C",
  scale: "minor",
  tempo: 100,
  zones: [
    { id: "A", label: "A", x: 0.35, y: 0.6, w: 0.14, h: 0.2, voice: "snare", trigger: "strike" },
    { id: "B", label: "B", x: 0.55, y: 0.6, w: 0.14, h: 0.2, voice: "kick", trigger: "strike" },
  ],
});

/** Build a 21-landmark hand with the fingertips we care about placed exactly. */
function hand(tips: {
  index: [number, number];
  middle: [number, number];
  ring: [number, number];
  pinky: [number, number];
  thumb: [number, number];
}): TrackedHand {
  const lms = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const put = (i: number, p: [number, number]) => {
    lms[i] = { x: p[0], y: p[1], z: 0 };
  };
  put(0, [0.5, 0.95]); // wrist
  put(5, [0.45, 0.85]); // index MCP
  put(17, [0.55, 0.85]); // pinky MCP
  put(4, tips.thumb);
  put(8, tips.index);
  put(12, tips.middle);
  put(16, tips.ring);
  put(20, tips.pinky);
  return { handedness: "right", score: 1, landmarks: lms };
}

/** Drive the performer through a downward sweep and return the hits produced. */
function sweep(
  config: Partial<PerformerConfig>,
  xs: [number, number, number, number, number],
  fromY: number,
  toY: number,
  frames: number,
  startMs: number,
  performer: Performer,
) {
  // Natural fingertip length offsets, so tips do not all cross at once.
  const yOffsets = [0, 0.02, 0.035, 0.05, 0.015];
  for (let i = 0; i < frames; i++) {
    const t = i / (frames - 1);
    const base = fromY + (toY - fromY) * t;
    const frame: FrameResult = {
      hands: [
        hand({
          index: [xs[0], base + yOffsets[0]],
          middle: [xs[1], base + yOffsets[1]],
          ring: [xs[2], base + yOffsets[2]],
          pinky: [xs[3], base + yOffsets[3]],
          thumb: [xs[4], base + yOffsets[4]],
        }),
      ],
      timestampMs: startMs + i * 16,
      inferenceMs: 5,
      captureLatencyMs: null,
    };
    performer.update(frame);
  }
  return startMs + frames * 16;
}

/**
 * Behavioural regression check for the multi-finger trigger engine, driven by
 * synthetic landmark frames against a fake AudioEngine. Dev-only — this is a
 * test harness, not a product endpoint.
 *
 * Run: `curl localhost:3000/api/fingertest`
 */
export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Not found", { status: 404 });
  }

  const results: Record<string, unknown> = {};
  // predictMs 0 keeps the geometry deterministic for assertions.
  const base: PerformerConfig = {
    ...DEFAULT_PERFORMER_CONFIG,
    predictMs: 0,
    fingerCount: 5,
  };

  // --- 1. Open hand, all five fingers over ONE pad. Must fire exactly once.
  {
    const { engine, hits } = fakeEngine();
    const p = new Performer(engine);
    p.setConfig(base);
    p.setLayout(LAYOUT);
    sweep(base, [0.32, 0.35, 0.38, 0.40, 0.30], 0.25, 0.95, 16, 1000, p);
    results.oneZoneFiveFingers = {
      hits: hits.length,
      expected: 1,
      pass: hits.length === 1,
      voices: hits.map((h) => h.voice),
    };
  }

  // --- 2. Hand spread across TWO pads. Both must fire (a chord).
  {
    const { engine, hits } = fakeEngine();
    const p = new Performer(engine);
    p.setConfig(base);
    p.setLayout(LAYOUT);
    // index+middle+thumb over A, ring+pinky over B
    sweep(base, [0.32, 0.38, 0.52, 0.58, 0.30], 0.25, 0.95, 16, 1000, p);
    const voices = hits.map((h) => h.voice).sort();
    results.twoZonesChord = {
      hits: hits.length,
      expected: 2,
      pass: hits.length === 2 && voices.join(",") === "kick,snare",
      voices,
    };
  }

  // --- 3. Single-finger mode ignores the other fingertips.
  {
    const { engine, hits } = fakeEngine();
    const p = new Performer(engine);
    p.setConfig({ ...base, fingerCount: 1 });
    p.setLayout(LAYOUT);
    // index over A, everything else over B — only A should sound.
    sweep(base, [0.35, 0.52, 0.55, 0.58, 0.56], 0.25, 0.95, 16, 1000, p);
    results.singleFingerMode = {
      hits: hits.length,
      expected: 1,
      pass: hits.length === 1 && hits[0]?.voice === "snare",
      voices: hits.map((h) => h.voice),
    };
  }

  // --- 4. Lift and strike again: the pad must re-arm.
  {
    const { engine, hits } = fakeEngine();
    const p = new Performer(engine);
    p.setConfig(base);
    p.setLayout(LAYOUT);
    let t = sweep(base, [0.32, 0.35, 0.38, 0.40, 0.30], 0.25, 0.95, 16, 1000, p);
    t = sweep(base, [0.32, 0.35, 0.38, 0.40, 0.30], 0.95, 0.25, 16, t + 100, p);
    sweep(base, [0.32, 0.35, 0.38, 0.40, 0.30], 0.25, 0.95, 16, t + 100, p);
    results.liftAndRestrike = {
      hits: hits.length,
      expected: 2,
      pass: hits.length === 2,
    };
  }

  // --- 5. Palm mode still triggers.
  {
    const { engine, hits } = fakeEngine();
    const p = new Performer(engine);
    p.setConfig({ ...base, striker: "palm" });
    p.setLayout(LAYOUT);
    // Palm is the mean of wrist + index MCP + pinky MCP, which `hand()` pins
    // near x=0.5,y=0.88 — so drive a layout zone that the palm passes through.
    const wide = LayoutSchema.parse({
      ...LAYOUT,
      zones: [
        { id: "W", label: "W", x: 0.5, y: 0.5, w: 0.5, h: 0.4, voice: "tom", trigger: "strike" },
      ],
    });
    p.setLayout(wide);
    for (let i = 0; i < 16; i++) {
      const y = 0.2 + (0.75 * i) / 15;
      const lms = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
      lms[0] = { x: 0.5, y, z: 0 };
      lms[5] = { x: 0.45, y, z: 0 };
      lms[17] = { x: 0.55, y, z: 0 };
      lms[4] = { x: 0.4, y, z: 0 };
      lms[8] = { x: 0.5, y, z: 0 };
      lms[12] = { x: 0.52, y, z: 0 };
      lms[16] = { x: 0.54, y, z: 0 };
      lms[20] = { x: 0.56, y, z: 0 };
      p.update({
        hands: [{ handedness: "right", score: 1, landmarks: lms }],
        timestampMs: 1000 + i * 16,
        inferenceMs: 5,
        captureLatencyMs: null,
      });
    }
    results.palmMode = {
      hits: hits.length,
      expected: 1,
      pass: hits.length === 1,
    };
  }

  // --- 6. The case that per-finger cooldown could NOT catch.
  //
  // A steeply tilted hand spreads its fingertips ~0.18 vertically. Struck at a
  // deliberate (not fast) speed, the tips cross the trigger line far further
  // apart than any sane retrigger gap, so per-finger cooldown would let several
  // through as a flam. Per-(zone,hand) arming collapses them to one hit.
  {
    const { engine, hits } = fakeEngine();
    const p = new Performer(engine);
    p.setConfig(base);
    p.setLayout(LAYOUT);

    const tilt = [0, 0.045, 0.09, 0.135, 0.18]; // fingertips down a steep rake
    const xs = [0.32, 0.35, 0.38, 0.4, 0.3];
    const frames = 40;
    const fromY = 0.2;
    const toY = 0.95;
    const dtMs = 16;
    for (let i = 0; i < frames; i++) {
      const y = fromY + ((toY - fromY) * i) / (frames - 1);
      p.update({
        hands: [
          hand({
            index: [xs[0], y + tilt[0]],
            middle: [xs[1], y + tilt[1]],
            ring: [xs[2], y + tilt[2]],
            pinky: [xs[3], y + tilt[3]],
            thumb: [xs[4], y + tilt[4]],
          }),
        ],
        timestampMs: 1000 + i * dtMs,
        inferenceMs: 5,
        captureLatencyMs: null,
      });
    }

    const speed = (toY - fromY) / ((frames * dtMs) / 1000);
    const spreadMs = Math.round((0.18 / speed) * 1000);
    results.tiltedHandSlowStrike = {
      hits: hits.length,
      expected: 1,
      pass: hits.length === 1,
      handSpeedUnitsPerSec: Math.round(speed * 100) / 100,
      fingerCrossingSpreadMs: spreadMs,
      cooldownMs: base.cooldownMs,
      note: `tips cross ${spreadMs}ms apart vs a ${base.cooldownMs}ms cooldown — cooldown alone would not collapse these`,
    };
  }

  const all = Object.values(results) as { pass: boolean }[];
  return NextResponse.json({
    allPassed: all.every((r) => r.pass),
    results,
  });
}
