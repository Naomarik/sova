import type { WebSocket } from "ws";

/** The close code for a message over the cap, as ws sends it itself (RFC 6455 "message too big"). */
export const MESSAGE_TOO_BIG = 1009;

/** A ws message's size in bytes, whatever form the runtime hands it over in. */
export function messageBytes(data: unknown): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Array.isArray(data)) return data.reduce((n: number, part) => n + messageBytes(part), 0);
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
  return 0;
}

/**
 * Enforce `maxPayload` on one socket ourselves, before any `message` listener sees the data.
 * ws does this on Node (and closes with 1009), but Bun replaces the `ws` package with its own shim,
 * which ignores `maxPayload`. So every socket that relies on a cap goes through here, and the cap
 * holds on both runtimes. On Node this never fires: ws drops an oversized frame before emitting it.
 *
 * The first message over `max` calls `onOversize` (default: close with 1009), and from then on the
 * socket emits no message at all, so no listener, added before or after this call, forwards one.
 */
export function enforceMaxPayload(ws: WebSocket, max: number, onOversize: (ws: WebSocket) => void = closeTooBig): WebSocket {
  let over = false;
  const emit = ws.emit;
  ws.emit = function (this: WebSocket, event: string | symbol, ...args: unknown[]): boolean {
    if (event === "message") {
      if (over) return false;
      if (messageBytes(args[0]) > max) {
        over = true;
        onOversize(ws);
        return false;
      }
    }
    return emit.call(this, event, ...args);
  } as WebSocket["emit"];
  return ws;
}

function closeTooBig(ws: WebSocket): void {
  if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(MESSAGE_TOO_BIG, "Message too big");
}
