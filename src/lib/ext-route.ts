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
