import type { Context, Hono, MiddlewareHandler } from "hono";
import { COMPOSER_HEADER, PEER_AREA_HEADER, peerRefusal, WIRE_AREAS, WIRE_VERSION_CODE, type WritingRefused, writingRefusal } from "../shared/wire-areas";
import { meshEnabled, meshSelf } from "./mesh";

// The host holding a session refuses what it can't trust (§mesh.compatibility/refusal): every
// writing request states a writing number, and a number other than this host's own is refused here,
// with the mesh on or off, for a page of this host as for one on another. The page's state is the
// visible half; this is the rule, so a tab left open across an update can't write in an old format.

/**
 * The writing-area routes (§mesh.compatibility/areas): messages, steering, Stop, model and in-chat
 * actions, new sessions. Hono patterns, `:name` one path segment. Besides these, /ws/chat's frames
 * (server/ws.ts) and POST /api/chat/frames, whose route refuses on its own so what it carried goes
 * back as a draft.
 *
 * Judged outside the area, so not gated (each keeps working on another writing number):
 * - the session's place in the list, not its chat: /api/sessions/title, /archive, /auto-title,
 *   /shorten-titles, /cleanup, /api/session-groups (create, assign, rename, delete) and
 *   /api/worktrees/cleanup, /api/worktrees/restore;
 * - a draft or a file staged before a send, which writes nothing into the chat (the send itself is
 *   gated): PUT /api/sessions/draft, /api/upload, /api/attachment;
 * - what an agent or another chat does in a chat, not a page's send: /api/session-cards/post and
 *   /trust, /api/session-offers/show;
 * - host settings and stores: /api/settings/*, /api/models/favorite, /api/profiles/*, /api/overseer/*;
 * - organizations, batons, projects and the share listener's /api/i/*: best effort
 *   (§mesh.compatibility/best-effort), no area of their own.
 */
export const WRITING_ROUTES = [
  "/api/sessions",
  "/api/sessions/connect",
  "/api/sessions/fork",
  "/api/sessions/prompt",
  "/api/sessions/configure",
  "/api/sessions/loadout",
  "/api/sessions/profile",
  "/api/session-groups/:id/prompt",
  "/api/chat/action",
  "/api/mode",
  "/api/mode/command",
  "/api/sandbox",
  "/api/subagents",
  "/api/workers/resume",
  "/api/session-offers/choose",
  "/api/session-cards/state",
  "/api/session-cards/run",
  "/api/session-cards/answer",
] as const;

/** This host's name in a refusal; with the mesh off it has none. */
export const refusingHost = (): string => (meshEnabled() ? meshSelf().label : "this host");

/** Why this host refuses a socket or request stating `stated` as its writing number, or null. */
export const writingRefused = (stated: string | null | undefined): string | null => writingRefusal(stated, WIRE_AREAS.composer, refusingHost());

/** The answer to a refused writing request. */
export const refusedAnswer = (c: Context, error: string): Response => c.json({ error, code: WIRE_VERSION_CODE } satisfies WritingRefused, 409);

/** Each route as a whole-path pattern: `:name` is one segment, the rest literal. */
const writing = WRITING_ROUTES.map((r) => new RegExp(`^${r.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z]+/g, "[^/]+")}$`));
export const isWritingRoute = (path: string): boolean => writing.some((re) => re.test(path));

/** Before the routes it guards. `c.req.path` is the very string the router matches, so no spelling
    that reaches a route gets past it. */
const writingGate: MiddlewareHandler = async (c, next) => {
  const why = c.req.method === "POST" && isWritingRoute(c.req.path) ? writingRefused(c.req.header(COMPOSER_HEADER)) : null;
  if (why) return refusedAnswer(c, why);
  await next();
};

export function mountWritingGate(app: Hono): void {
  app.use("/api/*", writingGate);
}

/** What a peer sent under another host-to-host number, refused; null when it passes
    (§mesh.compatibility/every-send-states-a-version). */
export const peerAreaRefused = (c: Context, host: string): Response | null => {
  const why = peerRefusal(c.req.header(PEER_AREA_HEADER), WIRE_AREAS.peer, host);
  return why ? c.json({ error: why, reason: WIRE_VERSION_CODE }, 409) : null;
};

/** peerAreaRefused as a route's own middleware. */
export const peerAreaGate = (host: () => string): MiddlewareHandler => async (c, next) => {
  const refused = peerAreaRefused(c, host());
  if (refused) return refused;
  await next();
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
