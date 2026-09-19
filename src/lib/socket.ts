import { createSignal, onCleanup, type Accessor } from "solid-js";

export type SocketStatus = "connecting" | "open" | "reconnecting" | "failed" | "closed";

/** Delay before retry N (1-based). Max 5 retries, then the user retries by hand. */
const BACKOFF_MS = [1000, 2000, 5000, 5000, 5000];

export interface ReconnectingSocket {
  status: Accessor<SocketStatus>;
  /** Retry number currently scheduled/in flight (0 when connected). */
  attempt: Accessor<number>;
  send(msg: unknown): boolean;
  /** Manual retry after "failed" (resets the backoff). */
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
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      if (stopped) {
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
      if (status() !== "failed") return;
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
