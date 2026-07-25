import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // MediaPipe ships a large WASM bundle that must not be pre-bundled by webpack/turbopack.
  // We load it from `public/vision` (or a CDN) at runtime instead.
  experimental: {
    optimizePackageImports: ["@mediapipe/tasks-vision"],
  },
};

export default nextConfig;
