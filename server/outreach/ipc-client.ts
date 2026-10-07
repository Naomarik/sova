import { createConnection, type Socket } from "node:net";

/**
 * A client of the WhatsApp sender's IPC v1 (services/whatsapp/IPC.md) over its Unix socket
 * (§app.outreach/sender-route): newline-delimited JSON, requests `{id, op, …}` answered by `{id, ok, …}`,
 * events `{ev, seq, …}` after a `hello`. One connection, opened on first use and re-opened at most
 * every 10 s while it is down; a request waits at most 30 s. Only the frames reach Sova: never the
 * sender process's own output.
 */

export type Frame = Record<string, unknown>;
export interface SenderEvent extends Frame {
  ev: string;
  seq: number;
}

const RETRY_MS = 10_000;
const REQUEST_MS = 30_000;
const MAX_LINE = 64 * 1024;

/** How a client reaches the sender, and how long it waits. Tests: an in-memory stream, no retry gap. */
export interface SenderClientOptions {
  retryMs?: number;
  requestMs?: number;
  /** Opens the connection (default: the Unix socket at the path). */
  connect?: (path: string) => Socket;
}

export class SenderUnreachable extends Error {}
/** The request went out but no answer came (a timeout, or the connection closed): what the sender did is unknown. */
export class SenderUncertain extends SenderUnreachable {}

export class SenderClient {
  private sock: Socket | null = null;
  private connecting: Promise<Socket> | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, { resolve(f: Frame): void; reject(e: Error): void; timer: NodeJS.Timeout }>();
  private lastFail = 0;
  private lastFailWhy = "";
  private retryTimer: NodeJS.Timeout | null = null;
  private closed = false;
  /** The newest event seq seen, for `hello {since}` after a reconnect. */
  seq: number | undefined;
  /** The hello answer of the current connection. */
  hello: Frame | null = null;

  constructor(
    readonly socketPath: string,
    private readonly onEvent: (e: SenderEvent) => void = () => {},
    private readonly opts: SenderClientOptions = {},
  ) {}

  /** Why the last connect failed, or null while connected (or never tried). */
  get unreachableWhy(): string | null {
    return this.sock ? null : this.lastFailWhy || null;
  }

  async request(op: string, body: Frame = {}, ms = this.opts.requestMs ?? REQUEST_MS): Promise<Frame> {
    const sock = await this.connect();
    const id = this.nextId++;
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SenderUncertain(`The sender didn't answer within ${Math.round(ms / 1000)} s.`));
      }, ms);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      sock.write(`${JSON.stringify({ ...body, id, op })}\n`);
    });
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.sock?.destroy();
    this.sock = null;
  }

  private connect(): Promise<Socket> {
    if (this.sock) return Promise.resolve(this.sock);
    if (this.connecting) return this.connecting;
    const retryMs = this.opts.retryMs ?? RETRY_MS;
    if (this.closed) return Promise.reject(new SenderUnreachable("The sender connection is closed."));
    if (Date.now() - this.lastFail < retryMs) return Promise.reject(new SenderUnreachable(this.lastFailWhy));
    this.connecting = new Promise<Socket>((resolve, reject) => {
      const s = (this.opts.connect ?? createConnection)(this.socketPath);
      let open = false;
      s.setEncoding("utf8");
      s.once("connect", () => {
        open = true;
        this.sock = s;
        this.buf = "";
        this.lastFailWhy = "";
        resolve(s);
        // Subscribe to events (receipts, state), replaying what came since the last one seen.
        void this.request("hello", { v: 1, ...(this.seq !== undefined ? { since: this.seq } : {}) })
          .then((h) => {
            this.hello = h;
            if (typeof h.seq === "number" && this.seq === undefined) this.seq = h.seq;
          })
          .catch(() => {});
      });
      s.on("data", (chunk: string) => this.onData(chunk));
      s.once("error", (err: NodeJS.ErrnoException) => {
        if (!open) {
          this.lastFail = Date.now();
          this.lastFailWhy = err.code === "ENOENT" || err.code === "ECONNREFUSED" ? "The sender is not running (no socket answers)." : `The sender's socket failed: ${err.code ?? err.message}.`;
          reject(new SenderUnreachable(this.lastFailWhy));
        }
      });
      s.once("close", () => {
        if (this.sock === s) this.dropped();
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private dropped(): void {
    this.sock = null;
    this.hello = null;
    this.lastFail = Date.now();
    this.lastFailWhy = "The connection to the sender closed.";
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new SenderUncertain(this.lastFailWhy));
    }
    this.pending.clear();
    // Keep receiving receipts: try again once, after the retry gap.
    if (!this.closed && !this.retryTimer) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.connect().catch(() => {});
      }, (this.opts.retryMs ?? RETRY_MS) + 50);
      this.retryTimer.unref?.();
    }
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > MAX_LINE * 4 && !this.buf.includes("\n")) {
      this.sock?.destroy();
      return;
    }
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let f: Frame;
      try {
        f = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof f.ev === "string" && typeof f.seq === "number") {
        this.seq = Math.max(this.seq ?? 0, f.seq);
        try {
          this.onEvent(f as SenderEvent);
        } catch {
          // a listener's failure never breaks the connection
        }
        continue;
      }
      const p = typeof f.id === "number" ? this.pending.get(f.id) : undefined;
      if (!p) continue;
      this.pending.delete(f.id as number);
      clearTimeout(p.timer);
      p.resolve(f);
    }
  }
}
