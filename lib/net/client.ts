import {
  PROTOCOL_VERSION,
  ROOM_CODE_LENGTH,
  SCORE_PUSH_HZ,
  WS_PATH,
  decodeServer,
  encode,
  type ClientMessage,
  type ScoreUpdate,
  type ServerMessage,
} from "@/lib/net/protocol";
import type { Chart, RoundSummary } from "@/lib/game/types";

/**
 * Browser side of the duel relay. Framework-agnostic on purpose — React binds to
 * it through `on`/`off` in an effect, so nothing in here ever touches a render.
 *
 * Two things this class is responsible for, and nothing else matters as much:
 *
 *  1. CLOCK SYNC. Both clients must agree on when the chart starts, and the only
 *     shared reference is the server's `Date.now()`. `serverNow()` is that
 *     estimate. It is used for the countdown only — never for judging, which
 *     runs entirely on the local AudioContext clock.
 *  2. NOT FLOODING THE WIRE. Score pushes are throttled to SCORE_PUSH_HZ, and
 *     the final update of a round is always flushed before the summary so the
 *     opponent's bar never freezes one tick short of the truth.
 */

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed";

export interface ConnectionState {
  status: ConnectionStatus;
  /** Consecutive failed attempts; 0 once connected. Drives the UI's retry copy. */
  attempt: number;
  /** Lowest round-trip time in the current clock window, ms. Null until synced. */
  rttMs: number | null;
}

/** Every server message is an event, keyed by its `type`, plus `status`. */
type ServerEventMap = { [M in ServerMessage as M["type"]]: M };
export type DuelEventMap = ServerEventMap & { status: ConnectionState };
export type DuelEvent = keyof DuelEventMap;
export type DuelHandler<K extends DuelEvent> = (
  payload: DuelEventMap[K],
) => void;

export interface DuelClientOptions {
  /** Override the derived `ws(s)://host/ws` endpoint. */
  url?: string;
}

type TimerHandle = ReturnType<typeof setTimeout>;

interface ClockSample {
  rttMs: number;
  offsetMs: number;
}

/** Rolling clock window. Small: only the best sample in it is ever used. */
const CLOCK_WINDOW = 8;
/** Probe fast until the window fills, then back off — sync matters most at join. */
const PING_PRIME_MS = 400;
const PING_STEADY_MS = 3000;
/** A round trip longer than this is a stall, not a measurement. */
const MAX_PLAUSIBLE_RTT_MS = 4000;

const RECONNECT_BASE_MS = 400;
const RECONNECT_CAP_MS = 8000;
const RECONNECT_FACTOR = 1.8;

/** Control messages queued across a reconnect. Deliberately tiny. */
const MAX_OUTBOX = 8;

export class DuelClient {
  private readonly url: string;
  private readonly listeners = new Map<
    DuelEvent,
    Set<(payload: never) => void>
  >();

  private socket: WebSocket | null = null;
  private name = "Player";
  private id: string | null = null;
  private code: string | null = null;

  private statusValue: ConnectionStatus = "idle";
  private attempt = 0;
  private intentional = false;

  private reconnectTimer: TimerHandle | null = null;
  private pingTimer: TimerHandle | null = null;

  private readonly outbox: ClientMessage[] = [];

  private readonly samples: ClockSample[] = [];
  private clockOffsetMs: number;
  private bestRttMs: number | null = null;

  private pendingScore: ScoreUpdate | null = null;
  private scoreTimer: TimerHandle | null = null;
  private lastScoreAt = 0;
  private readonly scoreIntervalMs = 1000 / SCORE_PUSH_HZ;

  private ready: Promise<void> | null = null;
  private settle: { resolve: () => void; reject: (e: Error) => void } | null =
    null;

  constructor(options: DuelClientOptions = {}) {
    this.url = options.url ?? defaultUrl();
    // Seed: assume the two wall clocks agree. Usually within a second or two,
    // and it is replaced by a measured offset as soon as the first pong lands.
    this.clockOffsetMs = Date.now() - performance.now();
  }

  // ------------------------------------------------------------- accessors

  get playerId(): string | null {
    return this.id;
  }

  get roomCode(): string | null {
    return this.code;
  }

  get status(): ConnectionStatus {
    return this.statusValue;
  }

  /**
   * Server wall-clock estimate, in the same domain as `countdown.startAtServerMs`.
   * Compare against this — never against `Date.now()` — to decide when to start.
   */
  serverNow(): number {
    return performance.now() + this.clockOffsetMs;
  }

  // ------------------------------------------------------------- connection

  /**
   * Resolves when the server's `welcome` arrives. If the very first attempt
   * fails the promise rejects so callers never await forever, but reconnection
   * continues in the background — watch the `status` event for the real state.
   */
  connect(name: string): Promise<void> {
    this.name = name.trim().slice(0, 16) || "Player";
    this.intentional = false;

    if (this.socket?.readyState === WebSocket.OPEN && this.id) {
      return Promise.resolve();
    }
    if (!this.ready) {
      this.ready = new Promise<void>((resolve, reject) => {
        this.settle = { resolve, reject };
      });
    }
    // A retry may already be in flight; opening a second socket here would
    // leave an orphan the server sees as a third player.
    if (!this.socket && !this.reconnectTimer) this.openSocket();
    return this.ready;
  }

  disconnect(): void {
    this.intentional = true;
    this.clearTimer("reconnectTimer");
    this.clearTimer("pingTimer");
    this.clearTimer("scoreTimer");
    this.pendingScore = null;
    this.outbox.length = 0;

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close(1000, "client closed");
      }
    }

    this.rejectPending(new Error("Disconnected"));
    this.ready = null;
    this.id = null;
    this.code = null;
    this.setStatus("closed");
  }

  // ------------------------------------------------------------- room verbs

  createRoom(): void {
    this.code = null;
    this.post({ type: "create" });
  }

  /**
   * `this.code` is only ever set from a server `room` frame, never from here —
   * an optimistic code would make the reconnect logic retry a room that was
   * rejected as full or nonexistent.
   */
  joinRoom(code: string): void {
    this.post({
      type: "join",
      code: code.trim().toUpperCase().slice(0, ROOM_CODE_LENGTH),
    });
  }

  leaveRoom(): void {
    this.code = null;
    this.post({ type: "leave" });
  }

  setReady(ready: boolean): void {
    this.post({ type: "ready", ready });
  }

  setChart(chart: Chart): void {
    this.post({ type: "setChart", chart });
  }

  start(): void {
    this.post({ type: "start" });
  }

  // ------------------------------------------------------------- score wire

  /**
   * Coalescing throttle: the newest update wins and at most SCORE_PUSH_HZ of
   * them leave per second. Dropping intermediate frames is free here because
   * every update is a full snapshot, not a delta.
   */
  sendScore(update: ScoreUpdate): void {
    this.pendingScore = update;
    this.pumpScore();
  }

  sendRoundDone(summary: RoundSummary): void {
    this.flushScore();
    this.post({ type: "roundDone", summary });
  }

  sendMatchDone(summary: RoundSummary): void {
    this.flushScore();
    this.post({ type: "matchDone", summary });
  }

  private pumpScore(): void {
    if (!this.pendingScore || this.scoreTimer) return;
    const wait = this.scoreIntervalMs - (performance.now() - this.lastScoreAt);
    if (wait <= 0) {
      this.flushScore();
      return;
    }
    this.scoreTimer = setTimeout(() => {
      this.scoreTimer = null;
      this.pumpScore();
    }, wait);
  }

  private flushScore(): void {
    this.clearTimer("scoreTimer");
    const update = this.pendingScore;
    if (!update) return;
    this.pendingScore = null;
    this.lastScoreAt = performance.now();
    this.post({ type: "score", update });
  }

  // ------------------------------------------------------------- emitter

  on<K extends DuelEvent>(event: K, handler: DuelHandler<K>): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
  }

  off<K extends DuelEvent>(event: K, handler: DuelHandler<K>): void {
    this.listeners.get(event)?.delete(handler);
  }

  private dispatch(
    event: DuelEvent,
    payload: DuelEventMap[DuelEvent],
  ): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Snapshot: a handler is allowed to unsubscribe itself while we iterate.
    for (const handler of [...set]) {
      try {
        (handler as (p: DuelEventMap[DuelEvent]) => void)(payload);
      } catch {
        // A UI exception must not tear down the socket mid-match.
      }
    }
  }

  // ------------------------------------------------------------- socket

  private openSocket(): void {
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      // `hello` must be the first frame; WebSocket ordering guarantees the
      // queued messages behind it arrive after the server has seated us.
      socket.send(
        encode({ type: "hello", version: PROTOCOL_VERSION, name: this.name }),
      );

      // Reconnecting into a room we already believe we are in: the server holds
      // the seat through a short grace period precisely so this works.
      if (this.code) {
        socket.send(encode({ type: "join", code: this.code }));
      }
      const queued = this.outbox.splice(0, this.outbox.length);
      for (const message of queued) {
        if (this.code && (message.type === "join" || message.type === "create")) {
          continue; // already covered by the auto-rejoin above
        }
        socket.send(encode(message));
      }

      this.setStatus("open");
      this.samples.length = 0;
      this.bestRttMs = null;
      this.schedulePing(0);
    };

    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      if (typeof event.data !== "string") return; // protocol is text-only
      const message = decodeServer(event.data);
      if (!message) return; // malformed frames are dropped, never trusted
      this.handle(message);
    };

    socket.onerror = () => {
      // `onclose` always follows; reconnection is driven from there alone so a
      // single failure cannot schedule two overlapping retries.
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimer("pingTimer");
      this.id = null;
      if (this.intentional) {
        this.setStatus("closed");
        return;
      }
      this.rejectPending(new Error("Connection closed"));
      this.scheduleReconnect();
    };
  }

  private handle(message: ServerMessage): void {
    switch (message.type) {
      case "welcome":
        this.id = message.playerId;
        this.attempt = 0;
        this.setStatus("open");
        this.resolveReady();
        break;
      case "room":
        this.code = message.code;
        break;
      case "pong":
        // Consumed internally: clock sync is plumbing, not a UI event.
        this.acceptPong(message.t, message.serverMs);
        return;
      default:
        break;
    }
    this.dispatch(message.type, message);
  }

  private scheduleReconnect(): void {
    if (this.intentional || this.reconnectTimer) return;
    this.attempt += 1;
    const backoff = Math.min(
      RECONNECT_CAP_MS,
      RECONNECT_BASE_MS * RECONNECT_FACTOR ** (this.attempt - 1),
    );
    // Jitter: both duellists lose the same server at the same instant, and
    // retrying in lockstep would just re-collide on every attempt.
    const delay = backoff * (0.8 + Math.random() * 0.4);
    this.setStatus("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  // ------------------------------------------------------------- clock sync

  private schedulePing(delayMs: number): void {
    this.clearTimer("pingTimer");
    this.pingTimer = setTimeout(() => {
      this.pingTimer = null;
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(encode({ type: "ping", t: performance.now() }));
      this.schedulePing(
        this.samples.length < CLOCK_WINDOW ? PING_PRIME_MS : PING_STEADY_MS,
      );
    }, delayMs);
  }

  private acceptPong(sentAt: number, serverMs: number): void {
    const rttMs = performance.now() - sentAt;
    if (!(rttMs >= 0) || rttMs > MAX_PLAUSIBLE_RTT_MS) return;

    // Assume the trip was symmetric: the server stamped `serverMs` when our
    // clock read `sentAt + rtt/2`.
    const offsetMs = serverMs - (sentAt + rttMs / 2);

    this.samples.push({ rttMs, offsetMs });
    if (this.samples.length > CLOCK_WINDOW) this.samples.shift();

    // Take the LOWEST-rtt sample rather than an average. The symmetry
    // assumption above is the only thing that can be wrong, and it is wrong in
    // proportion to how much the packet was delayed — a frame that sat in a
    // queue inflates one leg of the trip and biases the offset by half of that
    // delay. The fastest round trip in the window is the one least contaminated
    // by queueing, so it is the most accurate estimate available; averaging
    // would drag the good sample toward the bad ones. This is why NTP does the
    // same thing.
    let best = this.samples[0];
    for (const sample of this.samples) {
      if (sample.rttMs < best.rttMs) best = sample;
    }

    const improved = this.bestRttMs === null || best.rttMs < this.bestRttMs;
    this.clockOffsetMs = best.offsetMs;
    this.bestRttMs = best.rttMs;
    // Only surface a genuinely better measurement, so the UI is not repainted
    // several times a second by noise.
    if (improved) this.emitStatus();
  }

  // ------------------------------------------------------------- plumbing

  private post(message: ClientMessage): void {
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN && this.id) {
      socket.send(encode(message));
      return;
    }
    // Scores and pings are worthless once stale — a replayed ping would poison
    // the clock estimate with a fabricated round trip. Only room control
    // messages are worth carrying across a reconnect.
    if (message.type === "score" || message.type === "ping") return;
    if (this.outbox.length >= MAX_OUTBOX) this.outbox.shift();
    this.outbox.push(message);
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.statusValue === status) return;
    this.statusValue = status;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.dispatch("status", {
      status: this.statusValue,
      attempt: this.attempt,
      rttMs: this.bestRttMs,
    });
  }

  /**
   * `ready` is dropped once settled either way, so a later `connect()` after a
   * `disconnect()` gets a fresh promise instead of a stale resolved one.
   */
  private resolveReady(): void {
    const settle = this.settle;
    this.settle = null;
    this.ready = null;
    settle?.resolve();
  }

  private rejectPending(error: Error): void {
    const settle = this.settle;
    if (!settle) return;
    this.settle = null;
    this.ready = null;
    settle.reject(error);
  }

  private clearTimer(key: "reconnectTimer" | "pingTimer" | "scoreTimer"): void {
    const timer = this[key];
    if (timer === null) return;
    clearTimeout(timer);
    this[key] = null;
  }
}

function defaultUrl(): string {
  if (typeof window === "undefined") {
    throw new Error("DuelClient is browser-only; construct it in an effect.");
  }
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}${WS_PATH}`;
}
