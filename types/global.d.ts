/**
 * `requestVideoFrameCallback` is widely shipped (Chrome, Safari, Edge) but is
 * not yet in TypeScript's bundled lib.dom. We depend on it for frame-accurate,
 * duplicate-free hand tracking, so declare it here.
 *
 * Spec: https://wicg.github.io/video-rvfc/
 */
interface VideoFrameCallbackMetadata {
  presentationTime: DOMHighResTimeStamp;
  expectedDisplayTime: DOMHighResTimeStamp;
  width: number;
  height: number;
  mediaTime: number;
  presentedFrames: number;
  processingDuration?: number;
  /** Only present for camera/WebRTC sources. */
  captureTime?: DOMHighResTimeStamp;
  receiveTime?: DOMHighResTimeStamp;
  rtpTimestamp?: number;
}

type VideoFrameRequestCallback = (
  now: DOMHighResTimeStamp,
  metadata: VideoFrameCallbackMetadata,
) => void;

interface HTMLVideoElement {
  requestVideoFrameCallback?(callback: VideoFrameRequestCallback): number;
  cancelVideoFrameCallback?(handle: number): void;
}
