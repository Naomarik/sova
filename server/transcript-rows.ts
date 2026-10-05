// Older transcript rows on demand: `GET /api/transcript` with `tail`, `before` or `from`
// (TranscriptRows in shared/protocol.ts). A view that asked its socket for the newest rows alone
// (`?tail=rest`) fetches the rest here when it wants them: the chunk above what it holds as the
// reader scrolls up, the range down to a jump's target in one request, all of it in the background
// for a browser on this machine. Read from the file with our own parser, never a runtime, never a
// write; normalized over the whole active branch as the hello and the snapshot are, and cut with
// their rules (server/tail-hello.ts), so what the socket sent and what comes from here concatenate.
// On wire 2 (`wire=2`) the same rows go out mapped (server/wire-rows.ts), cut where wire 1 cuts them.

import { readFile, stat } from "node:fs/promises";
import type { HEntry } from "../shared/harness";
import type { ContextInfo, TranscriptItem, WireVersion } from "../shared/protocol";
import { entryOfRow, summarize } from "../shared/row-counts";
import { branchOf, parsePi } from "./harness/pi/reader";
import { chunkStart, HISTORY_CHUNK_CHARS, rangeStart, TAIL_CHARS, TAIL_MIN_ROWS, tailStart } from "./tail-hello";
import { rowsOf as historyRows } from "./transcript";
import { rowFor } from "./wire-rows";

/** One file's branch, normalized, with each row's JSON made once. */
export interface Rows {
  /** Size and mtime the file had when it was read: a different one reads it again. */
  stamp: string;
  branch: HEntry[];
  items: TranscriptItem[];
  /** Each row's JSON on wire 1, whose lengths (`sizes`) every cut is made by. */
  json: string[];
  sizes: number[];
  /** Each row's JSON on wire 2, made on its first ask. */
  json2?: string[];
  /** Every entry id in the file (the header's included), and those on the active branch. */
  fileIds: Set<string>;
  branchIds: Set<string>;
  /** Row id → index, made on first use. */
  at?: Map<string, number>;
  /** What keeping it costs, roughly: the file's bytes (its parsed branch) plus its rows' JSON. */
  weight: number;
}

/** Files kept parsed: a view scrolling up, prefetching, or opening tool cards asks for one file many
    times running. At most KEEP files and CACHE_BYTES of weight; the newest is kept whatever its size. */
const KEEP = 3;
const CACHE_BYTES = 24 * 1024 * 1024;
const cache = new Map<string, Rows>();

function trim(): void {
  let total = 0;
  for (const r of cache.values()) total += r.weight;
  while (cache.size > 1 && (cache.size > KEEP || total > CACHE_BYTES)) {
    const oldest = cache.keys().next().value!;
    total -= cache.get(oldest)!.weight;
    cache.delete(oldest);
  }
}

export async function rowsOf(path: string): Promise<Rows> {
  const st = await stat(path);
  const stamp = `${st.size}:${st.mtimeMs}`;
  const had = cache.get(path);
  if (had && had.stamp === stamp) {
    cache.delete(path);
    cache.set(path, had);
    return had;
  }
  const { header, entries } = parsePi(await readFile(path, "utf8"));
  const branch = branchOf(entries);
  const items = historyRows(branch);
  const json = items.map((it) => JSON.stringify(it));
  const ids = (list: readonly unknown[]) => new Set(list.filter((id): id is string => typeof id === "string"));
  const sizes = json.map((s) => s.length);
  const weight = st.size + sizes.reduce((n, x) => n + x, 0);
  const fileIds = ids([header?.id, ...entries.map((h) => h.id)]);
  const rows: Rows = { stamp, branch, items, json, sizes, fileIds, branchIds: ids(branch.map((h) => h.id)), weight };
  cache.delete(path);
  cache.set(path, rows);
  trim();
  return rows;
}

/** The rows' JSON on `wire`. */
function jsonOn(rows: Rows, wire: WireVersion): string[] {
  if (wire === 1) return rows.json;
  if (!rows.json2) {
    rows.json2 = rows.items.map((it) => JSON.stringify(rowFor(it, 2)));
    rows.weight += rows.json2.reduce((n, x) => n + x.length, 0);
    trim();
  }
  return rows.json2;
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
 * for an answer that reaches the end of the branch (`tail`, `from` alone), as the whole-branch
 * response does.
 */
export async function transcriptRows(
  path: string,
  q: RowsQuery,
  context: (branch: readonly HEntry[]) => Promise<ContextInfo | null>,
  wire: WireVersion = 1,
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
  // The fill, as the whole-branch response carries it, for the answers that reach the end.
  const ctx = q.tail || !q.before ? `,"context":${JSON.stringify(await context(rows.branch))}` : "";
  const summary = JSON.stringify(summarize(rows.items.slice(0, from)));
  return { status: 200, body: `{"items":[${jsonOn(rows, wire).slice(from, end).join(",")}],"older":${from},"olderSummary":${summary}${ctx}}` };
}

// ---- The light view: `view=light` ----------------------------------------------------------------

/** Rows whose text a pane reads: an input's preview and title, a change row's "Model: x", a tool
    call's name. Every other row's text is only drawn by the thread. */
const LIGHT_TEXT = new Set<TranscriptItem["kind"]>(["user", "wake", "info", "tool-call"]);
/** A tool call's line is kept this long. */
const LIGHT_ARG_CHARS = 200;
/** A compaction's summary is kept this long. */
const LIGHT_SUMMARY_CHARS = 400;

/**
 * A row as the session pane reads it (the Session tab's changes and fill, the Timeline's inputs,
 * turns, markers and chapters), without what only the thread draws: a reply's text, a tool's
 * content, image bytes (each image stays, as ""), a report's body and preview, an unknown row's
 * entry, a compaction's details. Every row stays, in order, so a turn's reply and tool counts and
 * its time are the same as on the whole branch. Made on wire 1: a wire-2 light row is this one's
 * mapping, so its compaction facts lose the details and the long summary too.
 */
export function lightRow(it: TranscriptItem): TranscriptItem {
  const out: TranscriptItem = { ...it };
  if (!LIGHT_TEXT.has(it.kind)) delete out.text;
  if (it.images) out.images = it.images.map(() => "");
  if (it.report) out.report = { ...it.report, body: "", preview: "" };
  if (it.meta && (it.meta.details !== undefined || (it.meta.summary?.length ?? 0) > LIGHT_SUMMARY_CHARS)) {
    const { details: _details, ...meta } = it.meta;
    if (meta.summary !== undefined) meta.summary = meta.summary.slice(0, LIGHT_SUMMARY_CHARS);
    out.meta = meta;
  }
  if (it.tool) {
    const { args: _args, output: _output, details: _details, ...tool } = it.tool;
    if (tool.summary !== undefined) tool.summary = tool.summary.slice(0, LIGHT_ARG_CHARS);
    out.tool = tool;
  }
  delete out.entry;
  return out;
}

/** The whole branch, each row light (`view=light`), on `wire`, with the fill: `{ items, context }`. */
export async function transcriptLight(path: string, context: (branch: readonly HEntry[]) => Promise<ContextInfo | null>, wire: WireVersion = 1): Promise<string> {
  const rows = await rowsOf(path);
  return JSON.stringify({ items: rows.items.map((it) => rowFor(lightRow(it), wire)), context: await context(rows.branch) });
}

/** Forget every parsed file (tests). */
export const clearRowsCache = (): void => cache.clear();
