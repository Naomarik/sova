// corpus: the frozen copy read once into what both systems need (plan.md, The dataset).
// Per session: every line's end offset and timestamp (the as-of view), and its user and assistant
// messages through the same reader text path the incumbent searches (lineMay, lineEntry,
// joinedText without images): no tool output, no thinking.
import { copyFileSync, constants, existsSync, mkdirSync, readFileSync, renameSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { joinedText, lineEntry, lineMay } from "../../server/harness/pi/reader";
import { sha256 } from "./common";

export interface Message {
  who: "user" | "assistant";
  /** The line's own timestamp (ms): what the as-of view cuts on. */
  lineAt: number;
  /** The incumbent's snippet time (sentAt, else the entry time). */
  at: number;
  text: string;
}

export interface ListingRow {
  id: string;
  rel: string;
  listed: boolean;
  cwd: string;
  /** Its project: the listing's, else the build a worktree name implies (freeze.ts buildOf). */
  project: string | null;
  createdAt: string | null;
  lastActiveAt: string | null;
  title: string | null;
  originalTitle: string | null;
  outlineGist: string | null;
  outlineNow: string | null;
  outlineTopics: number | null;
  outlineAt: number | null;
  archived: boolean;
  skipped: string | null;
}

export interface Session {
  row: ListingRow;
  path: string;
  size: number;
  mtimeMs: number;
  /** The first line's timestamp (ms), or 0 when it has none: a session created after a query is absent. */
  bornAt: number;
  /** End offset (bytes, exclusive, newline included) and timestamp of each line, in file order. */
  lineEnd: Float64Array;
  lineAt: Float64Array;
  messages: Message[];
}

const TS = /"timestamp":"([^"]+)"/;

/** A line's timestamp (ms): the entry's own `timestamp`, read from its head (no full parse). */
export function lineTime(line: string): number {
  const m = TS.exec(line.length > 400 ? line.slice(0, 400) : line);
  return m ? Date.parse(m[1]!) || 0 : 0;
}

/** One session file → its lines' ends and times, and its user/assistant messages. */
export function readSession(path: string): Pick<Session, "bornAt" | "lineEnd" | "lineAt" | "messages"> {
  const buf = readFileSync(path);
  const ends: number[] = [];
  const ats: number[] = [];
  const messages: Message[] = [];
  let start = 0;
  let last = 0;
  while (start < buf.length) {
    let nl = buf.indexOf(0x0a, start);
    const end = nl < 0 ? buf.length : nl + 1;
    if (nl < 0) nl = buf.length;
    const line = buf.toString("utf8", start, nl);
    let t = lineTime(line);
    if (!t) t = last; // an entry with no time of its own sits where its neighbours do
    last = t;
    ends.push(end);
    ats.push(t);
    if (lineMay(line, "user") || lineMay(line, "assistant")) {
      const h = lineEntry(line);
      if (h && (h.kind === "user" || h.kind === "assistant")) {
        const text = joinedText(h, { images: false });
        if (text.trim()) {
          const at = typeof h.sentAt === "number" ? h.sentAt : typeof h.at === "string" ? Date.parse(h.at) || 0 : 0;
          messages.push({ who: h.kind, lineAt: t, at, text });
        }
      }
    }
    start = end;
  }
  return { bornAt: ats.find((t) => t > 0) ?? 0, lineEnd: Float64Array.from(ends), lineAt: Float64Array.from(ats), messages };
}

export function loadCorpus(copy: string, rows: readonly ListingRow[]): Session[] {
  return rows.map((row) => {
    const path = join(copy, row.rel);
    const st = statSync(path);
    return { row, path, size: st.size, mtimeMs: st.mtimeMs, ...readSession(path) };
  });
}

/** The file as of `t`: how many bytes were written by then, and its last activity then. */
export function asOf(s: Pick<Session, "bornAt" | "lineEnd" | "lineAt" | "size" | "mtimeMs">, t: number): { present: boolean; bytes: number; activeAt: number } {
  if (!Number.isFinite(t) || t >= s.mtimeMs) return { present: true, bytes: s.size, activeAt: s.mtimeMs };
  if (s.bornAt > t || !s.lineAt.length) return { present: false, bytes: 0, activeAt: 0 };
  // the last line written at or before t (times are non-decreasing in an append-only file, mostly)
  let lo = 0;
  let hi = s.lineAt.length - 1;
  let k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s.lineAt[mid]! <= t) {
      k = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (k < 0) return { present: false, bytes: 0, activeAt: 0 };
  return k === s.lineAt.length - 1 ? { present: true, bytes: s.size, activeAt: s.lineAt[k]! } : { present: true, bytes: s.lineEnd[k]!, activeAt: s.lineAt[k]! };
}

/** A path holding the first `bytes` of `src`: `src` itself when whole, else a reflinked, truncated
    copy under `dir` (made once, kept). Never a link: an edit could never reach the copy's source. */
export function truncatedCopy(src: string, size: number, bytes: number, dir: string): string {
  if (bytes >= size) return src;
  mkdirSync(dir, { recursive: true });
  const dst = join(dir, `${sha256(`${src}\t${bytes}`).slice(0, 24)}.jsonl`);
  if (!existsSync(dst)) {
    copyFileSync(src, dst + ".tmp", constants.COPYFILE_FICLONE);
    truncateSync(dst + ".tmp", bytes);
    renameSync(dst + ".tmp", dst);
  }
  return dst;
}
