import { NextResponse } from "next/server";
import { ChartClock } from "@/lib/game/clock";
import { Judge } from "@/lib/game/judge";
import {
  ChartSchema,
  COMBO_STEP,
  HIT_WINDOWS,
  HIT_WINDOW_MAX,
  MAX_MULTIPLIER,
  SUDDEN_DEATH_MISS_PENALTY,
  type Chart,
  type Judgement,
} from "@/lib/game/types";

/**
 * Behavioural regression check for the judge, the scorer and the clock bridge.
 * Dev-only — a test harness, not a product endpoint.
 *
 * Run: `curl localhost:3000/api/judgetest`
 */

const LANES = [
  { index: 0, label: "C4", note: "C4" },
  { index: 1, label: "E4", note: "E4" },
  { index: 2, label: "G4", note: "G4" },
  { index: 3, label: "B4", note: "B4" },
];

interface NoteDef {
  lane: number;
  timeSec: number;
  round?: number;
}

/** Build a valid chart through the real schema so defaults apply as in prod. */
function chartOf(defs: NoteDef[], suddenDeathRound = -1): Chart {
  return ChartSchema.parse({
    id: "judgetest",
    title: "Judge Test",
    bpm: 120,
    key: "C",
    scale: "major",
    lanes: LANES,
    notes: defs.map((d, i) => ({
      id: `n${i}`,
      lane: d.lane,
      timeSec: d.timeSec,
      kind: "tap",
      note: LANES[d.lane].note,
      velocity: 0.8,
      round: d.round ?? 0,
    })),
    rounds: [
      {
        index: 0,
        label: "R1",
        startSec: 0,
        endSec: 60,
        bpm: 120,
        suddenDeath: suddenDeathRound === 0,
      },
      {
        index: 1,
        label: "R2",
        startSec: 60,
        endSec: 120,
        bpm: 120,
        suddenDeath: suddenDeathRound === 1,
      },
    ],
    durationSec: 120,
    source: "fallback",
  });
}

/** A judge over one note in lane 0 at t=10, calibration off unless asked. */
function singleNote(calibrationSec = 0) {
  return new Judge(chartOf([{ lane: 0, timeSec: 10 }]), { calibrationSec });
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return new NextResponse("Not found", { status: 404 });
  }

  const results: Record<string, unknown> = {};

  // --- 1. On-time is PERFECT, and every window boundary lands on the right
  //        side. Each offset gets a fresh judge because a note resolves once.
  {
    const cases: { offset: number; expect: Judgement | null }[] = [
      { offset: 0, expect: "perfect" },
      { offset: HIT_WINDOWS.perfect, expect: "perfect" },
      { offset: -HIT_WINDOWS.perfect, expect: "perfect" },
      { offset: HIT_WINDOWS.perfect + 0.001, expect: "great" },
      { offset: HIT_WINDOWS.great, expect: "great" },
      { offset: -HIT_WINDOWS.great, expect: "great" },
      { offset: HIT_WINDOWS.great + 0.001, expect: "good" },
      { offset: HIT_WINDOW_MAX, expect: "good" },
      { offset: -HIT_WINDOW_MAX, expect: "good" },
      { offset: HIT_WINDOW_MAX + 0.001, expect: null },
    ];
    const got = cases.map((c) => {
      const j = singleNote();
      const hit = j.judgeHit(0, 10 + c.offset);
      return {
        offset: r6(c.offset),
        expect: c.expect,
        actual: hit?.judgement ?? null,
      };
    });
    results.windowBoundaries = {
      pass: got.every((g) => g.actual === g.expect),
      cases: got,
    };
  }

  // --- 2. A hit well outside the widest window scores nothing and resolves
  //        nothing — proven by the note still coming back as a MISS later.
  {
    const j = singleNote();
    const hit = j.judgeHit(0, 10 + HIT_WINDOW_MAX + 0.13);
    const afterHit = j.getScore();
    const retired = j.update(10 + HIT_WINDOW_MAX + 0.5);
    results.outOfWindowResolvesNothing = {
      pass:
        hit === null &&
        afterHit.resolved === 0 &&
        afterHit.score === 0 &&
        retired.length === 1 &&
        retired[0].judgement === "miss",
      hit,
      resolvedAfterHit: afterHit.resolved,
      retiredAsMiss: retired.map((r) => r.judgement),
    };
  }

  // --- 3. One note cannot be scored twice.
  {
    const j = singleNote();
    const first = j.judgeHit(0, 10);
    const second = j.judgeHit(0, 10.01);
    const s = j.getScore();
    results.noDoubleScoring = {
      pass:
        first?.judgement === "perfect" &&
        second === null &&
        s.resolved === 1 &&
        s.score === 300 &&
        s.combo === 1,
      first: first?.judgement ?? null,
      second,
      score: s.score,
      resolved: s.resolved,
    };
  }

  // --- 4. An un-hit note becomes a MISS once its window passes, and not one
  //        frame before it.
  {
    const j = singleNote();
    // update() hands back a reused buffer, so read its length before the next
    // call rather than holding the reference.
    const earlyCount = j.update(10 + HIT_WINDOW_MAX - 0.001).length;
    const late = j.update(10 + HIT_WINDOW_MAX + 0.01);
    const lateCount = late.length;
    const first = late[0];
    const s = j.getScore();
    results.unhitBecomesMiss = {
      pass:
        earlyCount === 0 &&
        lateCount === 1 &&
        first.judgement === "miss" &&
        first.noteId === "n0" &&
        s.counts.miss === 1 &&
        s.combo === 0 &&
        s.score === 0,
      retiredEarly: earlyCount,
      retiredLate: lateCount,
      counts: s.counts,
    };
  }

  // --- 5. Combo raises the multiplier every COMBO_STEP notes and caps at
  //        MAX_MULTIPLIER. Notes are 0.4s apart in one lane, all hit dead on.
  {
    const count = 45;
    const defs: NoteDef[] = [];
    for (let i = 0; i < count; i++) defs.push({ lane: 0, timeSec: 1 + i * 0.4 });
    const j = new Judge(chartOf(defs), { calibrationSec: 0 });
    const points: number[] = [];
    for (let i = 0; i < count; i++) points.push(j.judgeHit(0, 1 + i * 0.4)?.points ?? -1);
    const s = j.getScore();
    // Combo counts the note being judged, so the COMBO_STEP-th hit itself pays
    // at 2x. Indices are 0-based, hence step - 1.
    const stepIdx = COMBO_STEP - 1;
    results.comboMultiplierSteps = {
      pass:
        points[0] === 300 &&
        points[stepIdx - 1] === 300 &&
        points[stepIdx] === 600 &&
        points[stepIdx + COMBO_STEP] === 900 &&
        points[stepIdx + COMBO_STEP * 2] === 1200 &&
        points[stepIdx + COMBO_STEP * 3] === 300 * MAX_MULTIPLIER &&
        points[count - 1] === 300 * MAX_MULTIPLIER &&
        s.combo === count &&
        s.bestCombo === count,
      sampled: {
        hit1: points[0],
        hit9: points[stepIdx - 1],
        hit10: points[stepIdx],
        hit20: points[stepIdx + COMBO_STEP],
        hit30: points[stepIdx + COMBO_STEP * 2],
        hit40: points[stepIdx + COMBO_STEP * 3],
        hit45: points[count - 1],
      },
      combo: s.combo,
    };
  }

  // --- 6. A miss breaks the combo, and the multiplier resets with it.
  {
    const j = new Judge(
      chartOf([
        { lane: 0, timeSec: 1 },
        { lane: 0, timeSec: 2 },
        { lane: 0, timeSec: 3 },
        { lane: 0, timeSec: 4 },
      ]),
      { calibrationSec: 0 },
    );
    j.judgeHit(0, 1);
    j.judgeHit(0, 2);
    const comboBefore = j.getScore().combo;
    const retired = j.update(3.5);
    const comboAfterMiss = j.getScore().combo;
    const next = j.judgeHit(0, 4);
    const s = j.getScore();
    results.missBreaksCombo = {
      pass:
        comboBefore === 2 &&
        retired.length === 1 &&
        retired[0].combo === 0 &&
        comboAfterMiss === 0 &&
        next?.points === 300 &&
        s.combo === 1 &&
        s.bestCombo === 2,
      comboBefore,
      comboAfterMiss,
      comboAfterNextHit: s.combo,
      bestCombo: s.bestCombo,
    };
  }

  // --- 7. Calibration shifts the window: a hit late by exactly the calibration
  //        amount is PERFECT with it applied, and merely GREAT without it.
  {
    const cal = 0.08;
    const withCal = singleNote(cal);
    const hitWith = withCal.judgeHit(0, 10 + cal);
    const withoutCal = singleNote(0);
    const hitWithout = withoutCal.judgeHit(0, 10 + cal);
    results.calibrationShiftsWindow = {
      pass:
        hitWith?.judgement === "perfect" &&
        Math.abs(hitWith.deltaSec) < 1e-9 &&
        hitWithout?.judgement === "great" &&
        Math.abs((hitWithout?.deltaSec ?? 0) - cal) < 1e-9,
      calibrated: {
        judgement: hitWith?.judgement ?? null,
        deltaSec: r6(hitWith?.deltaSec ?? NaN),
      },
      uncalibrated: {
        judgement: hitWithout?.judgement ?? null,
        deltaSec: r6(hitWithout?.deltaSec ?? NaN),
      },
    };
  }

  // --- 8. Sudden death: a miss costs SUDDEN_DEATH_MISS_PENALTY and the score
  //        floors at zero rather than going negative.
  {
    const j = new Judge(
      chartOf(
        [
          { lane: 0, timeSec: 61, round: 1 },
          { lane: 0, timeSec: 62, round: 1 },
          { lane: 0, timeSec: 63, round: 1 },
          { lane: 0, timeSec: 64, round: 1 },
        ],
        1,
      ),
      { calibrationSec: 0 },
    );
    const hit = j.judgeHit(0, 61)?.points ?? 0; // 300
    const m1 = j.update(62.5)[0];
    const afterFirst = j.getScore().score;
    const m2 = j.update(63.5)[0];
    const afterSecond = j.getScore().score;
    const m3 = j.update(64.5)[0];
    const afterThird = j.getScore().score;
    results.suddenDeathPenaltyFloorsAtZero = {
      pass:
        hit === 300 &&
        m1?.points === -SUDDEN_DEATH_MISS_PENALTY &&
        afterFirst === 300 - SUDDEN_DEATH_MISS_PENALTY &&
        m2?.points === -SUDDEN_DEATH_MISS_PENALTY &&
        afterSecond === 0 &&
        m3?.points === 0 &&
        afterThird === 0,
      afterHit: hit,
      afterFirstMiss: afterFirst,
      afterSecondMiss: afterSecond,
      afterThirdMiss: afterThird,
      missPoints: [m1?.points, m2?.points, m3?.points],
    };
  }

  // --- 9. Accuracy is weighted (1 / 0.7 / 0.4 / 0) over a known sequence, and
  //        the per-round summary agrees with the running score.
  {
    const j = new Judge(
      chartOf([
        { lane: 0, timeSec: 1 },
        { lane: 1, timeSec: 2 },
        { lane: 2, timeSec: 3 },
        { lane: 3, timeSec: 4 },
      ]),
      { calibrationSec: 0 },
    );
    j.judgeHit(0, 1); // perfect
    j.judgeHit(1, 2 + 0.08); // great
    j.judgeHit(2, 3 + 0.15); // good
    j.update(4.5); // note 4 never struck -> miss
    const s = j.getScore();
    const summary = j.getRoundSummary(0);
    const expected = (1 + 0.7 + 0.4 + 0) / 4;
    results.weightedAccuracy = {
      pass:
        s.resolved === 4 &&
        s.counts.perfect === 1 &&
        s.counts.great === 1 &&
        s.counts.good === 1 &&
        s.counts.miss === 1 &&
        Math.abs(s.accuracy - expected) < 1e-9 &&
        s.score === 600 &&
        Math.abs(summary.accuracy - expected) < 1e-9 &&
        summary.score === s.score &&
        summary.bestCombo === 3,
      accuracy: r6(s.accuracy),
      expected: r6(expected),
      counts: s.counts,
      score: s.score,
      summary: { ...summary, accuracy: r6(summary.accuracy) },
    };
  }

  // --- 10. visibleNotes reuses its buffer and returns only the notes in range.
  {
    const defs: NoteDef[] = [];
    for (let i = 0; i < 40; i++) defs.push({ lane: i % 4, timeSec: 1 + i * 0.25 });
    const j = new Judge(chartOf(defs), { calibrationSec: 0 });
    // Every read has to happen before the next call: the array is refilled in
    // place, which is the whole point of the buffer.
    const a = j.visibleNotes(5, 1);
    const idsA = a.map((n) => n.id).join(",");
    const countA = a.length;
    const b = j.visibleNotes(5, 1);
    const sameIdentity = a === b;
    const idsB = b.map((n) => n.id).join(",");
    const later = j.visibleNotes(8, 1);
    const countLater = later.length;
    const inRange = later.every(
      (n) => n.timeSec >= 8 - HIT_WINDOW_MAX && n.timeSec <= 9,
    );
    results.visibleNotesReusesBuffer = {
      pass:
        sameIdentity && idsA === idsB && countA > 0 && countLater > 0 && inRange,
      sameArrayIdentity: sameIdentity,
      countAt5s: countA,
      countAt8s: countLater,
      allInRange: inRange,
    };
  }

  // --- 11. ChartClock maps the perf clock into chart time, and honours a
  //         start anchored in the future (the countdown case).
  {
    const fake = { currentTime: 5 };
    const ctx = fake as unknown as AudioContext;

    const clock = new ChartClock();
    const beforeStart = clock.nowSec();
    const p0 = performance.now();
    clock.start(ctx);
    const atStart = clock.nowSec();
    fake.currentTime = 7;
    const after2s = clock.nowSec();
    const perfMapped = clock.perfToChartSec(p0 + 1000);

    const future = new ChartClock();
    fake.currentTime = 5;
    future.start(ctx, fake.currentTime + 2);
    const preroll = future.nowSec();
    const audioTime = future.chartToAudioSec(3);
    future.stop();

    results.chartClockBridge = {
      pass:
        beforeStart === 0 &&
        !new ChartClock().started &&
        clock.started &&
        Math.abs(atStart) < 1e-9 &&
        Math.abs(after2s - 2) < 1e-9 &&
        Math.abs(perfMapped - 1) < 0.02 &&
        Math.abs(preroll + 2) < 1e-9 &&
        Math.abs(audioTime - 10) < 1e-9 &&
        !future.started,
      atStart: r6(atStart),
      after2s: r6(after2s),
      perfPlus1sMapsTo: r6(perfMapped),
      prerollNowSec: r6(preroll),
      chartToAudioSec3: r6(audioTime),
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
