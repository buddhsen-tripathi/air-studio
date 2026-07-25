import type { Chart, Judgement, RoundSpec } from "@/lib/game/types";
import { capsulePath, SpriteCache, withAlpha } from "./sprites";

/**
 * The falling-note highway.
 *
 * Plain class, no React: this draws every animation frame from data that
 * changes 60 times a second, and it shares a thread with MediaPipe hand
 * inference. Anything routed through React state here would cost a render pass
 * per frame and add a frame of latency to the one surface the player reads
 * timing off.
 *
 * ── The performance contract ──────────────────────────────────────────────
 * `draw()` allocates nothing in steady state and builds no strings. Every
 * colour string, font string, gradient, sprite and lane x-position is computed
 * once in `ensureLayout()` and reused; per-note brightness is modulated with
 * `globalAlpha` (a cheap state change) instead of by composing new rgba
 * strings. There is no `shadowBlur` anywhere — see lib/render/sprites.ts.
 *
 * ── Time -> screen ────────────────────────────────────────────────────────
 * A note due at `timeSec` sits at
 *     p = 1 - (timeSec - chartTimeSec) / lookaheadSec
 *     y = p * hitY
 * so it enters at the top edge exactly `lookaheadSec` before it is due and
 * crosses the hit line exactly when it is due. Notes keep falling past the line
 * for `fallout` pixels so a late hit still has something under the striker.
 */

/** Hit line height as a fraction of canvas height. */
const HIT_LINE_FRAC = 0.78;

/** Lane strike flash lifetime. Matches the perceived attack of the piano voice. */
const FLASH_MS = 190;

/** Judgement popup lifetime. */
const POP_MS = 620;

/**
 * Reduced-motion damping. We keep every animation — a flash that never fires
 * would remove the feedback the player is actually judging against — but we
 * shrink its amplitude and drop the travel, which is what triggers vestibular
 * discomfort.
 */
const REDUCED_AMP = 0.4;

/** Beat lines are cheap but not free; a pathological bpm must not unbound us. */
const MAX_GRID_LINES = 48;

/** Token values from app/globals.css. Constant lookup, never composed at draw. */
const JUDGEMENT_COLOR: Record<Judgement, string> = {
  perfect: "#46e5a0",
  great: "#7dd3fc",
  good: "#fbbf24",
  miss: "#ff5470",
};

const JUDGEMENT_LABEL: Record<Judgement, string> = {
  perfect: "PERFECT",
  great: "GREAT",
  good: "GOOD",
  miss: "MISS",
};

export interface HighwayTheme {
  laneColors: string[];
  accent: string;
  dim: boolean;
}

export interface HighwayState {
  chart: Chart;
  chartTimeSec: number;
  /** Seconds of chart visible above the hit line. */
  lookaheadSec: number;
  lanes: number;
  /** Lane index -> ms since it was last struck, for the strike flash. */
  laneFlash: Float32Array;
  /** Recent judgements to pop above the hit line. */
  popups: { lane: number; judgement: Judgement; ageMs: number }[];
  theme: HighwayTheme;
}

export class HighwayRenderer {
  /**
   * Rolling average of draw() wall time in ms, for the perf pass. Exponential
   * rather than a windowed mean so it costs one multiply-add and no buffer.
   */
  lastFrameMs = 0;

  private readonly ctx: CanvasRenderingContext2D;
  private readonly motionQuery: MediaQueryList | null;

  private width = 0;
  private height = 0;
  private dpr = 1;

  // --- cached layout, rebuilt only when size / lane count / theme changes ---
  private layoutDirty = true;
  private lastAccent = "";
  private readonly lastLaneColors: string[] = [];
  private lanes = 0;
  private padX = 0;
  private laneW = 0;
  private hitY = 0;
  private fallout = 0;
  private noteW = 0;
  private noteH = 0;
  private popRise = 0;
  private popBaseY = 0;
  private laneMid = new Float32Array(0);
  /** Separator x positions, pre-snapped to device pixels. */
  private sepX = new Float32Array(0);
  private hairline = 1;
  private noteSprites: HTMLCanvasElement[] = [];
  private laneGlows: HTMLCanvasElement[] = [];
  private accentGlow: HTMLCanvasElement | null = null;
  private noteGlowR = 0;
  private holdFill: string[] = [];
  private holdEdge: string[] = [];
  private laneTint = "";
  private sepColor = "";
  private gridColor = "";
  private downbeatColor = "";
  private hitCore = "";
  private hitEdge = "";
  private labelColor = "";
  private popupFont = "";
  private labelFont = "";

  // --- per-chart state -----------------------------------------------------
  private chartId = "";
  /** Longest hold in the chart; widens the cull window so tails stay visible. */
  private maxHoldSec = 0;
  /** Moving index of the first note that could still be on screen. */
  private cursor = 0;
  /** Moving index into chart.rounds, for the beat grid tempo. */
  private roundIdx = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly sprites: SpriteCache,
  ) {
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("HighwayRenderer: 2d context unavailable");
    this.ctx = ctx;
    this.motionQuery =
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
  }

  /** Match the backing store to the CSS box at device resolution, DPR capped at 2. */
  resize(cssW: number, cssH: number): void {
    const dpr = Math.min(
      typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
      2,
    );
    if (this.width === cssW && this.height === cssH && this.dpr === dpr) return;
    this.width = cssW;
    this.height = cssH;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(cssW * dpr));
    this.canvas.height = Math.max(1, Math.round(cssH * dpr));
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Geometry also depends on the lane count and theme, which only arrive with
    // a frame, so the actual rebuild happens on the next draw().
    this.layoutDirty = true;
  }

  draw(state: HighwayState): void {
    const t0 = performance.now();
    const ctx = this.ctx;
    const w = this.width;
    const h = this.height;
    if (w <= 0 || h <= 0) return;

    ctx.clearRect(0, 0, w, h);

    const { chart, theme } = state;
    const lanes = clampInt(state.lanes, 1, 8);
    this.ensureLayout(lanes, theme);
    this.ensureChart(chart);

    const t = Number.isFinite(state.chartTimeSec) ? state.chartTimeSec : 0;
    // A zero or negative lookahead would divide by zero and put every note on
    // the hit line at once; clamp rather than bail so a bad prop still plays.
    const look = state.lookaheadSec > 0.05 ? state.lookaheadSec : 0.05;
    const reduced = this.motionQuery !== null && this.motionQuery.matches;
    const dimK = theme.dim ? 0.45 : 1;

    this.drawLanes(dimK);
    this.drawBeatGrid(chart, t, look, dimK);
    this.drawFlashes(state.laneFlash, reduced, dimK);
    this.drawNotes(chart, t, look, lanes, dimK);
    this.drawHitLine(dimK);
    // Lane labels are drawn in the DOM by LaneOverlay, which gets real
    // typography and stays crisp at any DPR. Drawing them here too printed
    // every pitch name twice, a few pixels apart.
    // this.drawLaneLabels(chart, lanes, dimK);
    this.drawPopups(state.popups, reduced, dimK);

    ctx.globalAlpha = 1;

    const dt = performance.now() - t0;
    this.lastFrameMs =
      this.lastFrameMs === 0 ? dt : this.lastFrameMs * 0.9 + dt * 0.1;
  }

  // ------------------------------------------------------------------ layout

  /**
   * Has anything the cached layout depends on actually changed?
   *
   * Deliberately a field-by-field comparison rather than a joined signature
   * string: this runs on every frame, and a template literal here would
   * allocate 60 strings a second for the sole purpose of discovering that
   * nothing changed. Theme objects are frequently rebuilt inline by callers, so
   * identity comparison on `theme` itself is not safe.
   */
  private layoutStale(lanes: number, theme: HighwayTheme): boolean {
    if (this.layoutDirty) return true;
    if (lanes !== this.lanes) return true;
    if (theme.accent !== this.lastAccent) return true;
    const colors = theme.laneColors;
    if (colors.length !== this.lastLaneColors.length) return true;
    for (let i = 0; i < colors.length; i++) {
      if (colors[i] !== this.lastLaneColors[i]) return true;
    }
    return false;
  }

  /** Rebuild everything that is constant for a given size + lane count + theme. */
  private ensureLayout(lanes: number, theme: HighwayTheme): void {
    if (!this.layoutStale(lanes, theme)) return;
    this.layoutDirty = false;
    this.lastAccent = theme.accent;
    this.lastLaneColors.length = theme.laneColors.length;
    for (let i = 0; i < theme.laneColors.length; i++) {
      this.lastLaneColors[i] = theme.laneColors[i];
    }
    this.lanes = lanes;

    const w = this.width;
    const h = this.height;
    const dpr = this.dpr;

    this.hairline = 1 / dpr;
    this.padX = Math.max(6, Math.min(48, w * 0.03));
    this.laneW = (w - this.padX * 2) / lanes;
    // Snap the hit line to a device-pixel centre so the 2px core stays crisp
    // instead of smearing across three rows.
    this.hitY = (Math.round(h * HIT_LINE_FRAC * dpr) + 0.5) / dpr;
    this.fallout = Math.min(h * 0.09, 72);

    // Chunky tiles, deliberately. These are struck by a hand a metre from the
    // camera, not tapped with a finger on glass — a slim bar reads as a line to
    // aim at rather than a target to hit, and the eye cannot judge its arrival
    // at the hit line in peripheral vision. Nearly lane-width and roughly twice
    // as tall as the first pass.
    this.noteW = Math.min(this.laneW * 0.9, 220);
    this.noteH = clamp(this.laneW * 0.42, 18, 46);
    this.noteGlowR = Math.max(8, Math.round(this.noteW * 0.85));

    this.popRise = 26;
    this.popBaseY = this.hitY - this.noteH - 22;

    if (this.laneMid.length !== lanes) this.laneMid = new Float32Array(lanes);
    if (this.sepX.length !== lanes + 1) this.sepX = new Float32Array(lanes + 1);
    for (let i = 0; i < lanes; i++) {
      this.laneMid[i] = this.padX + this.laneW * (i + 0.5);
    }
    for (let i = 0; i <= lanes; i++) {
      const x = this.padX + this.laneW * i;
      this.sepX[i] = (Math.round(x * dpr) + 0.5) / dpr;
    }

    this.noteSprites.length = lanes;
    this.laneGlows.length = lanes;
    this.holdFill.length = lanes;
    this.holdEdge.length = lanes;
    const nw = Math.round(this.noteW);
    const nh = Math.round(this.noteH);
    for (let i = 0; i < lanes; i++) {
      const color = laneColor(theme, i);
      // One sprite per lane at the note's LARGEST on-screen size. Notes shrink
      // with distance, and downscaling a blit is free — requesting a sprite per
      // size would blow the cache cap and rasterise every frame.
      this.noteSprites[i] = this.sprites.noteSprite(color, nw, nh);
      this.laneGlows[i] = this.sprites.glow(color, this.noteGlowR);
      this.holdFill[i] = withAlpha(color, 0.26);
      this.holdEdge[i] = withAlpha(color, 0.7);
    }
    this.accentGlow = this.sprites.glow(
      theme.accent,
      Math.max(16, Math.round(h * 0.05)),
    );

    this.laneTint = "rgba(255,255,255,0.016)";
    this.sepColor = "rgba(255,255,255,0.055)";
    this.gridColor = "rgba(255,255,255,0.04)";
    this.downbeatColor = "rgba(255,255,255,0.1)";
    this.hitCore = withAlpha(theme.accent, 0.95);
    this.hitEdge = withAlpha(theme.accent, 0.3);
    this.labelColor = "rgba(255,255,255,0.34)";

    const popSize = Math.round(clamp(this.laneW * 0.28, 13, 26));
    const labelSize = Math.round(clamp(this.laneW * 0.2, 9, 14));
    this.popupFont = `700 ${popSize}px "Saira", ui-sans-serif, system-ui, sans-serif`;
    this.labelFont = `600 ${labelSize}px ui-monospace, "SF Mono", Menlo, monospace`;
  }

  /** Reset the moving indices when a different chart shows up. */
  private ensureChart(chart: Chart): void {
    if (chart.id === this.chartId) return;
    this.chartId = chart.id;
    this.cursor = 0;
    this.roundIdx = 0;
    let longest = 0;
    for (let i = 0; i < chart.notes.length; i++) {
      const d = chart.notes[i].durationSec;
      if (d !== undefined && d > longest) longest = d;
    }
    this.maxHoldSec = longest;
  }

  // ----------------------------------------------------------------- surfaces

  private drawLanes(dimK: number): void {
    const ctx = this.ctx;
    const h = this.height;
    ctx.globalAlpha = dimK;

    // Faint columns so the highway reads as lanes even with no notes on screen.
    ctx.fillStyle = this.laneTint;
    ctx.fillRect(this.padX, 0, this.laneW * this.lanes, h);

    // Hairlines: exactly one device pixel wide, whatever the DPR.
    ctx.strokeStyle = this.sepColor;
    ctx.lineWidth = this.hairline;
    ctx.beginPath();
    for (let i = 0; i <= this.lanes; i++) {
      const x = this.sepX[i];
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.hitY + this.fallout);
    }
    ctx.stroke();
  }

  /**
   * Horizontal line on every beat, brighter on the downbeat.
   *
   * This is what lets a player anticipate. Watching a note fall tells you where
   * it is; watching the grid slide past at a constant rate tells you how fast
   * time is moving, which is the thing you actually pre-empt against.
   */
  private drawBeatGrid(
    chart: Chart,
    t: number,
    look: number,
    dimK: number,
  ): void {
    const round = this.roundAt(chart, t);
    const bpm = round.bpm > 0 ? round.bpm : chart.bpm;
    if (!(bpm > 0)) return;
    const beat = 60 / bpm;
    const start = round.startSec;
    const left = this.padX;
    const right = this.padX + this.laneW * this.lanes;
    const ctx = this.ctx;
    const hitY = this.hitY;

    const first = Math.ceil((t - start) / beat);
    const last = Math.floor((t + look - start) / beat);
    if (last < first) return;
    const count = Math.min(last - first + 1, MAX_GRID_LINES);

    ctx.globalAlpha = dimK;
    ctx.lineWidth = this.hairline;

    ctx.strokeStyle = this.gridColor;
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const k = first + i;
      if (mod4(k) === 0) continue;
      const y = snapHalf((1 - (start + k * beat - t) / look) * hitY, this.dpr);
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
    }
    ctx.stroke();

    ctx.strokeStyle = this.downbeatColor;
    ctx.beginPath();
    for (let i = 0; i < count; i++) {
      const k = first + i;
      if (mod4(k) !== 0) continue;
      const y = snapHalf((1 - (start + k * beat - t) / look) * hitY, this.dpr);
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
    }
    ctx.stroke();
  }

  /**
   * A soft column of light in any lane struck recently.
   *
   * Drawn UNDER the notes: the flash is confirmation of an input that already
   * happened, and it must never obscure the note the player is about to hit.
   */
  private drawFlashes(
    laneFlash: Float32Array,
    reduced: boolean,
    dimK: number,
  ): void {
    const ctx = this.ctx;
    const n = Math.min(this.lanes, laneFlash.length);
    const beamH = this.hitY * 0.55;
    for (let i = 0; i < n; i++) {
      const age = laneFlash[i];
      if (!(age >= 0) || age >= FLASH_MS) continue;
      const glow = this.laneGlows[i];
      if (!glow) continue;
      let k = 1 - age / FLASH_MS;
      k *= k;
      if (reduced) k *= REDUCED_AMP;

      const x = this.padX + this.laneW * i;
      ctx.globalAlpha = 0.4 * k * dimK;
      ctx.drawImage(glow, x, this.hitY - beamH, this.laneW, beamH * 2);
      // A tight bar right on the line gives the flash a hard edge to land on,
      // which is what makes the confirmation feel instant rather than smeared.
      ctx.globalAlpha = 0.85 * k * dimK;
      ctx.drawImage(
        glow,
        x - this.laneW * 0.1,
        this.hitY - this.noteH * 0.9,
        this.laneW * 1.2,
        this.noteH * 1.8,
      );
    }
  }

  // -------------------------------------------------------------------- notes

  /**
   * Draw only the notes inside the visible time window.
   *
   * `cursor` is a moving index into the time-sorted note array, so this is
   * O(visible) per frame rather than O(chart). Both walks are bounded by array
   * indices, so an out-of-order note costs at most a dropped sprite — never a
   * hang.
   */
  private drawNotes(
    chart: Chart,
    t: number,
    look: number,
    lanes: number,
    dimK: number,
  ): void {
    const notes = chart.notes;
    if (notes.length === 0) return;

    const ctx = this.ctx;
    const hitY = this.hitY;
    const bottom = hitY + this.fallout;
    // How far back in time the fallout zone reaches, plus the longest hold so a
    // tail whose head is already gone still renders.
    const grace = (this.fallout / hitY) * look;
    const winStart = t - grace - this.maxHoldSec;
    const winEnd = t + look;

    let i = this.cursor;
    if (i > notes.length) i = notes.length;
    // Rewind handles seeks and round restarts; advance handles normal playback.
    while (i > 0 && notes[i - 1].timeSec >= winStart) i--;
    while (i < notes.length && notes[i].timeSec < winStart) i++;
    this.cursor = i;

    for (let j = i; j < notes.length; j++) {
      const note = notes[j];
      if (note.timeSec > winEnd) break;
      const lane = note.lane;
      if (lane < 0 || lane >= lanes) continue;

      const y = (1 - (note.timeSec - t) / look) * hitY;
      const hold =
        note.kind === "hold" && note.durationSec !== undefined
          ? note.durationSec
          : 0;

      if (hold > 0) {
        const tailY = (1 - (note.timeSec + hold - t) / look) * hitY;
        if (tailY > bottom) continue;
        this.drawHold(lane, tailY, y, bottom, dimK);
      } else if (y > bottom) {
        continue;
      }

      // Nearness drives size and brightness together so a note's urgency is
      // readable in peripheral vision, without having to look straight at it.
      const p = clamp01(y / hitY);
      const scale = 0.8 + 0.2 * p;
      const past = y > hitY ? 1 - (y - hitY) / this.fallout : 1;
      const alpha = clamp01((0.5 + 0.5 * p * p) * past) * dimK;
      if (alpha <= 0.01) continue;

      const nw = this.noteW * scale;
      const nh = this.noteH * scale;
      const mid = this.laneMid[lane];

      // Distant notes get no halo: it is invisible at that alpha anyway, and
      // skipping it removes the largest overdraw source in the frame.
      if (p > 0.35) {
        const glow = this.laneGlows[lane];
        if (glow) {
          const gr = this.noteGlowR * scale;
          ctx.globalAlpha = alpha * 0.5 * p;
          ctx.drawImage(glow, mid - gr, y - gr, gr * 2, gr * 2);
        }
      }

      const sprite = this.noteSprites[lane];
      if (!sprite) continue;
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprite, mid - nw / 2, y - nh / 2, nw, nh);
    }
  }

  /** Hold bodies are capsules trailing upward from the head. */
  private drawHold(
    lane: number,
    tailY: number,
    headY: number,
    bottomLimit: number,
    dimK: number,
  ): void {
    const ctx = this.ctx;
    // Clip rather than skip: a long hold whose tail is above the canvas or
    // whose head has already fallen past the line must still render as a
    // continuous ribbon for the part that is on screen.
    const top = Math.max(tailY, -this.noteH);
    const bottom = Math.max(Math.min(headY, bottomLimit), top + 1);
    const w = this.noteW * 0.56;
    const x = this.laneMid[lane] - w / 2;
    const p = clamp01(headY / this.hitY);

    ctx.globalAlpha = clamp01(0.45 + 0.5 * p) * dimK;
    capsulePath(ctx, x, top, w, bottom - top, w / 2);
    ctx.fillStyle = this.holdFill[lane];
    ctx.fill();
    ctx.lineWidth = this.hairline * 1.5;
    ctx.strokeStyle = this.holdEdge[lane];
    ctx.stroke();
  }

  // ----------------------------------------------------------------- hit line

  /** The brightest thing on screen. Everything else is calibrated against it. */
  private drawHitLine(dimK: number): void {
    const ctx = this.ctx;
    const left = this.padX;
    const width = this.laneW * this.lanes;
    const y = this.hitY;

    if (this.accentGlow) {
      // A radial glow stretched into a band. Blurry by construction, so the
      // distortion reads as a light bloom rather than a stretched circle.
      const bandH = Math.max(24, this.height * 0.1);
      ctx.globalAlpha = 0.5 * dimK;
      ctx.drawImage(this.accentGlow, left, y - bandH / 2, width, bandH);
    }

    ctx.globalAlpha = dimK;
    ctx.fillStyle = this.hitEdge;
    ctx.fillRect(left, y - 3, width, 6);
    ctx.fillStyle = this.hitCore;
    ctx.fillRect(left, y - 1, width, 2);

    // Ticks at every lane boundary: they anchor the line to the lanes so the
    // eye can tell which column it is looking down without moving.
    ctx.strokeStyle = this.hitCore;
    ctx.lineWidth = this.hairline * 2;
    ctx.beginPath();
    for (let i = 0; i <= this.lanes; i++) {
      const x = this.sepX[i];
      ctx.moveTo(x, y - 9);
      ctx.lineTo(x, y + 9);
    }
    ctx.stroke();
  }

  private drawLaneLabels(chart: Chart, lanes: number, dimK: number): void {
    const ctx = this.ctx;
    const y = this.hitY + Math.min(this.fallout * 0.55, 26);
    ctx.globalAlpha = dimK;
    ctx.font = this.labelFont;
    ctx.fillStyle = this.labelColor;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const n = Math.min(lanes, chart.lanes.length);
    for (let i = 0; i < n; i++) {
      ctx.fillText(chart.lanes[i].label, this.laneMid[i], y);
    }
  }

  private drawPopups(
    popups: HighwayState["popups"],
    reduced: boolean,
    dimK: number,
  ): void {
    if (popups.length === 0) return;
    const ctx = this.ctx;
    ctx.font = this.popupFont;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (let i = 0; i < popups.length; i++) {
      const pop = popups[i];
      const age = pop.ageMs;
      if (!(age >= 0) || age >= POP_MS) continue;
      const lane = pop.lane;
      if (lane < 0 || lane >= this.lanes) continue;

      const k = age / POP_MS;
      // Fast fade in, slow fade out: the judgement has to be readable the
      // instant it appears, because the next note is already falling.
      const alpha = k < 0.1 ? k / 0.1 : 1 - (k - 0.1) / 0.9;
      const rise = reduced ? 0 : easeOutCubic(k) * this.popRise;

      ctx.globalAlpha = clamp01(alpha) * dimK;
      ctx.fillStyle = JUDGEMENT_COLOR[pop.judgement];
      ctx.fillText(
        JUDGEMENT_LABEL[pop.judgement],
        this.laneMid[lane],
        this.popBaseY - rise,
      );
    }
  }

  // ----------------------------------------------------------------- helpers

  /** Rounds carry their own tempo, so the beat grid has to follow them. */
  private roundAt(chart: Chart, t: number): RoundSpec {
    const rounds = chart.rounds;
    let i = this.roundIdx;
    if (i >= rounds.length) i = rounds.length - 1;
    if (i < 0) i = 0;
    while (i > 0 && t < rounds[i].startSec) i--;
    while (i < rounds.length - 1 && t >= rounds[i].endSec) i++;
    this.roundIdx = i;
    return rounds[i];
  }
}

// -------------------------------------------------------------------- helpers

function laneColor(theme: HighwayTheme, i: number): string {
  const colors = theme.laneColors;
  if (colors.length === 0) return theme.accent;
  return colors[i % colors.length];
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function clampInt(n: number, lo: number, hi: number): number {
  const v = Math.round(n);
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/** `k % 4` that also does the right thing for negative beat indices. */
function mod4(k: number): number {
  return ((k % 4) + 4) % 4;
}

/** Put a horizontal line on a device-pixel centre so hairlines stay 1px. */
function snapHalf(y: number, dpr: number): number {
  return (Math.round(y * dpr) + 0.5) / dpr;
}

function easeOutCubic(k: number): number {
  const u = 1 - k;
  return 1 - u * u * u;
}
