import { DuelShell } from "@/components/game/DuelShell";

/**
 * The duel.
 *
 * DuelShell is a client component; everything touching getUserMedia,
 * AudioContext or WebGL happens in effects and handlers, so the shell still
 * prerenders for a fast first paint. MediaPipe is dynamically imported inside
 * HandTracker.load(), keeping the WASM out of the initial bundle.
 */
export default function Page() {
  return <DuelShell />;
}
