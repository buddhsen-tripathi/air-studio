/**
 * One Euro filter (Casiez, Roussel & Vogel, CHI 2012).
 *
 * Why this and not a plain low-pass: raw MediaPipe landmarks jitter by a few
 * pixels even when the hand is still, which makes zone boundaries chatter and
 * fires phantom hits. A fixed low-pass removes the jitter but adds constant lag
 * — fatal for an instrument, because lag is exactly what we are fighting.
 *
 * One Euro adapts its cutoff to the speed of the signal: nearly still hands get
 * heavy smoothing (no jitter), fast hands get almost none (no lag). That
 * asymmetry is what makes air-drumming feel tight rather than mushy.
 */

class LowPassFilter {
  private y: number | null = null;

  filter(x: number, alpha: number): number {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }

  get last(): number | null {
    return this.y;
  }

  reset(): void {
    this.y = null;
  }
}

export interface OneEuroConfig {
  /**
   * Cutoff in Hz at zero speed. Lower = steadier when still, but slower to
   * start moving. 1.2 is a good default for hand landmarks at 30-60fps.
   */
  minCutoff: number;
  /**
   * Speed coefficient. Higher = the filter gets out of the way faster as the
   * hand accelerates. This is the knob that trades jitter for lag.
   */
  beta: number;
  /** Cutoff for the derivative estimate itself. Rarely needs changing. */
  derivativeCutoff: number;
}

/**
 * Tuned for responsiveness over steadiness.
 *
 * These are the single biggest source of *felt* lag that we actually control.
 * Smoothing lag is real lag: at minCutoff 1.2 a hand that starts moving takes
 * ~130ms to be believed, which lands on top of the camera's own 40-80ms and is
 * plainly visible as the cursor trailing your fingertip.
 *
 * Raising minCutoff cuts the lag at rest; raising beta makes the filter get out
 * of the way much harder as soon as you move, which is exactly the moment that
 * matters for a strike. The cost is a little more jitter when your hand is
 * still — and a still hand is not about to trigger anything, so that jitter is
 * invisible in practice.
 */
export const DEFAULT_ONE_EURO: OneEuroConfig = {
  minCutoff: 2.2,
  beta: 0.11,
  derivativeCutoff: 1.2,
};

export class OneEuroFilter {
  private xFilter = new LowPassFilter();
  private dxFilter = new LowPassFilter();
  private lastTimeMs: number | null = null;
  /** Filtered derivative in units/second — reused by the trigger engine. */
  private velocity = 0;

  constructor(private config: OneEuroConfig = DEFAULT_ONE_EURO) {}

  setConfig(config: OneEuroConfig): void {
    this.config = config;
  }

  /** Most recent filtered speed, in normalized units per second. */
  get speed(): number {
    return this.velocity;
  }

  filter(x: number, timestampMs: number): number {
    if (this.lastTimeMs === null) {
      this.lastTimeMs = timestampMs;
      this.velocity = 0;
      return this.xFilter.filter(x, 1);
    }

    // Guard against zero/negative dt: duplicate frames and clock jitter would
    // otherwise produce an infinite derivative and blow up the cutoff.
    const dt = Math.max((timestampMs - this.lastTimeMs) / 1000, 1e-4);
    this.lastTimeMs = timestampMs;

    const previous = this.xFilter.last ?? x;
    const dx = (x - previous) / dt;
    const edx = this.dxFilter.filter(
      dx,
      alpha(this.config.derivativeCutoff, dt),
    );
    this.velocity = edx;

    const cutoff = this.config.minCutoff + this.config.beta * Math.abs(edx);
    return this.xFilter.filter(x, alpha(cutoff, dt));
  }

  reset(): void {
    this.xFilter.reset();
    this.dxFilter.reset();
    this.lastTimeMs = null;
    this.velocity = 0;
  }
}

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

/** A 2D point smoothed by an independent One Euro filter per axis. */
export class SmoothedPoint {
  private fx: OneEuroFilter;
  private fy: OneEuroFilter;

  x = 0;
  y = 0;
  /** Signed velocity in normalized units/second. */
  vx = 0;
  vy = 0;
  /** True once the point has received at least one sample. */
  live = false;

  constructor(config: OneEuroConfig = DEFAULT_ONE_EURO) {
    this.fx = new OneEuroFilter(config);
    this.fy = new OneEuroFilter(config);
  }

  setConfig(config: OneEuroConfig): void {
    this.fx.setConfig(config);
    this.fy.setConfig(config);
  }

  update(x: number, y: number, timestampMs: number): void {
    this.x = this.fx.filter(x, timestampMs);
    this.y = this.fy.filter(y, timestampMs);
    this.vx = this.fx.speed;
    this.vy = this.fy.speed;
    this.live = true;
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
    this.live = false;
    this.vx = 0;
    this.vy = 0;
  }

  /** Magnitude of the velocity vector, normalized units/second. */
  get speed(): number {
    return Math.hypot(this.vx, this.vy);
  }
}
