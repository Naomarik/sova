import { existsSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import type { ChatClientMessage, ChatServerMessage, WatchServerMessage } from "../shared/protocol";
import { acquireChat, BusyError, ConfigError, type ChatClient } from "./chat-manager";
import { normalizeClaudeText, resolveClaudeSession } from "./claude-transcript";
import { resolveSessionPath } from "./paths";
import { trackViewer } from "./seen";
import { idOf } from "./sessions-index";
import { extensionSocketRoute, upgradeExtensionSocket } from "./extensions";
import { meshUpgrade } from "./mesh";
import { claudeUsageTally, type UsageTally } from "./transcript-usage";
import { type Normalize, SessionTail } from "./watch";
import { sharedWorkerWindowResolver } from "./models";
import { contextTally, type Format, type WindowResolver } from "./worker-context";

function sendJson(ws: WebSocket, msg: ChatServerMessage | WatchServerMessage): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch (err) {
    console.error("[ws] send failed", err);
  }
}

async function handleChat(ws: WebSocket, path: string, force: boolean): Promise<void> {
  const client: ChatClient = { send: (msg) => sendJson(ws, msg) };
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
    if (chat) chat.handle(client, msg);
    else early.push(msg);
  });
  // Seen: a pane is on screen while its socket is open (server/seen.ts). Stamped at attach and at
  // detach, whether or not the runtime opens — a refused chat is still a session the user looked at.
  const id = idOf(path);
  trackViewer(id, 1);
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

function handleWatch(ws: WebSocket, path: string, normalize?: Normalize, tally?: UsageTally, format: Format = "pi"): void {
  // pi replies name their model, so the fill carries its window; the runtime is resolved first.
  let resolve: WindowResolver = () => null;
  const tail = new SessionTail(path, (msg) => sendJson(ws, msg), normalize, tally, contextTally(format, (ref) => resolve(ref)));
  // A claude-code worker's own file has no Sova session id: nothing to stamp.
  const id = normalize ? "" : idOf(path);
  if (id) trackViewer(id, 1);
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

const wss = new WebSocketServer({ noServer: true });

/** Sova's own sockets, /ws/chat and /ws/watch; anything else is dropped. Also the peer
    listener's upgrade handler (server/mesh/listener.ts). */
export function upgradeSovaSocket(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = url.pathname;
  if (route !== "/ws/chat" && route !== "/ws/watch") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    // /ws/watch?claude=<uuid>: a claude-code worker's own session file, in CC's own format.
    const claudeId = route === "/ws/watch" ? url.searchParams.get("claude") : null;
    if (claudeId) {
      const file = resolveClaudeSession(claudeId);
      if (!file || !existsSync(file)) {
        sendJson(ws, { type: "error", message: file ? "Session file not found" : "Unknown Claude Code session" });
        ws.close(4404, "bad path");
        return;
      }
      handleWatch(ws, file, normalizeClaudeText, claudeUsageTally(), "claude");
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
      handleChat(ws, path, url.searchParams.get("force") === "1").catch((err) => {
        console.error("[ws/chat]", err);
        ws.close(4500, "internal");
      });
    } else {
      handleWatch(ws, path);
    }
  });
}

export function attachWebSockets(server: Server): void {
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
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
