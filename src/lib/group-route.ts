// The workspace routes. `#/s/<path>` (one session, the whole page) is untouched; a group adds
//
//   #/g/<id>               the group's workspace, no pane singled out
//   #/g/<id>/<path>        the same, with that pane focused (its composer takes the focus)
//
// Both parts are percent-encoded: a session path is a filesystem path, and a group id is whatever
// the server minted. Membership is never in the URL — the session list's `groupId` is its truth.

export interface GroupRoute {
  id: string;
  /** The focused pane's session path, or null when the URL names no pane. */
  path: string | null;
}

/** `#/g/<id>` or `#/g/<id>/<path>`, else null (including a hash we can't decode). */
export function groupRouteFromHash(hash: string): GroupRoute | null {
  const m = /^#\/g\/([^/]+)(?:\/(.+))?$/.exec(hash);
  if (!m) return null;
  try {
    const id = decodeURIComponent(m[1]!);
    if (!id) return null;
    return { id, path: m[2] ? decodeURIComponent(m[2]) : null };
  } catch {
    return null;
  }
}

/** The link to a workspace, optionally with the pane to focus. */
export const groupHref = (id: string, path?: string | null): string =>
  `#/g/${encodeURIComponent(id)}${path ? `/${encodeURIComponent(path)}` : ""}`;
