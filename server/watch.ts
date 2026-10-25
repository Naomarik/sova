import { type FSWatcher, watch } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { TranscriptItem, WatchServerMessage, WireVersion } from "../shared/protocol";
import { parsePi, parsePiBranch } from "./harness/pi/reader";
import { cutTail, pullFields } from "./tail-hello";
import type { ReplyTimings } from "./reply-facts";
import { rowsOf } from "./transcript";
import { withRows } from "./wire-rows";
import { entryOfRow } from "../shared/row-counts";
import type { ContextTally } from "./worker-context";

const POLL_MS = 1500;

/** The kinds an assistant reply's first row can be (the row that carries its `reply` fact). */
const REPLY_HEAD = new Set<string>(["thinking", "assistant-text", "tool-call"]);

/** JSONL text -> rows. Whole file on snapshot, the new lines only on append. */
export type Normalize = (text: string, part: "snapshot" | "append") => TranscriptItem[];

/** pi sessions: the active branch of the file, the new rows as they land (a header line has none). */
const piNormalize: Normalize = (text, part) => rowsOf(part === "snapshot" ? parsePiBranch(text).branch : parsePi(text).entries);

/**
 * Read-only tail of one session JSONL file for one client. Opens the file with "r" only.
 * Sends `snapshot` (active branch), then `append` for each batch of complete new lines.
 * If the file shrinks (rewritten), a fresh `snapshot` is sent. With `sendRaw` (the client asked
 * with `?tail=1`), each snapshot holds only the newest rows and its older rows follow as `history`
 * before anything else (server/tail-hello.ts): no read runs until the snapshot's step is done.
 * With `pull` (`?tail=rest`), the snapshot is cut the same way and nothing follows it.
 * On `wire` 2 (`?wire=2`) every row goes out mapped (server/wire-rows.ts), cut where wire 1 cuts it.
 * With `timings` (wire 2, a pi session file), an assistant reply's first row carries its measured timing
 * (`reply`, server/reply-facts.ts): loaded with each snapshot, and asked again when an append holds a
 * reply the lookup has no timing for yet (its chat, another process, writes the timing as it writes
 * the reply).
 */
export class SessionTail {
  private offset = 0;
  private watcher: FSWatcher | null = null;
  private poll: NodeJS.Timeout | null = null;
  private reading = false;
  private dirty = false;
  private closed = false;
  /** The session's measured replies, as last loaded through `timings`. */
  private replies: ReplyTimings | null = null;

  constructor(
    private readonly path: string,
    private readonly send: (msg: WatchServerMessage) => void,
    /** How this file's lines become rows; claude-code workers write a different format. */
    private readonly normalize: Normalize = piNormalize,
    /** The transcript's context fill, same feed. One per tail: it follows reads, so it must not
        be shared between clients. (What it spent is the usage ledger's: /api/usage/session.) */
    private readonly context?: ContextTally,
    /** Set for a tail-first client: its snapshot is cut, and the history goes out through this. */
    private readonly sendRaw?: (json: string) => void,
    /** Set for a `?tail=rest` client: its snapshot is cut, and it fetches the older rows itself
        (server/transcript-rows.ts); `prefetch`: all of them, now (a browser on this machine). */
    private readonly pull?: { prefetch: boolean },
    /** The wire the client asked for: its rows' facts as `meta` (1) or `facts` (2). */
    private readonly wire: WireVersion = 1,
    /** Where this session's measured replies come from (wire 2 only; never throws). */
    private readonly timings?: () => Promise<ReplyTimings | null>,
  ) {}

  /** The lookup, loaded again. A failed or empty answer keeps what was there: the store only grows. */
  private async loadReplies(): Promise<void> {
    if (!this.timings || this.wire === 1) return;
    try {
      const got = await this.timings();
      if (got) this.replies = got;
    } catch {
      // keep what was there
    }
  }

  async start(): Promise<void> {
    await this.snapshot();
    if (this.closed) return;
    try {
      this.watcher = watch(this.path, { persistent: false }, () => this.kick());
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = null; // polling keeps working
      });
    } catch {
      // fs.watch unavailable: polling only
    }
    this.poll = setInterval(() => this.kick(), POLL_MS);
    this.poll.unref();
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  /** Read [from, to) and return the text up to the last newline, plus bytes consumed. */
  private async readComplete(from: number, to: number): Promise<{ text: string; consumed: number }> {
    if (to <= from) return { text: "", consumed: 0 };
    const fh = await open(this.path, "r");
    try {
      const buf = Buffer.alloc(to - from);
      const { bytesRead } = await fh.read(buf, 0, buf.length, from);
      const data = buf.subarray(0, bytesRead);
      const nl = data.lastIndexOf(0x0a);
      if (nl < 0) return { text: "", consumed: 0 }; // partial line: wait for the rest
      return { text: data.subarray(0, nl + 1).toString("utf8"), consumed: nl + 1 };
    } finally {
      await fh.close();
    }
  }

  private async snapshot(): Promise<void> {
    const replies = this.loadReplies();
    const { size } = await stat(this.path);
    const { text, consumed } = await this.readComplete(0, size);
    this.offset = consumed;
    await replies;
    const context = this.context?.(text, "snapshot");
    if (this.closed) return;
    const items = this.normalize(text, "snapshot");
    const cut = this.sendRaw || this.pull ? cutTail(items, { history: !this.pull }) : null;
    this.send(withRows({
      type: "snapshot",
      items: cut ? cut.items : items,
      ...(context !== undefined ? { context } : {}),
      ...(cut && cut.older > 0 ? { older: cut.older } : {}),
      ...(cut && cut.older > 0 && this.pull ? pullFields(items, cut.older, this.pull.prefetch) : {}),
    }, this.wire, this.replies?.get));
    if (cut && this.sendRaw) for (const part of cut.history) this.sendRaw(this.wire === 1 ? part.raw : JSON.stringify(withRows(part.msg, this.wire, this.replies?.get)));
  }

  private kick(): void {
    if (this.closed) return;
    if (this.reading) {
      this.dirty = true;
      return;
    }
    this.reading = true;
    this.readNew()
      .catch((err) => {
        if (!this.closed) this.send({ type: "error", message: `watch read failed: ${err?.message ?? err}` });
      })
      .finally(() => {
        this.reading = false;
        if (this.dirty) {
          this.dirty = false;
          this.kick();
        }
      });
  }

  private async readNew(): Promise<void> {
    const { size } = await stat(this.path);
    if (size < this.offset) {
      await this.snapshot();
      return;
    }
    if (size === this.offset) return;
    const { text, consumed } = await this.readComplete(this.offset, size);
    if (!consumed) return;
    this.offset += consumed;
    const items = this.normalize(text, "append");
    // The state after this batch, sent explicitly — "compacted" included — on every append.
    const context = this.context?.(text, "append");
    if (!items.length || this.closed) return;
    // A reply just written whose timing the lookup lacks: ask once for this batch.
    if (this.timings && this.wire === 2 && items.some((it) => it.meta !== undefined && REPLY_HEAD.has(it.kind) && !this.replies?.get(entryOfRow(it.id)))) {
      await this.loadReplies();
      if (this.closed) return;
    }
    this.send(withRows({ type: "append", items, ...(context !== undefined ? { context } : {}) }, this.wire, this.replies?.get));
  }
}
