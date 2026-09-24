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

/**
 * A `message` event → the session it asks Sova to open, or null when it isn't one we accept:
 * it must come from this origin AND from the extension's own iframe window (`frame`), carry
 * `type: "sova:open-session"`, and a `session` with an absolute `.jsonl` path and a cwd. Anything
 * else (another window, another origin, another message, a malformed session) is ignored.
 */
export function parseOpenSession(
  event: { origin: string; source: unknown; data: unknown },
  expected: { origin: string; frame: unknown },
): SessionSummary | null {
  if (event.origin !== expected.origin || !expected.frame || event.source !== expected.frame) return null;
  const data = event.data as { type?: unknown; session?: unknown } | null;
  if (!data || typeof data !== "object" || data.type !== OPEN_SESSION) return null;
  const s = data.session as Partial<SessionSummary> | null;
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  if (typeof s.path !== "string" || !s.path.startsWith("/") || !s.path.endsWith(".jsonl")) return null;
  if (typeof s.cwd !== "string" || !s.cwd) return null;
  return s as SessionSummary;
}
