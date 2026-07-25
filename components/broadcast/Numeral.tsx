"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";

/**
 * Numeral — the rolling odometer readout, plus the handful of primitives the
 * rest of the broadcast kit shares.
 *
 * The shared bits live here rather than in their own module because every other
 * component in this folder already imports Numeral, so this is the one file
 * that can hold them without introducing a second dependency edge.
 */

// ─────────────────────────────────────────────────────────────────────── seats

export type Seat = 0 | 1;

/**
 * Seat → Tailwind class literals.
 *
 * These are written out in full on purpose. Tailwind scans source *text*, so a
 * class assembled at runtime (`text-p${seat}`) is never generated and silently
 * renders unstyled. Anything seat-coloured has to come from this table.
 */
export const SEAT = {
  0: {
    text: "text-p1",
    fill: "bg-p1",
    wash: "bg-p1/12",
    edge: "border-p1",
    outline: "focus-visible:outline-p1",
    glow: "shadow-[0_0_30px_-12px_var(--color-p1)]",
    /** For the places where a utility can't win — see `varColor` below. */
    cssVar: "var(--color-p1)",
    tag: "P1",
  },
  1: {
    text: "text-p2",
    fill: "bg-p2",
    wash: "bg-p2/12",
    edge: "border-p2",
    outline: "focus-visible:outline-p2",
    glow: "shadow-[0_0_30px_-12px_var(--color-p2)]",
    cssVar: "var(--color-p2)",
    tag: "P2",
  },
} as const satisfies Record<Seat, Record<string, string>>;

/**
 * `.label`, `.display` and friends live outside Tailwind's cascade layers in
 * globals.css, so an unlayered `color:` in `.label` beats *any* `text-*`
 * utility no matter the source order. Colouring a `.label` therefore has to go
 * through an inline style, which is the only thing above an unlayered rule.
 */
export function varColor(cssVar: string): { color: string } {
  return { color: cssVar };
}

// ────────────────────────────────────────────────────────────── animation help

/**
 * Re-fires a one-shot CSS animation whenever `trigger` changes.
 *
 * Re-assigning the same class name is a no-op to the engine, so the animation
 * has to be torn off, a style flush forced, and the class put back. Keep the
 * animation class *out* of the element's JSX `className`: React overwrites the
 * whole attribute when the prop value changes, which would silently strip a
 * class we added behind its back.
 *
 * prefers-reduced-motion is handled globally — every `.animate-*` in
 * globals.css already collapses to `animation: none` there, so this hook needs
 * no special case for it.
 */
export function useReplayAnimation<T extends HTMLElement>(
  animationClass: string,
  trigger: unknown,
  enabled = true,
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.classList.remove(animationClass);
    if (!enabled) return;
    void el.offsetWidth; // forced reflow; without it the re-add is coalesced away
    el.classList.add(animationClass);
  }, [animationClass, trigger, enabled]);
  return ref;
}

// ────────────────────────────────────────────────────────────────────── numeral

export type NumeralSize = "sm" | "md" | "lg" | "xl";
export type NumeralTone =
  "ink" | "muted" | "faint" | "p1" | "p2" | "live" | "perfect" | "miss";

const SIZE: Record<NumeralSize, string> = {
  sm: "text-[0.8125rem] font-semibold [font-stretch:104%]",
  md: "text-[clamp(1rem,2.4vw,1.375rem)] font-bold [font-stretch:98%]",
  lg: "text-[clamp(1.625rem,4.4vw,2.5rem)] font-extrabold [font-stretch:92%]",
  xl: "text-[clamp(2.125rem,6.6vw,4.25rem)] font-extrabold [font-stretch:88%]",
};

const TONE: Record<NumeralTone, string> = {
  ink: "text-ink",
  muted: "text-ink-2",
  faint: "text-ink-3",
  p1: "text-p1",
  p2: "text-p2",
  live: "text-live",
  perfect: "text-perfect",
  miss: "text-miss",
};

/** Every cell is this tall so glyphs have headroom inside the clipped column. */
const CELL = "h-[1.12em]";

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

export interface NumeralProps {
  value: number;
  size?: NumeralSize;
  tone?: NumeralTone;
  /** Pad to this many integer digits so the readout keeps a fixed width. */
  minDigits?: number;
  /**
   * Ghost the padding. Right for a score field, wrong for a clock — "1:05" is
   * a number you read whole, not a number sitting in a reserved field.
   */
  ghostPad?: boolean;
  decimals?: number;
  /** Rendered full size, e.g. "×" or "+". */
  prefix?: string;
  /** Rendered small and dim, e.g. "%" or "ms". */
  suffix?: string;
  className?: string;
}

/**
 * Align siblings with `items-center`, not `items-baseline`. Each digit column
 * is an `overflow: hidden` box, and such a box's baseline is its bottom edge
 * rather than the glyph's — so baseline alignment would hang adjacent text a
 * quarter-em low.
 */
export function Numeral({
  value,
  size = "md",
  tone = "ink",
  minDigits = 1,
  ghostPad = true,
  decimals = 0,
  prefix,
  suffix,
  className = "",
}: NumeralProps) {
  const safe = Number.isFinite(value) ? value : 0;
  const negative = safe < 0;
  const abs = Math.abs(safe);
  const fixed = decimals > 0 ? abs.toFixed(decimals) : String(Math.round(abs));
  const dot = fixed.indexOf(".");
  const intLength = dot === -1 ? fixed.length : dot;

  // Ghosted leading zeros keep the readout a fixed width across a 999 → 1000
  // rollover. A score that gains a digit mid-round must not shove the rest of
  // the scorebug sideways.
  const pad = Math.max(0, minDigits - intLength);
  const body = "0".repeat(pad) + fixed;

  const spoken = `${prefix ?? ""}${negative ? "-" : ""}${fixed}${suffix ?? ""}`;

  return (
    <span
      className={`numeral inline-flex items-center leading-none ${SIZE[size]} ${TONE[tone]} ${className}`}
    >
      <span className="sr-only">{spoken}</span>
      <span aria-hidden className="flex items-center">
        {prefix ? <Glyph>{prefix}</Glyph> : null}
        {negative ? <Glyph>&#8722;</Glyph> : null}
        {body
          .split("")
          .map((ch, i) =>
            ch >= "0" && ch <= "9" ? (
              <Digit key={i} digit={Number(ch)} ghost={ghostPad && i < pad} />
            ) : (
              <Glyph key={i}>{ch}</Glyph>
            ),
          )}
        {suffix ? (
          <span
            className={`flex ${CELL} items-center pl-[0.08em] opacity-60`}
            style={{ fontSize: "0.62em" }}
          >
            {suffix}
          </span>
        ) : null}
      </span>
    </span>
  );
}

function Glyph({ children }: { children: ReactNode }) {
  return (
    <span className={`flex ${CELL} items-center justify-center`}>
      {children}
    </span>
  );
}

/**
 * One odometer column: all ten digits stacked, clipped to a single cell, moved
 * by transform.
 *
 * This is why the readout cannot reflow. The column's width is the width of the
 * *widest* of 0-9, and all ten are always in the box — so the width is a
 * constant that does not depend on which digit is showing. Tabular figures make
 * the columns agree with each other; keeping every glyph resident is what makes
 * each column agree with itself.
 *
 * A 9→0 tick rolls backwards through the strip rather than wrapping forwards.
 * Fixing that needs a monotonic virtual counter and a snap-back on
 * transitionend, and it would buy nothing here: scores jump by 100-1200 at a
 * time, so the roll distance is arbitrary already.
 */
function Digit({ digit, ghost }: { digit: number; ghost: boolean }) {
  return (
    <span
      className={`relative inline-block ${CELL} overflow-hidden ${ghost ? "opacity-[0.16]" : ""}`}
    >
      <span
        className="flex flex-col transition-transform duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
        style={{ transform: `translateY(${-digit * 10}%)` }}
      >
        {DIGITS.map((n) => (
          <span key={n} className={`flex ${CELL} items-center justify-center`}>
            {n}
          </span>
        ))}
      </span>
    </span>
  );
}
