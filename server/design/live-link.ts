// A short-lived link to one design's page being written. A sandboxed frame has no origin and sends no cookie
// of the app's, so the link itself is what lets it in: random, good for one design and version, a few minutes.
// Kept in memory: a server restart ends them, and the page asks for a new one.
import { randomBytes } from "node:crypto";

export const LIVE_LINK_MS = 5 * 60_000;
/** More than any screen holds: an old one goes before this grows. */
const MOST_LINKS = 1024;

export interface LiveLink {
  sessionId: string;
  label: string;
  version: number;
  expires: number;
}

const links = new Map<string, LiveLink>();
let now = (): number => Date.now();
export const setLiveLinkClockForTest = (clock: (() => number) | null): void => void (now = clock ?? (() => Date.now()));

export function mintLiveLink(sessionId: string, label: string, version: number): { token: string; expires: number } {
  const at = now();
  for (const [token, link] of links) if (link.expires <= at) links.delete(token);
  while (links.size >= MOST_LINKS) links.delete(links.keys().next().value!);
  // Hex: the gate judges a path lower-cased, so a token must read the same that way.
  const token = randomBytes(32).toString("hex");
  const expires = at + LIVE_LINK_MS;
  links.set(token, { sessionId, label, version, expires });
  return { token, expires };
}

/** What a token opens, or null: never issued, or past its time. */
export function liveLink(token: string): LiveLink | null {
  const link = links.get(token);
  if (!link) return null;
  if (link.expires > now()) return link;
  links.delete(token);
  return null;
}

/** The page's own address for a token: no chat in it, the token is all it takes. */
export const LIVE_LINK_ROUTE = "/api/design/live-page/:token";
export const liveLinkUrl = (token: string): string => `/api/design/live-page/${token}`;

/** Whether this request is a live link that still opens: the gate's one question about this route. */
export function liveLinkOpens(method: string, path: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const m = /^\/api\/design\/live-page\/([0-9a-f]+)$/.exec(path);
  return !!m && liveLink(m[1]!) !== null;
}
