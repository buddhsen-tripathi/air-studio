"use client";

import type { ReactNode } from "react";
import { SEAT, varColor, type Seat } from "./Numeral";

/**
 * Panel — a titled region marked out by a rule and negative space.
 *
 * Deliberately not a card. Broadcast chrome separates content with hairlines;
 * boxes-inside-boxes read as a web dashboard from two metres away, and every
 * border you add steals contrast from the numbers that actually matter.
 */

export interface PanelProps {
  title?: string;
  /** Right-aligned slot in the header row: a count, a toggle, a Button. */
  action?: ReactNode;
  /** Tints the title tick with a player accent. */
  seat?: Seat;
  /**
   * Adds a raised surface behind the body. Use sparingly — only when the panel
   * genuinely sits on top of something busy, like the camera feed.
   */
  filled?: boolean;
  /** Panels nested under a page heading should drop to 3. */
  headingLevel?: 2 | 3;
  className?: string;
  children: ReactNode;
}

export function Panel({
  title,
  action,
  seat,
  filled = false,
  headingLevel = 2,
  className = "",
  children,
}: PanelProps) {
  const Heading = headingLevel === 3 ? "h3" : "h2";
  const accent = seat === undefined ? undefined : SEAT[seat];
  const hasHeader = Boolean(title || action);

  return (
    <section className={`flex min-w-0 flex-col ${className}`}>
      {hasHeader && (
        <>
          <header className="flex min-w-0 items-center justify-between gap-3 pb-2">
            {title ? (
              <div className="flex min-w-0 items-center gap-2">
                {accent && (
                  <span
                    aria-hidden
                    className={`h-[0.7rem] w-[2px] shrink-0 ${accent.fill}`}
                  />
                )}
                <Heading
                  className="label truncate"
                  style={accent ? varColor(accent.cssVar) : undefined}
                >
                  {title}
                </Heading>
              </div>
            ) : (
              <span />
            )}
            {action}
          </header>
          <div className="rule-h" aria-hidden />
        </>
      )}
      <div
        className={[
          hasHeader ? "mt-3" : "",
          filled ? "bg-chrome/80 p-4 backdrop-blur-[2px]" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {children}
      </div>
    </section>
  );
}
