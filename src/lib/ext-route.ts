import type { SessionSummary } from "../../shared/protocol";

// The extension route: `#/ext/<id>` shows the installed extension `<id>` in the main pane, its UI
// iframed from `/ext/<id>/` (served and proxied by server/extensions.ts), and `#/ext/<id>/<sub>`
// the same with the extension's own route `#/<sub>` (its iframe's hash). The id is the
// manifest's, [A-Za-z0-9._-]+, so it never needs encoding; anything else in the hash is not this
// route.

const ID_RE = /^[A-Za-z0-9._-]+$/;
/** An extension's own route, after its `#/`: the characters ext-contract §3.7 allows in a hash. */
const SUB_RE = /^[A-Za-z0-9._~:%/-]*$/;
/** A whole extension hash as `sova:route` carries it. */
const EXT_HASH_RE = /^#\/[A-Za-z0-9._~:%/-]*$/;

export interface ExtRoute {
  id: string;
  /** The extension's own route without its `#/` (`row/dataico:dataico-wt1`), or null for its home. */
  sub: string | null;
}

/**
 * `#/ext/<id>` or `#/ext/<id>/<sub>` → the route, else null. A trailing slash is the home. A
 * sub-route with characters an extension hash can't carry is dropped: the extension still opens,
 * at its home.
 */
export function extRouteFromHash(hash: string): ExtRoute | null {
  const m = /^#\/ext\/([^/]+)(?:\/(.*))?$/.exec(hash);
  if (!m) return null;
  const id = m[1]!;
  if (!ID_RE.test(id) || id === "." || id === "..") return null;
  const sub = m[2] ?? "";
  return { id, sub: sub && SUB_RE.test(sub) ? sub : null };
}

/** The app link to an extension, optionally at one of its own routes. */
export const extHref = (id: string, sub?: string | null): string => `#/ext/${id}${sub ? `/${sub}` : ""}`;

/** Where the extension's UI is served; the trailing slash keeps its relative asset URLs inside it.
    A sub-route goes in the fragment, so the extension starts there. */
export const extFrameSrc = (id: string, sub?: string | null): string => `/ext/${id}/${sub ? `#/${sub}` : ""}`;

/** An extension hash (`#/row/x`) → the sub-route it names (`row/x`), null for its home (`#/`). */
export const subFromExtHash = (hash: string): string | null => hash.slice(2) || null;

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

/** Maximize and restore requests, and the extension's own navigation (ext-contract §3.7). */
export const MAXIMIZE = "sova:maximize";
export const RESTORE = "sova:restore";
export const ROUTE = "sova:route";
/** Sova's answer to MAXIMIZE and RESTORE, posted into the iframe once applied. */
export const MAXIMIZED = "sova:maximized";

export type ExtMessage =
  | { kind: "open-session"; session: SessionSummary }
  | { kind: "maximize" }
  | { kind: "restore" }
  | { kind: "route"; hash: string };

/**
 * A `message` event → what the extension asks for. null: not a Sova message from the extension's
 * own iframe (another window, another origin, a type we don't know), ignored without a word.
 * `{error}`: a Sova message the extension got wrong (an incomplete session, a bad hash), worth a
 * warning because it is a bug in the extension. Never throws.
 */
export function parseExtMessage(
  event: { origin: string; source: unknown; data: unknown },
  expected: { origin: string; frame: unknown },
): ExtMessage | { error: string } | null {
  if (event.origin !== expected.origin || !expected.frame || event.source !== expected.frame) return null;
  const data = event.data as { type?: unknown; session?: unknown; hash?: unknown } | null;
  if (!data || typeof data !== "object") return null;
  switch (data.type) {
    case OPEN_SESSION: {
      const problem = sessionSummaryProblem(data.session);
      return problem ? { error: `${OPEN_SESSION}: ${problem}` } : { kind: "open-session", session: data.session as SessionSummary };
    }
    case MAXIMIZE:
      return { kind: "maximize" };
    case RESTORE:
      return { kind: "restore" };
    case ROUTE:
      return typeof data.hash === "string" && EXT_HASH_RE.test(data.hash)
        ? { kind: "route", hash: data.hash }
        : { error: `${ROUTE}: hash must match #/[A-Za-z0-9._~:%/-]*` };
    default:
      return null;
  }
}
