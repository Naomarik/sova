// The framed socket between the server and a chat process (shared/chat-runtime-wire.ts), both ends.
// The chat process listens (`serveLink`) and the server dials (`connectLink`). A connection starts
// with the chat's `hello`; the server answers `control` with its controller epoch, and the chat keeps
// one controller at a time: an epoch below the highest it has seen is refused, an equal one while
// its link is up is refused, a higher one replaces the link before it. Each side pings the other
// every 10 s and counts the link lost after 3 pings go unanswered. `hello` is always a link's first
// frame; a later hello on the same link only says the runtime's new `state`: it is never a reconnect.
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  CHAT_WIRE_MIN_PROTO,
  CHAT_WIRE_PROTO,
  type ChatWireFrame,
  type ChatWireType,
  encodeFrame,
  FrameDecoder,
  type FrameOf,
  LINK_BACKLOG_MAX_BYTES,
  PING_EVERY_MS,
  PINGS_MISSED_MAX,
  protoCompatible,
} from "../../shared/chat-runtime-wire";

export type HelloFrame = FrameOf<"hello">;

/** Frames kept for a listener not there yet, at most. */
const HELD_MAX = 256;
export type ControlFrame = FrameOf<"control">;

/** Why a link ended. */
export type LinkEnd =
  | { reason: "closed" } // the peer (or this side) closed it
  | { reason: "lost" } // pings went unanswered
  | { reason: "protocol"; message: string } // a broken frame
  | { reason: "backlog" } // the peer stopped reading
  | { reason: "replaced" } // a newer controller took over (runtime side)
  | { reason: "refused"; refusal: FrameOf<"refuse"> };

export interface LinkOptions {
  pingEveryMs?: number;
  pingsMissedMax?: number;
  backlogMax?: number;
  log?: (line: string) => void;
}

/** One connection, either end. Frames are handed to the listeners of their type in arrival order. */
export class Link {
  private readonly decoder: FrameDecoder;
  private readonly listeners = new Map<string, Set<(frame: never) => void>>();
  private readonly unknown = new Set<string>();
  /** Frames that came before anyone listened for their type (the peer answered a control or an
      attach in the same breath as the frame its listener waits for): handed to the first listener of
      their type. A type nobody ever listens for is dropped past HELD_MAX, oldest first. */
  private held: ChatWireFrame[] = [];
  private pingTimer: NodeJS.Timeout | null = null;
  private pingN = 0;
  private unanswered = 0;
  private ended: LinkEnd | null = null;
  private resolveClosed!: (end: LinkEnd) => void;
  /** Settles once, with why the link ended. */
  readonly closed: Promise<LinkEnd>;
  /** Whether the peer's protocol is one this side speaks beyond the kernel frames. */
  compatible = true;
  /** The protocol the peer speaks (its hello's or control's): a proto-1 peer gets no stage-3 frames. */
  peerProto = CHAT_WIRE_PROTO;
  /** The state the last `hello` this side sent on the link said; null before its first. */
  saidState: HelloFrame["state"] | null = null;
  private readonly log: (line: string) => void;

  constructor(
    private readonly socket: Socket,
    private readonly opts: LinkOptions = {},
  ) {
    this.log = opts.log ?? ((l) => console.error(`[chat-link] ${l}`));
    this.closed = new Promise((r) => (this.resolveClosed = r));
    this.decoder = new FrameDecoder({ onLarge: (n) => this.log(`a large frame: ${n} bytes`) });
    socket.on("data", (chunk: Buffer) => {
      if (this.ended) return;
      let frames;
      try {
        frames = this.decoder.push(chunk);
      } catch (err) {
        this.log(`broken stream: ${(err as Error).message}`);
        this.end({ reason: "protocol", message: (err as Error).message });
        return;
      }
      for (const f of frames) {
        if (this.ended) return;
        this.dispatch(f as ChatWireFrame);
      }
    });
    socket.on("error", () => {}); // a reset ends in close
    // The peer closed its side (a half-open link means nothing here): ended, as on close.
    socket.on("end", () => this.end({ reason: "closed" }));
    socket.on("close", () => this.end({ reason: "closed" }));
  }

  get isOpen(): boolean {
    return this.ended === null;
  }

  /** Hear frames of type `t`, in order; the returned call stops it. */
  on<T extends ChatWireType>(t: T, fn: (frame: FrameOf<T>) => void): () => void {
    let set = this.listeners.get(t);
    if (!set) this.listeners.set(t, (set = new Set()));
    set.add(fn as (frame: never) => void);
    if (this.held.some((h) => h.t === t)) {
      const mine = this.held.filter((h) => h.t === t);
      this.held = this.held.filter((h) => h.t !== t);
      queueMicrotask(() => {
        for (const h of mine) if (!this.ended) this.deliver(h);
      });
    }
    return () => set.delete(fn as (frame: never) => void);
  }

  /** Send one frame. False when the link is gone (nothing was sent). A peer that stopped reading
      past the backlog limit loses the link. */
  send(frame: ChatWireFrame): boolean {
    if (this.ended) return false;
    let bytes: Uint8Array;
    try {
      bytes = encodeFrame(frame);
    } catch (err) {
      this.log(`not sent: ${(err as Error).message}`);
      return false;
    }
    this.socket.write(bytes);
    if (frame.t === "hello") this.saidState = frame.state;
    if (this.socket.writableLength > (this.opts.backlogMax ?? LINK_BACKLOG_MAX_BYTES)) {
      this.log(`the peer stopped reading (${this.socket.writableLength} bytes waiting): dropping the link`);
      this.end({ reason: "backlog" });
      return false;
    }
    return true;
  }

  /** Ping the peer every `pingEveryMs`; the link is lost after `pingsMissedMax` go unanswered. */
  startPings(): void {
    if (this.pingTimer || this.ended) return;
    const every = this.opts.pingEveryMs ?? PING_EVERY_MS;
    const max = this.opts.pingsMissedMax ?? PINGS_MISSED_MAX;
    this.pingTimer = setInterval(() => {
      if (this.unanswered >= max) {
        this.log(`${this.unanswered} pings unanswered: the link is lost`);
        this.end({ reason: "lost" });
        return;
      }
      this.unanswered++;
      this.send({ t: "ping", n: ++this.pingN });
    }, every);
    this.pingTimer.unref?.();
  }

  /** Close the link from this side, after sending `last` if given. */
  close(end: LinkEnd = { reason: "closed" }, last?: ChatWireFrame): void {
    if (this.ended) return;
    if (last) this.send(last);
    this.end(end);
  }

  private end(end: LinkEnd): void {
    if (this.ended) return;
    this.ended = end;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    // Whatever was written goes out before the socket closes.
    this.socket.end();
    if (end.reason !== "closed") setTimeout(() => this.socket.destroy(), 1_000).unref?.();
    this.resolveClosed(end);
  }

  private dispatch(frame: ChatWireFrame): void {
    if (frame.t === "ping") this.send({ t: "pong", n: frame.n });
    else if (frame.t === "pong") this.unanswered = 0;
    else if (frame.t === "refuse") {
      this.end({ reason: "refused", refusal: frame });
      return;
    }
    if (frame.t === "ping" || frame.t === "pong") return void this.deliver(frame);
    if (!this.listeners.get(frame.t)?.size) {
      this.held.push(frame);
      if (this.held.length > HELD_MAX) {
        const gone = this.held.shift()!;
        if (!this.unknown.has(gone.t)) {
          this.unknown.add(gone.t);
          this.log(`ignoring frames of type ${gone.t}`);
        }
      }
      return;
    }
    this.deliver(frame);
  }

  private deliver(frame: ChatWireFrame): void {
    const set = this.listeners.get(frame.t);
    if (!set?.size) return;
    for (const fn of [...set]) {
      try {
        (fn as (f: ChatWireFrame) => void)(frame);
      } catch (err) {
        this.log(`a ${frame.t} listener failed: ${(err as Error).stack ?? err}`);
      }
    }
  }
}

// ---- the chat process's end ------------------------------------------------------------------------

export interface ServeLinkOptions extends LinkOptions {
  /** The hello to open each connection with, as the chat stands now. */
  hello(): Omit<HelloFrame, "t" | "proto" | "minProto" | "epoch">;
  /** A server took control on `link` (its `control` frame). The link before it, if any, was closed. */
  onControl(link: Link, control: ControlFrame): void;
  /** How long a connection may take to send `control` before it is closed. */
  controlWithinMs?: number;
}

export interface LinkServer {
  /** The controller's link now, or null. */
  readonly controller: Link | null;
  /** The highest controller epoch this process has seen. */
  readonly epoch: number;
  close(): Promise<void>;
}

/**
 * Listen on `sockPath` (its directory made 0700, a stale socket file removed, the socket 0600) and
 * hand each connection that takes control to `onControl`, one controller at a time by epoch.
 */
export async function serveLink(sockPath: string, opts: ServeLinkOptions): Promise<LinkServer> {
  mkdirSync(dirname(sockPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(sockPath), 0o700);
  rmSync(sockPath, { force: true });
  let controller: Link | null = null;
  let epoch = 0;
  const log = opts.log ?? ((l: string) => console.error(`[chat-link] ${l}`));
  const server: Server = createServer((socket) => {
    const link = new Link(socket, opts);
    link.send({ t: "hello", proto: CHAT_WIRE_PROTO, minProto: CHAT_WIRE_MIN_PROTO, epoch, ...opts.hello() });
    const timer = setTimeout(() => link.close({ reason: "closed" }), opts.controlWithinMs ?? 10_000);
    timer.unref?.();
    void link.closed.then(() => clearTimeout(timer));
    const off = link.on("control", (control) => {
      off();
      clearTimeout(timer);
      const refuse = (reason: FrameOf<"refuse">["reason"], message: string) => {
        log(`refused a controller: ${message}`);
        link.close({ reason: "closed" }, { t: "refuse", reason, message });
      };
      if (!Number.isFinite(control.epoch) || control.epoch < epoch) return refuse("stale-epoch", `epoch ${control.epoch} is below ${epoch}`);
      if (control.epoch === epoch && controller?.isOpen) return refuse("busy-controller", `epoch ${epoch} already controls this chat`);
      epoch = control.epoch;
      // A server too old or too new for anything but the kernel frames may still drain this chat.
      link.compatible = protoCompatible(control.proto, control.proto - 1);
      link.peerProto = control.proto;
      const before = controller;
      controller = link;
      if (before?.isOpen) before.close({ reason: "replaced" });
      void link.closed.then(() => {
        if (controller === link) controller = null;
      });
      link.startPings();
      opts.onControl(link, control);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(sockPath, 0o600);
  return {
    get controller() {
      return controller;
    },
    get epoch() {
      return epoch;
    },
    async close() {
      controller?.close();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(sockPath, { force: true });
    },
  };
}

// ---- the server's end ---------------------------------------------------------------------------

export interface ConnectLinkOptions extends LinkOptions {
  epoch: number;
  build: string;
  settings: ControlFrame["settings"];
  /** The last lifecycle seq this server saw of the chat; null: a fresh server (no replay). */
  since: number | null;
  serverPid?: number;
  serverStartedAt?: number;
  /** Keep dialing a socket that isn't there yet (or refuses) for this long, every `retryEveryMs`. */
  retryForMs?: number;
  retryEveryMs?: number;
  /** How long the chat may take to say hello once connected; never less than what is left of
      `retryForMs` (a chat still loading its code answers late: the start's budget is the socket's). */
  helloWithinMs?: number;
}

/** This server's start, worked out once: the same on every link it opens, so a chat tells one server life from the next. */
const SERVER_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);

export class LinkRefused extends Error {
  constructor(readonly refusal: FrameOf<"refuse">) {
    super(`The chat process refused this server: ${refusal.message}`);
  }
}

/**
 * Dial a chat process at `sockPath` and take control: its hello, and the link (pinging). A refusal of
 * the control (a stale or busy epoch) ends the link with reason "refused" rather than rejecting here:
 * race `link.closed` against the first frame awaited next (`opened`, or `state` on adoption), as
 * `awaitFrame` does, which rejects with LinkRefused.
 */
export async function connectLink(sockPath: string, opts: ConnectLinkOptions): Promise<{ link: Link; hello: HelloFrame }> {
  const until = Date.now() + (opts.retryForMs ?? 0);
  for (;;) {
    let socket: Socket;
    try {
      socket = await dial(sockPath);
    } catch (err) {
      if (Date.now() >= until) throw err;
      await new Promise((r) => setTimeout(r, opts.retryEveryMs ?? 100));
      continue;
    }
    const link = new Link(socket, opts);
    const helloMs = Math.max(opts.helloWithinMs ?? 5_000, until - Date.now());
    const hello = await new Promise<HelloFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        link.close();
        reject(new Error(`The chat process at ${sockPath} didn't say hello in time.`));
      }, helloMs);
      const off = link.on("hello", (h) => {
        off();
        clearTimeout(timer);
        resolve(h);
      });
      void link.closed.then((end) => {
        clearTimeout(timer);
        reject(new Error(`The chat process at ${sockPath} closed the link before its hello (${end.reason}).`));
      });
    });
    link.compatible = protoCompatible(hello.proto, hello.minProto);
    link.peerProto = hello.proto;
    link.send({
      t: "control",
      proto: CHAT_WIRE_PROTO,
      epoch: opts.epoch,
      serverPid: opts.serverPid ?? process.pid,
      serverStartedAt: opts.serverStartedAt ?? SERVER_STARTED_AT,
      build: opts.build,
      since: opts.since,
      settings: opts.settings,
    });
    // A refusal (stale or busy epoch) ends the link with reason "refused": callers race `closed`
    // against the first frame they wait for (`opened`, or `state` on adoption).
    link.startPings();
    return { link, hello };
  }
}

/** The next frame of type `t` that matches `match`; rejects when the link ends first (a refusal as
    LinkRefused) or after `withinMs`. */
export function awaitFrame<T extends ChatWireType>(link: Link, t: T, withinMs: number, match: (f: FrameOf<T>) => boolean = () => true): Promise<FrameOf<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`The chat process didn't answer (${t}) in time.`));
    }, withinMs);
    const off = link.on(t, (f) => {
      if (!match(f)) return;
      off();
      clearTimeout(timer);
      resolve(f);
    });
    void link.closed.then((end) => {
      off();
      clearTimeout(timer);
      reject(end.reason === "refused" ? new LinkRefused(end.refusal) : new Error(`The chat process's link ended (${end.reason}).`));
    });
  });
}

function dial(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = createConnection(path);
    s.once("connect", () => {
      s.off("error", reject);
      resolve(s);
    });
    s.once("error", reject);
  });
}
