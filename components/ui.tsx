"use client";

import type { ReactNode } from "react";

/** Shared chrome primitives. Kept deliberately small — this is not a UI kit. */

export function Panel({
  title,
  action,
  children,
  className = "",
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-edge bg-panel/80 backdrop-blur-sm ${className}`}
    >
      {title && (
        <header className="flex items-center justify-between gap-2 border-b border-edge px-3.5 py-2.5">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            {title}
          </h2>
          {action}
        </header>
      )}
      <div className="p-3.5">{children}</div>
    </section>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  disabled,
  type = "button",
  className = "",
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "ghost" | "danger";
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
  title?: string;
}) {
  const styles = {
    default:
      "bg-panel-raised text-ink border-edge-bright hover:border-ink-faint hover:bg-edge",
    primary:
      "bg-signal text-chassis border-signal font-semibold hover:bg-signal/90",
    ghost: "bg-transparent text-ink-dim border-transparent hover:text-ink",
    danger:
      "bg-transparent text-hot border-hot/40 hover:bg-hot/10 hover:border-hot",
  }[variant];

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

/**
 * A labelled slider that shows its current value. Every control the player
 * touches while playing shows its number — you cannot tune feel by feel alone
 * if you can't tell what you changed.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
  hint?: string;
}) {
  const id = `slider-${label.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <div className="py-1">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[12px] text-ink-dim">
          {label}
        </label>
        <span className="numeric text-[12px] text-ink">
          {format ? format(value) : value.toFixed(2)}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number.parseFloat(e.target.value))}
      />
      {hint && (
        <p className="-mt-1 text-[11px] leading-snug text-ink-faint">{hint}</p>
      )}
    </div>
  );
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="py-1.5">
      <span className="mb-1.5 block text-[12px] text-ink-dim">{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        className="flex gap-1 rounded-lg border border-edge bg-chassis p-1"
      >
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(option.value)}
              className={`flex-1 rounded-md px-2 py-1 text-[12px] transition-colors ${
                active
                  ? "bg-panel-raised text-ink shadow-sm"
                  : "text-ink-faint hover:text-ink-dim"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function Stat({
  label,
  value,
  unit,
  tone = "normal",
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: "normal" | "good" | "warn" | "bad";
}) {
  const color = {
    normal: "text-ink",
    good: "text-signal",
    warn: "text-amber",
    bad: "text-hot",
  }[tone];

  return (
    <div className="flex min-w-0 flex-col">
      <span className="truncate text-[10px] uppercase tracking-[0.1em] text-ink-faint">
        {label}
      </span>
      <span className={`numeric text-[13px] leading-tight ${color}`}>
        {value}
        {unit && <span className="ml-0.5 text-[10px] text-ink-faint">{unit}</span>}
      </span>
    </div>
  );
}
