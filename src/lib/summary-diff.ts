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
  project: "compare",
  profile: "compare",
  activity: "compare",
  pendingDialogs: "compare",
  seenAt: { exempt: "Nothing renders it (`unread`, which does, is compared); it moves at every open and close of any tab, and a new row object would re-mount the row for nothing." },
  unread: "compare",
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
