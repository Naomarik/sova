import { type FSWatcher, watch } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { TranscriptItem, WatchServerMessage } from "../shared/protocol";
import { activeBranch, normalizeEntries, parseLines } from "./transcript";
import { piUsageTally, totalOf, type UsageTally } from "./transcript-usage";
import type { ContextTally } from "./worker-context";

const POLL_MS = 1500;

/** JSONL text -> rows. Whole file on snapshot, the new lines only on append. */
export type Normalize = (text: string, part: "snapshot" | "append") => TranscriptItem[];

/** pi sessions: the active branch of the file, the new rows as they land. */
const piNormalize: Normalize = (text, part) =>
  normalizeEntries(part === "snapshot" ? activeBranch(parseLines(text)) : parseLines(text).filter((e) => e.type !== "session"));

/**
 * Read-only tail of one session JSONL file for one client. Opens the file with "r" only.
 * Sends `snapshot` (active branch), then `append` for each batch of complete new lines.
 * If the file shrinks (rewritten), a fresh `snapshot` is sent.
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
    /** Running token total for this connection, in that same format. One per tail: it
        deduplicates across reads, so it must not be shared between clients. */
    private readonly tally: UsageTally = piUsageTally(),
    /** The transcript's context fill, same feed; per connection for the same reason. */
    private readonly context?: ContextTally,
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
    const usage = totalOf(this.tally(text, "snapshot"));
    const context = this.context?.(text, "snapshot");
    if (!this.closed) this.send({ type: "snapshot", items: this.normalize(text, "snapshot"), ...(usage ? { usage } : {}), ...(context !== undefined ? { context } : {}) });
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
    // Cumulative, so a row-less batch that still spent tokens keeps the header honest.
    const usage = totalOf(this.tally(text, "append"));
    // The state after this batch, sent explicitly — "compacted" included — on every append.
    const context = this.context?.(text, "append");
    if (items.length && !this.closed) this.send({ type: "append", items, ...(usage ? { usage } : {}), ...(context !== undefined ? { context } : {}) });
  }
}
