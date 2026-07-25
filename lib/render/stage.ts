import { zoneBounds, zoneColor, type Layout, type Zone } from "@/lib/layout/types";
import { SpriteCache } from "@/lib/render/sprites";
import { HAND_CONNECTIONS } from "@/lib/vision/handTracker";
import type {
  HandState,
  Performer,
  StrikerState,
} from "@/lib/vision/performer";

/**
 * Canvas overlay renderer.
 *
 * Plain class rather than a React component on purpose: it reads Performer
 * state directly every animation frame. Routing 60fps of hand positions through
 * React state would re-render the whole studio ~60 times a second and add a
 * frame of latency to the visual feedback for no benefit.
 *
 * Coordinates arriving here are already in mirrored view space (see
 * HandTracker), so x maps straight onto canvas width with no further flipping.
 */

const FLASH_MS = 220;

export interface RenderOptions {
  /** Draw the hand skeleton, not just the striker point. */
  showSkeleton: boolean;
  /** Draw the predicted position and the lead line to it. */
  showPrediction: boolean;
  /** Dim zones the current striker cannot reach (wrong hand). */
  showLabels: boolean;
  /**
   * How much zone furniture to draw over the camera.
   *
   * - `full`  rounded pads, glow sprites, dashed trigger lines, labels.
   *           Right for practice mode, where the zones ARE the instrument.
   * - `grid`  bare lane separators, the trigger line, and a flat flash on hit.
   *           A few stroked paths per frame instead of a sprite composite per
   *           zone — visually it still tells you where the lanes fall on your
   *           body, which is the thing worth having.
   * - `none`  hands only.
   */
  zones?: "full" | "grid" | "none";
}

export class StageRenderer {
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;

  private sprites: SpriteCache;

  constructor(
    private canvas: HTMLCanvasElement,
    private performer: Performer,
    /**
     * Share the game's cache when there is one — the glow sprites are keyed by
     * colour and radius, so the highway and this overlay reuse each other's.
     */
    sprites?: SpriteCache,
  ) {
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("StageRenderer: 2d context unavailable");
    this.ctx = ctx;
    this.sprites = sprites ?? new SpriteCache();
  }

  /** Match the canvas backing store to its CSS size at device resolution. */
  resize(cssWidth: number, cssHeight: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (
      this.width === cssWidth &&
      this.height === cssHeight &&
      this.dpr === dpr
    ) {
      return;
    }
    this.width = cssWidth;
    this.height = cssHeight;
    this.dpr = dpr;
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(layout: Layout | null, options: RenderOptions): void {
    const { ctx, width: w, height: h } = this;
    ctx.clearRect(0, 0, w, h);

    const now = performance.now();
    const hands = this.performer.getHandStates();

    const mode = options.zones ?? "full";
    if (layout && mode === "full") {
      for (const zone of layout.zones) {
        this.drawZone(zone, now, hands, options);
      }
    } else if (layout && mode === "grid") {
      this.drawZoneGrid(layout, now);
    }

    for (const hand of hands) {
      if (!hand.present) continue;
      if (options.showSkeleton) this.drawSkeleton(hand);
      // Every live fingertip is an independent striker, so every one gets a
      // marker. The index finger is drawn largest as a visual anchor.
      for (let i = 0; i < hand.strikers.length; i++) {
        this.drawStriker(hand, hand.strikers[i], i === 0, options);
      }
    }
  }

  // -------------------------------------------------------------------- zones

  private drawZone(
    zone: Zone,
    now: number,
    hands: HandState[],
    options: RenderOptions,
  ): void {
    const { ctx, width: w, height: h } = this;
    const b = zoneBounds(zone);
    const x = b.left * w;
    const y = b.top * h;
    const zw = zone.w * w;
    const zh = zone.h * h;
    const color = zoneColor(zone);

    const flash = this.performer.zoneFlash.get(zone.id);
    const age = flash ? now - flash.tMs : Infinity;
    const heat = age < FLASH_MS ? 1 - age / FLASH_MS : 0;
    const velocity = flash?.velocity ?? 0;

    // Is any striker hovering over this zone right now? Hover gets a subtle
    // lift so the player can find a pad without having to hit it first.
    const hovered = hands.some(
      (hand) =>
        hand.present &&
        (zone.hand === "any" || zone.hand === hand.handedness) &&
        hand.strikers.some(
          (s) =>
            s.armedToPlay &&
            s.px >= b.left &&
            s.px <= b.right &&
            s.py >= b.top &&
            s.py <= b.bottom,
        ),
    );

    const radius = Math.min(14, zw * 0.18, zh * 0.18);

    ctx.save();

    // Fill: nearly transparent at rest so the player can still see themselves.
    ctx.beginPath();
    roundRect(ctx, x, y, zw, zh, radius);
    ctx.fillStyle = withAlpha(color, 0.05 + heat * 0.32 * velocity + (hovered ? 0.07 : 0));
    ctx.fill();

    // Hit glow, drawn from a cached sprite rather than with shadowBlur.
    // shadowBlur re-runs a full gaussian on every stroke, every frame, for every
    // flashing zone — it is the most expensive call in the 2D API and it was
    // costing us frames while MediaPipe inference shares the same thread. The
    // sprite is rasterised once and composited additively, which looks the same
    // and is effectively free.
    if (heat > 0) {
      const glow = this.sprites.glow(color, 48);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = 0.55 * heat * (0.4 + velocity);
      ctx.drawImage(glow, x - 12, y - 12, zw + 24, zh + 24);
      ctx.restore();
    }

    // Border brightens with hit energy.
    ctx.lineWidth = 1 + heat * 2.5;
    ctx.strokeStyle = withAlpha(color, 0.35 + heat * 0.65 + (hovered ? 0.2 : 0));
    ctx.stroke();

    // The trigger line: the exact plane the strike is measured against. Showing
    // it is what turns "why didn't that fire?" into an obvious answer.
    if (zone.trigger === "strike") {
      ctx.beginPath();
      ctx.setLineDash([5, 6]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = withAlpha(color, 0.28 + heat * 0.5);
      ctx.moveTo(x + 6, b.midY * h);
      ctx.lineTo(x + zw - 6, b.midY * h);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (zone.trigger === "cross") {
      ctx.beginPath();
      ctx.lineWidth = 1.5 + heat * 2;
      ctx.strokeStyle = withAlpha(color, 0.5 + heat * 0.5);
      ctx.moveTo(b.midX * w, y + 4);
      ctx.lineTo(b.midX * w, y + zh - 4);
      ctx.stroke();
    }

    if (options.showLabels) {
      this.drawZoneLabel(zone, x, y, zw, zh, color, heat);
    }

    ctx.restore();
  }

  /**
   * The cheap lane grid: separators, the strike plane, and a flat hit flash.
   *
   * This exists because seeing the lanes fall across your own body is genuinely
   * useful — it tells you where to put your hands without looking away from the
   * notes. The expensive parts of `drawZone` (rounded paths, glow sprites,
   * dashed strokes, text) contributed almost nothing to that, so this keeps the
   * information and drops the cost to a handful of straight lines per frame.
   */
  private drawZoneGrid(layout: Layout, now: number): void {
    const { ctx, width: w, height: h } = this;
    ctx.save();

    // One pass for every separator, so the whole grid is a single stroke call.
    ctx.beginPath();
    for (const zone of layout.zones) {
      const b = zoneBounds(zone);
      const left = Math.round(b.left * w) + 0.5;
      const right = Math.round(b.right * w) + 0.5;
      ctx.moveTo(left, 0);
      ctx.lineTo(left, h);
      ctx.moveTo(right, 0);
      ctx.lineTo(right, h);
    }
    ctx.strokeStyle = "rgba(232,236,244,0.14)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // The strike plane — the exact height a downward stroke has to cross.
    ctx.beginPath();
    for (const zone of layout.zones) {
      if (zone.trigger !== "strike") continue;
      const b = zoneBounds(zone);
      const y = Math.round(b.midY * h) + 0.5;
      ctx.moveTo(b.left * w + 4, y);
      ctx.lineTo(b.right * w - 4, y);
    }
    ctx.strokeStyle = "rgba(232,236,244,0.3)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Flat flash on a struck lane: no sprite, just a fill that decays.
    for (const zone of layout.zones) {
      const flash = this.performer.zoneFlash.get(zone.id);
      if (!flash) continue;
      const heat = 1 - (now - flash.tMs) / FLASH_MS;
      if (heat <= 0) continue;
      const b = zoneBounds(zone);
      ctx.fillStyle = withAlpha(zoneColor(zone), heat * 0.3 * flash.velocity);
      ctx.fillRect(b.left * w, b.top * h, zone.w * w, zone.h * h);
    }

    ctx.restore();
  }

  private drawZoneLabel(
    zone: Zone,
    x: number,
    y: number,
    zw: number,
    zh: number,
    color: string,
    heat: number,
  ): void {
    const { ctx } = this;
    const compact = zw < 64;
    const label = zone.label;

    ctx.font = `500 ${compact ? 10 : 11}px ui-monospace, SF Mono, Menlo, monospace`;
    ctx.textBaseline = "top";

    // Narrow "cross" strings get a rotated label so it fits the column.
    if (compact) {
      ctx.save();
      ctx.translate(x + zw / 2, y + zh - 6);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "left";
      ctx.fillStyle = withAlpha(color, 0.55 + heat * 0.45);
      ctx.fillText(label, 0, -4);
      ctx.restore();
      return;
    }

    ctx.textAlign = "left";
    // Shadow keeps the label legible over a bright shirt or a window behind you.
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillText(label, x + 9, y + 8);
    ctx.fillStyle = withAlpha(color, 0.7 + heat * 0.3);
    ctx.fillText(label, x + 8, y + 7);

    if (zone.hand !== "any") {
      ctx.font = "500 9px ui-monospace, SF Mono, Menlo, monospace";
      ctx.fillStyle = withAlpha(color, 0.4);
      ctx.fillText(zone.hand === "left" ? "L" : "R", x + 8, y + 21);
    }
  }

  // -------------------------------------------------------------------- hands

  private drawSkeleton(hand: HandState): void {
    const { ctx, width: w, height: h } = this;
    const lms = hand.landmarks;
    if (!lms) return;

    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(232,236,244,0.28)";
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      const p = lms[a];
      const q = lms[b];
      if (!p || !q) continue;
      ctx.moveTo(p.x * w, p.y * h);
      ctx.lineTo(q.x * w, q.y * h);
    }
    ctx.stroke();

    ctx.fillStyle = "rgba(232,236,244,0.4)";
    for (const p of lms) {
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawStriker(
    hand: HandState,
    striker: StrikerState,
    primary: boolean,
    options: RenderOptions,
  ): void {
    const { ctx, width: w, height: h } = this;
    const cx = striker.x * w;
    const cy = striker.y * h;
    const px = striker.px * w;
    const py = striker.py * h;

    // Speed drives the ring size, giving continuous feedback about how hard the
    // next hit will land — before it lands.
    const energy = Math.min(1, striker.speed / 2.6);
    const accent = hand.pinched ? "#ffb454" : "#4ade9b";
    // Secondary fingers are drawn smaller and dimmer: they are fully live, but
    // showing five identical dots turns the stage into confetti.
    const scale = primary ? 1 : 0.62;
    const fade = primary ? 1 : 0.6;

    // A curled finger cannot trigger. Drawing it as a hollow outline answers
    // "why didn't that play?" without the player having to guess.
    if (!striker.armedToPlay) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, 3.5 * scale, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(232,236,244,0.3)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
      return;
    }

    ctx.save();

    if (options.showPrediction) {
      // The lead line shows exactly how far ahead we are aiming. When the
      // prediction slider is wrong, this is what makes it obvious.
      ctx.beginPath();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = withAlpha(accent, 0.35 * fade);
      ctx.lineWidth = 1;
      ctx.moveTo(cx, cy);
      ctx.lineTo(px, py);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.beginPath();
      ctx.arc(px, py, 4 * scale, 0, Math.PI * 2);
      ctx.strokeStyle = withAlpha(accent, 0.75 * fade);
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(cx, cy, (6 + energy * 10) * scale, 0, Math.PI * 2);
    ctx.strokeStyle = withAlpha(accent, (0.2 + energy * 0.5) * fade);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Fingertip glow: same sprite substitution as the zone flash above. There
    // are up to ten of these on screen at once, so a per-fingertip gaussian was
    // the single worst thing in this renderer.
    const halo = this.sprites.glow(accent, 24);
    const haloR = (14 + energy * 16) * scale;
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = (0.5 + energy * 0.4) * fade;
    ctx.drawImage(halo, cx - haloR, cy - haloR, haloR * 2, haloR * 2);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;

    ctx.beginPath();
    ctx.arc(cx, cy, 4.5 * scale, 0, Math.PI * 2);
    ctx.fillStyle = withAlpha(accent, fade);
    ctx.fill();

    ctx.restore();
  }
}

// ------------------------------------------------------------------- helpers

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * Apply alpha to a colour. Zone colours come from presets, the AI, or user
 * input, so this handles #rgb, #rrggbb and passes anything else through with a
 * global alpha fallback rather than producing an invalid colour string.
 */
function withAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      return `rgba(${r},${g},${b},${a})`;
    }
    if (hex.length === 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if (
        Number.isFinite(r) &&
        Number.isFinite(g) &&
        Number.isFinite(b)
      ) {
        return `rgba(${r},${g},${b},${a})`;
      }
    }
  }
  return color;
}
