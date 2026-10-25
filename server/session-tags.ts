import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionTags } from "../shared/protocol";
import type { HEntry } from "../shared/harness";
import { isLinkMessage } from "../shared/link-message";
import { isTopicBatch } from "../shared/topic-message";
import type { Answer } from "./decide";
import { joinedText, lineEntry } from "./harness/pi/reader";
import { stateRoot } from "./state-root";
import { sessionsChanged } from "./list-generation";

/**
 * Session tags: the user's own manual tags per session (§app.decisions/session-tags). Automatic
 * tags (a topic and a "throwaway" guess) are retired: nothing here asks a decision provider any
 * more. A topic or throwaway answer stored before stays readable in the store and is never sent.
 * Stored in `<stateRoot>/session-tags.json`, keyed by session id like titles/archive/groups: a
 * sidecar only, never a byte into a JSONL.
 */

/** Manual tags: the ideas store's rule (server/overseer-ideas.ts cleanTags). */
export const USER_TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const USER_TAGS_MAX = 8;

const CHUNK = 16 * 1024;
const MAX_TAIL = 256 * 1024;
const NL = 0x0a;

// --- the store -------------------------------------------------------------------------------

/** One session's stored tags. `basis` + `answers` are the model's; `user` is the user's. */
export interface TagRecord {
  /** ms epoch the session was classified. */
  at?: number;
  /** What was classified: the last assistant entry's id and the file size then. */
  basis?: { turnId: string; size: number };
  /** Raw answers, as the seam returned them. */
  answers?: { topic?: Answer; status?: Answer; throwaway?: Answer };
  provider?: string;
  model?: string;
  user?: string[];
}

interface Store {
  /** ms epoch the live pass began tagging new activity (set when the feature is first seen on). */
  liveSince?: number;
  sessions: Record<string, TagRecord>;
}

const tagsFile = () => join(stateRoot(), "session-tags.json");

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** One stored answer back, or undefined when it isn't one (a hand-edited file loses only that field). */
function cleanAnswer(v: unknown): Answer | undefined {
  if (!isObj(v)) return undefined;
  if (v.type === "boolean" && fin(v.p)) return { type: "boolean", p: v.p };
  if (v.type === "choice" && typeof v.choice === "string" && fin(v.confidence) && isObj(v.probabilities)) {
    const probabilities: Record<string, number> = {};
    for (const [k, p] of Object.entries(v.probabilities)) if (fin(p)) probabilities[k] = p;
    return { type: "choice", choice: v.choice, probabilities, confidence: v.confidence };
  }
  if (v.type === "score" && fin(v.score) && fin(v.confidence) && Array.isArray(v.probabilities)) {
    return { type: "score", score: v.score, probabilities: v.probabilities.filter(fin), confidence: v.confidence };
  }
  return undefined;
}

function cleanRecord(v: unknown): TagRecord | null {
  if (!isObj(v)) return null;
  const out: TagRecord = {};
  if (fin(v.at)) out.at = v.at;
  if (isObj(v.basis) && typeof v.basis.turnId === "string" && fin(v.basis.size)) out.basis = { turnId: v.basis.turnId, size: v.basis.size };
  if (isObj(v.answers)) {
    const a: NonNullable<TagRecord["answers"]> = {};
    for (const k of ["topic", "status", "throwaway"] as const) {
      const ans = cleanAnswer(v.answers[k]);
      if (ans) a[k] = ans;
    }
    out.answers = a;
  }
  if (typeof v.provider === "string") out.provider = v.provider;
  if (typeof v.model === "string") out.model = v.model;
  if (Array.isArray(v.user)) {
    const user = v.user.filter((t): t is string => typeof t === "string" && USER_TAG_RE.test(t)).slice(0, USER_TAGS_MAX);
    if (user.length) out.user = user;
  }
  return out.at !== undefined || out.user ? out : null;
}

function load(file: string): Store {
  // No prototype: an id is a plain key, and "__proto__" must stay one.
  const sessions: Record<string, TagRecord> = Object.create(null);
  const store: Store = { sessions };
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isObj(v)) return store;
    if (fin(v.liveSince)) store.liveSince = v.liveSince;
    if (!isObj(v.sessions)) return store;
    for (const [id, r] of Object.entries(v.sessions)) {
      const rec = cleanRecord(r);
      if (rec) sessions[id] = rec;
    }
  } catch {
    // missing or corrupt: start empty
  }
  return store;
}

let cache: { file: string; at: number; store: Store } | null = null;
const CACHE_MS = 1000;

function readStore(file = tagsFile()): Store {
  const now = Date.now();
  if (cache && cache.file === file && now - cache.at < CACHE_MS) return cache.store;
  const store = load(file);
  cache = { file, at: now, store };
  return store;
}

/** Re-read, change, write atomically (tmp + rename): another server's ids survive. */
function update(fn: (s: Store) => boolean, file = tagsFile()): Store {
  const next = load(file);
  if (fn(next)) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, ...(next.liveSince !== undefined ? { liveSince: next.liveSince } : {}), sessions: next.sessions }));
    renameSync(tmp, file);
    sessionsChanged();
  }
  cache = { file, at: Date.now(), store: next };
  return next;
}

/** The stored record of one session (raw answers included), for tests and the backfill. */
export function tagRecord(id: string): TagRecord | undefined {
  return readStore().sessions[id];
}

// --- the wire --------------------------------------------------------------------------------

/** A stored record as the wire carries it: the manual tags only (a stored topic or throwaway
    answer, from when tags were automatic, is never sent); undefined when there are none. */
export function wireTags(rec: TagRecord | undefined): SessionTags | undefined {
  if (!rec?.user?.length) return undefined;
  return { user: [...rec.user] };
}

/** The overlay listSessions/getSessionSummary lay over a row (1 s read cache, like seen.ts). */
export function tagsFor(id: string): SessionTags | undefined {
  return wireTags(readStore().sessions[id]);
}

/** Every session with tags on the wire — the `marks` snapshot a new feed socket gets. */
export function allTags(): Map<string, SessionTags> {
  const out = new Map<string, SessionTags>();
  for (const [id, rec] of Object.entries(readStore().sessions)) {
    const t = wireTags(rec);
    if (t) out.set(id, t);
  }
  return out;
}

// --- change events ---------------------------------------------------------------------------

export interface TagsChange {
  id: string;
  /** The session file, when the writer knew it (a manual tag by id may not). */
  path?: string;
  /** What the wire shows now; undefined = no tags (clear the overlay). */
  tags: SessionTags | undefined;
}

const listeners = new Set<(changes: TagsChange[]) => void>();

/** Subscribe to tag writes (the server push forwards them). Returns the unsubscribe. */
export function onTagsChanged(fn: (changes: TagsChange[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(changes: TagsChange[]): void {
  if (!changes.length) return;
  for (const fn of listeners) {
    try {
      fn(changes);
    } catch (err) {
      console.warn("[session-tags] listener failed:", err instanceof Error ? err.message : String(err));
    }
  }
}

const sameTags = (a: SessionTags | undefined, b: SessionTags | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// --- manual tags -----------------------------------------------------------------------------

/** "a, #B c" or ["a","B"] → the stored list (trimmed, lowercase, no leading #, deduped), or an
    error sentence (the route's 400). Same rule as the ideas store. */
export function cleanUserTags(v: unknown): string[] | string {
  if (!Array.isArray(v)) return "user must be a list of tags, or null to clear them.";
  const tags = [...new Set(v.map((t) => (typeof t === "string" ? t.trim().toLowerCase().replace(/^#/, "") : "")))].filter(Boolean);
  for (const t of tags) if (!USER_TAG_RE.test(t)) return `Tag "${t}" is not valid: lowercase letters, digits and dashes, at most 32.`;
  if (tags.length > USER_TAGS_MAX) return `At most ${USER_TAGS_MAX} tags.`;
  return tags;
}

/** Set (or with null / [] clear) one session's manual tags; returns what the wire shows now. */
export function setUserTags(id: string, user: string[] | null, path?: string): SessionTags | undefined {
  let before: SessionTags | undefined;
  const store = update((s) => {
    const cur = s.sessions[id];
    before = wireTags(cur);
    const next: TagRecord = { ...(cur ?? {}) };
    if (user && user.length) next.user = [...user];
    else delete next.user;
    if (JSON.stringify(next.user ?? null) === JSON.stringify(cur?.user ?? null)) return false;
    if (next.at === undefined && !next.user) delete s.sessions[id];
    else s.sessions[id] = next;
    return true;
  });
  const after = wireTags(store.sessions[id]);
  if (!sameTags(before, after)) emit([{ id, ...(path ? { path } : {}), tags: after }]);
  return after;
}

/** Drop the records of deleted sessions (cleanup's ids), like dropSessionTitles. */
export function dropSessionTags(ids: string[]): void {
  const gone: TagsChange[] = [];
  update((s) => {
    for (const id of ids) {
      if (!(id in s.sessions)) continue;
      delete s.sessions[id];
      gone.push({ id, tags: undefined });
    }
    return gone.length > 0;
  });
  emit(gone);
}

// --- input (head/tail only) ------------------------------------------------------------------

/** An entry's text blocks, joined by newlines (images left out, notes kept). */
const textOf = (h: HEntry): string => joinedText(h, { images: false });

/**
 * The file's last finished assistant reply (its entry id and text) and the last user message
 * before it, scanned backwards from EOF (16 KB chunks, cap 256 KB, torn lines skipped) — the list's
 * own tail window, never a full-file read. null when the window holds no finished reply. `user` is
 * null when that message is a partner's over a link.
 */
export async function readTailTurn(path: string, size: number): Promise<{ turnId: string; assistant: string; user: string | null } | null> {
  const fh = await open(path, "r");
  try {
    const floor = Math.max(0, size - MAX_TAIL);
    let end = size;
    let carry = Buffer.alloc(0);
    let found: { turnId: string; assistant: string } | null = null;
    const done = (user: string | null) => (found ? { ...found, user } : null);
    while (end > floor) {
      const start = Math.max(floor, end - CHUNK);
      const chunk = Buffer.alloc(end - start);
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, start);
      if (bytesRead < chunk.length) return done(null);
      end = start;
      const buf = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      let stop = buf.length;
      for (;;) {
        const i = stop > 0 ? buf.lastIndexOf(NL, stop - 1) : -1;
        if (i < 0 && start > floor) break;
        const line = buf.subarray(i + 1, stop);
        if (line.includes(found ? '"user"' : '"assistant"')) {
          const h = lineEntry(line); // null: a torn line or not JSON, skipped
          if (!found && h?.kind === "assistant" && h.stop !== "toolUse" && h.id !== null) {
            found = { turnId: h.id, assistant: textOf(h) };
          } else if (found && h?.kind === "user") {
            // A partner's message over a link, or a topic batch, is never topic evidence (§mesh.links/transcript, §chat.topics/row).
            const user = textOf(h);
            return done(isLinkMessage(user) || isTopicBatch(user) ? null : user);
          }
        }
        if (i < 0) return done(null);
        stop = i;
      }
      carry = buf.subarray(0, stop);
    }
    return done(null);
  } finally {
    await fh.close();
  }
}
