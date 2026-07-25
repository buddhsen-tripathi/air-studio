import { NextResponse } from "next/server";
import type { AudioEngine } from "@/lib/audio/engine";
import { LayoutSchema, type Layout } from "@/lib/layout/types";
import {
  DEFAULT_PERFORMER_CONFIG,
  Performer,
  type PerformerConfig,
} from "@/lib/vision/performer";
import type { FrameResult, TrackedHand } from "@/lib/vision/handTracker";

/**
 * Behavioural regression check for the multi-finger trigger engine, driven by
 * synthetic landmark frames against a fake AudioEngine. Dev-only — this is a
 * test harness, not a product endpoint.
 *
 * Run: `curl localhost:3000/api/fingertest`
 */

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

type Pt = [number, number];

/**
 * Build a 21-landmark hand.
 *
 * Finger joints are synthesised from the tip so extension is modelled honestly:
 * an extended finger's PIP sits partway between the anchor and the tip (ratio
 * ~1.8), a curled one's sits beyond it (ratio ~0.7). That is exactly the
 * geometry `fingerExtensionRatio` measures.
 */
function makeHand(opts: {
  /** Vertical position of the wrist; the knuckles track just above it. */
  palmY: number;
  /** Fingertips in engine order: index, middle, ring, pinky, thumb. */
  tips: [Pt, Pt, Pt, Pt, Pt];
  extended: [boolean, boolean, boolean, boolean, boolean];
  /** Defaults to "right"; set explicitly when testing two hands at once. */
  handedness?: "left" | "right";
}): TrackedHand {
  const lms = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const put = (i: number, p: Pt) => {
    lms[i] = { x: p[0], y: p[1], z: 0 };
  };

  const wrist: Pt = [0.5, opts.palmY];
  const indexMcp: Pt = [0.45, opts.palmY - 0.08];
  const pinkyMcp: Pt = [0.55, opts.palmY - 0.08];
  put(0, wrist);
  put(5, indexMcp);
  put(17, pinkyMcp);

  const TIP_LM = [8, 12, 16, 20, 4];
  const JOINT_LM = [6, 10, 14, 18, 3];

  for (let f = 0; f < 5; f++) {
    const tip = opts.tips[f];
    // The thumb is measured against the pinky knuckle, not the wrist.
    const anchor = f === 4 ? pinkyMcp : wrist;
    const t = opts.extended[f] ? 0.55 : 1.45;
    put(TIP_LM[f], tip);
    put(JOINT_LM[f], [
      anchor[0] + (tip[0] - anchor[0]) * t,
      anchor[1] + (tip[1] - anchor[1]) * t,
    ]);
  }

  return {
    handedness: opts.handedness ?? "right",
    score: 1,
    landmarks: lms,
  };
}

const ALL_EXTENDED: [boolean, boolean, boolean, boolean, boolean] = [
  true,
  true,
  true,
  true,
  true,
];

interface SweepOpts {
  xs: [number, number, number, number, number];
  fromY: number;
  toY: number;
  frames?: number;
  startMs?: number;
  extended?: [boolean, boolean, boolean, boolean, boolean];
  /** Natural fingertip length offsets, so tips don't all cross at once. */
  yOffsets?: [number, number, number, number, number];
  /** When false, the palm stays put and only the fingertips travel. */
  movePalm?: boolean;
}

function sweep(performer: Performer, o: SweepOpts): number {
  const frames = o.frames ?? 16;
  const startMs = o.startMs ?? 1000;
  const extended = o.extended ?? ALL_EXTENDED;
  const yOffsets = o.yOffsets ?? [0, 0.02, 0.035, 0.05, 0.015];
  const movePalm = o.movePalm ?? true;

  for (let i = 0; i < frames; i++) {
    const t = i / (frames - 1);
    const base = o.fromY + (o.toY - o.fromY) * t;
    performer.update({
      hands: [
        makeHand({
          palmY: movePalm ? base + 0.35 : 0.95,
          tips: [
            [o.xs[0], base + yOffsets[0]],
            [o.xs[1], base + yOffsets[1]],
            [o.xs[2], base + yOffsets[2]],
            [o.xs[3], base + yOffsets[3]],
            [o.xs[4], base + yOffsets[4]],
          ],
          extended,
        }),
      ],
      timestampMs: startMs + i * 16,
      inferenceMs: 5,
      captureLatencyMs: null,
    } satisfies FrameResult);
  }
  return startMs + frames * 16;
}

function fresh(config: PerformerConfig, layout: Layout = LAYOUT) {
  const { engine, hits } = fakeEngine();
  const p = new Performer(engine);
  p.setConfig(config);
  p.setLayout(layout);
  return { p, hits };
}

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
  const OVER_A: [number, number, number, number, number] = [
    0.32, 0.35, 0.38, 0.4, 0.3,
  ];

  // --- 1. Open hand, all five fingers over ONE pad. Must fire exactly once.
  {
    const { p, hits } = fresh(base);
    sweep(p, { xs: OVER_A, fromY: 0.25, toY: 0.95 });
    results.oneZoneFiveFingers = {
      hits: hits.length,
      expected: 1,
      pass: hits.length === 1,
    };
  }

  // --- 2. Hand spread across TWO pads. Both must fire (a chord).
  {
    const { p, hits } = fresh(base);
    sweep(p, { xs: [0.32, 0.38, 0.52, 0.58, 0.3], fromY: 0.25, toY: 0.95 });
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
    const { p, hits } = fresh({ ...base, fingerCount: 1 });
    sweep(p, { xs: [0.35, 0.52, 0.55, 0.58, 0.56], fromY: 0.25, toY: 0.95 });
    results.singleFingerMode = {
      hits: hits.length,
      expected: 1,
      pass: hits.length === 1 && hits[0]?.voice === "snare",
    };
  }

  // --- 4. Lift and strike again: the pad must re-arm.
  {
    const { p, hits } = fresh(base);
    let t = sweep(p, { xs: OVER_A, fromY: 0.25, toY: 0.95 });
    t = sweep(p, { xs: OVER_A, fromY: 0.95, toY: 0.25, startMs: t + 100 });
    sweep(p, { xs: OVER_A, fromY: 0.25, toY: 0.95, startMs: t + 100 });
    results.liftAndRestrike = {
      hits: hits.length,
      expected: 2,
      pass: hits.length === 2,
    };
  }

  // --- 5. Palm mode still triggers.
  {
    const wide = LayoutSchema.parse({
      ...LAYOUT,
      zones: [
        { id: "W", label: "W", x: 0.5, y: 0.5, w: 0.5, h: 0.4, voice: "tom", trigger: "strike" },
      ],
    });
    const { p, hits } = fresh({ ...base, striker: "palm" }, wide);
    // Palm tracks the knuckles, so a whole-hand descent moves it through W.
    sweep(p, { xs: [0.5, 0.52, 0.54, 0.56, 0.48], fromY: -0.15, toY: 0.5 });
    results.palmMode = {
      hits: hits.length,
      expected: 1,
      pass: hits.length === 1,
    };
  }

  // --- 6. The flam case per-finger cooldown could NOT catch.
  {
    const { p, hits } = fresh(base);
    const tilt: [number, number, number, number, number] = [
      0, 0.045, 0.09, 0.135, 0.18,
    ];
    const frames = 40;
    sweep(p, {
      xs: OVER_A,
      fromY: 0.2,
      toY: 0.95,
      frames,
      yOffsets: tilt,
    });
    const speed = 0.75 / ((frames * 16) / 1000);
    const spreadMs = Math.round((0.18 / speed) * 1000);
    results.tiltedHandSlowStrike = {
      hits: hits.length,
      expected: 1,
      pass: hits.length === 1,
      note: `tips cross ${spreadMs}ms apart vs a ${base.cooldownMs}ms cooldown`,
    };
  }

  // --- 7. Curled fingers are silent. A relaxed hand passing over a pad plays
  //        nothing, which is the whole point of the extension gate.
  {
    const { p, hits } = fresh(base);
    sweep(p, {
      xs: OVER_A,
      fromY: 0.25,
      toY: 0.95,
      extended: [false, false, false, false, false],
    });
    results.curledHandSilent = {
      hits: hits.length,
      expected: 0,
      pass: hits.length === 0,
    };
  }

  // --- 8. Extending only the index selects which finger plays.
  {
    const { p, hits } = fresh(base);
    // Index over A (extended), everything else over B (curled).
    sweep(p, {
      xs: [0.35, 0.52, 0.55, 0.58, 0.56],
      fromY: 0.25,
      toY: 0.95,
      extended: [true, false, false, false, false],
    });
    results.onlyExtendedFingerPlays = {
      hits: hits.length,
      expected: 1,
      pass: hits.length === 1 && hits[0]?.voice === "snare",
      voices: hits.map((h) => h.voice),
    };
  }

  // --- 9. The gate can be turned off.
  {
    const { p, hits } = fresh({ ...base, requireExtendedFingers: false });
    sweep(p, {
      xs: OVER_A,
      fromY: 0.25,
      toY: 0.95,
      extended: [false, false, false, false, false],
    });
    results.gateDisabledCurledPlays = {
      hits: hits.length,
      expected: 1,
      pass: hits.length === 1,
    };
  }

  // --- 10. strikeMotion "finger": moving the WHOLE hand must not trigger.
  {
    const { p, hits } = fresh({ ...base, strikeMotion: "finger" });
    sweep(p, { xs: OVER_A, fromY: 0.25, toY: 0.95, movePalm: true });
    results.fingerModeIgnoresHandMotion = {
      hits: hits.length,
      expected: 0,
      pass: hits.length === 0,
    };
  }

  // --- 11. strikeMotion "finger": a press with the hand held still DOES fire.
  {
    const { p, hits } = fresh({ ...base, strikeMotion: "finger" });
    sweep(p, { xs: OVER_A, fromY: 0.25, toY: 0.95, movePalm: false });
    results.fingerModePressFires = {
      hits: hits.length,
      expected: 1,
      pass: hits.length === 1,
    };
  }

  // --- 12. strikeMotion "hand": whole-hand strokes still work.
  {
    const { p, hits } = fresh({ ...base, strikeMotion: "hand" });
    sweep(p, { xs: OVER_A, fromY: 0.25, toY: 0.95, movePalm: true });
    results.handModeStrokeFires = {
      hits: hits.length,
      expected: 1,
      pass: hits.length === 1,
    };
  }

  // --- 13. fingerCount is PER HAND, not global.
  //
  // In single-finger mode the duel still has to register the index finger of
  // BOTH hands — otherwise two-lane chords become unplayable and the left hand
  // is dead weight. `live` is computed inside the per-slot loop, so each hand
  // gets its own allowance; this proves it rather than trusting the reading.
  {
    const { p, hits } = fresh({ ...base, fingerCount: 1 });
    const frames = 16;
    for (let i = 0; i < frames; i++) {
      const y = 0.25 + (0.7 * i) / (frames - 1);
      // Left hand's index over zone A, right hand's index over zone B. Every
      // other finger is parked far off to the side and curled.
      const parked: [Pt, Pt, Pt, Pt] = [
        [0.02, 0.05],
        [0.02, 0.05],
        [0.02, 0.05],
        [0.02, 0.05],
      ];
      p.update({
        hands: [
          makeHand({
            handedness: "left",
            palmY: y + 0.35,
            tips: [[0.35, y], ...parked] as [Pt, Pt, Pt, Pt, Pt],
            extended: [true, false, false, false, false],
          }),
          makeHand({
            handedness: "right",
            palmY: y + 0.35,
            tips: [[0.55, y], ...parked] as [Pt, Pt, Pt, Pt, Pt],
            extended: [true, false, false, false, false],
          }),
        ],
        timestampMs: 1000 + i * 16,
        inferenceMs: 5,
        captureLatencyMs: null,
      });
    }
    const voices = hits.map((h) => h.voice).sort();
    results.bothHandsRegisterInSingleFingerMode = {
      hits: hits.length,
      expected: 2,
      pass: hits.length === 2 && voices.join(",") === "kick,snare",
      voices,
      note: "one index finger per hand => 2 strikers, so 2-lane chords still work",
    };
  }

  // --- 14. fingerCount 4 excludes the THUMB specifically.
  //
  // The duel runs at 4 so the thumb is out: it sits lower and more inboard than
  // the other tips, folds sideways instead of curling, and is the noisiest
  // landmark MediaPipe reports — it fires lanes nobody aimed at. This pins the
  // exclusion to the thumb rather than to "some finger", so reordering
  // FINGER_NAMES cannot silently let it back in.
  {
    const { p, hits } = fresh({ ...base, fingerCount: 4 });
    const frames = 16;
    for (let i = 0; i < frames; i++) {
      const y = 0.25 + (0.7 * i) / (frames - 1);
      p.update({
        hands: [
          makeHand({
            palmY: y + 0.35,
            tips: [
              [0.35, y], // index  -> zone A
              [0.36, y], // middle -> zone A
              [0.37, y], // ring   -> zone A
              [0.38, y], // pinky  -> zone A
              [0.55, y], // thumb  -> zone B, and fully extended
            ],
            extended: [true, true, true, true, true],
          }),
        ],
        timestampMs: 1000 + i * 16,
        inferenceMs: 5,
        captureLatencyMs: null,
      });
    }
    const voices = hits.map((h) => h.voice).sort();
    const fingers = hits.map((h) => h.finger ?? "?");
    results.thumbExcludedAtFour = {
      hits: hits.length,
      expected: 1,
      // Zone A fires once (the four fingers collapse to one hit per hand), and
      // zone B — under the thumb alone — must stay silent.
      pass:
        hits.length === 1 &&
        voices.join(",") === "snare" &&
        !fingers.includes("thumb"),
      voices,
      fingers,
    };
  }

  const all = Object.values(results) as { pass: boolean }[];
  return NextResponse.json({
    allPassed: all.every((r) => r.pass),
    passed: all.filter((r) => r.pass).length,
    total: all.length,
    results,
  });
}
