"use client";

import { useId, useState, type ChangeEvent, type FormEvent } from "react";
import { Button, SEAT, varColor } from "@/components/broadcast";
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "@/lib/net/protocol";

/**
 * TitleScreen — the front door.
 *
 * The whole screen is one argument: this is a *duel*. So the two actions are not
 * a stack of buttons but two opposed columns with a VS between them, and each
 * one wears the accent of the seat it actually leads to — the room's creator is
 * seat 0 (blue), whoever joins is seat 1 (amber). The colour is therefore a
 * promise about what happens next rather than decoration, which is the only
 * reason it is allowed to be here at all.
 */

export interface TitleScreenProps {
  onCreate: () => void;
  onJoin: (code: string) => void;
  connecting: boolean;
  error: string | null;
  onPractice: () => void;
}

/**
 * Uppercase, drop anything outside the room alphabet, stop at the length limit.
 *
 * The alphabet already excludes both halves of every confusable pair (I/1, O/0),
 * so there is no "did they mean O or zero" to resolve — an illegal character is
 * simply a typo, and swallowing it silently is kinder than an error message
 * about a character the user can see never appeared.
 */
function sanitiseCode(raw: string): string {
  let out = "";
  for (const ch of raw.toUpperCase()) {
    if (ROOM_CODE_ALPHABET.includes(ch)) out += ch;
    if (out.length === ROOM_CODE_LENGTH) break;
  }
  return out;
}

export function TitleScreen({
  onCreate,
  onJoin,
  connecting,
  error,
  onPractice,
}: TitleScreenProps) {
  const [code, setCode] = useState("");
  const [focused, setFocused] = useState(false);
  const inputId = useId();
  const hintId = useId();
  const hostHeadingId = useId();
  const joinHeadingId = useId();

  const complete = code.length === ROOM_CODE_LENGTH;
  const canJoin = complete && !connecting;

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    setCode(sanitiseCode(event.target.value));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canJoin) return;
    onJoin(code);
  }

  return (
    <div className="broadcast-field relative isolate flex min-h-dvh flex-col overflow-hidden">
      {/* `precedence` lets React 19 hoist this into <head> and dedupe it, rather
          than emitting a <style> element in the middle of the body. */}
      <style href="apd-notefield" precedence="default">
        {NOTEFIELD_CSS}
      </style>
      <NoteField />

      <header className="relative z-10 flex items-center justify-between gap-4 px-5 py-3 sm:px-8">
        <span className="label">air piano duel</span>
        <span className="label hidden sm:block">
          two webcams · one chart · no wrong notes
        </span>
      </header>
      <div className="rule-h relative z-10" aria-hidden />

      <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center gap-10 px-5 py-10 sm:px-8 lg:gap-14">
        <Wordmark />

        <div className="rule-h" aria-hidden />

        {/*
         * Asymmetry on purpose: host reads left-to-right in blue, joiner is
         * mirrored right-to-left in amber, exactly as the two halves of a
         * scorebug behave for the rest of the match.
         */}
        <div className="grid gap-10 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-stretch md:gap-8">
          <section
            aria-labelledby={hostHeadingId}
            className="animate-sweep flex flex-col items-start gap-4 text-left"
          >
            <ColumnHeading id={hostHeadingId} seat={0}>
              host a match
            </ColumnHeading>
            <p className="max-w-[34ch] text-[0.9375rem] leading-snug text-ink-2">
              Open a room, choose the music, and read the code out to your
              challenger. You take the blue seat.
            </p>
            <Button
              variant="primary"
              accent={0}
              size="lg"
              onClick={onCreate}
              disabled={connecting}
              className="mt-auto w-full sm:w-auto"
            >
              Create match
            </Button>
          </section>

          <Divider />

          <section
            aria-labelledby={joinHeadingId}
            className="animate-sweep flex flex-col items-start gap-4 text-left md:items-end md:text-right"
          >
            <ColumnHeading id={joinHeadingId} seat={1} mirrored>
              join a match
            </ColumnHeading>

            <form
              onSubmit={handleSubmit}
              className="flex w-full flex-1 flex-col items-start gap-3 md:items-end"
            >
              <label htmlFor={inputId} className="label">
                room code
              </label>

              <CodeSlots
                inputId={inputId}
                hintId={hintId}
                code={code}
                focused={focused}
                disabled={connecting}
                onChange={handleChange}
                onFocusChange={setFocused}
              />

              <p id={hintId} className="text-xs text-ink-3">
                {ROOM_CODE_LENGTH} characters — letters and numbers.
              </p>

              <Button
                type="submit"
                variant="primary"
                accent={1}
                size="lg"
                disabled={!canJoin}
                className="mt-auto w-full sm:w-auto"
              >
                Join match
              </Button>
            </form>
          </section>
        </div>

        {/* Height is reserved so a connection attempt cannot shove the actions. */}
        <div className="flex min-h-8 items-center justify-center gap-2 text-center">
          {connecting && (
            <>
              <span
                aria-hidden
                className="animate-live h-[6px] w-[6px] shrink-0 rounded-full bg-ink-2"
              />
              <span className="label">connecting</span>
            </>
          )}
          {error && (
            <p role="alert" className="text-sm leading-snug text-miss">
              {error}
            </p>
          )}
        </div>

        {/*
         * Solo sits with the other two actions rather than in a footer.
         *
         * It is not a fine-print escape hatch — it is the only way to play
         * without a second person present, which is most of the time. Buried in
         * a footer it read as an afterthought; here it is the third choice on
         * the same shelf, still visually subordinate to the two duel actions
         * because the duel is the point.
         */}
        <div className="animate-sweep flex flex-col items-center gap-3">
          <div className="flex w-full items-center gap-4" aria-hidden>
            <span className="h-px flex-1 bg-rule" />
            <span className="label">or</span>
            <span className="h-px flex-1 bg-rule" />
          </div>

          <Button
            variant="ghost"
            size="lg"
            onClick={onPractice}
            disabled={connecting}
            className="group w-full sm:w-auto"
          >
            Practice on your own
            <svg
              viewBox="0 0 16 16"
              width="15"
              height="15"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              className="ml-2 transition-transform duration-150 group-hover:translate-x-0.5"
            >
              <path d="M2.5 8h10M9 4.5 12.5 8 9 11.5" />
            </svg>
          </Button>

          <p className="max-w-[42ch] text-center text-xs leading-snug text-ink-3">
            Same chart, same scoring, no opponent — good for finding your range
            before someone is watching.
          </p>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────── wordmark

function Wordmark() {
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      {/*
       * The two accent bars flank the word the way they flank a scorebug: blue
       * on the left, amber on the right, the seats the two players are about to
       * take. `em` heights hang them off the same clamp as the type, so the
       * lockup scales as one object.
       */}
      <h1 className="flex flex-col items-center gap-2">
        <span className="display text-[clamp(1.25rem,4vw,2.25rem)] tracking-[0.34em] text-ink-2">
          Air Piano
        </span>
        <span className="flex w-full items-center justify-center gap-[0.14em] text-[clamp(3.5rem,15vw,10rem)]">
          <span aria-hidden className="h-[0.5em] w-[0.06em] shrink-0 bg-p1" />
          <span className="display text-[1em] text-ink">Duel</span>
          <span aria-hidden className="h-[0.5em] w-[0.06em] shrink-0 bg-p2" />
        </span>
      </h1>
      <p className="mt-1 max-w-[46ch] text-[0.9375rem] leading-snug text-ink-2">
        Two players, two webcams, one chart. The chart owns the pitch — you own
        the timing, so there is no such thing as a wrong note.
      </p>
    </div>
  );
}

function ColumnHeading({
  id,
  seat,
  mirrored = false,
  children,
}: {
  id: string;
  seat: 0 | 1;
  mirrored?: boolean;
  children: string;
}) {
  const accent = SEAT[seat];
  return (
    <div
      className={`flex items-center gap-2 ${mirrored ? "flex-row-reverse" : ""}`}
    >
      <span aria-hidden className={`h-4 w-[3px] shrink-0 ${accent.fill}`} />
      {/* `.label` is unlayered in globals.css, so its colour beats any text-*
          utility — a seat tint has to arrive as an inline style. */}
      <h2 id={id} className="label" style={varColor(accent.cssVar)}>
        {children}
      </h2>
    </div>
  );
}

/** The VS post: a hairline on wide screens, a labelled rule when stacked. */
function Divider() {
  return (
    <div
      aria-hidden
      className="flex items-center gap-4 md:flex-col md:gap-3 md:px-2"
    >
      <span
        className="h-px flex-1 md:h-auto md:w-px md:flex-1"
        style={{
          background:
            "linear-gradient(90deg,transparent,var(--color-rule-bright),transparent)",
        }}
      />
      <span className="display shrink-0 text-[1.125rem] text-ink-3">vs</span>
      <span
        className="h-px flex-1 md:h-auto md:w-px md:flex-1"
        style={{
          background:
            "linear-gradient(90deg,transparent,var(--color-rule-bright),transparent)",
        }}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────── code entry

/**
 * One real input lying transparently over a row of drawn cells.
 *
 * Letter-spacing a single input never lines its glyphs up with cells underneath
 * — the tracking lands after the last character too — so the text is rendered by
 * the cells and the input only holds the value. It keeps the caret, selection,
 * paste, mobile keyboards, autofill and the focus ring that a div-based fake
 * would throw away.
 */
function CodeSlots({
  inputId,
  hintId,
  code,
  focused,
  disabled,
  onChange,
  onFocusChange,
}: {
  inputId: string;
  hintId: string;
  code: string;
  focused: boolean;
  disabled: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onFocusChange: (focused: boolean) => void;
}) {
  const active = focused
    ? Math.min(code.length, ROOM_CODE_LENGTH - 1)
    : -1;

  return (
    <div className="relative w-full max-w-[19rem]">
      <input
        id={inputId}
        type="text"
        value={code}
        onChange={onChange}
        onFocus={() => onFocusChange(true)}
        onBlur={() => onFocusChange(false)}
        disabled={disabled}
        maxLength={ROOM_CODE_LENGTH}
        inputMode="text"
        autoComplete="off"
        autoCapitalize="characters"
        autoCorrect="off"
        spellCheck={false}
        aria-describedby={hintId}
        // Not opacity-0: that would hide the focus outline along with the text.
        className="absolute inset-0 z-10 w-full bg-transparent text-center text-transparent caret-transparent disabled:cursor-not-allowed"
      />
      <div aria-hidden className="flex gap-2">
        {Array.from({ length: ROOM_CODE_LENGTH }, (_, i) => {
          const ch = code[i] ?? "";
          const isActive = i === active;
          return (
            <span
              key={i}
              className={[
                "relative flex h-[clamp(3rem,6vw,3.75rem)] flex-1 items-center justify-center",
                "border-b-2 transition-colors duration-150",
                isActive
                  ? "border-b-p2 bg-chrome-raised"
                  : ch
                    ? "border-b-ink-2 bg-chrome"
                    : "border-b-rule-bright bg-chrome",
                disabled ? "opacity-40" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {ch ? (
                <span className="display text-[clamp(1.375rem,3.4vw,2rem)] text-ink">
                  {ch}
                </span>
              ) : (
                isActive && (
                  <span className="animate-live h-[1.3em] w-[2px] bg-p2" />
                )
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────── atmosphere

/**
 * Falling notes, built from six gradient strips and one transform each.
 *
 * No canvas and no JS loop: this is the title screen, and it may sit open for
 * minutes while two people fetch each other on a call. Six composited layers
 * cost nothing and never touch the main thread. The strips are twice the field
 * height and their pattern repeats twice over that distance, so a 50% travel
 * loops seamlessly with no snap.
 *
 * Blue on the left half, amber on the right: even the wallpaper is telling you
 * this screen is about two opposed players.
 */
const NOTEFIELD_CSS = `
.apd-notefield{position:absolute;inset:0;display:flex;pointer-events:none;
-webkit-mask-image:linear-gradient(180deg,transparent 0%,#000 20%,#000 66%,transparent 94%);
mask-image:linear-gradient(180deg,transparent 0%,#000 20%,#000 66%,transparent 94%)}
.apd-lane{position:relative;flex:1 1 0;overflow:hidden}
.apd-strip{position:absolute;top:-100%;left:14%;right:14%;height:200%;opacity:.17;
animation-name:apd-fall;animation-timing-function:linear;animation-iteration-count:infinite}
.apd-hitline{position:absolute;left:0;right:0;top:74%;height:1px;
background:linear-gradient(90deg,transparent,rgb(255 255 255/.10) 18%,rgb(255 255 255/.10) 82%,transparent)}
@keyframes apd-fall{from{transform:translate3d(0,0,0)}to{transform:translate3d(0,50%,0)}}
@media (prefers-reduced-motion:reduce){.apd-notefield{display:none}}
`;

/**
 * Offsets are deliberately uneven so the six lanes never form a row of notes
 * marching in step, which reads as a loading bar rather than as music.
 */
const LANES: ReadonlyArray<{
  seat: 0 | 1;
  head: number;
  tail: number;
  duration: string;
  delay: string;
}> = [
  { seat: 0, head: 3, tail: 8, duration: "11s", delay: "-2.4s" },
  { seat: 0, head: 9, tail: 13, duration: "8.5s", delay: "-6.1s" },
  { seat: 0, head: 15, tail: 21, duration: "13s", delay: "-1.2s" },
  { seat: 1, head: 6, tail: 10, duration: "9.5s", delay: "-4.8s" },
  { seat: 1, head: 17, tail: 22, duration: "12s", delay: "-0.6s" },
  { seat: 1, head: 11, tail: 15, duration: "10s", delay: "-7.3s" },
];

/** Period is a fixed 25% of the strip, i.e. exactly half a screen height. */
function notePattern(head: number, tail: number, cssVar: string): string {
  return `repeating-linear-gradient(180deg,transparent 0 ${head}%,${cssVar} ${head}% ${tail}%,transparent ${tail}% 25%)`;
}

function NoteField() {
  return (
    <div className="apd-notefield" aria-hidden>
      {LANES.map((lane, i) => (
        <div key={i} className="apd-lane">
          <div
            className="apd-strip"
            style={{
              backgroundImage: notePattern(
                lane.head,
                lane.tail,
                SEAT[lane.seat].cssVar,
              ),
              animationDuration: lane.duration,
              animationDelay: lane.delay,
            }}
          />
        </div>
      ))}
      <div className="apd-hitline" />
    </div>
  );
}
