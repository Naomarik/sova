import type { SessionSummary } from "../../shared/protocol";

/**
 * Whether the session list may keep a row's old summary object. `reuseUnchanged` (App.tsx) keeps
 * the previous object for an unchanged row so <For> updates the list in place and focus survives;
 * a field left out of the comparison is a field whose change never reaches the screen until a
 * reload (the unread dot that never cleared). So every field is listed here, and the type makes
 * a field added to SessionSummary later a compile error until it is: compared (deeply), or
 * exempt with the reason it can't matter.
 */
const FIELDS: { [K in keyof Required<SessionSummary>]: "compare" | { exempt: string } } = {
  id: "compare",
  path: "compare",
  cwd: "compare",
  title: "compare",
  originalTitle: "compare",
  titleBy: "compare",
  createdAt: "compare",
  lastActiveAt: "compare",
  model: "compare",
  outlineNow: "compare",
  outlineGist: "compare",
  outlineAt: "compare",
  outlineTopics: "compare",
  context: "compare",
  live: "compare",
  workers: "compare",
  workerSession: "compare",
  busy: "compare",
  chat: "compare",
  origin: "compare",
  archived: "compare",
  align: "compare",
  groupId: "compare",
  parent: "compare",
  parentId: "compare",
  target: "compare",
  remoteCwd: "compare",
  draftPreview: "compare",
  hasDraft: "compare",
  overseer: "compare",
  baton: "compare",
  projectOverseer: "compare",
  org: "compare",
  folderOrg: "compare",
  project: "compare",
  profile: "compare",
  queueChat: "compare",
  activity: "compare",
  pendingDialogs: "compare",
  seenAt: { exempt: "Nothing renders it (`unread`, which does, is compared); it moves at every open and close of any tab, and a new row object would re-mount the row for nothing." },
  unread: "compare",
  unreadReplies: "compare",
  turnError: "compare",
  signals: "compare",
  workerSignals: "compare",
  tags: "compare",
  readiness: "compare",
};

export const COMPARED_FIELDS = (Object.keys(FIELDS) as (keyof SessionSummary)[]).filter((k) => FIELDS[k] === "compare");
export const EXEMPT_FIELDS = (Object.keys(FIELDS) as (keyof SessionSummary)[]).filter((k) => FIELDS[k] !== "compare");

/** Plain-JSON deep equality (the summary is JSON off the wire). */
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** True when nothing a row can show differs: every compared field, deeply. */
export const sameSummary = (a: SessionSummary, b: SessionSummary): boolean => COMPARED_FIELDS.every((k) => same(a[k], b[k]));

/** Keeps the previous object for unchanged rows so <For> updates the list in place (focus survives).
    When no row changed and none moved, it hands back `prev` itself, so a memo or signal holding the
    list sees no change at all and nothing downstream re-runs. */
export function reuseUnchanged(next: SessionSummary[], prev: SessionSummary[] | undefined): SessionSummary[] {
  if (!prev) return next;
  const old = new Map(prev.map((s) => [s.path, s]));
  const out = next.map((s) => {
    const o = old.get(s.path);
    return o && sameSummary(o, s) ? o : s;
  });
  return out.length === prev.length && out.every((s, i) => s === prev[i]) ? prev : out;
}

// ---- Row deltas (the session feed's `rows` frames, §app.decisions/push) -----------------------
// Imported by the server too (server/session-feed.ts): stays DOM- and Solid-free.

/** What of a row a delta compares: every compared field, in COMPARED_FIELDS order, as JSON.
    A row and its JSON round trip give the same key, so the server and a tab agree on it. */
export function rowKey(s: SessionSummary): string {
  const o: Record<string, unknown> = {};
  for (const k of COMPARED_FIELDS) if (s[k] !== undefined) o[k] = s[k];
  return JSON.stringify(o);
}

/** 32-bit FNV-1a over UTF-16 code units. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const keys = new WeakMap<SessionSummary, { key: string; hash: number }>();

/** A row's key and its hash (path and key), cached per row object: an unchanged row object is never
    stringified twice. */
export function rowEntry(s: SessionSummary): { key: string; hash: number } {
  let e = keys.get(s);
  if (!e) {
    const key = rowKey(s);
    e = { key, hash: fnv1a(`${s.path}\n${key}`) };
    keys.set(s, e);
  }
  return e;
}

/** The order-free digest of a list (`rows_check`): the 32-bit sum of its rows' hashes, as hex. */
export function rowsDigest(rows: Iterable<SessionSummary>): string {
  let sum = 0;
  for (const s of rows) sum = (sum + rowEntry(s).hash) >>> 0;
  return sum.toString(16);
}

/** The list order of GET /api/sessions (server/sessions-index.ts sorts with it): newest activity
    first, the path breaking a tie, so a tab merging deltas orders rows exactly as a full read does. */
export function byActivity(a: SessionSummary, b: SessionSummary): number {
  return b.lastActiveAt.localeCompare(a.lastActiveAt) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** The list version header of GET /api/sessions: `<epoch>:<version>`. */
export const LIST_VERSION_HEADER = "X-Sova-List-Version";

export function parseListVersion(v: string | null | undefined): { epoch: string; version: number } | null {
  const m = v ? /^([A-Za-z0-9_-]+):(\d+)$/.exec(v) : null;
  return m ? { epoch: m[1]!, version: Number(m[2]) } : null;
}
