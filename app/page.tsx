import Studio from "@/components/Studio";

/**
 * Studio is a client component. Everything that touches getUserMedia,
 * AudioContext or WebGL happens in effects and event handlers, so the shell
 * still prerenders on the server for a fast first paint. The MediaPipe WASM is
 * dynamically imported inside HandTracker.load(), which keeps it out of both
 * the server bundle and the initial client bundle.
 */
export default function Page() {
  return <Studio />;
}
