import { existsSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";
import { cappedWebSocketServer, streamWebSocketServer } from "./runtime-quirks";
import type { ChatClientMessage, ChatServerMessage, LlmFeedMessage, SessionFeedMessage, V2EventFrame, WatchServerMessage } from "../shared/protocol";
import { refuseUpgrade } from "./auth";
import { isDirectLocal } from "./compression";
import { acquireChat, BusyError, ConfigError, type ChatClient } from "./chat-manager";
import { normalizeClaudeText, resolveClaudeSession } from "./claude-transcript";
import { resolveSessionPath } from "./paths";
import { trackViewer } from "./seen";
import { nudgeMarks, sessionFeed } from "./session-feed";
import { llmInflight } from "./llm-inflight";
import { idOf } from "./sessions-index";
import { sessionsChanged } from "./list-generation";
import { extensionSocketRoute, upgradeExtensionSocket } from "./extensions";
import { meshUpgrade } from "./mesh";
import { type Normalize, SessionTail } from "./watch";
import { sharedWorkerWindowResolver } from "./models";
import { contextTally, type Format, type WindowResolver } from "./worker-context";
import { wireOf } from "./wire-rows";
import type { WireVersion } from "../shared/protocol";

function sendJson(ws: WebSocket, msg: ChatServerMessage | V2EventFrame | WatchServerMessage | SessionFeedMessage | LlmFeedMessage): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch (err) {
    console.error("[ws] send failed", err);
  }
}

/** A message already serialized: made once for every client that gets it. */
function sendRaw(ws: WebSocket, json: string): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(json);
  } catch (err) {
    console.error("[ws] send failed", err);
  }
}

/** What a client asked of the transcript: all of it (legacy), newest rows first with the rest
    pushed (`?tail=1`), or newest rows alone, the rest fetched over REST (`?tail=rest`, with
    `prefetch` for a browser on this machine connecting directly: it may as well fetch it all). */
type TailAsk = { tail: false } | { tail: true; pull: false } | { tail: true; pull: true; prefetch: boolean };

async function handleChat(ws: WebSocket, path: string, force: boolean, ask: TailAsk, wire: WireVersion): Promise<void> {
  const client: ChatClient = {
    send: (msg) => sendJson(ws, msg),
    sendRaw: (json) => sendRaw(ws, json),
    ...(wire === 2 ? { wire: 2 as const } : {}),
    ...(ask.tail ? { tail: true } : {}),
    ...(ask.tail && ask.pull ? { pull: { prefetch: ask.prefetch } } : {}),
  };
  // Buffer messages that arrive while the runtime is still opening.
  const early: ChatClientMessage[] = [];
  let chat: Awaited<ReturnType<typeof acquireChat>> | null = null;
  let gone = false;
  ws.on("message", (data) => {
    let msg: ChatClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      client.send({ type: "error", code: "internal", message: "Invalid JSON" });
      return;
    }
    sessionsChanged(); // a prompt, abort or rename: the next listing is built afresh
    if (chat) chat.handle(client, msg);
    else early.push(msg);
  });
  // Seen: a pane is on screen while its socket is open (server/seen.ts). Stamped at attach and at
  // detach, whether or not the runtime opens — a refused chat is still a session the user looked at.
  const id = idOf(path);
  trackViewer(id, 1);
  nudgeMarks(); // a mark clears once its session is on screen (server/session-feed.ts)
  ws.on("close", () => {
    gone = true;
    trackViewer(id, -1);
    chat?.detach(client);
  });

  try {
    chat = await acquireChat(path, force);
  } catch (err) {
    // Three outcomes, three close codes, because the client's retry policy keys off them:
    // 4409 busy (another process owns it), 4422 config (permanent — do NOT reconnect), 4500
    // internal (transient — backoff and retry).
    const busy = err instanceof BusyError;
    const config = err instanceof ConfigError;
    const code = busy ? err.code : config ? "config" : "internal";
    client.send({ type: "error", code, message: err instanceof Error ? err.message : String(err) });
    ws.close(busy ? 4409 : config ? 4422 : 4500, busy ? "busy" : config ? "config" : "open failed");
    return;
  }
  if (gone) {
    chat.detach(client); // triggers idle disposal if nobody else is attached
    return;
  }
  chat.attach(client);
  for (const msg of early.splice(0)) chat.handle(client, msg);
}

function handleWatch(ws: WebSocket, path: string, ask: TailAsk, wire: WireVersion, normalize?: Normalize, format: Format = "pi"): void {
  // pi replies name their model, so the fill carries its window; the runtime is resolved first.
  let resolve: WindowResolver = () => null;
  const tail = new SessionTail(
    path,
    (msg) => sendJson(ws, msg),
    normalize,
    contextTally(format, (ref) => resolve(ref)),
    ask.tail && !ask.pull ? (json) => sendRaw(ws, json) : undefined,
    ask.tail && ask.pull ? { prefetch: ask.prefetch } : undefined,
    wire,
  );
  // A claude-code worker's own file has no Sova session id: nothing to stamp.
  const id = normalize ? "" : idOf(path);
  if (id) {
    trackViewer(id, 1);
    nudgeMarks();
  }
  ws.on("close", () => {
    if (id) trackViewer(id, -1);
    tail.close();
  });
  ws.on("message", () => {}); // read-only: ignore anything the client sends
  const windows = format === "pi" ? sharedWorkerWindowResolver().then((r) => void (resolve = r)) : Promise.resolve();
  windows.then(() => tail.start()).catch((err) => {
    sendJson(ws, { type: "error", message: err instanceof Error ? err.message : String(err) });
    ws.close(4500, "watch failed");
  });
}

/** /ws/watch?feed=sessions: the session list's decision overlays, pushed (server/session-feed.ts). */
function handleFeed(ws: WebSocket): void {
  const feed = sessionFeed();
  if (!feed) {
    sendJson(ws, { type: "error", message: "The session feed is not running" });
    ws.close(4500, "no feed");
    return;
  }
  const remove = feed.add((msg) => sendJson(ws, msg));
  // The LLM calls in flight ride the same socket.
  const removeLlm = llmInflight()?.addBrowser((msg) => sendJson(ws, msg));
  ws.on("close", () => {
    remove();
    removeLlm?.();
  });
  ws.on("message", () => {}); // read-only: ignore anything the client sends
}

/** /ws/watch?feed=llm: this host's OWN LLM calls in flight, for a peer's fan-in (server/llm-inflight.ts). */
function handleLlmFeed(ws: WebSocket): void {
  const hub = llmInflight();
  if (!hub) {
    sendJson(ws, { type: "error", message: "The LLM count is not running" });
    ws.close(4500, "no feed");
    return;
  }
  ws.on("close", hub.addLocal((msg) => sendJson(ws, msg)));
  ws.on("message", () => {}); // read-only
}

// permessage-deflate, for a browser that offers it: a session's hello is one JSON frame of the
// whole transcript (MBs for a large one), sent to phones over the tailnet. Frames under 1 KB (the
// streaming deltas) go uncompressed. No context takeover either way, so a connection holds no
// window between messages; ws creates its zlib streams lazily, so a socket that only ever sends
// small frames holds none at all. Level 1: the ratio on a hello is within a few percent of level 6
// at a fraction of the CPU (numbers in the commit message).
const DEFLATE = {
  threshold: 1024,
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
  zlibDeflateOptions: { level: 1 },
};
const wss = cappedWebSocketServer({ noServer: true, perMessageDeflate: DEFLATE });
// A dial-out pairing's sockets arrive on HTTP/2 streams, which only the pure-JS server can upgrade
// (runtime-quirks.ts, "WebSockets over a stream").
const streamWss = streamWebSocketServer({ perMessageDeflate: DEFLATE });

/** Sova's own sockets, /ws/chat and /ws/watch; anything else is dropped. Also the peer
    listener's upgrade handler (server/mesh/listener.ts). */
export function upgradeSovaSocket(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  upgradeWith(wss, req, socket, head);
}

/** The same, for a request that arrived on a stream rather than a socket (server/mesh/lan.ts). */
export function upgradeSovaStreamSocket(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  upgradeWith(streamWss, req, socket, head);
}

function upgradeWith(server: typeof wss, req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = url.pathname;
  if (route !== "/ws/chat" && route !== "/ws/watch") {
    socket.destroy();
    return;
  }
  // A browser on this machine, not through a proxy: decline permessage-deflate (server/compression.ts).
  const direct = isDirectLocal(req);
  if (direct) delete req.headers["sec-websocket-extensions"];
  server.handleUpgrade(req, socket, head, (ws) => {
    // /ws/watch?feed=sessions: no session at all, the list's pushed overlays.
    if (route === "/ws/watch" && url.searchParams.get("feed") === "sessions") {
      handleFeed(ws);
      return;
    }
    if (route === "/ws/watch" && url.searchParams.get("feed") === "llm") {
      handleLlmFeed(ws);
      return;
    }
    // ?tail=1: the transcript newest rows first (server/tail-hello.ts); ?tail=rest: newest rows
    // alone (server/transcript-rows.ts); anything else, as it always was.
    const t = url.searchParams.get("tail");
    const tail: TailAsk = t === "1" ? { tail: true, pull: false } : t === "rest" ? { tail: true, pull: true, prefetch: direct } : { tail: false };
    // ?wire=2: events and rows in the harness contract's words (server/wire-rows.ts); else wire 1.
    const wire = wireOf(url.searchParams);
    // /ws/watch?claude=<uuid>: a claude-code worker's own session file, in CC's own format.
    const claudeId = route === "/ws/watch" ? url.searchParams.get("claude") : null;
    if (claudeId) {
      const file = resolveClaudeSession(claudeId);
      if (!file || !existsSync(file)) {
        sendJson(ws, { type: "error", message: file ? "Session file not found" : "Unknown Claude Code session" });
        ws.close(4404, "bad path");
        return;
      }
      // REST serves pi session files only: a Claude Code file's older rows are pushed, as with ?tail=1.
      handleWatch(ws, file, tail.tail ? { tail: true, pull: false } : tail, wire, normalizeClaudeText, "claude");
      return;
    }
    const path = resolveSessionPath(url.searchParams.get("path"));
    if (!path || !existsSync(path)) {
      const message = path ? "Session file not found" : "Invalid or missing ?path= (must be a .jsonl under the pi sessions dir)";
      sendJson(ws, route === "/ws/chat" ? { type: "error", code: "internal", message } : { type: "error", message });
      ws.close(4404, "bad path");
      return;
    }
    if (route === "/ws/chat") {
      handleChat(ws, path, url.searchParams.get("force") === "1", tail, wire).catch((err) => {
        console.error("[ws/chat]", err);
        ws.close(4500, "internal");
      });
    } else {
      handleWatch(ws, path, tail, wire);
    }
  });
}

export function attachWebSockets(server: Server): void {
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // The main listener's gate (server/auth.ts upgradeAllowed): the token, and the Host and Origin
    // rules, before any socket is dispatched. Not in upgradeSovaSocket: the peer listener calls
    // that directly, and a peer is answered by its Tailscale identity.
    if (refuseUpgrade(req, socket)) return;
    const url = new URL(req.url ?? "/", "http://localhost");
    // An extension's own socket, forwarded to its backend (server/extensions.ts).
    const ext = extensionSocketRoute(url.pathname);
    if (ext) {
      upgradeExtensionSocket(req, socket, head, ext[0], ext[1], url.search);
      return;
    }
    // A session on another host, forwarded to it (server/mesh/proxy.ts); never while the mesh is off.
    if (meshUpgrade(req, socket, head, url)) return;
    upgradeSovaSocket(req, socket, head);
  });
}
