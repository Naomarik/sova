import { type FSWatcher, watch } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { WatchServerMessage } from "../shared/protocol";
import { activeBranch, normalizeEntries, parseLines } from "./transcript";

const POLL_MS = 1500;

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
    if (!this.closed) this.send({ type: "snapshot", items: normalizeEntries(activeBranch(parseLines(text))) });
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
    const items = normalizeEntries(parseLines(text).filter((e) => e.type !== "session"));
    if (items.length && !this.closed) this.send({ type: "append", items });
  }
}
