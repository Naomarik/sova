import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket } from "ws";
import { cappedWebSocketServer, streamWebSocketServer } from "./runtime-quirks";
import type { ChatClientMessage, ChatServerMessage, LlmFeedMessage, SessionFeedMessage, V2EventFrame, WatchServerMessage } from "../shared/protocol";
import { refuseUpgrade } from "./auth";
import { isDirectLocal } from "./compression";
import { acquireChatHandle, BusyError, ConfigError, type ChatClient } from "./chat-handle";
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
import { replyTimingsOf, sessionIdOfPath } from "./reply-facts";
import { HAVE_MAX_CHARS, HAVE_PARAM, type WireVersion } from "../shared/protocol";
import { unsentRefusal } from "../shared/chat-runtime";
import { draftTexts, HeldSends, type Unsent } from "../shared/held-sends";
import { putBackDraft } from "./drafts";

/** How long a chat socket that closed stays in its chat to hear what became of the messages it
    sent (§chat.transcript/send-while-starting): taken, or refused and put back as the draft. */
export const GONE_LISTEN_MS = 120_000;

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

/** `?have=` on a `?tail=rest` chat socket: the last row the browser holds (§chat.transcript/instant-open);
    anything empty or longer than HAVE_MAX_CHARS is ignored. */
export function haveOf(params: URLSearchParams, ask: TailAsk): string | undefined {
  const have = params.get(HAVE_PARAM);
  return ask.tail && ask.pull && have && have.length <= HAVE_MAX_CHARS ? have : undefined;
}

async function handleChat(ws: WebSocket, path: string, force: boolean, ask: TailAsk, wire: WireVersion, have?: string): Promise<void> {
  const id = idOf(path);
  // What this socket sent and the chat hasn't answered yet (§chat.transcript/send-while-starting).
  // Once the socket is gone, a refusal can't reach any tab: its text goes back as the draft.
  const held = new HeldSends();
  let gone = false;
  const heard = (back: Unsent[]) => {
    if (gone && back.length) putBackDraft(id, draftTexts(back));
    if (gone && held.size === 0) leave();
  };
  const client: ChatClient = {
    send: (msg) => {
      if (held.listening) heard(held.heard(msg));
      sendJson(ws, msg);
    },
    sendRaw: (json) => {
      if (held.listening) heard(held.heardJson(json));
      sendRaw(ws, json);
    },
    close: (code, reason) => ws.close(code, reason),
    ...(wire === 2 ? { wire: 2 as const } : {}),
    ...(ask.tail ? { tail: true } : {}),
    ...(ask.tail && ask.pull ? { pull: { prefetch: ask.prefetch } } : {}),
    ...(have ? { have } : {}),
  };
  // Buffer messages that arrive while the runtime is still opening. They run, in order, once it
  // is open, even when the socket has closed by then (a tab that left or reloaded).
  const early: ChatClientMessage[] = [];
  let chat: Awaited<ReturnType<typeof acquireChatHandle>> | null = null;
  /** Out of the chat for good: at the socket's close, or once what it sent is answered. */
  let left = false;
  let listen: NodeJS.Timeout | undefined;
  const leave = () => {
    if (left) return;
    left = true;
    clearTimeout(listen);
    chat?.detach(client);
  };
  /** The socket closed with sends unanswered: stay to hear them, for a while. */
  const stayToHear = () => {
    if (held.size === 0) return leave();
    listen = setTimeout(leave, GONE_LISTEN_MS);
    listen.unref?.();
  };
  ws.on("message", (data) => {
    let msg: ChatClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      client.send({ type: "error", code: "internal", message: "Invalid JSON" });
      return;
    }
    sessionsChanged(); // a prompt, abort or rename: the next listing is built afresh
    held.sent(msg);
    if (chat) chat.clientMessage(client, msg);
    else early.push(msg);
  });
  // Seen: a pane is on screen while its socket is open (server/seen.ts). Stamped at attach and at
  // detach, whether or not the runtime opens — a refused chat is still a session the user looked at.
  trackViewer(id, 1);
  nudgeMarks(); // a mark clears once its session is on screen (server/session-feed.ts)
  ws.on("close", () => {
    gone = true;
    trackViewer(id, -1);
    if (chat) stayToHear();
  });

  try {
    chat = await acquireChatHandle(path, force);
  } catch (err) {
    // Three outcomes, three close codes, because the client's retry policy keys off them:
    // 4409 busy (another process owns it), 4422 config (permanent — do NOT reconnect), 4500
    // internal (transient — backoff and retry).
    const busy = err instanceof BusyError;
    const config = err instanceof ConfigError;
    const code = busy ? err.code : config ? "config" : "internal";
    // What the pane sent meanwhile never reached a chat: each prompt goes back to its composer,
    // or, with no tab left to hear it, to the session's saved draft.
    const refusals = heldRefusals(early.splice(0));
    if (gone) putBackDraft(id, draftTexts(held.takeAll()));
    else for (const refusal of refusals) client.send(refusal);
    client.send({ type: "error", code, message: err instanceof Error ? err.message : String(err) });
    ws.close(busy ? 4409 : config ? 4422 : 4500, busy ? "busy" : config ? "config" : "open failed");
    return;
  }
  if (gone && early.length === 0) {
    chat.detach(client);
    return;
  }
  // Gone or not, the chat takes what the socket sent while it opened, in order, and this socket
  // stays in it until each send is answered (stayToHear).
  chat.attach(client);
  for (const msg of early.splice(0)) chat.clientMessage(client, msg);
  if (gone) stayToHear();
}

/** At most this many frames in one POST /api/chat/frames. */
export const POSTED_FRAMES_MAX = 100;

/**
 * Frames a page handed over as it went (POST /api/chat/frames, §chat.transcript/send-while-starting):
 * a tab closed or reloaded before its chat socket opened. They take the very path a chat socket's
 * early frames take (handleChat), on a stand-in socket that is already gone: the chat opens, runs
 * them in order, takes each client id once, and a refusal goes back as the session's draft.
 */
export function deliverFrames(path: string, frames: readonly ChatClientMessage[]): void {
  const gone = Object.assign(new EventEmitter(), { readyState: 3, OPEN: 1, close() {}, send() {} });
  const ws = gone as unknown as WebSocket;
  handleChat(ws, path, false, { tail: true, pull: true, prefetch: false }, 2).catch((err) => console.error("[chat/frames]", err));
  for (const f of frames) gone.emit("message", JSON.stringify(f));
  gone.emit("close");
}

/** The frames of a POST /api/chat/frames body (`{ frames: [...] }`), or null when malformed. */
export function postedFrames(body: unknown): ChatClientMessage[] | null {
  const frames = (body as { frames?: unknown } | null)?.frames;
  if (!Array.isArray(frames) || frames.length === 0 || frames.length > POSTED_FRAMES_MAX) return null;
  for (const f of frames) if (!f || typeof f !== "object" || Array.isArray(f) || typeof (f as { type?: unknown }).type !== "string") return null;
  return frames as ChatClientMessage[];
}

/** The refusals for messages a pane sent while its chat was opening, when it didn't open. */
export function heldRefusals(held: readonly ChatClientMessage[]): ChatServerMessage[] {
  return held.map(unsentRefusal).filter((r): r is NonNullable<typeof r> => r !== null);
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
    // Wire 2 on a pi session file: replies carry their measured timing, as on REST and /ws/chat.
    wire === 2 && format === "pi" && !normalize ? () => replyTimingsOf(sessionIdOfPath(path)) : undefined,
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
      handleChat(ws, path, url.searchParams.get("force") === "1", tail, wire, haveOf(url.searchParams, tail)).catch((err) => {
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
