/**
 * Pre-rendered sprites for the note highway.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * `ctx.shadowBlur` is by far the most expensive thing in the Canvas2D API: it
 * forces a separate blur pass over the shape's bounding box on every single
 * fill, on the CPU, with no caching between frames. The highway wants a glow on
 * every visible note, and there are ~30 of those; at 60fps that is ~1800 blur
 * passes a second sharing a thread with MediaPipe hand inference. That is the
 * difference between 60fps and 25fps, and dropped frames here are not cosmetic
 * — the player reads timing off this canvas.
 *
 * So we pay for each glow exactly once, into a small offscreen canvas, and
 * every frame afterwards is a `drawImage` blit the compositor can hand to the
 * GPU. Scaling a blit is free; regenerating a blur is not.
 *
 * Sprites are rendered at device resolution and drawn into CSS-pixel
 * destination rects, so the caller never thinks about DPR.
 */

/**
 * Hard cap on cached sprites.
 *
 * A well-behaved caller asks for O(lanes x kinds) distinct sprites — six lane
 * colours times {note, glow}, plus one accent glow, is thirteen — and only
 * re-asks on resize or theme change. 48 leaves room for a mid-session theme
 * swap while still bounding a caller that (wrongly) derives sprite dimensions
 * from per-frame values and would otherwise grow the map forever. A 128px glow
 * is ~64KB of backing store at DPR 2, so the cap pins worst-case sprite memory
 * around 3MB.
 *
 * Eviction is FIFO, not LRU: the correct working set is tiny and effectively
 * insertion-ordered, so if we are evicting at all something upstream is already
 * wrong and we only need to stay bounded, not clever.
 */
const MAX_SPRITES = 48;

/** Colour used when a caller hands us something we cannot parse. */
const FALLBACK_RGB: readonly [number, number, number] = [148, 163, 184];

export class SpriteCache {
  private readonly cache = new Map<string, HTMLCanvasElement>();
  private readonly dpr: number;

  constructor() {
    // Captured once. A window dragged between monitors mid-session gets
    // slightly soft or slightly over-sampled sprites until the next clear(),
    // which is a far better trade than re-rasterising every glow on a move.
    this.dpr =
      typeof window === "undefined"
        ? 1
        : Math.min(window.devicePixelRatio || 1, 2);
  }

  /**
   * A radial glow disc of `radius` CSS pixels, alpha falling to zero at the
   * edge. Draw it into any rect you like — it is blurry by construction, so
   * stretching it into a band or a column reads as intentional.
   */
  glow(color: string, radius: number): HTMLCanvasElement {
    const r = Math.max(2, Math.round(radius));
    const key = `g:${color}:${r}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const size = r * 2;
    const canvas = this.makeCanvas(size, size);
    const ctx = canvas.getContext("2d");
    if (!ctx) return this.store(key, canvas);
    ctx.scale(this.dpr, this.dpr);

    const [cr, cg, cb] = parseRgb(color);
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    // Hand-tuned falloff rather than a linear ramp: a linear alpha ramp on a
    // radial gradient bands visibly on dark backgrounds and reads as a hard
    // disc, not a glow.
    g.addColorStop(0, `rgba(${cr},${cg},${cb},1)`);
    g.addColorStop(0.18, `rgba(${cr},${cg},${cb},0.62)`);
    g.addColorStop(0.36, `rgba(${cr},${cg},${cb},0.32)`);
    g.addColorStop(0.56, `rgba(${cr},${cg},${cb},0.13)`);
    g.addColorStop(0.78, `rgba(${cr},${cg},${cb},0.035)`);
    g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);

    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return this.store(key, canvas);
  }

  /**
   * The solid body of a note: a capsule with a vertical shade and a bright rim.
   *
   * Callers should request ONE size per lane and scale it with `drawImage`
   * rather than requesting a new sprite per frame as notes grow — see the cache
   * cap above.
   */
  noteSprite(color: string, w: number, h: number): HTMLCanvasElement {
    const cw = Math.max(2, Math.round(w));
    const ch = Math.max(2, Math.round(h));
    const key = `n:${color}:${cw}x${ch}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const canvas = this.makeCanvas(cw, ch);
    const ctx = canvas.getContext("2d");
    if (!ctx) return this.store(key, canvas);
    ctx.scale(this.dpr, this.dpr);

    const rgb = parseRgb(color);
    const top = mix(rgb, [255, 255, 255], 0.5);
    const bottom = mix(rgb, [0, 0, 0], 0.3);
    // Inset by half a pixel so the 1px rim stroke lands inside the bitmap
    // instead of being clipped in half by the canvas edge.
    const x = 0.5;
    const y = 0.5;
    const bw = cw - 1;
    const bh = ch - 1;
    const r = Math.min(bh / 2, bw * 0.42);

    const body = ctx.createLinearGradient(0, 0, 0, ch);
    body.addColorStop(0, `rgb(${top[0]},${top[1]},${top[2]})`);
    body.addColorStop(0.45, `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`);
    body.addColorStop(1, `rgb(${bottom[0]},${bottom[1]},${bottom[2]})`);

    capsulePath(ctx, x, y, bw, bh, r);
    ctx.fillStyle = body;
    ctx.fill();

    // A white rim is what keeps the note legible once it is sitting inside its
    // own glow — without it the edges dissolve and the note loses its shape
    // exactly when the player most needs to judge its position.
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.stroke();

    // Specular band across the top third, clipped to the capsule.
    ctx.save();
    ctx.clip();
    const spec = ctx.createLinearGradient(0, 0, 0, bh * 0.55);
    spec.addColorStop(0, "rgba(255,255,255,0.4)");
    spec.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = spec;
    ctx.fillRect(0, 0, cw, bh * 0.55);
    ctx.restore();

    return this.store(key, canvas);
  }

  /** Drop every sprite. Call on theme change or when the DPR really moved. */
  clear(): void {
    this.cache.clear();
  }

  // ------------------------------------------------------------------ internal

  private makeCanvas(cssW: number, cssH: number): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(cssW * this.dpr));
    canvas.height = Math.max(1, Math.ceil(cssH * this.dpr));
    return canvas;
  }

  private store(key: string, canvas: HTMLCanvasElement): HTMLCanvasElement {
    if (this.cache.size >= MAX_SPRITES) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, canvas);
    return canvas;
  }
}

// -------------------------------------------------------------------- helpers

/**
 * Rounded-rect path. `r` at half the height gives a capsule.
 *
 * Deliberately not `ctx.roundRect`: this runs inside the highway's draw loop
 * for hold bodies, and arcTo has no argument-array allocation.
 */
export function capsulePath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * `#rgb` / `#rrggbb` / `rgb()` / `rgba()` to components.
 *
 * Never throws and never returns NaN: lane colours can come from a theme the
 * AI or the user chose, and a bad colour must degrade to a visible note rather
 * than a blank canvas the player cannot play against.
 */
export function parseRgb(color: string): [number, number, number] {
  const c = color.trim();
  if (c.charCodeAt(0) === 35 /* # */) {
    const hex = c.slice(1);
    if (hex.length === 3) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      if (isByte(r) && isByte(g) && isByte(b)) return [r, g, b];
    } else if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if (isByte(r) && isByte(g) && isByte(b)) return [r, g, b];
    }
  } else if (c.startsWith("rgb")) {
    const open = c.indexOf("(");
    const close = c.indexOf(")");
    if (open > 0 && close > open) {
      const parts = c.slice(open + 1, close).split(/[\s,/]+/);
      const r = Number(parts[0]);
      const g = Number(parts[1]);
      const b = Number(parts[2]);
      if (isByte(r) && isByte(g) && isByte(b)) {
        return [Math.round(r), Math.round(g), Math.round(b)];
      }
    }
  }
  return [FALLBACK_RGB[0], FALLBACK_RGB[1], FALLBACK_RGB[2]];
}

/**
 * Colour plus alpha, as an `rgba()` string.
 *
 * Intended for one-time precomputation — building these per note per frame is
 * exactly the string churn the highway is written to avoid.
 */
export function withAlpha(color: string, alpha: number): string {
  const [r, g, b] = parseRgb(color);
  const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  return `rgba(${r},${g},${b},${a})`;
}

function mix(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  k: number,
): [number, number, number] {
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

function isByte(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= 255;
}
