// /ws/events (§app/events): the main listener's event stream socket. server/ws.ts attachWebSockets
// routes it here after the main listener's gate (token, Host and Origin); the peer and stream
// upgrade paths (upgradeSovaSocket, upgradeSovaStreamSocket) never do, and the peer listener's
// classifier refuses it outright (server/mesh/access.ts classifyUpgrade).
//
// Each socket has its own queue in front of the socket: the socket takes frames while fewer than
// WRITABLE_BYTES of them are in flight (sent, and not yet written out: a send's callback says when);
// past that they wait here, at most QUEUE_MAX entries or QUEUE_BYTES. Past that the oldest are dropped
// and, before the next frame, the socket gets one `gap overflow` naming exactly the dropped seqs. A
// socket full for FULL_CLOSE_MS straight is closed; its client can resume. A resume's replay is not
// queued: it goes out first, as the socket takes it, and is never dropped (the ring bounds it). Send callbacks, not
// `bufferedAmount`: on Bun a server socket's `bufferedAmount` is never lowered once its client
// drains a backlog, while the callbacks fire as the bytes leave, on both runtimes.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type GapFrame, WITH_COMMANDS } from "../shared/events";
import { cursorOf, type Entry, type EventHub, eventHub } from "./events";
import { cappedWebSocketServer } from "./runtime-quirks";

export const WRITABLE_BYTES = 64 * 1024;
export const QUEUE_MAX = 256;
export const QUEUE_BYTES = 256 * 1024;
export const FULL_CLOSE_MS = 60_000;
/** A client's frames are ignored; anything bigger than this closes the socket (1009). */
export const CLIENT_FRAME_MAX = 4096;

/** What of a socket the queue uses (ws's WebSocket fits). */
export interface EventsSocket {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string, cb: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on(event: "close", fn: () => void): unknown;
  on(event: "message", fn: () => void): unknown;
}

export interface OutboxOptions {
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (t: unknown) => void;
}

/** One socket's queue. */
export class Outbox {
  private readonly queue: Entry[] = [];
  /** A resume's replay: the ring's entries after the cursor, sent before anything queued and never
      dropped (the ring already bounds them: RING_MAX entries, RING_BYTES). */
  private replaying: readonly Entry[] = [];
  private replayAt = 0;
  private bytes = 0;
  /** Bytes sent whose callback hasn't come yet. */
  private inflight = 0;
  private dropped: { from: number; to: number } | null = null;
  /** How many queued entries are command frames (none unless the socket asked for them). */
  private commandsQueued = 0;
  private fullTimer: unknown = null;
  private closed = false;

  constructor(
    private readonly ws: EventsSocket,
    private readonly o: OutboxOptions = {},
  ) {}

  get size(): number {
    return this.queue.length;
  }

  get queuedBytes(): number {
    return this.bytes;
  }

  get inflightBytes(): number {
    return this.inflight;
  }

  /** A resume's replay, in seq order: goes out ahead of every queued entry, as the socket takes it. */
  replay(entries: readonly Entry[]): void {
    if (this.closed || !entries.length) return;
    this.replaying = entries;
    this.replayAt = 0;
    this.flush();
  }

  get replayLeft(): number {
    return this.replaying.length - this.replayAt;
  }

  /** Send now (hello, error): never queued, never dropped. */
  direct(json: string): void {
    this.send(json);
  }

  push(entry: Entry): void {
    if (this.closed) return;
    if (entry.command) this.commandsQueued++;
    this.queue.push(entry);
    this.bytes += entry.bytes;
    let dropped = false;
    while (this.queue.length > QUEUE_MAX || this.bytes > QUEUE_BYTES) {
      // A command frame (opted in, live only) goes before any event, silently: it names no seq,
      // and dropping one never makes a socket "too slow".
      const cmd = this.commandsQueued ? this.queue.findIndex((e) => e.command) : -1;
      if (cmd >= 0) {
        this.bytes -= this.queue.splice(cmd, 1)[0]!.bytes;
        this.commandsQueued--;
        continue;
      }
      const gone = this.queue.shift()!;
      this.bytes -= gone.bytes;
      dropped = true;
      // seq 0 is the `restarted` notice, which names no seq of this stream.
      if (gone.seq > 0) this.dropped = this.dropped ? { from: Math.min(this.dropped.from, gone.seq), to: Math.max(this.dropped.to, gone.seq) } : { from: gone.seq, to: gone.seq };
    }
    if (dropped && !this.fullTimer) {
      this.fullTimer = (this.o.setTimeout ?? setTimeout)(() => {
        this.fullTimer = null;
        this.ws.close(4408, "too slow");
        this.stop();
      }, FULL_CLOSE_MS);
      (this.fullTimer as { unref?: () => void }).unref?.();
    }
    this.flush();
  }

  /** Hand the socket what it can take now. Called on each push and each finished send. */
  flush(): void {
    if (this.closed) return;
    if (this.ws.readyState !== this.ws.OPEN) return this.stop();
    let progressed = false;
    while ((this.replayLeft || this.queue.length || this.dropped) && this.inflight < WRITABLE_BYTES) {
      // Every replayed seq is below every queued one, so the replay goes first; a dropped range
      // (live entries only) then comes just before the queued entry that follows it.
      if (this.replayLeft) {
        const e = this.replaying[this.replayAt++]!;
        this.send(e.json, e.bytes);
        if (!this.replayLeft) {
          this.replaying = [];
          this.replayAt = 0;
        }
        continue;
      }
      if (this.dropped) {
        this.send(JSON.stringify({ type: "gap", reason: "overflow", ...this.dropped } satisfies GapFrame));
        this.dropped = null;
        continue;
      }
      const e = this.queue.shift()!;
      this.bytes -= e.bytes;
      if (e.command) this.commandsQueued--;
      this.send(e.json, e.bytes);
      progressed = true;
    }
    if (progressed && this.queue.length < QUEUE_MAX) this.unfull();
  }

  stop(): void {
    this.closed = true;
    this.queue.length = 0;
    this.replaying = [];
    this.replayAt = 0;
    this.bytes = 0;
    this.commandsQueued = 0;
    this.dropped = null;
    this.unfull();
  }

  private send(json: string, bytes = Buffer.byteLength(json)): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    this.inflight += bytes;
    let done = false;
    try {
      this.ws.send(json, () => {
        if (done) return;
        done = true;
        this.inflight -= bytes;
        this.flush();
      });
    } catch {
      this.inflight -= bytes;
      done = true;
    }
  }

  private unfull(): void {
    if (!this.fullTimer) return;
    (this.o.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.fullTimer);
    this.fullTimer = null;
  }
}

/** Serve one events socket from `hub`: hello, the resume's replay, then live entries. */
export function serveEvents(ws: EventsSocket, search: URLSearchParams, hub: EventHub, o?: OutboxOptions): void {
  const outbox = new Outbox(ws, o);
  const refuse = (message: string) => {
    outbox.direct(JSON.stringify({ type: "error", message }));
    ws.close(4400, "bad cursor");
  };
  const c = cursorOf(search);
  if ("error" in c) return refuse(c.error);
  // `?with=command.ran` adds the command frames (§app.command-audit/record); any other `with` is
  // ignored, so every socket that connects today connects the same way.
  const commands = search.get("with") === WITH_COMMANDS;
  const sub = hub.subscribe({ deliver: (e) => outbox.push(e), ...(commands ? { commands: true as const } : {}) }, c.cursor);
  if ("error" in sub) return refuse(sub.error);
  outbox.direct(sub.hello);
  outbox.replay(sub.replay);
  ws.on("message", () => {}); // read-only
  ws.on("close", () => {
    outbox.stop();
    sub.leave();
  });
}

const wss = cappedWebSocketServer({ noServer: true, maxPayload: CLIENT_FRAME_MAX });

/** The main listener's /ws/events upgrade (server/ws.ts attachWebSockets, after its gate). */
export function upgradeEventsSocket(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const hub = eventHub();
  if (!hub) {
    socket.destroy();
    return;
  }
  const search = new URL(req.url ?? "/", "http://localhost").searchParams;
  wss.handleUpgrade(req, socket, head, (ws) => serveEvents(ws, search, hub));
}
