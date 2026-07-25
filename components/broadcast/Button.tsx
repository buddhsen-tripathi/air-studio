"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { SEAT, type Seat } from "./Numeral";

/**
 * Button — chunky, all-caps, unmistakable.
 *
 * Targets are large because players press these with a webcam pointed at them,
 * often standing, sometimes on a phone propped against a laptop. The primary
 * variant spends no colour at all: it is ink-on-stage, the highest contrast the
 * palette has, which leaves blue and amber free to mean "player" everywhere
 * else. Pass `accent` only when the button genuinely belongs to one seat.
 */

export type ButtonVariant = "primary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[11px] tracking-[0.12em]",
  md: "h-11 px-5 text-[12.5px] tracking-[0.14em]",
  lg: "h-14 px-8 text-[15px] tracking-[0.16em]",
};

// Disabled buttons get `pointer-events-none` below, so the hover states here
// never need a disabled counterpart to switch them back off.
const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-ink text-stage hover:bg-white active:bg-ink-2",
  ghost:
    "border border-rule-bright bg-transparent text-ink-2 hover:border-ink-3 hover:text-ink",
  danger:
    "border border-miss/40 bg-transparent text-miss hover:border-miss hover:bg-miss/10",
};

export interface ButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children"
> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Fills a primary button with a seat accent instead of ink. */
  accent?: Seat;
  fullWidth?: boolean;
  children: ReactNode;
}

export function Button({
  variant = "ghost",
  size = "md",
  accent,
  fullWidth = false,
  className = "",
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  const seat = accent === undefined ? undefined : SEAT[accent];
  const skin =
    variant === "primary" && seat
      ? `${seat.fill} text-stage hover:brightness-110`
      : VARIANT[variant];

  return (
    <button
      type={type}
      // The global :focus-visible ring is blue; on an amber button that reads as
      // the other player's colour, so seat buttons override it to their own.
      className={[
        "inline-flex shrink-0 items-center justify-center gap-2 uppercase",
        "font-semibold [font-stretch:106%] leading-none",
        "transition-[background-color,border-color,color,transform] duration-150",
        "active:translate-y-px",
        "disabled:pointer-events-none disabled:opacity-35",
        SIZE[size],
        skin,
        seat?.outline ?? "",
        fullWidth ? "w-full" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </button>
  );
}
