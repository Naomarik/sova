import type { Context, Hono, MiddlewareHandler } from "hono";
import { COMPOSER_HEADER, PEER_AREA_HEADER, peerRefusal, WIRE_AREAS, WIRE_VERSION_CODE, type WritingRefused, writingRefusal } from "../shared/wire-areas";
import { meshEnabled, meshSelf } from "./mesh";

// The host holding a session refuses what it can't trust (§mesh.compatibility/refusal): every
// writing request states a writing number, and a number other than this host's own is refused here,
// with the mesh on or off, for a page of this host as for one on another. The page's state is the
// visible half; this is the rule, so a tab left open across an update can't write in an old format.

/** The writing-area routes (§mesh.compatibility/areas), besides /ws/chat's frames (server/ws.ts) and
    POST /api/chat/frames, whose route refuses on its own so what it carried goes back as a draft. */
export const WRITING_ROUTES = [
  "/api/sessions",
  "/api/sessions/connect",
  "/api/sessions/fork",
  "/api/sessions/prompt",
  "/api/sessions/configure",
  "/api/chat/action",
  "/api/mode",
  "/api/sandbox",
  "/api/session-offers/choose",
  "/api/session-cards/state",
  "/api/session-cards/run",
] as const;

/** This host's name in a refusal; with the mesh off it has none. */
export const refusingHost = (): string => (meshEnabled() ? meshSelf().label : "this host");

/** Why this host refuses a socket or request stating `stated` as its writing number, or null. */
export const writingRefused = (stated: string | null | undefined): string | null => writingRefusal(stated, WIRE_AREAS.composer, refusingHost());

/** The answer to a refused writing request. */
export const refusedAnswer = (c: Context, error: string): Response => c.json({ error, code: WIRE_VERSION_CODE } satisfies WritingRefused, 409);

const writingGate: MiddlewareHandler = async (c, next) => {
  const why = writingRefused(c.req.header(COMPOSER_HEADER));
  if (why) return refusedAnswer(c, why);
  await next();
};

/** Before the routes it guards: on each route's own pattern, so no spelling that reaches the route
    gets past it. */
export function mountWritingGate(app: Hono): void {
  for (const route of WRITING_ROUTES) app.post(route, writingGate);
}

/** Why this host refuses what a peer sent under a host-to-host number, or null
    (§mesh.compatibility/every-send-states-a-version). */
export const peerAreaRefused = (c: Context, host: string): Response | null => {
  const why = peerRefusal(c.req.header(PEER_AREA_HEADER), WIRE_AREAS.peer, host);
  return why ? c.json({ error: why, reason: WIRE_VERSION_CODE }, 409) : null;
};

/** The app's in-process dispatch, for what this server runs itself (the Overseer's tools, offers'
    buttons, schedules): it states this host's own number like any other sender. */
export function statingOwnNumber(app: Pick<Hono, "request">): (path: string, init?: RequestInit) => Response | Promise<Response> {
  return (path, init) => {
    const headers = new Headers(init?.headers);
    headers.set(COMPOSER_HEADER, String(WIRE_AREAS.composer));
    return app.request(path, { ...init, headers });
  };
}
