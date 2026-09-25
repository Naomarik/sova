// One reading of a request path for every mesh access decision, matching what the router will
// route: Hono decodes %XX before matching, so a check on the raw path ("/api/%6Desh") is not a
// check on the route it reaches ("/api/mesh").

/**
 * `raw` (a URL pathname, dot segments already resolved) as the router will see it, decoded,
 * slash-collapsed and lower-cased, for judging only; null when it can't be judged: an encoded dot,
 * slash or backslash (decoding would change the segment structure) or an undecodable escape.
 */
export function judgedPath(raw: string): string | null {
  if (/%(?:2e|2f|5c)/i.test(raw)) return null;
  let path: string;
  try {
    path = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return path.replace(/[\\/]+/g, "/").toLowerCase();
}

/** Under /api/mesh (this host's own mesh config) or /api/peer (host-to-host only). */
export const isMeshOrPeerApi = (judged: string): boolean => /^\/api\/(?:peer|mesh)(?:\/|$)/.test(judged);
