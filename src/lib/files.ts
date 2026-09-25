// @-mention completion for the composer: find the "@token" at the
// caret — quote-aware, because a completed path with spaces is inserted as @"My Docs/… — derive
// the one-level entries the token's current directory offers from a cached FileIndex, and splice
// a picked entry back into the text. The index itself is fetched once per session cwd and reused
// while it stays fresh; every keystroke after that is local.

import type { FileIndex } from "../../shared/protocol";
import { fetchFileIndex } from "./api";

export interface MentionToken {
  /** Index of the "@" in the text. */
  start: number;
  /** End of the token (the next whitespace outside quotes, or the end of the text). */
  end: number;
  /** What follows the "@", up to the caret — a relative path prefix; may start with a quote. */
  query: string;
}

/**
 * The @ token the caret sits in: an "@" at the start of the text or right after whitespace, with
 * no whitespace between it and the caret that isn't inside an open double quote (a completed
 * path with spaces is inserted quoted, and the quote keeps the token one token). Emails
 * ("user@host") never qualify: their "@" follows a word character.
 */
export function mentionTokenAt(text: string, caret: number): MentionToken | null {
  // Walk the "@"s before the caret, nearest first, and scan each candidate token forward from its
  // "@": a backscan can't know it is inside a quote until it has already passed the space the
  // quote protects, so quote parity is only meaningful read left to right.
  for (let start = text.lastIndexOf("@", caret - 1); start !== -1 && start < caret; start = start === 0 ? -1 : text.lastIndexOf("@", start - 1)) {
    const before = start === 0 ? "" : text[start - 1]!;
    if (before !== "" && !/\s/.test(before)) continue; // mid-word, like an email's "@"
    let quote = false;
    let end = start + 1;
    while (end < text.length) {
      const ch = text[end]!;
      if (ch === '"') quote = !quote;
      else if (!quote && /\s/.test(ch)) break;
      end++;
    }
    if (caret > end) continue; // the caret left this token; an earlier open quote may still span it
    return { start, end, query: text.slice(start + 1, caret) };
  }
  return null;
}

/** One completable entry: a name in the token's current directory. */
export interface MentionEntry {
  /** The entry's own name ("api.ts", "lib"). */
  name: string;
  /** The path from the session cwd up to and including this name. */
  path: string;
  /** A directory: completing it appends "/" and keeps the menu drilling into it. */
  dir: boolean;
}

/** The query split at its last "/": the directory being listed (relative to the session cwd, ""
    for the cwd itself) and the segment filtering it. A leading quote (a path with spaces) is not
    part of either. */
export function mentionQueryParts(query: string): { dir: string; segment: string } {
  const unquoted = query.startsWith('"') ? query.slice(1) : query;
  const cut = unquoted.lastIndexOf("/");
  return cut === -1 ? { dir: "", segment: unquoted } : { dir: unquoted.slice(0, cut + 1), segment: unquoted.slice(cut + 1) };
}

/** Name order within a level: case-insensitive, then a fixed tiebreak so "a" and "A" never swap.
    The same ordering as `localeCompare(b, undefined, { sensitivity: "base" })`, built once — a
    per-call options object made the sort most of the cost of a keystroke on a large level. */
const byName = new Intl.Collator(undefined, { sensitivity: "base" }).compare;

/** Every name one directory offers, sorted, per index. Built once per (index, directory) and
    reused, so each keystroke only filters it — and the SAME entry object comes back for the same
    name on every call, which is what lets the menu's <For> keep its rows across keystrokes
    instead of rebuilding the list. Keyed by the index's files array: a refetched index is a new
    array and gets fresh entries; the old one is collected with it. */
const levels = new WeakMap<readonly string[], Map<string, MentionEntry[]>>();

function levelEntries(files: readonly string[], dirPrefix: string): MentionEntry[] {
  let byDir = levels.get(files);
  if (!byDir) levels.set(files, (byDir = new Map()));
  const hit = byDir.get(dirPrefix);
  if (hit) return hit;
  const dirLower = dirPrefix.toLowerCase(); // the directory matches case-insensitively too ("SRC/c")
  const seen = new Set<string>();
  const out: MentionEntry[] = [];
  for (const f of files) {
    if (!f.toLowerCase().startsWith(dirLower)) continue;
    const rest = f.slice(dirPrefix.length);
    if (rest === "") continue;
    const slash = rest.indexOf("/");
    const name = slash === -1 ? rest : rest.slice(0, slash);
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, path: f.slice(0, dirPrefix.length) + name, dir: slash !== -1 }); // the path in the index's own casing
  }
  out.sort((a, b) => Number(b.dir) - Number(a.dir) || byName(a.name, b.name) || (a.name < b.name ? -1 : 1));
  byDir.set(dirPrefix, out);
  return out;
}

/**
 * The entries the token's current directory offers, filtered by its current segment. The current
 * directory is the query up to its last "/" ("" is the cwd itself); the segment after it filters.
 * Directories appear when anything non-ignored lives under them; matching is a case-insensitive
 * prefix on the name; hidden entries (".env") only match once the segment starts with ".".
 * Every match, uncapped — the true count; `capMentionEntries` decides how many are drawn.
 */
export function mentionEntries(files: readonly string[], query: string): MentionEntry[] {
  const { dir: dirPrefix, segment } = mentionQueryParts(query);
  const lower = segment.toLowerCase();
  const hidden = segment.startsWith(".");
  return levelEntries(files, dirPrefix).filter((e) => (hidden || !e.name.startsWith(".")) && e.name.toLowerCase().startsWith(lower));
}

/** How many rows the @ menu draws. Measured on a 5660-name level: drawing every row blocked a
    frame for ~400ms (~0.07ms a row), so 100 rows is a few ms. It is also past where scrolling
    beats typing — the menu shows four or five rows at a time, and one more letter narrows
    faster than twenty screens of scrolling. */
export const MENTION_ROW_CAP = 100;

/** The matches the menu draws, and how many it leaves out. Under the cap it is the same array. */
export function capMentionEntries(entries: MentionEntry[], cap = MENTION_ROW_CAP): { shown: MentionEntry[]; more: number } {
  return entries.length <= cap ? { shown: entries, more: 0 } : { shown: entries.slice(0, cap), more: entries.length - cap };
}

/** Replaces the token with the completed entry. A directory keeps the token (and so the menu)
 *  open: "@" + path + "/", the quote opened when the path needs it. A file closes it: the token
 *  becomes the bare path — ordinary prompt text, quoted when it needs it — followed by a space
 *  unless one already follows. The caret lands right after what was inserted. */
export function insertMention(text: string, token: MentionToken, entry: MentionEntry): { text: string; caret: number } {
  const dirPrefix = mentionQueryParts(token.query).dir;
  const path = dirPrefix + entry.name;
  const quote = /\s/.test(path);
  const before = text.slice(0, token.start);
  const after = text.slice(token.end);
  const inserted = entry.dir
    ? `@${quote ? '"' : ""}${path}/`
    : `${quote ? '"' : ""}${path}${quote ? '"' : ""}${/^\s/.test(after) ? "" : " "}`;
  return { text: before + inserted + after, caret: before.length + inserted.length };
}

// ---------------------------------------------------------------------------
// the index

/** How long a fetched index stays fresh; the server keeps its own copy for the same span. */
export const INDEX_TTL_MS = 30_000;

/** An index fetch that failed, and the cwd it failed for. The cwd is the point: a composer whose
    session moved to another folder must not keep showing the old folder's error, and must not
    count the old folder's attempt as this folder's one try. */
export interface MentionIndexError {
  cwd: string;
  message: string;
}

/** What the @ menu shows besides entries: still reading the folder, or why it can't. */
export type MentionIndexStatus = { state: "loading" } | { state: "error"; error: string } | { state: "ready" };

/** Said when the session has no cwd yet, so there is no folder to read. */
export const NO_CWD_MESSAGE = "No working directory yet — the @ menu needs the session's folder.";

/** The menu's status for one cwd: an error belonging to another cwd is not this folder's news. */
export function mentionIndexStatus(args: { cwd: string | null | undefined; cached: boolean; error: MentionIndexError | null }): MentionIndexStatus {
  if (!args.cwd) return { state: "error", error: NO_CWD_MESSAGE };
  if (args.error && args.error.cwd === args.cwd) return { state: "error", error: args.error.message };
  return args.cached ? { state: "ready" } : { state: "loading" };
}

/** Whether the open menu should fetch: one attempt per cwd per opening. A cwd switch re-arms it,
    so a menu left open across the switch refetches instead of showing the folder it left. */
export function shouldFetchIndex(args: { cwd: string | null | undefined; cached: boolean; fetchedFor: string | null }): boolean {
  return !!args.cwd && !args.cached && args.fetchedFor !== args.cwd;
}

const cache = new Map<string, { index: FileIndex; at: number }>();
/** A cwd names a folder on one host: a peer's session (`host`) keeps its index apart from ours. */
const indexKey = (cwd: string, host?: string | null) => (host ? `${host}\n${cwd}` : cwd);

/** The session cwd's fresh index, or null when none was fetched (or it has gone stale). Decides
    whether to FETCH; what the menu shows is `heldFileIndex`. */
export function cachedFileIndex(cwd: string, now = Date.now(), host?: string | null): FileIndex | null {
  const hit = cache.get(indexKey(cwd, host));
  return hit && now - hit.at < INDEX_TTL_MS ? hit.index : null;
}

/** The newest index fetched for the cwd, however old — what the open menu lists. Aging out is a
    reason to refetch at the next opening, never to empty a menu the user is typing in: the fetch
    is one attempt per opening, so an index that went stale mid-token used to leave the menu on
    "Reading the folder…" until it was closed and reopened. */
export function heldFileIndex(cwd: string, host?: string | null): FileIndex | null {
  return cache.get(indexKey(cwd, host))?.index ?? null;
}

/**
 * Fetches the cwd's index when there is no fresh one. Concurrent callers share one request;
 * failures don't cache (a menu that couldn't read the folder retries on its next open).
 */
export async function ensureFileIndex(cwd: string, host?: string | null): Promise<FileIndex> {
  const key = indexKey(cwd, host);
  const fresh = cachedFileIndex(cwd, Date.now(), host);
  if (fresh) return fresh;
  const inflight = inflightIndexes.get(key);
  if (inflight) return inflight;
  const p = fetchFileIndex(cwd, host).then((index) => {
    cache.set(key, { index, at: Date.now() });
    return index;
  });
  inflightIndexes.set(key, p);
  try {
    return await p;
  } finally {
    inflightIndexes.delete(key);
  }
}

const inflightIndexes = new Map<string, Promise<FileIndex>>();
