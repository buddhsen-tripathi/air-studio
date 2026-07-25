import { zoneBounds, zoneColor, type Layout, type Zone } from "@/lib/layout/types";
import { HAND_CONNECTIONS } from "@/lib/vision/handTracker";
import type { HandState, Performer } from "@/lib/vision/performer";

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
}

export class StageRenderer {
  private ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;

  constructor(
    private canvas: HTMLCanvasElement,
    private performer: Performer,
  ) {
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) throw new Error("StageRenderer: 2d context unavailable");
    this.ctx = ctx;
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
    if (!layout) return;

    const now = performance.now();
    const hands = this.performer.getHandStates();

    for (const zone of layout.zones) {
      this.drawZone(zone, now, hands, options);
    }

    for (const hand of hands) {
      if (!hand.present) continue;
      if (options.showSkeleton) this.drawSkeleton(hand);
      this.drawStriker(hand, options);
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

    // Is a striker hovering over this zone right now? Hover gets a subtle lift
    // so the player can find a pad without having to hit it first.
    const hovered = hands.some(
      (hand) =>
        hand.present &&
        (zone.hand === "any" || zone.hand === hand.handedness) &&
        hand.px >= b.left &&
        hand.px <= b.right &&
        hand.py >= b.top &&
        hand.py <= b.bottom,
    );

    const radius = Math.min(14, zw * 0.18, zh * 0.18);

    ctx.save();

    // Fill: nearly transparent at rest so the player can still see themselves.
    ctx.beginPath();
    roundRect(ctx, x, y, zw, zh, radius);
    ctx.fillStyle = withAlpha(color, 0.05 + heat * 0.32 * velocity + (hovered ? 0.07 : 0));
    ctx.fill();

    // Border brightens with hit energy.
    ctx.lineWidth = 1 + heat * 2.5;
    ctx.strokeStyle = withAlpha(color, 0.35 + heat * 0.65 + (hovered ? 0.2 : 0));
    if (heat > 0) {
      ctx.shadowColor = withAlpha(color, 0.8 * heat);
      ctx.shadowBlur = 24 * heat * (0.4 + velocity);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

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

  private drawStriker(hand: HandState, options: RenderOptions): void {
    const { ctx, width: w, height: h } = this;
    const cx = hand.x * w;
    const cy = hand.y * h;
    const px = hand.px * w;
    const py = hand.py * h;

    // Speed drives the ring size, giving continuous feedback about how hard the
    // next hit will land — before it lands.
    const energy = Math.min(1, hand.speed / 2.6);
    const accent = hand.pinched ? "#ffb454" : "#4ade9b";

    ctx.save();

    if (options.showPrediction) {
      // The lead line shows exactly how far ahead we are aiming. When the
      // prediction slider is wrong, this is what makes it obvious.
      ctx.beginPath();
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = withAlpha(accent, 0.35);
      ctx.lineWidth = 1;
      ctx.moveTo(cx, cy);
      ctx.lineTo(px, py);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.strokeStyle = withAlpha(accent, 0.75);
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(cx, cy, 6 + energy * 10, 0, Math.PI * 2);
    ctx.strokeStyle = withAlpha(accent, 0.2 + energy * 0.5);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 10 + energy * 14;
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
