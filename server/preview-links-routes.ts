import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { PreviewError, PreviewList, PreviewMinted, PreviewView } from "../shared/preview-links";
import { peerPort } from "./mesh/peers";
import { PROXIED_HEADER } from "./mesh/proxy";
import { extendPreview, listPreviews, mintPreview, PreviewRefused, PreviewUnavailable, revokePreview, viewOf } from "./preview-links";
import { readPublicLinks } from "./public-links";
import { ingressInfo } from "./share/ingress";
import { awaitShareLinks } from "./share/links-events";
import { linkWarning, shareListenerState } from "./share/listener";
import { previewAddress, previewOrigin } from "./share/preview-address";
import { dialLoopback } from "./share/preview-proxy";

/**
 * Preview links, the operator's side (§mesh.public/preview, shared/preview-links.ts): list, mint,
 * turn off and extend a project's previews. Main listener only: a request from the peer listener or through a proxy gets the plain 404.
 * A mint needs a preview address (§mesh.public/preview-address) and a port that is none of Sova's.
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
  return out;
}

/** Whether something accepts connections on a loopback port now. */
async function running(port: number): Promise<boolean> {
  const s = await dialLoopback(port);
  if (s === "refused") return false;
  s.destroy();
  return true;
}

async function withRunning(views: PreviewView[]): Promise<PreviewView[]> {
  return Promise.all(views.map(async (v) => (v.state === "active" ? { ...v, running: await running(v.port) } : v)));
}

function refused(c: Context, err: unknown) {
  if (err instanceof PreviewRefused) return c.json({ error: err.message, code: err.code } satisfies PreviewError, 400);
  if (err instanceof PreviewUnavailable) return c.json({ error: err.message, code: "unavailable" } satisfies PreviewError, 503);
  throw err;
}

/** Mint, answering with the link once (its label is never stored). */
async function mint(c: Context, input: { orgId: unknown; projectId: unknown; port: unknown; days?: unknown; createdBy?: string }) {
  const address = previewAddress();
  if (!address.url) return c.json({ error: address.message ?? "No preview address is set.", code: address.reason ?? "no-address" } satisfies PreviewError, 400);
  try {
    const { result, outcome } = await awaitShareLinks(() =>
      mintPreview({ orgId: input.orgId as string, projectId: input.projectId as string, port: input.port, days: input.days, ...(input.createdBy ? { createdBy: input.createdBy } : {}) }, sovaPorts()),
    );
    const url = `${previewOrigin(address.url, result.label)}/`;
    const warning = typeof readPublicLinks().route === "object" ? linkWarning(outcome).linkWarning : undefined;
    const view = { ...viewOf(result.record), running: await running(result.record.port) };
    return c.json({ preview: view, url, ...(warning ? { linkWarning: warning } : {}) } satisfies PreviewMinted, 200, NO_STORE);
  } catch (err) {
    return refused(c, err);
  }
}

export function mountPreviewLinks(app: Hono): void {
  app.get("/api/previews", async (c) => {
    if (!local(c)) return notFound(c);
    const orgId = c.req.query("orgId");
    const projectId = c.req.query("projectId");
    const previews = listPreviews({ ...(orgId ? { orgId } : {}), ...(projectId ? { projectId } : {}) });
    return c.json({ previews: await withRunning(previews), address: previewAddress() } satisfies PreviewList, 200, NO_STORE);
  });

  app.post("/api/previews", small, async (c) => {
    if (!local(c)) return notFound(c);
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return c.json({ error: "Expected a JSON object body", code: "bad-project" } satisfies PreviewError, 400);
    return mint(c, { orgId: body.orgId, projectId: body.projectId, port: body.port, days: body.days });
  });

  app.post("/api/previews/:id/off", (c) => {
    if (!local(c)) return notFound(c);
    try {
      const r = revokePreview(c.req.param("id"));
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
