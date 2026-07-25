import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // MediaPipe ships a large WASM bundle that must not be pre-bundled by webpack/turbopack.
  // We load it from `public/vision` (or a CDN) at runtime instead.
  experimental: {
    optimizePackageImports: ["@mediapipe/tasks-vision"],
  },

  async headers() {
    return [
      {
        // The tracking model and WASM runtime are ~19MB and content-stable.
        // Serving them same-origin with an immutable cache turns a repeat visit
        // from an 8MB cross-origin download into a disk read.
        source: "/vision/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
      {
        source: "/fonts/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
