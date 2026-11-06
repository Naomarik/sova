// Every request this page makes states the writing number bundled into it
// (§mesh.compatibility/every-send-states-a-version). Stamped where fetch itself goes through, so a
// route added tomorrow can't forget: the host holding a session is the one that decides which
// requests the number matters to. Pure but for `installWireStamp`.

import { COMPOSER_HEADER, COMPOSER_PARAM, WIRE_AREAS } from "../../shared/wire-areas";

/** `?composer=<n>` as a /ws/chat URL carries it: a browser can't set a socket's headers. */
export const COMPOSER_QUERY = `${COMPOSER_PARAM}=${WIRE_AREAS.composer}`;

/** The path of a request's target when it is this page's own origin, else null. */
function ownPath(input: RequestInfo | URL, origin: string): string | null {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    const u = new URL(raw, origin);
    return u.origin === origin ? u.pathname : null;
  } catch {
    return null;
  }
}

/** Whether a request is one to state the number on: an /api route here, or through to a peer. */
export function stampsRequest(input: RequestInfo | URL, origin: string): boolean {
  const path = ownPath(input, origin);
  return path !== null && (path.startsWith("/api/") || /^\/peer\/[^/]+\/api\//.test(path));
}

/** `init` with the number stated, keeping every header it had (a Request's own included). */
export function stampInit(input: RequestInfo | URL, init: RequestInit | undefined, composer: number = WIRE_AREAS.composer): RequestInit {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set(COMPOSER_HEADER, String(composer));
  return { ...init, headers };
}

/** Wrap the page's fetch; once at start. */
export function installWireStamp(): void {
  const inner = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => (stampsRequest(input, location.origin) ? inner(input, stampInit(input, init)) : inner(input, init));
}
