# CLAUDE.md

Guidance for working in this repo. README.md is the user-facing doc; this file
is the stuff that will bite you if you don't know it.

## What this is

A webcam air-instrument studio. MediaPipe tracks hands, motion through zones
triggers Web Audio voices, and an OpenRouter-backed model generates the zone
layout for a named song plus post-hoc coaching.

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript strict · Tailwind 4 ·
zod 4. Node 22.

## Commands

```bash
npm run dev              # localhost:3000
npm run build            # must pass before calling anything done
npm run typecheck        # tsc --noEmit
npm run vendor:vision    # download MediaPipe wasm + model into public/vision
```

There is no test framework. Verification so far has been done by hitting route
handlers with curl and asserting invariants in Python — see "Verification" below.
If you add a test runner, wire it into `npm test` and say so here.

## The rule that must not be broken

```
camera frame -> Performer.update() -> AudioEngine.noteOn()
```

This path runs **synchronously inside the video frame callback, through refs,
with React nowhere in it.** It is the whole reason the instrument feels playable.

Concretely, in `lib/vision/performer.ts` and `lib/audio/engine.ts`:

- no `setState`, no promises, no `await`, no DOM reads on this path
- no allocation in steady state — per-zone/per-hand state objects are
  pre-created and mutated
- `AudioEngine.noteOn` schedules at `ctx.currentTime`. Do **not** add a lookahead
  scheduler for live hits; lookahead is for sequenced playback and is pure added
  latency here
- `noteToFreq` must never throw — it falls back to A4 on a malformed name

If you need something on screen in response to playing, poll a ref on a timer
inside a leaf component. `TelemetryBar` and `NoteRibbon` are the pattern: they
own their own `setInterval` so re-renders stay in their subtree. Never subscribe
a React setter to `Performer.onHit`.

Drawing is a separate `requestAnimationFrame` loop in `components/Studio.tsx`
that reads the same refs. `lib/render/stage.ts` is a plain class, not a
component, on purpose.

## Multi-finger triggering (read before touching `updateStrike`)

Every fingertip is an independent striker — index, middle, ring, pinky, thumb,
in that order. `config.fingerCount` takes a prefix of that list;
`config.striker: "palm"` collapses to a single point at the palm centre.

The non-obvious part:

> **Triggering is per finger. Arming is per (zone, hand).**

Any fingertip crossing a pad's trigger line can fire it, but once fired the pad
is disarmed for that entire hand until *every* live finger has lifted back above
it (`probeStrike` computes `allClear`).

This is not an optimisation, it's the thing that makes five fingers usable. An
open hand sweeping down through one pad has its tips cross the line tens to
hundreds of milliseconds apart depending on hand tilt and speed — measured at
154ms for a steeply raked hand at 1.2 units/sec. Per-finger cooldown cannot
collapse that (the gap is 2x the 70ms cooldown); it comes out as a flam. Chords
still work because separate zones keep separate state.

### Playing is a gesture, not presence

Two gates keep a hand that is merely *near* a zone from playing it:

- **Extension gate** (`requireExtendedFingers`, default on). A finger only
  triggers when extended. `fingerExtensionRatio` compares tip-to-anchor distance
  against middle-joint-to-anchor distance; curl a finger and the tip folds back,
  inverting the ratio. It's a *ratio*, so it is scale-free — same behaviour close
  to the camera or across the room, and no depth needed. The thumb folds
  sideways so it is measured against the pinky knuckle, not the wrist.
  Thresholds have hysteresis (`EXTEND_ON` 1.18 / `EXTEND_OFF` 1.04).
- **Motion source** (`strikeMotion`). `hand` uses absolute fingertip velocity
  (air-drumming). `finger` subtracts palm velocity, so whole-hand drift cancels
  and only the finger's own press counts — this is what lets you hold a chord
  shape still and play notes individually. `either` (default) takes the max.

The extension gate is applied in `canStrike` and deliberately runs *before* the
`allClear` test, so a curled finger resting on a pad neither fires it nor blocks
it from re-arming. It also gates `hold` zones — a curled finger inside a pad
should not sustain a note.

Corollaries that must hold:

- `hold`/`pinch` zones sound **one voice per (zone, hand)**, not per finger —
  resting three fingers in a pad is one note. `holdKey` is `zoneId:slotIndex`
  with no finger component.
- `cross` (strum) zones track side from the hand's **mean x**, so a spread hand
  plucks a string once. Velocity comes from the fastest finger.
- `probeStrike` writes into a preallocated scratch object (`this.probe`) because
  it runs per zone per hand per frame.

`app/api/fingertest/route.ts` is a dev-only harness with 12 cases covering all
of this — five fingers on one pad, chords across two pads, single-finger mode,
re-arming, palm mode, the tilted-hand flam case, the extension gate on and off,
and all three motion sources. Hit `curl localhost:3000/api/fingertest` after
changing the trigger engine.

Its `makeHand` helper synthesises PIP joints from the tip position, so extension
is modelled by the same geometry the engine measures. If you place landmarks by
hand in a new test and skip the joints, every finger reads as curled.

## Coordinate space

All zone and landmark coordinates are **normalized 0..1 in mirrored view space** —
the space the user sees. `(0,0)` is top-left as displayed.

Mirroring happens exactly once, in `HandTracker.toTrackedHands`. It flips both
`x` (`1 - x`) and the handedness label (MediaPipe reports handedness from the
camera's point of view; without the flip, `hand: "left"` zones respond to the
wrong hand). The `<video>` is CSS-mirrored and the canvas on top is **not**
transformed. Do not add a second flip anywhere.

## Zone geometry rules

These are enforced in three places and must stay in sync:

1. `lib/ai/prompts.ts` — told to the model
2. `lib/layout/repair.ts` — enforced on model output
3. `lib/layout/presets.ts` — the built-ins must satisfy them too

The rules:

- strike zones in the lower half (y 0.45–0.92); `y < 0.3` at `x` 0.35–0.65 is
  where the user's face is
- strike zones: `w >= 0.09`, `h >= 0.12`. Smaller than tracking jitter = unhittable
- cross (string) zones: `w >= 0.04`, `h >= 0.45`
- **no two strike zones may overlap horizontally by more than 45% of the smaller
  width** unless they are bound to opposite hands. This is the important one: a
  single downward stroke crosses both trigger lines and fires both drums, which
  sounds broken. Zones on opposite hands are exempt because the trigger engine
  only tests a zone against its assigned hand.

The drum kit preset is a horizontal fan rather than a picture of a real kit
specifically because kick-under-snare violates this. If you redesign a preset,
re-verify it.

## Model output is repaired, not rejected

`lib/layout/repair.ts` runs before `LayoutSchema.parse` in `/api/arrange`.
Models get musical judgement right and geometry subtly wrong; rejecting a good
arrangement over a misplaced pad is worse than nudging it. Repair handles:
off-frame coords, undersized zones, duplicate ids (they collide in the
performer's per-zone state maps), missing/unparseable notes on pitched voices,
bogus voice and trigger values, and stacked strikes.

`separateStackedStrikes` moves the lower zone **away from** the colliding zone.
An earlier version chose direction by available screen room and pushed zones
*into* the collision — if you touch this, verify overlap decreases.

## AI layer

- `lib/ai/openrouter.ts` is `server-only`. `OPENROUTER_API_KEY` must never reach
  the client — that's why the AI features are route handlers.
- `OPENROUTER_MODEL` is env-configured (default `anthropic/claude-sonnet-4.5`).
  The user sets both; don't hardcode a model.
- Both routes **always return 200 with a working payload.** On any model failure
  they fall back to `lib/ai/fallback.ts` and set `warning`. A dropped API call
  must degrade the coach, never break the instrument.
- `extractJson` doesn't trust `response_format` — models on OpenRouter variously
  wrap output in fences or prepend prose, so it walks for a balanced object.
- `lib/ai/fallback.ts` is a real implementation, not a stub. The offline coach
  measures velocity coefficient-of-variation, inter-onset-interval jitter, and
  zone coverage. Keep it that way so a fresh clone is genuinely usable.

## Next.js gotchas hit in this repo

- `ssr: false` with `next/dynamic` is **not allowed in Server Components**.
  `app/page.tsx` imports `Studio` directly; it's a client component and nothing
  at its module scope touches browser APIs.
- Folders under `app/` starting with `_` are **private and not routed**. A scratch
  route named `__repairtest` silently 404s.
- MediaPipe is dynamically imported inside `HandTracker.load()` to keep the WASM
  out of both the server bundle and the initial client bundle. Don't hoist it to
  a top-level import.
- `requestVideoFrameCallback` is not in lib.dom; it's declared in
  `types/global.d.ts`. It's optional, so bind it (`video.requestVideoFrameCallback?.bind(video)`)
  rather than relying on a `typeof` check to narrow across a closure.

## Startup ordering

In `Studio.start()`, `AudioEngine.init()` must be called **first**, before any
other `await`. Browsers only allow `new AudioContext()` during a user gesture;
awaiting the model load first spends the gesture and leaves the app silent.

Other lifecycle requirements:

- `Performer.setLayout` calls `allNotesOff()` first — otherwise a held pad is
  orphaned with no way to stop it when the zone map changes
- a hand leaving frame must release its holds (`releaseAllHolds`)
- `visibilitychange` calls `panic()` — background tabs throttle inference to
  ~1fps, which produces wild velocities and phantom hits
- unmount disposes the tracker and engine, or the webcam light stays on

## Current state

Complete and building: vision pipeline, One Euro filtering, trigger engine with
predictive lead, 15 synth voices, 5 presets, layout schema + repair, both AI
routes with fallbacks, full UI with live latency telemetry, asset vendoring
script.

Verified: `tsc --noEmit` and `next build` clean; both API routes exercised via
curl (fallback path only); `repairLayout` asserted against deliberately
malformed input; all 5 presets checked against the geometry rules; music theory
spot-checked (A4=69/440Hz, C4=261.63Hz, chord spellings, scale quantization).

**Not verified:** the real OpenRouter model path (no key was set during
development — only fallbacks ran), and the actual playing feel, which needs a
person in front of a camera. Default `predictMs: 55` and `sensitivity: 0.5` are
reasoned starting points, not measured ones.

Not built: recording/export, a sequencer or metronome, layout editing in the UI,
persistence of user settings, multi-user anything.

## Conventions

- Comments explain *why*, especially where a simpler-looking approach is wrong
  (lookahead, low-pass filtering, rAF, React on the hot path). Keep that style;
  don't strip these into restating the code.
- `@/*` path alias maps to the repo root.
- zod schemas in `lib/layout/types.ts` and `lib/ai/schemas.ts` are the shared
  contract between client, server and engine. Change them in one place.
- Tailwind 4 with `@theme` tokens in `app/globals.css` (chassis/panel/edge/ink/
  signal). Dark-only by design — the camera feed is the brightest thing on
  screen and light chrome fights it.
