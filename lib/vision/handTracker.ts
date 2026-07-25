import type {
  HandLandmarker,
  HandLandmarkerResult,
} from "@mediapipe/tasks-vision";

/**
 * MediaPipe hand tracking, wrapped so the rest of the app never imports the
 * WASM bundle directly.
 *
 * Two decisions here are latency decisions:
 *
 * 1. We drive detection from `requestVideoFrameCallback` when the browser has
 *    it, not `requestAnimationFrame`. rVFC fires once per *decoded camera
 *    frame* and hands us that frame's real presentation timestamp. rAF fires on
 *    the display refresh, which is uncorrelated with the camera — so it either
 *    processes the same frame twice (wasted inference) or misses one (added
 *    latency). rVFC also exposes `processingDuration`, letting us show the user
 *    the true capture-to-inference cost.
 *
 * 2. Detection runs in VIDEO mode with a single hand-presence pass, and we
 *    mirror coordinates here, once, so every downstream consumer works in the
 *    same space the user sees.
 */

export const HAND_CONNECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],          // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],          // index
  [5, 9], [9, 10], [10, 11], [11, 12],     // middle
  [9, 13], [13, 14], [14, 15], [15, 16],   // ring
  [13, 17], [17, 18], [18, 19], [19, 20],  // pinky
  [0, 17],                                  // palm base
];

/**
 * Landmark indices we actually care about, named.
 *
 * The PIP/IP joints matter as much as the tips: comparing a tip's distance from
 * the wrist against its middle joint's is how we tell an extended finger from a
 * curled one, which is what separates a deliberate play from a resting hand.
 */
export const LM = {
  wrist: 0,
  thumbMcp: 2,
  thumbIp: 3,
  thumbTip: 4,
  indexMcp: 5,
  indexPip: 6,
  indexTip: 8,
  middleMcp: 9,
  middlePip: 10,
  middleTip: 12,
  ringMcp: 13,
  ringPip: 14,
  ringTip: 16,
  pinkyMcp: 17,
  pinkyPip: 18,
  pinkyTip: 20,
} as const;

export interface TrackedHand {
  /** "Left" / "Right" as labelled by MediaPipe, already corrected for mirroring. */
  handedness: "left" | "right";
  score: number;
  /** 21 landmarks, normalized 0..1, already mirrored into view space. */
  landmarks: { x: number; y: number; z: number }[];
}

export interface FrameResult {
  hands: TrackedHand[];
  /** Timestamp of the frame in ms, on the performance.now() clock. */
  timestampMs: number;
  /** Milliseconds spent inside MediaPipe inference for this frame. */
  inferenceMs: number;
  /**
   * Browser-reported capture-to-callback latency in ms, when available.
   * This is the camera half of the end-to-end budget.
   */
  captureLatencyMs: number | null;
}

export interface TrackerOptions {
  /** Where to load the WASM binaries and the .task model from. */
  wasmBase?: string;
  modelUrl?: string;
  numHands?: number;
  /** Mirror horizontally so the view behaves like a mirror. */
  mirror?: boolean;
  minHandDetectionConfidence?: number;
  minTrackingConfidence?: number;
}

const CDN_WASM =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const CDN_MODEL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

/** Prefer locally vendored assets (npm run vendor:vision), fall back to CDN. */
async function resolveAssets(opts: TrackerOptions) {
  const wasmBase = opts.wasmBase ?? "/vision/wasm";
  const modelUrl = opts.modelUrl ?? "/vision/hand_landmarker.task";
  try {
    const probe = await fetch(modelUrl, { method: "HEAD" });
    if (probe.ok) return { wasmBase, modelUrl };
  } catch {
    // fall through to CDN
  }
  return { wasmBase: CDN_WASM, modelUrl: CDN_MODEL };
}

export class HandTracker {
  private landmarker: HandLandmarker | null = null;
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private running = false;
  private rvfcHandle: number | null = null;
  private rafHandle: number | null = null;
  private lastVideoTime = -1;
  private mirror: boolean;
  private opts: TrackerOptions;

  constructor(opts: TrackerOptions = {}) {
    this.opts = opts;
    this.mirror = opts.mirror ?? true;
  }

  get videoElement(): HTMLVideoElement | null {
    return this.video;
  }

  setMirror(mirror: boolean): void {
    this.mirror = mirror;
  }

  /** Load the model. Safe to call once; subsequent calls are no-ops. */
  async load(): Promise<void> {
    if (this.landmarker) return;
    // Dynamic import keeps the WASM glue out of the initial page bundle.
    const { FilesetResolver, HandLandmarker } = await import(
      "@mediapipe/tasks-vision"
    );
    const { wasmBase, modelUrl } = await resolveAssets(this.opts);
    const fileset = await FilesetResolver.forVisionTasks(wasmBase);
    this.landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: modelUrl,
        delegate: "GPU",
      },
      runningMode: "VIDEO",
      numHands: this.opts.numHands ?? 2,
      minHandDetectionConfidence: this.opts.minHandDetectionConfidence ?? 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: this.opts.minTrackingConfidence ?? 0.5,
    });
  }

  /** Request the webcam and bind it to a video element. */
  async startCamera(video: HTMLVideoElement): Promise<void> {
    this.video = video;
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 960 },
        height: { ideal: 540 },
        // A high camera frame rate is the cheapest latency win available: at
        // 60fps the worst-case wait for the next frame is 16ms, not 33ms.
        frameRate: { ideal: 60, min: 30 },
        facingMode: "user",
      },
      audio: false,
    });
    video.srcObject = this.stream;
    await video.play();
  }

  /**
   * Begin the detection loop. `onFrame` is called synchronously per camera
   * frame — it is the hot path, so it must not allocate or touch React state.
   */
  start(onFrame: (result: FrameResult) => void): void {
    if (this.running) return;
    this.running = true;

    const video = this.video;
    const landmarker = this.landmarker;
    if (!video || !landmarker) {
      this.running = false;
      throw new Error("HandTracker: call load() and startCamera() first");
    }

    // Bind once so the narrowing survives into the closure below, and so we
    // schedule against the same element even if the ref is reassigned.
    const rvfc = video.requestVideoFrameCallback?.bind(video) ?? null;

    const process = (
      nowMs: number,
      meta?: VideoFrameCallbackMetadata,
    ): void => {
      if (!this.running) return;

      // Skip if the decoder has not produced a new frame — running inference on
      // a duplicate frame burns GPU time and buys nothing.
      if (video.currentTime !== this.lastVideoTime && video.readyState >= 2) {
        this.lastVideoTime = video.currentTime;

        const t0 = performance.now();
        let raw: HandLandmarkerResult | null = null;
        try {
          raw = landmarker.detectForVideo(video, t0);
        } catch {
          // A transient detect failure (e.g. GPU context loss on tab switch)
          // must not kill the loop.
          raw = null;
        }
        const inferenceMs = performance.now() - t0;

        if (raw) {
          // `captureTime` is the moment the camera produced the frame, on the
          // same clock as performance.now(). The gap to now is real, unavoidable
          // sensor+decode latency — we surface it so the user can see whether a
          // laggy feel is our fault or their webcam's.
          const captureLatencyMs =
            typeof meta?.captureTime === "number"
              ? Math.max(0, nowMs - meta.captureTime)
              : null;

          onFrame({
            hands: this.toTrackedHands(raw),
            timestampMs: t0,
            inferenceMs,
            captureLatencyMs,
          });
        }
      }

      if (rvfc) {
        this.rvfcHandle = rvfc(process);
      } else {
        this.rafHandle = requestAnimationFrame((t) => process(t));
      }
    };

    if (rvfc) {
      this.rvfcHandle = rvfc(process);
    } else {
      this.rafHandle = requestAnimationFrame((t) => process(t));
    }
  }

  stop(): void {
    this.running = false;
    if (this.rvfcHandle !== null && this.video?.cancelVideoFrameCallback) {
      this.video.cancelVideoFrameCallback(this.rvfcHandle);
      this.rvfcHandle = null;
    }
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
  }

  dispose(): void {
    this.stop();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.landmarker?.close();
    this.landmarker = null;
  }

  private toTrackedHands(result: HandLandmarkerResult): TrackedHand[] {
    const out: TrackedHand[] = [];
    for (let i = 0; i < result.landmarks.length; i++) {
      const lms = result.landmarks[i];
      const category = result.handedness[i]?.[0];
      // MediaPipe labels handedness from the *camera's* point of view. When we
      // mirror the image for the user, the labels must flip too, otherwise a
      // "left hand only" zone responds to the wrong hand.
      const rawLabel = (category?.categoryName ?? "Right").toLowerCase();
      const handedness: "left" | "right" = this.mirror
        ? rawLabel === "left"
          ? "right"
          : "left"
        : rawLabel === "left"
          ? "left"
          : "right";

      out.push({
        handedness,
        score: category?.score ?? 0,
        landmarks: lms.map((p) => ({
          x: this.mirror ? 1 - p.x : p.x,
          y: p.y,
          z: p.z,
        })),
      });
    }
    return out;
  }
}
