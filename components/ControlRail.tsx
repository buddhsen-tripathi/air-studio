"use client";

import { MAX_FINGERS, type PerformerConfig } from "@/lib/vision/performer";
import { Panel, SegmentedControl, Slider } from "./ui";

/** Cumulative labels: the slider takes a prefix of the finger list. */
const FINGER_LABELS = [
  "Index",
  "+ Middle",
  "+ Ring",
  "+ Pinky",
  "All five",
];

/**
 * Calibration. Every control here changes how the instrument *feels*, and the
 * right setting depends on the player's webcam, lighting and playing style —
 * which is exactly why they are exposed rather than hard-coded.
 */

export interface StudioSettings {
  masterGain: number;
  space: number;
  /** 0..0.8 — how much the camera feed is darkened so zones stand out. */
  cameraDim: number;
  showSkeleton: boolean;
  showPrediction: boolean;
}

export function ControlRail({
  config,
  onConfig,
  settings,
  onSettings,
}: {
  config: PerformerConfig;
  onConfig: (config: PerformerConfig) => void;
  settings: StudioSettings;
  onSettings: (settings: StudioSettings) => void;
}) {
  const patch = (partial: Partial<PerformerConfig>) =>
    onConfig({ ...config, ...partial });
  const patchSettings = (partial: Partial<StudioSettings>) =>
    onSettings({ ...settings, ...partial });

  return (
    <Panel title="Feel">
      <Slider
        label="Lead"
        value={config.predictMs}
        min={0}
        max={120}
        step={5}
        onChange={(predictMs) => patch({ predictMs })}
        format={(v) => `${v.toFixed(0)} ms`}
        hint="Fires on where your hand is heading, cancelling camera lag. Raise it until hits land on the beat; too high and notes fire early."
      />

      <Slider
        label="Sensitivity"
        value={config.sensitivity}
        min={0}
        max={1}
        step={0.05}
        onChange={(sensitivity) => patch({ sensitivity })}
        format={(v) => `${Math.round(v * 100)}%`}
        hint="How committed a stroke has to be to count. Lower it if soft hits are being missed, raise it if you get phantom notes."
      />

      <Slider
        label="Retrigger gap"
        value={config.cooldownMs}
        min={30}
        max={200}
        step={5}
        onChange={(cooldownMs) => patch({ cooldownMs })}
        format={(v) => `${v.toFixed(0)} ms`}
        hint="Minimum time between two hits on the same pad. Raise it if one stroke double-triggers."
      />

      <Slider
        label="Steadiness"
        value={config.smoothing.beta}
        min={0.005}
        max={0.12}
        step={0.005}
        onChange={(beta) =>
          patch({ smoothing: { ...config.smoothing, beta } })
        }
        format={(v) => v.toFixed(3)}
        hint="How fast smoothing gets out of the way when you move. Higher tracks fast strokes more tightly; lower is calmer but laggier."
      />

      <SegmentedControl<PerformerConfig["striker"]>
        label="Strike with"
        value={config.striker}
        onChange={(striker) => patch({ striker })}
        options={[
          { value: "fingers", label: "Fingertips" },
          { value: "palm", label: "Palm" },
        ]}
      />

      {config.striker === "fingers" && (
        <>
          <Slider
            label="Fingers"
            value={config.fingerCount}
            min={1}
            max={MAX_FINGERS}
            step={1}
            onChange={(fingerCount) => patch({ fingerCount })}
            format={(v) => FINGER_LABELS[Math.round(v) - 1] ?? `${v}`}
            hint="Each fingertip triggers independently, so you can strike several zones at once."
          />

          <SegmentedControl<PerformerConfig["strikeMotion"]>
            label="Trigger on"
            value={config.strikeMotion}
            onChange={(strikeMotion) => patch({ strikeMotion })}
            options={[
              { value: "either", label: "Both" },
              { value: "hand", label: "Hand" },
              { value: "finger", label: "Finger" },
            ]}
          />
          <p className="-mt-1 mb-1 text-[11px] leading-snug text-ink-faint">
            {config.strikeMotion === "hand"
              ? "Only whole-hand strokes play. Natural for drums."
              : config.strikeMotion === "finger"
                ? "Only finger movement relative to your hand plays, so you can hold a chord shape still and press notes individually."
                : "Whole-hand strokes and individual finger presses both play."}
          </p>

          <Toggle
            label="Curled fingers don't play"
            checked={config.requireExtendedFingers}
            onChange={(requireExtendedFingers) =>
              patch({ requireExtendedFingers })
            }
          />
          <p className="mt-1 text-[11px] leading-snug text-ink-faint">
            Only extended fingers trigger, so a relaxed hand passing over a pad
            stays silent. Curled fingertips show as hollow outlines.
          </p>
        </>
      )}

      <div className="my-3 border-t border-edge" />

      <Slider
        label="Volume"
        value={settings.masterGain}
        min={0}
        max={1.2}
        step={0.05}
        onChange={(masterGain) => patchSettings({ masterGain })}
        format={(v) => `${Math.round(v * 100)}%`}
      />

      <Slider
        label="Space"
        value={settings.space}
        min={0}
        max={1}
        step={0.05}
        onChange={(space) => patchSettings({ space })}
        format={(v) => `${Math.round(v * 100)}%`}
        hint="Reverb send."
      />

      <Slider
        label="Camera dim"
        value={settings.cameraDim}
        min={0}
        max={0.8}
        step={0.05}
        onChange={(cameraDim) => patchSettings({ cameraDim })}
        format={(v) => `${Math.round(v * 100)}%`}
        hint="Darkens the video so the pads stand out. Raise it in bright rooms."
      />

      <div className="mt-3 space-y-2 border-t border-edge pt-3">
        <Toggle
          label="Show hand skeleton"
          checked={settings.showSkeleton}
          onChange={(showSkeleton) => patchSettings({ showSkeleton })}
        />
        <Toggle
          label="Show prediction lead"
          checked={settings.showPrediction}
          onChange={(showPrediction) => patchSettings({ showPrediction })}
        />
      </div>
    </Panel>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-2">
      <span className="text-[12px] text-ink-dim">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors ${
          checked ? "border-signal/50 bg-signal/25" : "border-edge bg-chassis"
        }`}
      >
        <span
          className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all ${
            checked ? "left-4.5 bg-signal" : "left-0.5 bg-ink-faint"
          }`}
        />
      </button>
    </label>
  );
}
