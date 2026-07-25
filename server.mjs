/**
 * Air Piano Duel — one process, one port: Next on HTTP, the duel relay on WS.
 *
 * A single port is not a nicety here. Both players reach the game over a LAN IP
 * or a tunnel, and a second port means a second thing to forward and a second
 * origin to get wrong. `/ws` upgrades go to the relay; everything else, Next's
 * own HMR socket included, goes back to Next.
 *
 * Run it with `node server.mjs`; NODE_ENV picks dev vs production.
 * Requires Node >= 22.18 (or >= 23.6) for built-in TypeScript type stripping.
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ROOT_URL = pathToFileURL(ROOT + path.sep).href;
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------- ts loading

/**
 * The relay shares `lib/net/protocol.ts` and `lib/net/rooms.ts` with the
 * browser — one wire schema, not two hand-synced copies that drift. Node runs
 * the TypeScript directly (built-in type stripping); all it lacks is bundler
 * resolution, so the hook below teaches it the `@/*` alias and extensionless
 * specifiers and nothing else.
 *
 * Note the shape carefully: this is a RESOLVE hook only. Adding a `load` hook
 * routes *every* CommonJS module in the process through the ESM translator,
 * whose synthetic `require` has no `require.extensions` — which crashes Next's
 * own `next.config.ts` require-hook on boot. Resolution alone is side-effect
 * free, so Next's module graph loads exactly as it normally would.
 */
if (process.features.typescript !== "strip") {
  console.error(
    `\n  Node ${process.versions.node} cannot run TypeScript directly.\n` +
      `  Air Piano Duel's server needs Node >= 22.18 (or >= 23.6), because it\n` +
      `  imports the wire protocol straight out of lib/net/*.ts.\n`,
  );
  process.exit(1);
}

const CANDIDATE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".js",
  ".mjs",
  "/index.ts",
  "/index.tsx",
];

function resolveOnDisk(baseUrl) {
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = baseUrl + suffix;
    let stats;
    try {
      stats = statSync(fileURLToPath(candidate), { throwIfNoEntry: false });
    } catch {
      continue;
    }
    // Must be a *file*: the empty suffix would otherwise happily "resolve" a
    // specifier like `@/lib/game` to the directory itself.
    if (stats?.isFile()) return candidate;
  }
  return null;
}

const isRepoTs = (url) =>
  url.startsWith(ROOT_URL) &&
  !url.includes("/node_modules/") &&
  /\.tsx?$/.test(url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    let base = null;
    if (specifier.startsWith("@/")) {
      base = new URL(specifier.slice(2), ROOT_URL).href;
    } else if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL &&
      isRepoTs(context.parentURL)
    ) {
      base = new URL(specifier, context.parentURL).href;
    }
    if (base) {
      const url = resolveOnDisk(base);
      if (url) return { url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

// Dynamic, because the hook above has to exist before any `@/` specifier does.
const { WS_PATH, encode } = await import("@/lib/net/protocol");
const { RoomRegistry } = await import("@/lib/net/rooms");

// `require`, not `import`: Next is CommonJS and pulls in a deep tree of it, and
// loading that tree through the ESM loader is what breaks its config hook.
const next = require("next");
const { WebSocketServer } = require("ws");

// ---------------------------------------------------------------- config

const dev = process.env.NODE_ENV !== "production";
const port = Number.parseInt(process.env.PORT ?? "3000", 10) || 3000;
const hostname = process.env.HOSTNAME ?? "0.0.0.0";

/** A 2000-note chart is a few hundred KB; past 2MB it is not a chart. */
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
/** Half-open sockets (a phone that slept) never fire `close`. Ping them out. */
const HEARTBEAT_MS = 30_000;

const app = next({
  dev,
  dir: ROOT,
  hostname,
  port,
  // Match `next dev`, which is Turbopack-first in Next 16. In production the
  // wrapper auto-detects from the build output, so we say nothing.
  ...(dev ? { turbopack: true } : {}),
});

await app.prepare();
const handleRequest = app.getRequestHandler();
const handleUpgrade = app.getUpgradeHandler();

// ---------------------------------------------------------------- relay

/** playerId -> live socket. The registry only ever knows the id. */
const sockets = new Map();

const registry = new RoomRegistry({
  send(playerId, message) {
    const socket = sockets.get(playerId);
    if (!socket || socket.readyState !== socket.OPEN) return;
    try {
      socket.send(encode(message));
    } catch {
      // A send racing a close is expected; the `close` handler cleans up.
    }
  },
  close(playerId, reason) {
    try {
      sockets.get(playerId)?.close(1002, reason);
    } catch {
      /* already gone */
    }
  },
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_PAYLOAD_BYTES,
});

wss.on("connection", (socket) => {
  // Server-minted and unguessable: playerId is the only handle the other client
  // gets on you, so it must not be enumerable.
  const playerId = randomUUID();
  sockets.set(playerId, socket);
  registry.open(playerId);

  socket.isAlive = true;
  socket.on("pong", () => {
    socket.isAlive = true;
  });

  socket.on("message", (data, isBinary) => {
    if (isBinary) return; // the protocol is JSON text, full stop
    registry.receive(playerId, data.toString("utf8"));
  });

  socket.on("close", () => {
    sockets.delete(playerId);
    registry.close(playerId);
  });

  socket.on("error", () => {
    try {
      socket.terminate();
    } catch {
      /* nothing left to do */
    }
  });
});

const heartbeat = setInterval(() => {
  for (const socket of sockets.values()) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    try {
      socket.ping();
    } catch {
      socket.terminate();
    }
  }
}, HEARTBEAT_MS);
heartbeat.unref();

// ---------------------------------------------------------------- http

const server = createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error("[next]", error);
    if (!res.headersSent) res.statusCode = 500;
    res.end("Internal Server Error");
  });
});

server.on("upgrade", (req, socket, head) => {
  // `req.url` is a path, so it needs a base to parse. The base is discarded.
  const { pathname } = new URL(req.url ?? "/", "http://localhost");

  if (pathname === WS_PATH) {
    // No Origin check: the relay carries no cookies and grants no ambient
    // authority, so a cross-origin page could at most open its own empty room.
    // The room code is the only secret, and it comes from a CSPRNG.
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
    return;
  }

  // Everything else — crucially Next's HMR socket in dev — stays Next's.
  handleUpgrade(req, socket, head).catch(() => socket.destroy());
});

server.listen(port, hostname, () => {
  const shown =
    hostname === "0.0.0.0" || hostname === "::" ? "localhost" : hostname;
  console.log(
    `\n  Air Piano Duel  ${dev ? "(dev)" : "(production)"}\n` +
      `  http://${shown}:${port}\n` +
      `  relay ws://${shown}:${port}${WS_PATH}\n`,
  );
});

// ---------------------------------------------------------------- shutdown

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n[server] ${signal}, shutting down`);
  clearInterval(heartbeat);
  registry.shutdown();
  for (const socket of sockets.values()) socket.close(1001, "server shutdown");
  sockets.clear();
  wss.close();
  server.close();
  try {
    await app.close();
  } catch {
    /* best effort */
  }
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
