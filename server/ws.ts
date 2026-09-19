import { existsSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import type { ChatClientMessage, ChatServerMessage, WatchServerMessage } from "../shared/protocol";
import { acquireChat, BusyError, type ChatClient } from "./chat-manager";
import { resolveSessionPath } from "./paths";
import { SessionTail } from "./watch";

function sendJson(ws: WebSocket, msg: ChatServerMessage | WatchServerMessage): void {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch (err) {
    console.error("[ws] send failed", err);
  }
}

async function handleChat(ws: WebSocket, path: string): Promise<void> {
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
  ws.on("close", () => {
    gone = true;
    chat?.detach(client);
  });

  try {
    chat = await acquireChat(path);
  } catch (err) {
    const busy = err instanceof BusyError;
    client.send({ type: "error", code: busy ? "busy" : "internal", message: err instanceof Error ? err.message : String(err) });
    ws.close(busy ? 4409 : 4500, busy ? "busy" : "open failed");
    return;
  }
  if (gone) {
    chat.detach(client); // triggers idle disposal if nobody else is attached
    return;
  }
  chat.attach(client);
  for (const msg of early.splice(0)) chat.handle(client, msg);
}

function handleWatch(ws: WebSocket, path: string): void {
  const tail = new SessionTail(path, (msg) => sendJson(ws, msg));
  ws.on("close", () => tail.close());
  ws.on("message", () => {}); // read-only: ignore anything the client sends
  tail.start().catch((err) => {
    sendJson(ws, { type: "error", message: err instanceof Error ? err.message : String(err) });
    ws.close(4500, "watch failed");
  });
}

export function attachWebSockets(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = url.pathname;
    if (route !== "/ws/chat" && route !== "/ws/watch") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const path = resolveSessionPath(url.searchParams.get("path"));
      if (!path || !existsSync(path)) {
        const message = path ? "Session file not found" : "Invalid or missing ?path= (must be a .jsonl under the pi sessions dir)";
        sendJson(ws, route === "/ws/chat" ? { type: "error", code: "internal", message } : { type: "error", message });
        ws.close(4404, "bad path");
        return;
      }
      if (route === "/ws/chat") {
        handleChat(ws, path).catch((err) => {
          console.error("[ws/chat]", err);
          ws.close(4500, "internal");
        });
      } else {
        handleWatch(ws, path);
      }
    });
  });
}
