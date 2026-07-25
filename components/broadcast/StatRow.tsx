"use client";

import { Numeral, SEAT, type NumeralSize } from "./Numeral";

/**
 * StatRow — one line of a head-to-head summary.
 *
 * Two numbers facing each other across their label, with a split bar underneath
 * carrying the proportion. The bar exists because a pair of numbers forces the
 * viewer to do arithmetic; the bar answers "by how much" before either number
 * is read.
 */

export type StatRowSize = "sm" | "md" | "lg";

const VALUE_SIZE: Record<StatRowSize, NumeralSize> = {
  sm: "sm",
  md: "md",
  lg: "lg",
};

export interface StatRowProps {
  label: string;
  p1: number;
  /** Omit for a single-player row: label left, value right. */
  p2?: number;
  decimals?: number;
  suffix?: string;
  /** Misses and timing error are stats you want *fewer* of. */
  higherIsBetter?: boolean;
  /** Defaults on when both values are present. */
  bar?: boolean;
  size?: StatRowSize;
  className?: string;
}

export function StatRow({
  label,
  p1,
  p2,
  decimals = 0,
  suffix,
  higherIsBetter = true,
  bar,
  size = "md",
  className = "",
}: StatRowProps) {
  const valueSize = VALUE_SIZE[size];

  if (p2 === undefined) {
    return (
      <div className={`flex items-center gap-3 py-1.5 ${className}`}>
        <span className="label shrink-0">{label}</span>
        <span aria-hidden className="h-px min-w-4 flex-1 bg-rule" />
        <Numeral
          value={p1}
          size={valueSize}
          decimals={decimals}
          suffix={suffix}
        />
      </div>
    );
  }

  const p1Wins = higherIsBetter ? p1 > p2 : p1 < p2;
  const p2Wins = higherIsBetter ? p2 > p1 : p2 < p1;
  const showBar = bar ?? true;

  // The bar shows *goodness*, not magnitude. On a lower-is-better stat the raw
  // share would hand the longer bar to whoever played worse, which inverts the
  // one thing the bar is there to say.
  const total = Math.abs(p1) + Math.abs(p2);
  const rawShare = total === 0 ? 0.5 : Math.abs(p1) / total;
  const share = higherIsBetter ? rawShare : 1 - rawShare;

  return (
    <div className={`py-1.5 ${className}`}>
      {/*
       * DOM order is label → p1 → p2 so a screen reader hears "accuracy, 98,
       * 91"; `order` puts the label back between the numbers visually. Safe to
       * reorder here specifically because a stat row contains nothing focusable,
       * so there is no tab order to desynchronise.
       */}
      <div className="flex items-center gap-3">
        <span className="label order-2 shrink-0 text-center">{label}</span>
        <span className="order-1 flex flex-1 justify-end">
          <Numeral
            value={p1}
            size={valueSize}
            decimals={decimals}
            suffix={suffix}
            tone={p1Wins ? "p1" : "muted"}
          />
        </span>
        <span className="order-3 flex flex-1 justify-start">
          <Numeral
            value={p2}
            size={valueSize}
            decimals={decimals}
            suffix={suffix}
            tone={p2Wins ? "p2" : "muted"}
          />
        </span>
      </div>
      {showBar && (
        <div aria-hidden className="mt-1.5 flex h-[3px] w-full gap-px">
          <span
            className={`${SEAT[0].fill} transition-[flex-basis] duration-500 ease-out ${p1Wins ? "opacity-100" : "opacity-30"}`}
            style={{ flexBasis: `${share * 100}%` }}
          />
          <span
            className={`${SEAT[1].fill} transition-[flex-basis] duration-500 ease-out ${p2Wins ? "opacity-100" : "opacity-30"}`}
            style={{ flexBasis: `${(1 - share) * 100}%` }}
          />
        </div>
      )}
    </div>
  );
}
