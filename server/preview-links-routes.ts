import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { PreviewError, PreviewList, PreviewMinted } from "../shared/preview-links";
import { peerPort } from "./mesh/peers";
import { PROXIED_HEADER } from "./mesh/proxy";
import { OrgError } from "./org-error";
import { extendPreview, PreviewRefused, PreviewUnavailable, viewOf } from "./preview-links";
import { makePreview, previewViews, resolvePreview, staticPorts, turnOffPreview } from "./project-previews";
import { readPublicLinks } from "./public-links";
import { ingressInfo } from "./share/ingress";
import { shareListenerState } from "./share/listener";
import { previewAddress } from "./share/preview-address";

/**
 * Preview links, the operator's side (§mesh.public/preview, shared/preview-links.ts): list, mint,
 * turn off and extend a project's previews. Main listener only: a request from the peer listener or through a proxy gets the plain 404.
 * A mint needs a preview address (§mesh.public/preview-address) and a port that is none of Sova's, or a
 * folder of one of the project's coding sessions' worktrees (§mesh.public/preview-serve). The list
 * carries each one's kept link: these routes and the project overseer's own tools are the only places
 * it goes (§app.project-overseer/previews).
 */

const notFound = (c: Context) => c.json({ error: "Not found" }, 404);
const local = (c: Context) => !(c.env as { meshPeer?: unknown } | undefined)?.meshPeer && !c.req.header(PROXIED_HEADER);
const small = bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: "Too large" }, 413) });
const NO_STORE = { "Cache-Control": "no-store" };

/** Every port this Sova process binds or its settings name: never a preview's. */
export function sovaPorts(env: NodeJS.ProcessEnv = process.env): Set<number> {
  const out = new Set<number>();
  const add = (v: unknown) => {
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n === "number" && Number.isInteger(n) && n > 0) out.add(n);
  };
  add(env.PORT ?? 4800);
  add(env.SOVA_PORT);
  add(peerPort());
  add(env.SOVA_SHARE_PORT);
  add(shareListenerState()?.port);
  const file = readPublicLinks();
  add(file.gateway?.sharePort);
  add(file.ingressPort);
  add(ingressInfo()?.port);
  for (const p of staticPorts()) add(p);
  return out;
}

function refused(c: Context, err: unknown) {
  if (err instanceof PreviewRefused) return c.json({ error: err.message, code: err.code } satisfies PreviewError, 400);
  if (err instanceof PreviewUnavailable) return c.json({ error: err.message, code: "unavailable" } satisfies PreviewError, 503);
  if (err instanceof OrgError && err.status === 404) return c.json({ error: err.message, code: "bad-project" } satisfies PreviewError, 400);
  throw err;
}

/** Mint (the operator's): checked like the overseer's but for the listener, then made; the answer carries the link. */
async function mint(c: Context, body: Record<string, unknown>) {
  try {
    if (typeof body.orgId !== "string" || typeof body.projectId !== "string") throw new PreviewRefused("bad-project", "Name the project this preview belongs to.");
    const ports = sovaPorts();
    const r = await resolvePreview({ orgId: body.orgId, projectId: body.projectId, port: body.port, folder: body.folder, sessionId: body.sessionId, purpose: body.purpose, days: body.days, createdBy: "operator", requireOwner: false }, { sovaPorts: ports });
    const made = await makePreview(r, ports);
    const view = (await previewViews({ orgId: r.orgId, projectId: r.projectId })).find((v) => v.id === made.record.id) ?? viewOf(made.record);
    return c.json({ preview: view, url: made.url, ...(made.linkWarning ? { linkWarning: made.linkWarning } : {}) } satisfies PreviewMinted, 200, NO_STORE);
  } catch (err) {
    return refused(c, err);
  }
}

export function mountPreviewLinks(app: Hono): void {
  app.get("/api/previews", async (c) => {
    if (!local(c)) return notFound(c);
    const orgId = c.req.query("orgId");
    const projectId = c.req.query("projectId");
    const previews = await previewViews({ ...(orgId ? { orgId } : {}), ...(projectId ? { projectId } : {}) });
    return c.json({ previews, address: previewAddress() } satisfies PreviewList, 200, NO_STORE);
  });

  app.post("/api/previews", small, async (c) => {
    if (!local(c)) return notFound(c);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return c.json({ error: "Expected a JSON object body", code: "bad-project" } satisfies PreviewError, 400);
    return mint(c, body);
  });

  app.post("/api/previews/:id/off", async (c) => {
    if (!local(c)) return notFound(c);
    try {
      const r = await turnOffPreview(c.req.param("id"));
      return r ? c.json(viewOf(r), 200, NO_STORE) : notFound(c);
    } catch (err) {
      return refused(c, err);
    }
  });

  app.post("/api/previews/:id/extend", small, async (c) => {
    if (!local(c)) return notFound(c);
    const body = (await c.req.json().catch(() => null)) as { days?: unknown } | null;
    try {
      const r = extendPreview(c.req.param("id"), body?.days);
      return r ? c.json(viewOf(r), 200, NO_STORE) : notFound(c);
    } catch (err) {
      return refused(c, err);
    }
  });
}
