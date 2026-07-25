# Air Studio

Play instruments in the air. Your webcam tracks your hands, strikes through
floating zones make sound, and an AI builds you an instrument for whatever song
you name.

Everything visual happens on-device — video never leaves the browser. The only
network calls are the two AI endpoints, and both work offline via a built-in
fallback.

```bash
npm install
npm run vendor:vision   # optional: host the tracking model locally
npm run dev             # http://localhost:3000
```

Click **Start camera**, allow permission, and strike downward through a pad.

---

## What it does

**Play.** Five built-in layouts — a drum kit, keys, plucked strings, an ambient
pad rig, and a split bass+drums kit. Zones respond to four gesture types:

| Trigger  | Gesture                                    | Used for        |
| -------- | ------------------------------------------ | --------------- |
| `strike` | fingertip crosses the zone's mid-line down | drums, keys     |
| `cross`  | hand sweeps sideways through the zone      | guitar, harp    |
| `hold`   | hand rests inside the zone                 | pads, drones    |
| `pinch`  | thumb + index pinched inside the zone      | sustained notes |

Velocity comes from how fast your hand is moving as it crosses, so soft ghost
notes and hard accents are both available. Where in the zone you land sets
timbre.

**Arrange.** Name a song. The model works out its key, tempo and progression,
picks the instrument that carries it, and places the zones so it's physically
playable. Output is validated and geometrically repaired before it reaches the
audio engine (see below).

**Coach.** Play a phrase, then ask. It reads your actual note timings and
velocities and reports on timing drift, flat dynamics, harmony, and whether
you're ignoring half the kit.

---

## Configuration

Copy `.env.example` to `.env.local`:

```bash
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=anthropic/claude-sonnet-4.5
```

Both are optional. Without a key, the arranger and coach fall back to
deterministic local implementations — the offline coach really does measure
timing jitter and dynamic range, it isn't a stub. The key is read server-side
only and never reaches the browser.

Any OpenRouter model slug works, as long as it follows instructions and emits
JSON.

---

## How it's built

```
lib/
  vision/     handTracker.ts   MediaPipe wrapper, frame loop, mirroring
              filter.ts        One Euro filter
              performer.ts     gesture -> note events  <- the hot path
  audio/      engine.ts        Web Audio synth voices + master chain
  music/      theory.ts        notes, scales, chords
  layout/     types.ts         zod schema shared by presets, AI and engine
              presets.ts       built-in instruments
              repair.ts        makes model output playable
  ai/         openrouter.ts    server-only client
              prompts.ts       arranger + coach prompts
              fallback.ts      offline arranger and coach
  render/     stage.ts         canvas overlay
app/api/      arrange, coach   route handlers
```

### The one rule that shapes everything

```
camera frame -> Performer.update() -> AudioEngine.noteOn()
```

That path runs synchronously inside the video frame callback, through refs, with
React nowhere in it. React state holds only what a human reads and changes at
human speed — the layout, the sliders, the AI panels. Drawing runs on a separate
`requestAnimationFrame` loop that reads the same refs.

If a hit had to wait for a re-render, the instrument would be unplayable on a bad
day and merely mushy on a good one. `TelemetryBar` and `NoteRibbon` poll refs on
their own timers so their updates stay inside their own subtrees.

### Latency, specifically

The end-to-end budget is roughly:

```
camera sensor + decode   30-70ms   (mostly out of our control)
hand landmark inference   5-15ms
audio output buffer       3-20ms
```

Four things fight it:

1. **`requestVideoFrameCallback`, not `requestAnimationFrame`.** rVFC fires once
   per decoded camera frame and hands us that frame's real timestamp. rAF fires
   on display refresh, which is uncorrelated with the camera — it either runs
   inference twice on one frame or misses one entirely.
2. **No lookahead scheduler.** Lookahead is correct for sequenced playback and is
   pure added latency for a live instrument. Hits are scheduled at
   `ctx.currentTime`.
3. **One Euro filtering, not a low-pass.** Raw landmarks jitter a few pixels when
   your hand is still, which chatters zone boundaries and fires phantom hits. A
   fixed low-pass fixes that and adds constant lag — fatal here. One Euro adapts
   its cutoff to hand speed: heavy smoothing when still, almost none when fast.
4. **Predictive triggering.** The **Lead** slider extrapolates your hand along its
   velocity vector before testing zone crossings, so a hit fires when your hand
   _feels_ like it arrived rather than ~60ms later. It front-runs latency rather
   than removing it, which is why the HUD reports "felt" separately from measured.

The telemetry bar breaks the budget down live, so a laggy session tells you
whether to blame the webcam, the model, or the audio device.

### Why layouts get repaired

Models get the musical judgement right and the geometry subtly wrong. The same
handful of failures recur: zones a few percent off-frame, pads smaller than
tracking jitter, pitched voices with no note, duplicate ids, and — worst — two
strike pads stacked vertically in one x-range, where a single stroke fires both
and it just sounds broken.

`lib/layout/repair.ts` clamps, resizes, deduplicates and separates before
validation, so a good arrangement isn't rejected over a misplaced pad. Zones
assigned to opposite hands are exempt from separation, since one stroke can never
cross both.

The built-in presets follow the same rules — the drum kit is a horizontal fan
rather than a picture of a real kit, precisely because kick-under-snare is a
double-trigger waiting to happen.

---

## Tuning the feel

The **Feel** panel is where an unresponsive session gets fixed:

- **Lead** — raise until hits land on the beat. Too high and notes fire early.
- **Sensitivity** — raise if you get phantom notes, lower if soft hits are missed.
- **Retrigger gap** — raise if one stroke double-triggers a pad.
- **Steadiness** — how fast smoothing gets out of the way. Higher tracks fast
  strokes tightly; lower is calmer but laggier.
- **Strike point** — fingertip is precise, palm is more forgiving.

---

## Notes and limits

- Needs HTTPS or `localhost` — `getUserMedia` won't run otherwise.
- Chrome and Safari give the tightest results. Firefox lacks
  `requestVideoFrameCallback` and falls back to rAF, which costs a few ms.
- Two hands maximum, which is a MediaPipe configuration, not a hard limit.
- Without `npm run vendor:vision`, the model and WASM load from a CDN (~8MB on
  cold load, and it won't work offline).
- Background tabs throttle inference to ~1fps, so held notes are released and
  tracking pauses when you switch away.
