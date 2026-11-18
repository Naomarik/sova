import fs from "node:fs";
import path from "node:path";
import { parseToolRunLine, type ToolRunRecord } from "../tool-run-record";

/**
 * The usage helper's reader of the tool-run store (`<agent dir>/usage/tools/v1/<UTC day>/<producer>.jsonl`,
 * one line per finished tool call, written by each chat process: server/tool-run-record.ts). Every
 * record in memory, deduplicated by key. Files are read from where the last read stopped (whole lines
 * only); a file that shrank is read again from its start. The newest days are looked at on every ask,
 * every day at most once a minute. An absent store (chats on older code) reads as no tool time.
 */

/** One stored tool run, as the reader keeps it. */
export interface ToolRunStored {
  sid: string;
  start: number;
  end: number;
  /** `worker-wait`: a tool waiting on the session's own workers (never agent time). */
  wait: boolean;
  /** The session's kind, when the record names it. */
  kind?: "main" | "worker" | "overseer";
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.jsonl$/;
const DAY_MS = 86_400_000;
const FULL_SWEEP_MS = 60_000;

export class ToolRunStore {
  private readonly files = new Map<string, { size: number; mtimeMs: number; off: number }>();
  private readonly byKey = new Map<string, ToolRunStored>();
  private seq = 0;
  private first: number | null = null;
  private lastSweep = -Infinity;

  constructor(private readonly opts: { root: string; now?: () => number }) {}

  get size(): number {
    return this.byKey.size;
  }

  /** Bumped per record added. */
  get version(): number {
    return this.seq;
  }

  /** The first recorded tool run's start (ms), or null: from then on tool time is counted. */
  get firstAt(): number | null {
    return this.first;
  }

  records(): IterableIterator<ToolRunStored> {
    return this.byKey.values();
  }

  refresh(full = false): void {
    let days: string[];
    try {
      days = fs.readdirSync(this.opts.root).filter((d) => DAY_RE.test(d)).sort();
    } catch {
      return;
    }
    const now = (this.opts.now ?? Date.now)();
    const sweep = full || now - this.lastSweep >= FULL_SWEEP_MS;
    if (sweep) this.lastSweep = now;
    const recent = new Set([new Date(now - DAY_MS), new Date(now)].map((d) => d.toISOString().slice(0, 10)));
    for (const d of days.slice(-2)) recent.add(d);
    for (const day of days) {
      if (!sweep && !recent.has(day)) continue;
      const dir = path.join(this.opts.root, day);
      let names: string[];
      try {
        names = fs.readdirSync(dir).filter((n) => FILE_RE.test(n));
      } catch {
        continue;
      }
      for (const name of names) this.readFile(path.join(dir, name));
    }
  }

  private readFile(file: string): void {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return;
    }
    const had = this.files.get(file);
    if (had && had.size === st.size && had.mtimeMs === st.mtimeMs) return;
    try {
      const from = had && st.size >= had.off ? had.off : 0;
      const len = st.size - from;
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(file, "r");
      try {
        fs.readSync(fd, buf, 0, len, from);
      } finally {
        fs.closeSync(fd);
      }
      const end = buf.lastIndexOf(10) + 1;
      if (end > 0) {
        for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
          if (!line) continue;
          const rec = parseToolRunLine(line);
          if (rec) this.add(rec);
        }
      }
      this.files.set(file, { size: st.size, mtimeMs: st.mtimeMs, off: from + end });
    } catch {
      // Unreadable now: tried again on its next change.
    }
  }

  /** One record, once per key. */
  add(rec: ToolRunRecord): void {
    if (this.byKey.has(rec.key) || rec.end <= rec.start) return;
    const out: ToolRunStored = { sid: rec.sid, start: rec.start, end: rec.end, wait: rec.kind === "worker-wait" };
    if (rec.sk !== undefined) out.kind = rec.sk;
    this.byKey.set(rec.key, out);
    this.seq++;
    if (this.first === null || rec.start < this.first) this.first = rec.start;
  }
}
