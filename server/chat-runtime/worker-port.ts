// A parent chat's worker host in a chat process of its own (al_3 stage 4, design §2.10): every op goes
// to the server's worker registry over the chat's link (`wk`), and each watch is the server's feed of
// that worker (`wk.watch`, then `wk.feed`). The ops are idempotent (a start and a send carry keys; a
// stop or an abort repeats harmlessly), so one the server did not answer is sent again to the next
// server, and each watch is asked again from its last cursor: a server restart loses nothing. With no
// server for serverToolWaitMs an op fails with NOT_RUN_NO_SERVER.
import type { FrameOf } from "../../shared/chat-runtime-wire";
import { NOT_RUN_NO_SERVER } from "../../shared/chat-runtime-wire";
import { noAnswer, type WorkerCursor, type WorkerFeedFrame, type WorkerHost, type WorkerRef, type WorkerStart } from "../../shared/chat-runtime";
import type { Link } from "./link";

/** The protocol that carries worker chats and the worker host. */
export const WORKER_PROTO = 3;

type Op = FrameOf<"wk">["op"];

interface PendingOp {
  id: string;
  op: Op;
  args: unknown;
  sentOn: Link | null;
  timer: NodeJS.Timeout | null;
  resolve(v: unknown): void;
  reject(e: Error): void;
}

interface Watch {
  cursor: WorkerCursor | null;
  fns: Set<(f: WorkerFeedFrame) => void>;
}

export class LinkWorkerHost {
  private link: Link | null = null;
  private n = 0;
  private readonly ops = new Map<string, PendingOp>();
  private readonly watches = new Map<string, Watch>();

  constructor(private readonly waitMs: () => number) {}

  /** Ops waiting on the server (part of the chat's quiet: never reloaded under one). */
  get pending(): number {
    return this.ops.size;
  }

  private speaks(link: Link | null): link is Link {
    return !!link?.isOpen && link.compatible && link.peerProto >= WORKER_PROTO;
  }

  /** A server took control: what it has not answered goes to it, and every watch is asked again. */
  linked(link: Link): void {
    this.link = link;
    if (!this.speaks(link)) return;
    link.on("wk.result", (f: FrameOf<"wk.result">) => {
      if (this.link === link) this.result(f);
    });
    link.on("wk.feed", (f: FrameOf<"wk.feed">) => {
      if (this.link === link) this.feed(f);
    });
    for (const p of this.ops.values()) this.write(p);
    for (const [chatId, w] of this.watches) link.send({ t: "wk.watch", chatId, cursor: w.cursor });
  }

  /** The controller's link ended: unanswered ops wait for the next server. */
  unlinked(): void {
    this.link = null;
    for (const p of this.ops.values()) {
      p.sentOn = null;
      this.arm(p);
    }
  }

  private write(p: PendingOp): void {
    const link = this.link;
    if (!this.speaks(link)) return;
    if (p.timer) clearTimeout(p.timer);
    p.timer = null;
    p.sentOn = link;
    link.send({ t: "wk", id: p.id, op: p.op, args: p.args });
  }

  private arm(p: PendingOp): void {
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      if (this.ops.get(p.id) !== p) return;
      this.ops.delete(p.id);
      p.reject(noAnswer(NOT_RUN_NO_SERVER));
    }, this.waitMs());
    p.timer.unref?.();
  }

  private op<R>(op: Op, args: unknown): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const p: PendingOp = { id: `k${++this.n}`, op, args, sentOn: null, timer: null, resolve: resolve as (v: unknown) => void, reject };
      this.ops.set(p.id, p);
      if (this.speaks(this.link)) this.write(p);
      else this.arm(p);
    });
  }

  private result(f: FrameOf<"wk.result">): void {
    const p = this.ops.get(f.id);
    if (!p) return;
    this.ops.delete(f.id);
    if (p.timer) clearTimeout(p.timer);
    if (f.ok) p.resolve(f.result);
    else p.reject(Object.assign(new Error(f.error.message), f.error.code ? { code: f.error.code } : {}));
  }

  private feed(f: FrameOf<"wk.feed">): void {
    const w = this.watches.get(f.chatId);
    if (!w) return;
    if (f.frame.t === "state" || f.frame.t === "event") w.cursor = f.frame.cursor;
    else if (f.frame.t === "gap") w.cursor = null;
    for (const fn of [...w.fns]) {
      try {
        fn(f.frame);
      } catch (err) {
        console.error("[chat-runtime] worker watcher failed", err);
      }
    }
  }

  /** The host as one parent session sees it. */
  bind(parent: { sessionId: string; path: string }): WorkerHost {
    return {
      start: (req: WorkerStart) => this.op<WorkerRef>("start", req),
      send: (chatId, input) => this.op<{ queued: boolean }>("send", { chatId, input }),
      abort: (chatId) => this.op<void>("abort", { chatId }),
      stop: (chatId, reason) => this.op<void>("stop", { chatId, reason }),
      list: () => this.op<WorkerRef[]>("list", { parentSessionId: parent.sessionId }),
      watch: (chatId, cursor, fn) => {
        let w = this.watches.get(chatId);
        if (!w) this.watches.set(chatId, (w = { cursor, fns: new Set() }));
        else if (cursor) w.cursor = cursor;
        w.fns.add(fn);
        if (this.speaks(this.link)) this.link.send({ t: "wk.watch", chatId, cursor: w.cursor });
        return () => {
          const now = this.watches.get(chatId);
          if (!now?.fns.delete(fn) || now.fns.size) return;
          this.watches.delete(chatId);
          if (this.speaks(this.link)) this.link.send({ t: "wk.unwatch", chatId });
        };
      },
    };
  }
}
