import { open, readFile, stat } from "node:fs/promises";
import type { HEntry } from "../shared/harness";
import { lineEntry, parsePiBranch } from "./harness/pi/reader";

/** A final reply (not a tool-use step) newer than `since`: what the unread count counts. */
export function isUnreadReply(h: HEntry, since: number): boolean {
  if (h.kind !== "assistant" || h.stop === "toolUse") return false;
  const t = typeof h.sentAt === "number" ? h.sentAt : Date.parse(h.at ?? "");
  return Number.isFinite(t) && t > since;
}

/** The bytes before the counted end compared on each read: a file rewritten under the same or a
    larger size (not only appended to) has other bytes there, and is counted again in full. */
const GUARD_BYTES = 64;

interface Counted {
  path: string;
  since: number;
  mtimeMs: number;
  /** Bytes counted: up to the end of the last whole line. */
  size: number;
  /** The last GUARD_BYTES of them. */
  guard: Buffer;
  /** The active branch's leaf after them. */
  leafId: string;
  count: number;
}

/**
 * The unread count of one session file (the Overseer's, a project overseer's), kept between reads.
 * While the file only grows by entries that extend the active branch (each one's parent is the
 * leaf before it), only the appended lines are parsed; anything else (the file shrank or was
 * rewritten, another path or `since`, an entry that starts another branch, a line that doesn't
 * parse, a file without entry ids) counts the whole branch again, as `readBranch` does.
 */
export class UnreadReplies {
  private memo: Counted | null = null;
  /** Full counts so far, for tests. */
  full = 0;

  async count(path: string, since: number | undefined): Promise<number> {
    if (since === undefined) return 0;
    const st = await stat(path).catch(() => null);
    if (!st) return 0;
    const m = this.memo;
    if (m && m.path === path && m.since === since) {
      if (st.mtimeMs === m.mtimeMs && st.size === m.size) return m.count;
      if (st.size >= m.size) {
        const grown = await this.appended(m, st.size, st.mtimeMs).catch(() => null);
        if (grown !== null) return grown;
      }
    }
    return this.recount(path, since);
  }

  /** Counts the lines appended since `m`, or null when they don't simply extend the branch. */
  private async appended(m: Counted, size: number, mtimeMs: number): Promise<number | null> {
    const fh = await open(m.path, "r");
    try {
      const from = Math.max(0, m.size - m.guard.length);
      const buf = Buffer.alloc(size - from);
      let got = 0;
      while (got < buf.length) {
        const { bytesRead } = await fh.read(buf, got, buf.length - got, from + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      if (got < m.size - from || !buf.subarray(0, m.size - from).equals(m.guard)) return null;
      const added = buf.subarray(m.size - from, got);
      const end = added.lastIndexOf(0x0a) + 1; // a line still being written waits for its end
      let leafId = m.leafId;
      let count = m.count;
      for (const line of added.subarray(0, end).toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        // A line that doesn't parse, or is a header, or has no id, ends the incremental read.
        const h = lineEntry(line);
        if (!h || h.id === null || h.parentId !== leafId) return null;
        leafId = h.id;
        if (isUnreadReply(h, m.since)) count++;
      }
      const counted = m.size + end;
      const all = buf.subarray(0, counted - from);
      this.memo = { ...m, mtimeMs, size: counted, guard: Buffer.from(all.subarray(Math.max(0, all.length - GUARD_BYTES))), leafId, count };
      return count;
    } finally {
      await fh.close();
    }
  }

  private async recount(path: string, since: number): Promise<number> {
    this.full++;
    const st = await stat(path).catch(() => null);
    const bytes = await readFile(path).catch(() => null);
    if (!st || !bytes) {
      this.memo = null;
      return 0;
    }
    const branch = parsePiBranch(bytes.toString("utf8")).branch;
    let count = 0;
    for (const e of branch) if (isUnreadReply(e, since)) count++;
    // Kept for the next read only when it can go on from here: whole lines, a leaf with an id.
    const leafId = branch.at(-1)?.id;
    const whole = bytes.length > 0 && bytes[bytes.length - 1] === 0x0a;
    this.memo =
      whole && typeof leafId === "string" && st.size === bytes.length
        ? { path, since, mtimeMs: st.mtimeMs, size: bytes.length, guard: Buffer.from(bytes.subarray(Math.max(0, bytes.length - GUARD_BYTES))), leafId, count }
        : null;
    return count;
  }
}
