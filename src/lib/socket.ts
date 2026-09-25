import { createSignal, onCleanup, type Accessor } from "solid-js";

export type SocketStatus = "connecting" | "open" | "reconnecting" | "failed" | "closed";

/** Delay before retry N (1-based). Max 5 retries, then the user retries by hand. */
const BACKOFF_MS = [1000, 2000, 5000, 5000, 5000];

/**
 * Close codes for a condition no reconnect can fix: the server would fail the same way and the
 * client would bank another banner each time (shared/protocol.ts, 4422 "config" — the session's
 * stored cwd is gone). Retrying is the user's move, after changing what's outside the server.
 * Transient closes (4500 "internal", a dropped link, a restarted server) are not in here.
 */
const PERMANENT_CLOSE = new Set([4422]);

export const isPermanentClose = (code: number): boolean => PERMANENT_CLOSE.has(code);

const [reconnects, setReconnects] = createSignal(0);
/** Bumped whenever any socket reconnects after having been open: the server may have changed
    under the page (a restart, or the front door moving it to another host). */
export const socketReconnects = reconnects;

export interface ReconnectingSocket {
  status: Accessor<SocketStatus>;
  /** Retry number currently scheduled/in flight (0 when connected). */
  attempt: Accessor<number>;
  send(msg: unknown): boolean;
  /** Manual retry after "failed" or a permanent "closed" (resets the backoff). */
  retry(): void;
  /** Drop the current connection and open a fresh one now (backoff reset). */
  reconnect(): void;
  /** Close for good; no reconnect. */
  close(): void;
}

export interface SocketHandlers<M> {
  onMessage(msg: M): void;
  /** Called on every successful (re)connect, before any message. */
  onOpen?(isReconnect: boolean): void;
}

/**
 * A WebSocket that reconnects with backoff. Must be created inside a reactive owner
 * (component or createRoot); the socket is closed cleanly on cleanup.
 */
export function createReconnectingSocket<M>(url: string, handlers: SocketHandlers<M>): ReconnectingSocket {
  const [status, setStatus] = createSignal<SocketStatus>("connecting");
  const [attempt, setAttempt] = createSignal(0);
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let everOpened = false;

  const connect = () => {
    if (stopped) return;
    const sock = new WebSocket(url);
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      setAttempt(0);
      setStatus("open");
      handlers.onOpen?.(everOpened);
      if (everOpened) setReconnects((n) => n + 1);
      everOpened = true;
    };
    sock.onmessage = (ev) => {
      if (ws !== sock || typeof ev.data !== "string") return;
      let msg: M;
      try {
        msg = JSON.parse(ev.data) as M;
      } catch {
        return;
      }
      handlers.onMessage(msg);
    };
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      ws = null;
      if (stopped) {
        setStatus("closed");
        return;
      }
      // Permanent: stay down. The server sent its `error` message before closing, so the view
      // has already shown the reason once — reconnecting would only repeat it.
      if (isPermanentClose(ev.code)) {
        stopped = true;
        clearTimeout(timer);
        setStatus("closed");
        return;
      }
      const next = attempt() + 1;
      if (next > BACKOFF_MS.length) {
        setStatus("failed");
        return;
      }
      setAttempt(next);
      setStatus("reconnecting");
      timer = setTimeout(connect, BACKOFF_MS[next - 1]);
    };
  };

  const close = () => {
    stopped = true;
    clearTimeout(timer);
    const sock = ws;
    ws = null;
    if (sock && (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING)) {
      sock.close(1000, "client closed");
    }
    setStatus("closed");
  };

  connect();
  onCleanup(close);

  return {
    status,
    attempt,
    send(msg) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },
    retry() {
      // "closed" too: a permanent close (or a view that closed us on a permanent error) stays
      // down on its own, but the user asking for it by hand is always allowed.
      if (status() !== "failed" && status() !== "closed") return;
      stopped = false;
      clearTimeout(timer);
      setAttempt(0);
      setStatus("connecting");
      connect();
    },
    reconnect() {
      if (stopped && status() !== "failed") return;
      stopped = false;
      clearTimeout(timer);
      const old = ws;
      ws = null; // detach first so its onclose doesn't schedule a retry
      old?.close(1000, "client reconnect");
      setAttempt(0);
      setStatus("connecting");
      connect();
    },
    close,
  };
}
