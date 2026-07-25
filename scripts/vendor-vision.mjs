#!/usr/bin/env node
/**
 * Copy the MediaPipe WASM runtime and download the hand-landmarker model into
 * `public/vision`, so the studio loads them from your own origin.
 *
 * Why bother: the CDN fallback works, but it costs an extra ~8MB cross-origin
 * fetch on every cold load and stops working offline. Hosting locally also
 * means the model can be cached by your own service worker / CDN rules.
 *
 * Usage: npm run vendor:vision
 */

import { mkdir, copyFile, readdir, writeFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const OUT_DIR = path.resolve("public/vision");
const WASM_OUT = path.join(OUT_DIR, "wasm");

async function main() {
  await mkdir(WASM_OUT, { recursive: true });

  // --- WASM runtime, copied out of the installed package
  let wasmDir;
  try {
    const entry = require.resolve("@mediapipe/tasks-vision");
    wasmDir = path.join(path.dirname(entry), "wasm");
    await stat(wasmDir);
  } catch {
    console.error(
      "Could not locate @mediapipe/tasks-vision/wasm. Run `npm install` first.",
    );
    process.exit(1);
  }

  const files = await readdir(wasmDir);
  let copied = 0;
  for (const file of files) {
    await copyFile(path.join(wasmDir, file), path.join(WASM_OUT, file));
    copied++;
  }
  console.log(`Copied ${copied} WASM files -> public/vision/wasm`);

  // --- model
  const modelPath = path.join(OUT_DIR, "hand_landmarker.task");
  process.stdout.write("Downloading hand_landmarker.task… ");
  const response = await fetch(MODEL_URL);
  if (!response.ok) {
    console.error(`\nModel download failed: HTTP ${response.status}`);
    process.exit(1);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(modelPath, bytes);
  console.log(`${(bytes.length / 1024 / 1024).toFixed(1)} MB`);

  console.log("\nDone. The studio will now prefer these local assets.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
