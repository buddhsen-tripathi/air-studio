"use client";

import { SEAT, varColor, type Seat } from "./Numeral";

/**
 * NamePlate — the broadcast lower-third.
 *
 * Seat 0 reads left-to-right with its accent on the leading edge; seat 1 is the
 * mirror image. That asymmetry is doing real work: it means a glance at *which
 * side of the plate the colour sits on* identifies the player before any text
 * is read, which is faster than reading a name and far more robust in
 * peripheral vision.
 */

export type NamePlateSize = "sm" | "md" | "lg";

const NAME_SIZE: Record<NamePlateSize, string> = {
  sm: "text-[clamp(0.8rem,1.8vw,0.95rem)]",
  md: "text-[clamp(1.05rem,3vw,1.5rem)]",
  lg: "text-[clamp(1.5rem,5vw,2.5rem)]",
};

const BAR_SIZE: Record<NamePlateSize, string> = {
  sm: "w-[3px]",
  md: "w-[4px]",
  lg: "w-[6px]",
};

const PAD: Record<NamePlateSize, string> = {
  sm: "px-2.5 py-1.5 gap-2",
  md: "px-3 py-2 gap-2.5",
  lg: "px-4 py-3 gap-3.5",
};

export interface NamePlateProps {
  name: string;
  seat: Seat;
  /** Small line under the name: "HOST", "READY", "YOU", a round label. */
  subtitle?: string;
  /** Dims the whole plate when false — for a player who is not up yet. */
  active?: boolean;
  size?: NamePlateSize;
  className?: string;
}

export function NamePlate({
  name,
  seat,
  subtitle,
  active = true,
  size = "md",
  className = "",
}: NamePlateProps) {
  const accent = SEAT[seat];
  const mirrored = seat === 1;

  return (
    <div
      className={[
        "inline-flex min-w-0 max-w-full items-center bg-chrome/85 backdrop-blur-[2px]",
        "transition-opacity duration-300",
        PAD[size],
        mirrored ? "flex-row-reverse" : "",
        active ? `opacity-100 ${accent.glow}` : "opacity-45",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span
        aria-hidden
        className={`self-stretch shrink-0 ${BAR_SIZE[size]} ${accent.fill}`}
      />
      <div
        className={`flex min-w-0 flex-col ${mirrored ? "items-end text-right" : "items-start text-left"}`}
      >
        <span
          className={`plate-name w-full truncate ${NAME_SIZE[size]} ${active ? "text-ink" : "text-ink-2"}`}
        >
          {name}
        </span>
        <span
          className={`flex w-full items-baseline gap-1.5 overflow-hidden ${mirrored ? "justify-end" : ""}`}
        >
          {/* The seat tag is the fallback identity when the plate is cropped or
              the name is long enough to truncate to nothing useful. */}
          <span
            className={`label shrink-0 ${mirrored ? "order-2" : "order-1"}`}
            style={varColor(accent.cssVar)}
          >
            {accent.tag}
          </span>
          {subtitle && (
            <span
              className={`label min-w-0 truncate ${mirrored ? "order-1" : "order-2"}`}
            >
              {subtitle}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
