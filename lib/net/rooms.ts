import {
  COUNTDOWN_LEAD_MS,
  PROTOCOL_VERSION,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  decodeClient,
  type ClientMessage,
  type Player,
  type RoomPhase,
  type ScoreUpdate,
  type ServerMessage,
} from "@/lib/net/protocol";
import type { Chart, RoundSummary } from "@/lib/game/types";

/**
 * In-memory room registry — the entire "server" of Air Piano Duel.
 *
 * It is deliberately transport-agnostic: it never imports `ws`, and emits
 * through injected `send`/`close` callbacks. That keeps it unit-testable from a
 * plain Node script and keeps `server.mjs` down to socket plumbing.
 *
 * What it does NOT do is as important as what it does. It never simulates the
 * game, never judges a hit, never holds a chart clock. Both clients judge
 * locally against the shared chart on their own audio clock and report results;
 * this registry only decides *who is in which room*, *when the countdown
 * starts*, and *who won*. Everything else is a relay.
 */

/** Rooms outlive a disconnect by this long so a page refresh can reclaim a seat. */
const DEFAULT_EMPTY_ROOM_GRACE_MS = 90_000;

/** Cheap DoS ceiling. A duel room is tiny, but unbounded maps are not. */
const DEFAULT_MAX_ROOMS = 500;

/** 32^4 ≈ 1M codes, so a collision is rare; give up rather than spin forever. */
const CODE_ATTEMPTS = 64;

const SEATS = 2;

/**
 * `lib.dom` and `@types/node` both declare `setTimeout` with different return
 * types, and which one wins here depends on lib ordering. Naming the handle
 * once keeps that ambiguity out of every call site.
 */
type TimerHandle = ReturnType<typeof setTimeout>;

/** Best-effort `unref`, a no-op under the DOM typing of `setTimeout`. */
function unrefTimer(timer: TimerHandle): void {
  (timer as unknown as { unref?: () => void }).unref?.();
}

export interface RoomRegistryOptions {
  /** Deliver a message to one connection. Must not throw. */
  send: (playerId: string, message: ServerMessage) => void;
  /** Optional hard close, used for protocol-version mismatches. */
  close?: (playerId: string, reason: string) => void;
  /** Injectable clock, for tests. */
  now?: () => number;
  emptyRoomGraceMs?: number;
  maxRooms?: number;
}

/** A seated player plus the per-round bookkeeping the registry needs. */
interface Member {
  id: string;
  name: string;
  ready: boolean;
  connected: boolean;
  seat: 0 | 1;
  disconnectedAt: number | null;
  /** Summary for the round currently in flight; cleared at each countdown. */
  roundSummary: RoundSummary | null;
  /** Final summary for the whole match. */
  matchSummary: RoundSummary | null;
}

interface Room {
  code: string;
  hostId: string;
  phase: RoomPhase;
  /** Index into `chart.rounds` of the round being played or just played. */
  round: number;
  chart: Chart | null;
  members: Map<string, Member>;
  /** seat index -> playerId. Seat identity drives the UI accent colours. */
  seats: (string | null)[];
  startTimer: TimerHandle | null;
  reapTimer: TimerHandle | null;
}

/** Per-connection state. `name` stays null until a valid `hello` arrives. */
interface Connection {
  id: string;
  name: string | null;
  roomCode: string | null;
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly connections = new Map<string, Connection>();
  private readonly send: RoomRegistryOptions["send"];
  private readonly closeConn: (playerId: string, reason: string) => void;
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly maxRooms: number;

  constructor(options: RoomRegistryOptions) {
    this.send = options.send;
    this.closeConn = options.close ?? (() => {});
    this.now = options.now ?? Date.now;
    this.graceMs = options.emptyRoomGraceMs ?? DEFAULT_EMPTY_ROOM_GRACE_MS;
    this.maxRooms = options.maxRooms ?? DEFAULT_MAX_ROOMS;
  }

  // ------------------------------------------------------------- lifecycle

  /** Register a freshly accepted socket. `playerId` must be unguessable. */
  open(playerId: string): void {
    this.connections.set(playerId, { id: playerId, name: null, roomCode: null });
  }

  /**
   * Handle one inbound frame. Every field is re-validated with `decodeClient`
   * before anything is mutated — this is the trust boundary, and the schema is
   * the only thing standing between a hostile client and the room state.
   */
  receive(playerId: string, raw: string): void {
    const conn = this.connections.get(playerId);
    if (!conn) return;

    const msg = decodeClient(raw);
    if (!msg) {
      this.error(playerId, "Malformed message");
      return;
    }

    // `hello` gates everything: without it we have no name to seat a player
    // with, and no proof the peer speaks this protocol version.
    if (conn.name === null && msg.type !== "hello") {
      this.error(playerId, "Expected hello first");
      return;
    }

    try {
      this.dispatch(conn, msg);
    } catch {
      // A registry bug must never take the process down with both players in it.
      this.error(playerId, "Server error");
    }
  }

  /** Socket closed. The seat is held (not freed) so a refresh can reclaim it. */
  close(playerId: string): void {
    const conn = this.connections.get(playerId);
    if (!conn) return;
    this.connections.delete(playerId);

    const room = conn.roomCode ? this.rooms.get(conn.roomCode) : undefined;
    if (!room) return;

    const member = room.members.get(playerId);
    if (!member) return;

    member.connected = false;
    member.ready = false;
    member.disconnectedAt = this.now();

    this.promoteHostIfNeeded(room);
    this.notifyOthers(room, playerId, { type: "opponentLeft", playerId });
    this.settleLobbyPhase(room);
    this.broadcastRoom(room);

    // A player who vanished mid-round would otherwise deadlock the survivor,
    // who waits forever for a summary that is never coming.
    this.tryResolveRound(room);
    this.tryResolveMatch(room);
    this.scheduleReapIfEmpty(room);
  }

  /** Drop every timer so the process can exit cleanly. */
  shutdown(): void {
    for (const room of this.rooms.values()) {
      if (room.startTimer) clearTimeout(room.startTimer);
      if (room.reapTimer) clearTimeout(room.reapTimer);
    }
    this.rooms.clear();
    this.connections.clear();
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  // ------------------------------------------------------------- dispatch

  private dispatch(conn: Connection, msg: ClientMessage): void {
    switch (msg.type) {
      case "hello":
        return this.onHello(conn, msg.version, msg.name);
      case "create":
        return this.onCreate(conn);
      case "join":
        return this.onJoin(conn, msg.code);
      case "leave":
        return this.leaveRoom(conn);
      case "ready":
        return this.onReady(conn, msg.ready);
      case "setChart":
        return this.onSetChart(conn, msg.chart);
      case "start":
        return this.onStart(conn);
      case "score":
        return this.onScore(conn, msg.update);
      case "roundDone":
        return this.onRoundDone(conn, msg.summary);
      case "matchDone":
        return this.onMatchDone(conn, msg.summary);
      case "ping":
        this.send(conn.id, { type: "pong", t: msg.t, serverMs: this.now() });
        return;
    }
  }

  private onHello(conn: Connection, version: number, name: string): void {
    if (version !== PROTOCOL_VERSION) {
      this.error(
        conn.id,
        `Protocol mismatch: server speaks v${PROTOCOL_VERSION}, you sent v${version}. Reload the page.`,
      );
      this.closeConn(conn.id, "protocol version");
      return;
    }
    conn.name = name;
    this.send(conn.id, {
      type: "welcome",
      playerId: conn.id,
      version: PROTOCOL_VERSION,
    });
  }

  private onCreate(conn: Connection): void {
    this.leaveRoom(conn);

    if (this.rooms.size >= this.maxRooms) {
      this.error(conn.id, "Server is at capacity, try again shortly");
      return;
    }

    const code = this.mintCode();
    if (!code) {
      this.error(conn.id, "Could not allocate a room code, try again");
      return;
    }

    const room: Room = {
      code,
      hostId: conn.id,
      phase: "lobby",
      round: 0,
      chart: null,
      members: new Map(),
      seats: new Array<string | null>(SEATS).fill(null),
      startTimer: null,
      reapTimer: null,
    };
    this.rooms.set(code, room);
    this.seat(room, conn, 0);
    this.broadcastRoom(room);
  }

  private onJoin(conn: Connection, code: string): void {
    const room = this.rooms.get(code);
    if (!room) {
      this.error(conn.id, `No room ${code}`);
      return;
    }
    if (room.members.has(conn.id)) return; // idempotent: a duplicate join is a no-op

    const seatIndex = this.pickSeat(room);
    if (seatIndex === null) {
      this.error(conn.id, "That room is full");
      return;
    }

    this.leaveRoom(conn);

    // The seat may have belonged to a player who dropped; evicting the ghost is
    // what lets a refreshing player walk straight back into their own seat.
    const ghostId = room.seats[seatIndex];
    if (ghostId) room.members.delete(ghostId);

    if (room.reapTimer) {
      clearTimeout(room.reapTimer);
      room.reapTimer = null;
    }

    this.seat(room, conn, seatIndex);

    // Late joiners need the chart to render the highway before the countdown.
    if (room.chart) this.send(conn.id, { type: "chart", chart: room.chart });

    this.settleLobbyPhase(room);
    this.broadcastRoom(room);
  }

  private onReady(conn: Connection, ready: boolean): void {
    const room = this.roomOf(conn);
    if (!room) return;
    const member = room.members.get(conn.id);
    if (!member) return;

    member.ready = ready;
    this.settleLobbyPhase(room);
    this.broadcastRoom(room);
  }

  private onSetChart(conn: Connection, chart: Chart): void {
    const room = this.roomOf(conn);
    if (!room) return;
    if (room.hostId !== conn.id) {
      this.error(conn.id, "Only the host sets the chart");
      return;
    }
    // Swapping the chart mid-match would desync the two highways, because each
    // client has already scheduled notes off the old one.
    if (room.phase !== "lobby" && room.phase !== "loading") {
      this.error(conn.id, "Cannot change the chart mid-match");
      return;
    }

    room.chart = chart;
    room.round = 0;
    this.broadcastAll(room, { type: "chart", chart });
    this.settleLobbyPhase(room);
    this.broadcastRoom(room);
  }

  private onStart(conn: Connection): void {
    const room = this.roomOf(conn);
    if (!room) return;
    if (room.hostId !== conn.id) {
      this.error(conn.id, "Only the host can start");
      return;
    }
    if (!room.chart) {
      this.error(conn.id, "No chart loaded yet");
      return;
    }
    if (room.phase === "countdown" || room.phase === "playing") return;

    const nextRound = room.phase === "roundBreak" ? room.round + 1 : room.round;
    if (nextRound >= room.chart.rounds.length) {
      this.error(conn.id, "No rounds left");
      return;
    }

    const live = this.liveMembers(room);
    if (live.length === 0) return;
    if (!live.every((m) => m.ready)) {
      this.error(conn.id, "Both players must be ready");
      return;
    }

    room.round = nextRound;
    room.phase = "countdown";
    for (const member of room.members.values()) member.roundSummary = null;

    // Both clients converge on this absolute server timestamp through their
    // ping-derived clock offset, so they start within a few tens of ms of each
    // other. That is cosmetic only — scoring is judged independently per client.
    const startAtServerMs = this.now() + COUNTDOWN_LEAD_MS;

    this.broadcastRoom(room);
    this.broadcastAll(room, {
      type: "countdown",
      startAtServerMs,
      round: nextRound,
    });

    if (room.startTimer) clearTimeout(room.startTimer);
    room.startTimer = setTimeout(() => {
      room.startTimer = null;
      if (room.phase !== "countdown") return;
      room.phase = "playing";
      this.broadcastRoom(room);
    }, COUNTDOWN_LEAD_MS);
  }

  private onScore(conn: Connection, update: ScoreUpdate): void {
    const room = this.roomOf(conn);
    if (!room) return;
    // Never echoed to the sender: the sender already owns this number, and a
    // round trip of its own score is the one thing it must not render.
    this.notifyOthers(room, conn.id, {
      type: "opponentScore",
      playerId: conn.id,
      update,
    });
  }

  private onRoundDone(conn: Connection, summary: RoundSummary): void {
    const room = this.roomOf(conn);
    if (!room) return;
    const member = room.members.get(conn.id);
    if (!member) return;

    member.roundSummary = summary;
    this.tryResolveRound(room);
  }

  private onMatchDone(conn: Connection, summary: RoundSummary): void {
    const room = this.roomOf(conn);
    if (!room) return;
    const member = room.members.get(conn.id);
    if (!member) return;

    member.matchSummary = summary;
    this.tryResolveMatch(room);
  }

  // ------------------------------------------------------------- resolution

  /**
   * A round resolves once every *still-connected* member has reported. Waiting
   * on disconnected members instead would hang the survivor's result screen
   * forever, which is a far worse failure than a one-sided scoreboard.
   */
  private tryResolveRound(room: Room): void {
    if (room.phase !== "countdown" && room.phase !== "playing") return;

    const reported = [...room.members.values()].filter((m) => m.roundSummary);
    if (reported.length === 0) return;
    if (this.liveMembers(room).some((m) => !m.roundSummary)) return;

    if (room.startTimer) {
      clearTimeout(room.startTimer);
      room.startTimer = null;
    }
    room.phase = "roundBreak";

    this.broadcastAll(room, {
      type: "roundResult",
      round: room.round,
      summaries: reported.map((m) => ({
        playerId: m.id,
        // Non-null: `reported` is filtered on it, but TS cannot see through that.
        summary: m.roundSummary as RoundSummary,
      })),
    });

    for (const member of room.members.values()) member.roundSummary = null;
    this.broadcastRoom(room);
  }

  private tryResolveMatch(room: Room): void {
    if (room.phase === "finished" || room.phase === "lobby") return;

    const reported = [...room.members.values()].filter((m) => m.matchSummary);
    if (reported.length === 0) return;
    if (this.liveMembers(room).some((m) => !m.matchSummary)) return;

    const summaries = reported.map((m) => ({
      playerId: m.id,
      summary: m.matchSummary as RoundSummary,
    }));

    // Highest score wins; an exact tie yields no winner rather than a coin flip.
    const ranked = [...summaries].sort(
      (a, b) => b.summary.score - a.summary.score,
    );
    const tied = ranked.length > 1 && ranked[0].summary.score === ranked[1].summary.score;
    const winnerId = tied ? null : ranked[0].playerId;

    room.phase = "finished";
    this.broadcastAll(room, { type: "matchResult", winnerId, summaries });
    this.broadcastRoom(room);
  }

  // ------------------------------------------------------------- membership

  private seat(room: Room, conn: Connection, seatIndex: number): void {
    const member: Member = {
      id: conn.id,
      name: conn.name ?? "Player",
      ready: false,
      connected: true,
      seat: seatIndex === 0 ? 0 : 1,
      disconnectedAt: null,
      roundSummary: null,
      matchSummary: null,
    };
    room.members.set(conn.id, member);
    room.seats[seatIndex] = conn.id;
    conn.roomCode = room.code;

    // The host may have been the ghost we just evicted from this seat.
    if (!room.members.has(room.hostId)) room.hostId = conn.id;
  }

  /** Prefer an empty seat, else the seat whose occupant dropped longest ago. */
  private pickSeat(room: Room): number | null {
    for (let i = 0; i < SEATS; i++) {
      const id = room.seats[i];
      if (!id || !room.members.has(id)) return i;
    }

    let bestIndex: number | null = null;
    let bestAt = Infinity;
    for (let i = 0; i < SEATS; i++) {
      const member = room.members.get(room.seats[i] as string);
      if (!member || member.connected) continue;
      const at = member.disconnectedAt ?? 0;
      if (at < bestAt) {
        bestAt = at;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  private leaveRoom(conn: Connection): void {
    const room = this.roomOf(conn);
    conn.roomCode = null;
    if (!room) return;

    const existed = room.members.delete(conn.id);
    const seatIndex = room.seats.indexOf(conn.id);
    if (seatIndex >= 0) room.seats[seatIndex] = null;
    if (!existed) return;

    this.promoteHostIfNeeded(room);
    this.notifyOthers(room, conn.id, {
      type: "opponentLeft",
      playerId: conn.id,
    });
    this.settleLobbyPhase(room);
    this.broadcastRoom(room);
    this.tryResolveRound(room);
    this.tryResolveMatch(room);
    this.scheduleReapIfEmpty(room);
  }

  /** Host rights follow the lowest connected seat, so a room is never orphaned. */
  private promoteHostIfNeeded(room: Room): void {
    const host = room.members.get(room.hostId);
    if (host?.connected) return;

    const heir = [...room.members.values()]
      .filter((m) => m.connected)
      .sort((a, b) => a.seat - b.seat)[0];
    if (heir) room.hostId = heir.id;
  }

  private scheduleReapIfEmpty(room: Room): void {
    if (this.liveMembers(room).length > 0) return;
    if (room.reapTimer) return;

    if (room.startTimer) {
      clearTimeout(room.startTimer);
      room.startTimer = null;
    }
    // Grace period, not immediate deletion: a refresh drops the socket for a
    // second or two, and destroying the room would end the match over nothing.
    room.reapTimer = setTimeout(() => {
      room.reapTimer = null;
      if (this.liveMembers(room).length === 0) this.rooms.delete(room.code);
    }, this.graceMs);
    unrefTimer(room.reapTimer);
  }

  // ------------------------------------------------------------- helpers

  /**
   * `lobby` and `loading` are the same pre-game screen; `loading` just tells the
   * guest that the host is off generating the chart, so the UI can say so
   * instead of showing a Start button that would be rejected.
   */
  private settleLobbyPhase(room: Room): void {
    if (room.phase !== "lobby" && room.phase !== "loading") return;
    const live = this.liveMembers(room);
    const allReady = live.length > 0 && live.every((m) => m.ready);
    room.phase = allReady && !room.chart ? "loading" : "lobby";
  }

  private liveMembers(room: Room): Member[] {
    return [...room.members.values()].filter((m) => m.connected);
  }

  private roomOf(conn: Connection): Room | undefined {
    return conn.roomCode ? this.rooms.get(conn.roomCode) : undefined;
  }

  private broadcastRoom(room: Room): void {
    const players: Player[] = [];
    for (const id of room.seats) {
      const member = id ? room.members.get(id) : undefined;
      if (!member) continue;
      players.push({
        id: member.id,
        name: member.name,
        ready: member.ready,
        connected: member.connected,
        seat: member.seat,
      });
    }
    this.broadcastAll(room, {
      type: "room",
      code: room.code,
      hostId: room.hostId,
      phase: room.phase,
      players,
    });
  }

  private broadcastAll(room: Room, message: ServerMessage): void {
    for (const member of room.members.values()) {
      if (member.connected) this.send(member.id, message);
    }
  }

  private notifyOthers(
    room: Room,
    exceptId: string,
    message: ServerMessage,
  ): void {
    for (const member of room.members.values()) {
      if (member.connected && member.id !== exceptId) {
        this.send(member.id, message);
      }
    }
  }

  private error(playerId: string, message: string): void {
    this.send(playerId, { type: "error", message });
  }

  private mintCode(): string | null {
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
      const code = randomCode();
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }
}

/**
 * Room codes come from a CSPRNG, not Math.random: a guessable code lets a
 * stranger walk into a stranger's duel. Rejection sampling keeps the alphabet
 * uniform — 256 % 32 === 0, so a plain modulo happens to be unbiased here, but
 * the guard survives someone editing the alphabet later.
 */
function randomCode(): string {
  const limit = 256 - (256 % ROOM_CODE_ALPHABET.length);
  const bytes = new Uint8Array(ROOM_CODE_LENGTH * 2);
  let out = "";
  while (out.length < ROOM_CODE_LENGTH) {
    globalThis.crypto.getRandomValues(bytes);
    for (let i = 0; i < bytes.length && out.length < ROOM_CODE_LENGTH; i++) {
      if (bytes[i] >= limit) continue;
      out += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
    }
  }
  return out;
}
