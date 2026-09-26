import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { LinkError, LinkInbox, LinksList, LinkWhoami, PeerLinkRead } from "../../shared/mesh-links";
import type { MeshApi } from "./index";
import { LinkActError, type LinksDeps, type MeshLinks, meshLinks as theLinks } from "./links";
import { PROXIED_HEADER } from "./proxy";

// The link routes (§mesh/links; the list and bodies: shared/mesh-links.ts). Peer routes answer
// only the peer listener's verified caller; the local acts under /api/mesh/links/* answer only
// this host's own listener (the peer listener refuses /api/mesh/*, the page proxy never forwards
// it, and each route checks again). While the mesh is off every route here is the plain 404.

export interface LinkRouteDeps extends Omit<LinksDeps, "mesh"> {
  /** sova_read_session with `host`, on the host that holds the session (server/overseer.ts). */
  renderPeerRead(path: string, opts: { from?: string; items?: number; chars?: number }): Promise<PeerLinkRead>;
}

const notFound = (c: Context) => c.json({ error: "Not found" }, 404);
const small = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "Too large" }, 413) });
/** A message: its text is the bulk. */
const message = bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "Too large" }, 413) });
const json = (c: Context) => c.req.json().catch(() => null);
const intOf = (v: string | undefined): number | undefined => (v !== undefined && /^\d{1,9}$/.test(v) ? Number(v) : undefined);

/** A local act's failure as its answer; anything else is the server's 500. */
function failed(c: Context, err: unknown): Response {
  if (err instanceof LinkActError) return c.json(err.body satisfies LinkError, err.status);
  throw err;
}

export function mountLinks(app: Hono, mesh: LinksDeps["mesh"] & Pick<MeshApi, "requestPeer">, deps: LinkRouteDeps, meshLinks: MeshLinks = theLinks): void {
  meshLinks.configure({ ...deps, mesh });

  /** This host's own listener, the mesh on: a local act or a page read may run. */
  const local = (c: Context) => mesh.enabled() && !(c.env as { meshPeer?: unknown } | undefined)?.meshPeer && !c.req.header(PROXIED_HEADER);

  // ---- peer listener ----------------------------------------------------------------------------

  app.get("/api/peer/links/whoami", (c) => {
    const caller = mesh.requestPeer(c);
    return caller ? c.json({ nodeId: caller.nodeId } satisfies LinkWhoami) : notFound(c);
  });

  app.get("/api/peer/links/read", async (c) => {
    if (!mesh.requestPeer(c)) return notFound(c);
    const id = c.req.query("id") ?? "";
    const s = /^[\w-]{1,100}$/.test(id) ? await deps.summary(id) : null;
    if (!s) return c.json({ error: "No session with that id" }, 404);
    const from = c.req.query("from");
    const items = intOf(c.req.query("items"));
    const chars = intOf(c.req.query("chars"));
    return c.json(await deps.renderPeerRead(s.path, { ...(from !== undefined ? { from } : {}), ...(items !== undefined ? { items } : {}), ...(chars !== undefined ? { chars } : {}) }), 200, {
      "Cache-Control": "no-store",
    });
  });

  app.post("/api/peer/links", small, async (c) => {
    const caller = mesh.requestPeer(c);
    if (!caller) return notFound(c);
    const r = await meshLinks.takeCopy(caller, await json(c));
    return c.json(r.body, r.status);
  });

  app.post("/api/peer/links/:id/end", small, async (c) => {
    const caller = mesh.requestPeer(c);
    if (!caller) return notFound(c);
    const r = meshLinks.takeEnd(caller, c.req.param("id"), await json(c));
    return c.json(r.body, r.status);
  });

  app.post("/api/peer/links/:id/message", message, async (c) => {
    const caller = mesh.requestPeer(c);
    if (!caller) return notFound(c);
    const r = await meshLinks.takeMessage(caller, c.req.param("id"), await json(c));
    return c.json(r.body, r.status);
  });

  // ---- local acts (the link extension, the Overseer's page) --------------------------------------

  app.get("/api/mesh/links", async (c) => {
    if (!local(c)) return notFound(c);
    const session = c.req.query("session");
    // A session's own view (link_members) is for a session this host runs; without one, every link.
    if (session && !deps.held(session)) return c.json({ error: "That session isn't running on this host.", reason: "not-member" } satisfies LinkError, 403);
    try {
      return c.json({ links: await meshLinks.list(session ? { sessionId: session } : {}) } satisfies LinksList, 200, { "Cache-Control": "no-store" });
    } catch (err) {
      return failed(c, err);
    }
  });

  app.post("/api/mesh/links", small, async (c) => {
    if (!local(c)) return notFound(c);
    try {
      return c.json(await meshLinks.create(await json(c)));
    } catch (err) {
      return failed(c, err);
    }
  });

  app.post("/api/mesh/links/send", message, async (c) => {
    if (!local(c)) return notFound(c);
    try {
      return c.json(await meshLinks.send(await json(c)));
    } catch (err) {
      return failed(c, err);
    }
  });

  app.get("/api/mesh/links/inbox", (c) => {
    if (!local(c)) return notFound(c);
    const session = c.req.query("session") ?? "";
    if (!deps.held(session)) return c.json({ error: "That session isn't running on this host.", reason: "not-member" } satisfies LinkError, 403);
    try {
      return c.json({ records: meshLinks.inbox(session, intOf(c.req.query("limit"))) } satisfies LinkInbox, 200, { "Cache-Control": "no-store" });
    } catch (err) {
      return failed(c, err);
    }
  });

  app.post("/api/mesh/links/:id/end", async (c) => {
    if (!local(c)) return notFound(c);
    try {
      return c.json(await meshLinks.end(c.req.param("id")));
    } catch (err) {
      return failed(c, err);
    }
  });

  // ---- page reads (proxied to a peer as /peer/<id>/api/links/…) --------------------------------

  app.get("/api/links/:id/thread", (c) => {
    if (!mesh.enabled()) return notFound(c);
    try {
      return c.json(meshLinks.thread(c.req.param("id")), 200, { "Cache-Control": "no-store" });
    } catch (err) {
      return failed(c, err);
    }
  });

  app.post("/api/links/:id/seen", small, async (c) => {
    if (!mesh.enabled()) return notFound(c);
    try {
      meshLinks.seen(c.req.param("id"), await json(c));
      return c.json({ ok: true as const });
    } catch (err) {
      return failed(c, err);
    }
  });
}
