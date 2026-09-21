// @-mention completion for the composer (spec/04h-file-mentions.md): find the "@token" at the
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

/**
 * The entries the token's current directory offers, filtered by its current segment. The current
 * directory is the query up to its last "/" ("" is the cwd itself); the segment after it filters.
 * Directories appear when anything non-ignored lives under them; matching is a case-insensitive
 * prefix on the name; hidden entries (".env") only match once the segment starts with ".".
 */
export function mentionEntries(files: readonly string[], query: string): MentionEntry[] {
  const { dir: dirPrefix, segment } = mentionQueryParts(query);
  const lower = segment.toLowerCase();
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
    if (name.startsWith(".") && !segment.startsWith(".")) continue;
    if (!name.toLowerCase().startsWith(lower)) continue;
    seen.add(name);
    out.push({ name, path: f.slice(0, dirPrefix.length) + name, dir: slash !== -1 }); // the path in the index's own casing
  }
  out.sort(
    (a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || (a.name < b.name ? -1 : 1),
  );
  return out;
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

const cache = new Map<string, { index: FileIndex; at: number }>();

/** The session cwd's fresh index, or null when none was fetched (or it has gone stale). */
export function cachedFileIndex(cwd: string): FileIndex | null {
  const hit = cache.get(cwd);
  return hit && Date.now() - hit.at < INDEX_TTL_MS ? hit.index : null;
}

/**
 * Fetches the cwd's index when there is no fresh one. Concurrent callers share one request;
 * failures don't cache (a menu that couldn't read the folder retries on its next open).
 */
export async function ensureFileIndex(cwd: string): Promise<FileIndex> {
  if (cachedFileIndex(cwd)) return cachedFileIndex(cwd)!;
  const inflight = inflightIndexes.get(cwd);
  if (inflight) return inflight;
  const p = fetchFileIndex(cwd).then((index) => {
    cache.set(cwd, { index, at: Date.now() });
    return index;
  });
  inflightIndexes.set(cwd, p);
  try {
    return await p;
  } finally {
    inflightIndexes.delete(cwd);
  }
}

const inflightIndexes = new Map<string, Promise<FileIndex>>();
