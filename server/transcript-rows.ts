// Older transcript rows on demand: `GET /api/transcript` with `tail`, `before` or `from`
// (TranscriptRows in shared/protocol.ts). A view that asked its socket for the newest rows alone
// (`?tail=rest`) fetches the rest here when it wants them: the chunk above what it holds as the
// reader scrolls up, the range down to a jump's target in one request, all of it in the background
// for a browser on this machine. Read from the file with our own parser, never a runtime, never a
// write; normalized over the whole active branch as the hello and the snapshot are, and cut with
// their rules (server/tail-hello.ts), so what the socket sent and what comes from here concatenate.

import { readFile, stat } from "node:fs/promises";
import type { ContextInfo, TranscriptItem } from "../shared/protocol";
import { entryOfRow, summarize } from "../shared/row-counts";
import { chunkStart, HISTORY_CHUNK_CHARS, rangeStart, TAIL_CHARS, TAIL_MIN_ROWS, tailStart } from "./tail-hello";
import { activeBranch, normalizeEntries, parseLines } from "./transcript";

type Entry = ReturnType<typeof parseLines>[number];

/** One file's branch, normalized, with each row's JSON made once. */
interface Rows {
  /** Size and mtime the file had when it was read: a different one reads it again. */
  stamp: string;
  branch: Entry[];
  items: TranscriptItem[];
  json: string[];
  sizes: number[];
  /** Every entry id in the file, and those on the active branch. */
  fileIds: Set<string>;
  branchIds: Set<string>;
  /** Row id → index, made on first use. */
  at?: Map<string, number>;
}

/** Files kept parsed: a view scrolling up, or prefetching, asks for one file many times running. */
const KEEP = 3;
const cache = new Map<string, Rows>();

async function rowsOf(path: string): Promise<Rows> {
  const st = await stat(path);
  const stamp = `${st.size}:${st.mtimeMs}`;
  const had = cache.get(path);
  if (had && had.stamp === stamp) {
    cache.delete(path);
    cache.set(path, had);
    return had;
  }
  const entries = parseLines(await readFile(path, "utf8"));
  const branch = activeBranch(entries);
  const items = normalizeEntries(branch);
  const json = items.map((it) => JSON.stringify(it));
  const ids = (list: Entry[]) => new Set(list.map((e) => e.id).filter((id): id is string => typeof id === "string"));
  const rows: Rows = { stamp, branch, items, json, sizes: json.map((s) => s.length), fileIds: ids(entries), branchIds: ids(branch) };
  cache.delete(path);
  cache.set(path, rows);
  while (cache.size > KEEP) cache.delete(cache.keys().next().value!);
  return rows;
}

const indexOfRow = (rows: Rows, id: string): number => {
  if (!rows.at) {
    rows.at = new Map();
    rows.items.forEach((it, i) => rows.at!.set(it.id, i));
  }
  return rows.at.get(id) ?? -1;
};

/** The row an entry (or row) id lands on, as the thread's own lookup does (src/lib/tail-render
    `rowIndexFor`): its own row or its first block's, then, for a block id, its entry's. */
function targetIndex(rows: Rows, id: string): number {
  const find = (x: string) => {
    const own = indexOfRow(rows, x);
    if (own >= 0) return own;
    const prefix = `${x}:`;
    return rows.items.findIndex((it) => it.id.startsWith(prefix));
  };
  const own = find(id);
  if (own >= 0) return own;
  const entry = entryOfRow(id);
  return entry === id ? -1 : find(entry);
}

export interface RowsQuery {
  tail?: boolean;
  before?: string;
  from?: string;
  explain?: string;
  leaf?: string;
  chars?: number;
}

export type RowsAnswer = { status: 200; body: string } | { status: 404 | 409; error: string; code: "missing" | "moved" };

/** Whether the query asks for rows (TranscriptRows) rather than the whole branch. */
export const asksForRows = (q: RowsQuery): boolean => !!(q.tail || q.before || q.from || q.explain);

const MIN_CHARS = 16 * 1024;
const MAX_CHARS = 8 * 1024 * 1024;

/**
 * The TranscriptRows answer for `path` (a session file that exists). `context` resolves the fill
 * for a `tail` answer, as the whole-branch response does.
 */
export async function transcriptRows(
  path: string,
  q: RowsQuery,
  context: (branch: Entry[]) => Promise<ContextInfo | null>,
): Promise<RowsAnswer> {
  const rows = await rowsOf(path);
  const moved = (why: string): RowsAnswer => ({ status: 409, error: `The branch moved: ${why}.`, code: "moved" });
  if (q.leaf && rows.fileIds.has(q.leaf) && !rows.branchIds.has(q.leaf)) return moved("the list's last entry is no longer on it");
  const n = rows.items.length;
  let end = n;
  if (q.before) {
    end = indexOfRow(rows, q.before);
    if (end < 0) return moved("the list's first row isn't on it");
  }
  let from: number;
  if (q.tail) {
    from = tailStart(rows.items, rows.sizes, TAIL_MIN_ROWS, TAIL_CHARS);
    end = n;
  } else if (q.from || q.explain) {
    const t = q.explain ? rows.items.findIndex((it) => it.report?.explain?.id === q.explain) : targetIndex(rows, q.from!);
    if (t < 0) return { status: 404, error: "That entry isn't on this branch.", code: "missing" };
    // Already held by the client (at or after its first row): nothing more to send.
    from = t >= end ? end : rangeStart(rows.items, t);
  } else {
    const chars = Math.min(MAX_CHARS, Math.max(MIN_CHARS, q.chars ?? HISTORY_CHUNK_CHARS));
    from = chunkStart(rows.items, rows.sizes, end, chars);
  }
  const ctx = q.tail ? `,"context":${JSON.stringify(await context(rows.branch))}` : "";
  const summary = JSON.stringify(summarize(rows.items.slice(0, from)));
  return { status: 200, body: `{"items":[${rows.json.slice(from, end).join(",")}],"older":${from},"olderSummary":${summary}${ctx}}` };
}

/** Forget every parsed file (tests). */
export const clearRowsCache = (): void => cache.clear();
