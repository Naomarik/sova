import type { SessionSummary } from "../../shared/protocol";

// The extension route: `#/ext/<id>` shows the installed extension `<id>` in the main pane, its UI
// iframed from `/ext/<id>/` (served and proxied by server/extensions.ts). The id is the manifest's,
// [A-Za-z0-9._-]+, so it never needs encoding; anything else in the hash is not this route.

const ID_RE = /^[A-Za-z0-9._-]+$/;

/** `#/ext/<id>` (a trailing slash tolerated) → the id, else null. */
export function extRouteFromHash(hash: string): string | null {
  const m = /^#\/ext\/([^/]+)\/?$/.exec(hash);
  if (!m) return null;
  const id = m[1]!;
  return ID_RE.test(id) && id !== "." && id !== ".." ? id : null;
}

/** The app link to an extension. */
export const extHref = (id: string): string => `#/ext/${id}`;

/** Where the extension's UI is served; the trailing slash keeps its relative asset URLs inside it. */
export const extFrameSrc = (id: string): string => `/ext/${id}/`;

/** What an extension posts to hand Sova a session to open (ext-contract §3.6). */
export const OPEN_SESSION = "sova:open-session";

const isString = (v: unknown): v is string => typeof v === "string";
const OPTIONAL_STRINGS = ["originalTitle", "outlineNow", "outlineGist", "groupId", "parent", "parentId", "target", "remoteCwd", "draftPreview"] as const;

/**
 * Why `s` is not a whole SessionSummary, or null when it is. Every required field is checked by
 * type, because the list, the sidebar's sort and the view read them straight away (a missing
 * `lastActiveAt` is a `localeCompare` of undefined), and an optional string that is present must
 * be a string.
 */
export function sessionSummaryProblem(s: unknown): string | null {
  if (!s || typeof s !== "object" || Array.isArray(s)) return "session is not an object";
  const r = s as Record<string, unknown>;
  if (!isString(r.path) || !r.path.startsWith("/") || !r.path.endsWith(".jsonl")) return "path must be an absolute .jsonl path";
  if (!isString(r.cwd) || !r.cwd) return "cwd must be a non-empty string";
  for (const k of ["id", "title", "createdAt", "lastActiveAt"] as const) if (!isString(r[k])) return `${k} must be a string`;
  if (r.model !== null && !isString(r.model)) return "model must be a string or null";
  if (r.live !== null) {
    const live = r.live as Record<string, unknown> | undefined;
    if (!live || typeof live !== "object" || typeof live.pid !== "number" || !isString(live.status)) return "live must be null or {pid, status}";
  }
  for (const k of ["busy", "archived"] as const) if (typeof r[k] !== "boolean") return `${k} must be a boolean`;
  if (r.origin !== "web" && r.origin !== "external") return 'origin must be "web" or "external"';
  for (const k of OPTIONAL_STRINGS) if (k in r && r[k] !== undefined && !isString(r[k])) return `${k} must be a string when present`;
  return null;
}

/**
 * A `message` event → what to do with it. null: not an open-session request from the extension's
 * own iframe (another window, another origin, another message), ignored without a word. Otherwise
 * `{session}` to open, or `{error}` when the extension asked with an incomplete session (worth a
 * warning: that is a bug in the extension). A session must be a whole SessionSummary, as
 * `POST /api/sessions` returns it.
 */
export function parseOpenSession(
  event: { origin: string; source: unknown; data: unknown },
  expected: { origin: string; frame: unknown },
): { session: SessionSummary } | { error: string } | null {
  if (event.origin !== expected.origin || !expected.frame || event.source !== expected.frame) return null;
  const data = event.data as { type?: unknown; session?: unknown } | null;
  if (!data || typeof data !== "object" || data.type !== OPEN_SESSION) return null;
  const problem = sessionSummaryProblem(data.session);
  return problem ? { error: problem } : { session: data.session as SessionSummary };
}
