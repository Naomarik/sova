import type { Context, Hono } from "hono";
import { extensionCaller, showsToken, TOKEN_HEADER } from "./auth";
import { allLabels, cleanLabelChanges, labelsOf, setLabels } from "./session-labels";

/**
 * Labels on a chat (server/session-labels.ts), mounted on the app:
 *   POST /api/sessions/labels {id, labels: {<key>: <value> | null}} → {id, labels: {<key>: <value>}}
 *     An extension's key only: the namespace is the key's own extension, never a body or a header.
 *     The operator's token, a page's cookie and every peer-listener request are refused (403): no
 *     linked computer writes another host's labels. A merge; null deletes a key.
 *   GET  /api/sessions/labels?id=<session id> → {id, labels: SessionLabels}
 *   GET  /api/sessions/labels → {sessions: {<session id>: SessionLabels}}
 *     The read-back, on the main listener only (any caller there).
 */

const SESSION_ID_RE = /^[\w-]{1,100}$/;
const NO_STORE = { "Cache-Control": "no-store" };

const fromPeer = (c: Context): boolean => !!(c.env as { meshPeer?: unknown } | undefined)?.meshPeer;

/** The extension whose key this request shows, or null (the token, a cookie, a peer, nothing). */
function keyExtension(c: Context): string | null {
  if (fromPeer(c)) return null;
  const token = c.req.header(TOKEN_HEADER);
  return token !== undefined && !showsToken(token) ? extensionCaller(token) : null;
}

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const v: unknown = await c.req.json();
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function registerLabelRoutes(app: Hono<any>, deps: { pathOfId: (id: string) => Promise<string | null> }): void {
  app.post("/api/sessions/labels", async (c) => {
    if (fromPeer(c)) return c.json({ error: "Labels are set by this computer's own extensions only." }, 403);
    // The body's shape first (its own sentence for each wrong value), then who asks, then the session.
    const body = await jsonBody(c);
    if (!body) return c.json({ error: "Expected JSON body { id, labels }" }, 400);
    if (typeof body.id !== "string" || !SESSION_ID_RE.test(body.id)) return c.json({ error: "id must be a session id" }, 400);
    const changes = cleanLabelChanges(body.labels);
    if (typeof changes === "string") return c.json({ error: changes }, 400);
    const ext = keyExtension(c);
    if (!ext) return c.json({ error: "Only an extension's key sets labels (x-sova-token: its key)." }, 403);
    const path = await deps.pathOfId(body.id);
    if (!path) return c.json({ error: "No session with that id" }, 404);
    const r = setLabels(body.id, path, ext, changes);
    if (typeof r === "string") return c.json({ error: r }, 400);
    return c.json({ id: body.id, labels: r.labels }, 200, NO_STORE);
  });

  app.get("/api/sessions/labels", (c) => {
    if (fromPeer(c)) return c.json({ error: "Labels are read on this computer's own door only." }, 403);
    const id = c.req.query("id");
    if (id === undefined) return c.json({ sessions: allLabels() }, 200, NO_STORE);
    if (!SESSION_ID_RE.test(id)) return c.json({ error: "Invalid ?id= (a session id)" }, 400);
    return c.json({ id, labels: labelsOf(id) ?? {} }, 200, NO_STORE);
  });
}
