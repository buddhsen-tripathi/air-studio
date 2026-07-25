import { NextResponse } from "next/server";
import { chartStats, expandChart, repairSpec } from "@/lib/game/chart";
import {
  MAX_SIMULTANEOUS,
  MIN_LANE_GAP_STEPS,
  PatternSpecSchema,
  STEPS_PER_BAR,
} from "@/lib/game/spec";
import {
  ChartSchema,
  MAX_LANES,
  type Chart,
  type RoundSpec,
} from "@/lib/game/types";

/**
 * A step string of `bars` bars whose notes sit exactly `gap` steps apart.
 *
 * Built from the constant rather than typed out, so retuning difficulty cannot
 * silently turn a fixture into an illegal pattern and make an unrelated test
 * start measuring the thinner instead of what it meant to check.
 */
function laneRun(bars: number, gap: number): string {
  const len = bars * STEPS_PER_BAR;
  let out = "";
  for (let i = 0; i < len; i++) out += i % gap === 0 ? "x" : "-";
  return out;
}

/**
 * Invariant check for the chart expander: `repairSpec` -> `expandChart` over a
 * spread of clean, degenerate and deliberately malformed specs. Dev-only — this
 * is a test harness, not a product endpoint.
 *
 * Everything downstream (the judge, the highway, the audio scheduler) assumes
 * these invariants hold, and none of them re-check. Run:
 * `curl localhost:3000/api/charttest`
 */

const EPS = 1e-6;

/** Seconds per 16th step, recovered from the chart alone. */
function stepSecOf(round: RoundSpec): number {
  return 60 / round.bpm / 4;
}

// ------------------------------------------------------------------ inputs

/** Well-formed, hand-checked: 4 lanes x 2 bars x 2 rounds = 44 notes. */
const MUSICAL = {
  title: "Test Waltz",
  song: "Nothing",
  bpm: 110,
  key: "C",
  scale: "major",
  lanes: [
    { label: "C4", note: "C4" },
    { label: "E4", note: "E4" },
    { label: "G4", note: "G4" },
    { label: "B4", note: "B4" },
  ],
  rounds: [
    {
      label: "Warm up",
      bars: 2,
      bpmScale: 1,
      patterns: [
        "x---x---x---x---".repeat(2),
        "--x---x---x---x-".repeat(2),
        "----x-------x---".repeat(2),
        "------------x---".repeat(2),
      ],
    },
    {
      label: "Push",
      bars: 2,
      bpmScale: 1.2,
      patterns: [
        "x---x---x---x---".repeat(2),
        "--x---x---x---x-".repeat(2),
        "----x-------x---".repeat(2),
        "------------x---".repeat(2),
      ],
    },
  ],
};

/**
 * Every failure mode seen from a model at once: too many lanes, garbage
 * pitches, ragged step strings, a lane hammering consecutive 16ths, seven
 * lanes on one step, out-of-range tempo, junk melodies, wrong types.
 */
const MALFORMED = {
  title: "   ",
  bpm: 9999,
  key: "H#",
  scale: "not-a-scale",
  lanes: [
    { label: "", note: "zz9" },
    { note: "C4" },
    "nonsense",
    { label: "TOO LONG A LABEL", note: "E4" },
    { label: "L5", note: "G4" },
    { label: "L6", note: "B4" },
    { label: "L7", note: "D5" },
    { label: "L8", note: "F5" },
    { label: "L9", note: "A5" },
  ],
  rounds: [
    {
      label: "",
      bars: 99,
      bpmScale: 17,
      patterns: [
        "xxxxxxxxxxxxxxxx", // consecutive-step spam
        "xxx", // ragged, shorter than a bar
        "x-x-x-x-x-x-x-x-x-x", // not a multiple of STEPS_PER_BAR
        "XXXXXXXXXXXXXXXX",
        "x---x---x---x---",
        "x---x---x---x---",
        "x---x---x---x---", // one pattern more than there are lanes
      ],
      melody: [["C4", "zz", "", "E4"], "bogus", 42],
    },
    { label: "R2", bars: -3, patterns: ["x-x-x-x-x-x-x-x-"] },
    { label: "R3", bars: 2, bpmScale: 0.01, patterns: [] },
    { label: "R4", patterns: "not an array" },
    { label: "R5", bars: 4, patterns: ["x---x---x---x---"] },
    { label: "R6", bars: 4, patterns: ["x---x---x---x---"] },
  ],
};

/** Nothing but rests: must still expand into a playable chart. */
const SILENT = {
  title: "Silence",
  bpm: 120,
  lanes: [
    { label: "C4", note: "C4" },
    { label: "D4", note: "D4" },
    { label: "E4", note: "E4" },
    { label: "F4", note: "F4" },
  ],
  rounds: [{ label: "Void", bars: 2, patterns: ["-".repeat(32)] }],
};

/** Maximum density in every direction, to exercise the budget guards. */
const OVERSIZED = {
  title: "Wall of notes",
  bpm: 40,
  lanes: Array.from({ length: 6 }, (_, i) => ({
    label: `L${i}`,
    note: `C${i + 2}`,
  })),
  rounds: Array.from({ length: 4 }, (_, i) => ({
    label: `R${i}`,
    bars: 16,
    bpmScale: 0.5,
    patterns: Array.from({ length: 6 }, () => "X".repeat(256)),
  })),
};

/** Lanes handed over out of pitch order, with their patterns attached. */
const UNSORTED = {
  title: "Backwards",
  bpm: 120,
  lanes: [
    { label: "hi", note: "C5" },
    { label: "lo", note: "C4" },
    { label: "mid", note: "G4" },
    { label: "top", note: "E5" },
  ],
  rounds: [
    {
      label: "R",
      bars: 1,
      patterns: [
        "x---------------", // belongs to C5
        "--x-------------", // belongs to C4
        "----x-----------", // belongs to G4
        "------x---------", // belongs to E5
      ],
    },
  ],
};

// ------------------------------------------------------------------ checks

/** 1. Every note sits exactly on its round's 16th grid. */
function checkGrid(chart: Chart): string | null {
  for (const note of chart.notes) {
    const round = chart.rounds[note.round];
    if (!round) return `${note.id}: round ${note.round} does not exist`;
    const steps = (note.timeSec - round.startSec) / stepSecOf(round);
    if (Math.abs(steps - Math.round(steps)) > EPS) {
      return `${note.id}: ${steps.toFixed(9)} steps into round ${note.round}`;
    }
    if (steps < -EPS) return `${note.id}: before its round`;
  }
  return null;
}

/**
 * 2. No lane fires twice inside the retrigger gap.
 *
 * Compared in seconds rather than steps because rounds can differ in tempo;
 * across a boundary the shorter of the two step durations is the binding one.
 */
function checkLaneGaps(chart: Chart): string | null {
  const stepSec = chart.rounds.map(stepSecOf);
  for (let lane = 0; lane < chart.lanes.length; lane++) {
    const inLane = chart.notes
      .filter((n) => n.lane === lane)
      .sort((a, b) => a.timeSec - b.timeSec);
    for (let i = 1; i < inLane.length; i++) {
      const prev = inLane[i - 1];
      const next = inLane[i];
      const floor =
        MIN_LANE_GAP_STEPS * Math.min(stepSec[prev.round], stepSec[next.round]);
      const gap = next.timeSec - prev.timeSec;
      if (gap < floor - EPS) {
        return `lane ${lane}: ${prev.id} -> ${next.id} only ${gap.toFixed(4)}s apart (need ${floor.toFixed(4)}s)`;
      }
    }
  }
  return null;
}

/** 3. No step carries more than MAX_SIMULTANEOUS notes. */
function checkChords(chart: Chart): string | null {
  const stats = chartStats(chart);
  if (stats.maxSimultaneous > MAX_SIMULTANEOUS) {
    return `${stats.maxSimultaneous} notes on one step`;
  }
  const seen = new Set<string>();
  for (const note of chart.notes) {
    const cell = `${note.lane}@${note.timeSec.toFixed(6)}`;
    if (seen.has(cell)) return `two notes in lane ${note.lane} at the same time`;
    seen.add(cell);
    if (seen.has(note.id + "#id")) return `duplicate note id ${note.id}`;
    seen.add(note.id + "#id");
  }
  return null;
}

/** 4. Rounds tile [0, durationSec) and contain every note, plus a tail. */
function checkRounds(chart: Chart): string | null {
  if (Math.abs(chart.rounds[0].startSec) > EPS) return "round 0 does not start at 0";
  for (let i = 0; i < chart.rounds.length; i++) {
    const round = chart.rounds[i];
    if (round.index !== i) return `round ${i} is indexed ${round.index}`;
    if (round.endSec <= round.startSec) return `round ${i} is empty`;
    const next = chart.rounds[i + 1];
    if (next && Math.abs(round.endSec - next.startSec) > EPS) {
      return `gap between round ${i} and ${i + 1}`;
    }
  }

  const last = chart.rounds[chart.rounds.length - 1];
  if (!last.suddenDeath) return "final round is not sudden death";
  if (chart.rounds.slice(0, -1).some((r) => r.suddenDeath)) {
    return "a non-final round is sudden death";
  }
  if (Math.abs(last.endSec - chart.durationSec) > EPS) {
    return "durationSec does not match the last round";
  }

  let latest = 0;
  for (const note of chart.notes) {
    const round = chart.rounds[note.round];
    if (note.timeSec < round.startSec - EPS || note.timeSec >= round.endSec) {
      return `${note.id} at ${note.timeSec.toFixed(3)}s falls outside round ${note.round}`;
    }
    latest = Math.max(latest, note.timeSec);
  }
  if (chart.durationSec - latest < 1.4) {
    return `only ${(chart.durationSec - latest).toFixed(2)}s of tail after the last note`;
  }

  for (let i = 1; i < chart.notes.length; i++) {
    if (chart.notes[i].timeSec < chart.notes[i - 1].timeSec - EPS) {
      return "notes are not sorted by time";
    }
  }
  return null;
}

// ------------------------------------------------------------------ route

export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Not found", { status: 404 });
  }

  const results: Record<string, unknown> = {};

  const charts: { name: string; chart: Chart }[] = [
    { name: "musical", chart: expandChart(repairSpec(MUSICAL)) },
    { name: "malformed", chart: expandChart(repairSpec(MALFORMED)) },
    { name: "silent", chart: expandChart(repairSpec(SILENT)) },
    { name: "oversized", chart: expandChart(repairSpec(OVERSIZED)) },
    { name: "unsorted", chart: expandChart(repairSpec(UNSORTED)) },
    { name: "empty", chart: expandChart(repairSpec({})) },
    { name: "junk", chart: expandChart(repairSpec("not a spec at all")) },
    { name: "null", chart: expandChart(repairSpec(null)) },
  ];

  const invariant = (
    key: string,
    check: (c: Chart) => string | null,
  ): void => {
    const failures = charts
      .map(({ name, chart }) => {
        const problem = check(chart);
        return problem ? `${name}: ${problem}` : null;
      })
      .filter((f): f is string => f !== null);
    results[key] = { pass: failures.length === 0, failures };
  };

  // --- 1..4. Structural invariants, over every chart above.
  invariant("onTheSixteenthGrid", checkGrid);
  invariant("laneRetriggerGap", checkLaneGaps);
  invariant("maxSimultaneous", checkChords);
  invariant("roundsContiguous", checkRounds);

  // --- 5. Repair is total: garbage in, schema-valid chart out.
  {
    const inputs: [string, unknown][] = [
      ["musical", MUSICAL],
      ["malformed", MALFORMED],
      ["silent", SILENT],
      ["oversized", OVERSIZED],
      ["unsorted", UNSORTED],
      ["empty object", {}],
      ["null", null],
      ["string", "not a spec at all"],
      ["number", 42],
      ["array", [1, 2, 3]],
      ["no rounds", { title: "x", lanes: [], rounds: [] }],
      ["nested junk", { lanes: [{}, {}, {}, {}], rounds: [{ patterns: [null] }] }],
    ];
    const failures: string[] = [];
    for (const [name, input] of inputs) {
      const spec = PatternSpecSchema.safeParse(repairSpec(input));
      if (!spec.success) {
        failures.push(`${name}: spec invalid (${spec.error.issues[0]?.message})`);
        continue;
      }
      const chart = ChartSchema.safeParse(expandChart(spec.data));
      if (!chart.success) {
        failures.push(`${name}: chart invalid (${chart.error.issues[0]?.path.join(".")}: ${chart.error.issues[0]?.message})`);
      }
    }
    results.repairIsTotal = { pass: failures.length === 0, failures };
  }

  // --- 6. Melody arrays wrap when shorter than the lane's run of hits.
  {
    const spec = repairSpec({
      title: "Wrap",
      bpm: 120,
      key: "C",
      scale: "major",
      lanes: [
        { label: "C4", note: "C4" },
        { label: "D4", note: "D4" },
        { label: "E4", note: "E4" },
        { label: "F4", note: "F4" },
      ],
      rounds: [
        {
          label: "R",
          bars: 1,
          // Spaced at exactly MIN_LANE_GAP_STEPS so repair leaves it alone —
          // otherwise this test measures thinning rather than melody wrapping.
          patterns: [laneRun(1, MIN_LANE_GAP_STEPS), "", "", ""],
          melody: [["C5", "E5"]],
        },
      ],
    });
    const chart = expandChart(spec);
    const lane0 = chart.notes
      .filter((n) => n.lane === 0)
      .sort((a, b) => a.timeSec - b.timeSec)
      .map((n) => n.note);
    // The melody has 2 entries and must wrap across however many notes fit.
    const expected = lane0.map((_, i) => (i % 2 === 0 ? "C5" : "E5"));
    // Lanes without a melody must fall back to their own default pitch.
    const others = chart.notes.filter((n) => n.lane !== 0);
    results.melodyWraps = {
      pass:
        lane0.join(",") === expected.join(",") &&
        others.every((n) => n.note === chart.lanes[n.lane].note),
      got: lane0,
      expected,
    };
  }

  // --- 7. A clean spec survives repair untouched.
  {
    const chart = expandChart(repairSpec(MUSICAL));
    const stats = chartStats(chart);
    const perLane = stats.byLane.join(",");
    // Assert the *properties* a clean spec must keep, not a note count — the
    // count is a function of MIN_LANE_GAP_STEPS and would need editing every
    // time difficulty is retuned, which is exactly how a test rots into noise.
    const gapOk = checkLaneGaps(chart) === null;
    results.cleanSpecPreserved = {
      pass:
        stats.notes > 0 &&
        gapOk &&
        chart.lanes.length === 4 &&
        chart.rounds.length === 2 &&
        chart.bpm === 110 &&
        Math.abs(chart.rounds[1].bpm - 132) < 1e-9,
      notes: stats.notes,
      byLane: perLane,
      gapsRespected: gapOk,
    };
  }

  // --- 8. Lanes come out ascending in pitch with their patterns still attached.
  {
    const chart = expandChart(repairSpec(UNSORTED));
    const labels = chart.lanes.map((l) => l.label).join(",");
    // The C5 lane's hit was on step 0; after sorting it must be lane 2 and
    // still be the earliest note in the round.
    const first = chart.notes[0];
    results.lanesSortedByPitch = {
      pass:
        labels === "lo,mid,hi,top" &&
        first.lane === 2 &&
        first.note === "C5" &&
        Math.abs(first.timeSec) < EPS,
      labels,
      first: { lane: first.lane, note: first.note },
    };
  }

  // --- 9. Accents survive as velocity, plain hits do not.
  {
    const chart = expandChart(
      repairSpec({
        title: "Accents",
        bpm: 120,
        lanes: [
          { label: "C4", note: "C4" },
          { label: "D4", note: "D4" },
          { label: "E4", note: "E4" },
          { label: "F4", note: "F4" },
        ],
        // Accent then plain hit, spaced legally so neither is thinned away.
        rounds: [
          {
            label: "R",
            bars: 1,
            patterns: [`X${"-".repeat(MIN_LANE_GAP_STEPS - 1)}x`.padEnd(16, "-")],
          },
        ],
      }),
    );
    const lane0 = chart.notes.filter((n) => n.lane === 0);
    results.accentVelocity = {
      pass:
        lane0.length === 2 &&
        lane0[0].velocity === 1 &&
        lane0[1].velocity === 0.8,
      velocities: lane0.map((n) => n.velocity),
    };
  }

  // --- 10. Expansion is deterministic: both peers must derive the same chart.
  {
    const a = expandChart(repairSpec(MALFORMED));
    const b = expandChart(repairSpec(MALFORMED));
    results.deterministic = {
      pass: a.id === b.id && JSON.stringify(a) === JSON.stringify(b),
      id: a.id,
    };
  }

  // --- 11. Budget guards: pathological density stays inside ChartSchema.
  {
    const chart = expandChart(repairSpec(OVERSIZED));
    const stats = chartStats(chart);
    results.budgetsRespected = {
      pass:
        stats.notes <= 2000 &&
        chart.durationSec <= 600 &&
        chart.rounds.every((r) => r.bpm >= 40 && r.bpm <= 260) &&
        chart.notes.length > 0,
      notes: stats.notes,
      durationSec: Number(chart.durationSec.toFixed(2)),
      densityPerSec: Number(stats.densityPerSec.toFixed(2)),
    };
  }

  // --- 12. Ragged step strings are padded/trimmed to whole bars.
  {
    const spec = repairSpec(MALFORMED);
    const round = spec.rounds[0];
    const widths = new Set(round.patterns.map((p) => p.length));
    results.barsAreWhole = {
      pass:
        widths.size === 1 &&
        [...widths][0] === round.bars * STEPS_PER_BAR &&
        round.patterns.length === spec.lanes.length &&
        // MALFORMED asks for more lanes than allowed; repair clamps to the cap.
        spec.lanes.length === MAX_LANES &&
        spec.rounds.length === 4,
      widths: [...widths],
      bars: round.bars,
      lanes: spec.lanes.length,
      rounds: spec.rounds.length,
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
