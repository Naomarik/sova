import { type FSWatcher, watch } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { TranscriptItem, WatchServerMessage, WireVersion } from "../shared/protocol";
import { parsePi, parsePiBranch } from "./harness/pi/reader";
import { cutTail, pullFields } from "./tail-hello";
import { rowsOf } from "./transcript";
import { withRows } from "./wire-rows";
import type { ContextTally } from "./worker-context";

const POLL_MS = 1500;

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
 */
export class SessionTail {
  private offset = 0;
  private watcher: FSWatcher | null = null;
  private poll: NodeJS.Timeout | null = null;
  private reading = false;
  private dirty = false;
  private closed = false;

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
  ) {}

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
    const { size } = await stat(this.path);
    const { text, consumed } = await this.readComplete(0, size);
    this.offset = consumed;
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
    }, this.wire));
    if (cut && this.sendRaw) for (const part of cut.history) this.sendRaw(this.wire === 1 ? part.raw : JSON.stringify(withRows(part.msg, this.wire)));
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
    if (items.length && !this.closed) this.send(withRows({ type: "append", items, ...(context !== undefined ? { context } : {}) }, this.wire));
  }
}
