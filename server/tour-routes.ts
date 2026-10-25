import { join } from "node:path";
import { stateRoot } from "./state-root";
import { TourApprovalStore } from "./tours/approvals";
import { ownerTourDestinations } from "./tours/destinations";
import { ensureTourToolRuntime } from "./tours/runtime";
import { mountTourJobRoutes } from "./tours/runtime-routes";
import { tourOwnerCurrent, tourOwnerPath } from "./tours/ownership";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { projectTourPublic } from "../shared/tour";
import { onSessionArchived } from "./sessions-index";
import { awaitShareLinks } from "./share/links-events";
import { currentTarget, routeSetting } from "./share/gateway-client";
import { gatewayRoutes } from "./share/registry-push";
import { linkUrl, linkWarning } from "./share/share-state";
import { readAsset, readEdition } from "./tours/store";
import { tourProgress } from "./tours/progress";
import { tourShares, TourShareError } from "./tours/shares";
import { mountTourBindingRoutes } from "./tours/bindings-routes";

/** Operator-only routes; this module is never mounted on the share listener. */
export const tourSessionPath = tourOwnerPath;
export async function tourSessionOwned(sessionId: string): Promise<boolean> { const path = await tourSessionPath(sessionId); return !!path && tourOwnerCurrent(sessionId, path); }
const missing = (c: Context) => c.json({ error: "Tour not found.", code: "not-found" }, 404);
/** Final admission after every await: a source deleted meanwhile answers 404 whatever its body was. */
const ownedNow = async (sessionId: string): Promise<boolean> => await tourSessionOwned(sessionId) && tourOwnerCurrent(sessionId);
const bodyOf = async (c: Context): Promise<{ ok: true; value: unknown } | { ok: false }> => { try { return { ok: true, value: await c.req.json() }; } catch { return { ok: false }; } };
const BASE = "/api/tours/:sessionId/:tourId/editions/:editionId";
const small = bodyLimit({ maxSize: 16 * 1024 });
let archiveHooked = false;
export function mountTourRoutes(app: Hono): void {
  ensureTourToolRuntime();
  if (!archiveHooked) {
    archiveHooked = true;
    onSessionArchived(sessionId => { try { tourShares().revokeSession(sessionId); } catch { /* fail closed on reads if the authority store is broken */ } });
  }
  app.use("/api/tours/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const sid = c.req.path.split("/")[3];
    if (!sid || !await tourSessionOwned(sid) || !tourOwnerCurrent(sid)) return missing(c);
    await next();
  });
  app.get(BASE, c => {
    const e = readEdition(c.req.param("sessionId"), c.req.param("tourId"), c.req.param("editionId"));
    // The ordinary viewer needs no source, raw report or contact sheet. Open-page links are separately authorized.
    return e ? c.json(projectTourPublic(e.manifest, { id: e.manifest.id, editionId: e.manifest.editionId })) : missing(c);
  });
  app.get(`${BASE}/destinations`, c => {
    const e = readEdition(c.req.param("sessionId"), c.req.param("tourId"), c.req.param("editionId"));
    if (!e) return missing(c);
    try { const approvals = new TourApprovalStore(join(stateRoot(), "tour-approvals")); return c.json(ownerTourDestinations(e, origin => approvals.isApproved(origin))); }
    catch { return c.json({}); }
  });
  app.get(`${BASE}/assets/:file`, c => {
    const { sessionId, tourId, editionId, file } = c.req.param();
    const e = readEdition(sessionId!, tourId!, editionId!);
    const allowed = e && projectTourPublic(e.manifest, { id: e.manifest.id, editionId: e.manifest.editionId }).assets.some(a => a.file === file);
    const asset = allowed ? readAsset(sessionId!, tourId!, editionId!, file!) : null;
    return asset ? c.body(new Uint8Array(asset.bytes), 200, { "Content-Type": asset.mime, "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" }) : missing(c);
  });
  app.get(`${BASE}/progress`, c => {
    const { sessionId, tourId, editionId } = c.req.param();
    const e = readEdition(sessionId!, tourId!, editionId!);
    return e ? c.json(tourProgress().get(`owner:${sessionId}:${tourId}`, e.manifest)) : missing(c);
  });
  app.put(`${BASE}/progress`, small, async c => {
    const { sessionId, tourId, editionId } = c.req.param();
    const e = readEdition(sessionId!, tourId!, editionId!);
    if (!e) return missing(c);
    const input = await bodyOf(c);
    if (!await ownedNow(sessionId!)) return missing(c);
    try { if (!input.ok) throw new Error("bad position"); return c.json(tourProgress().put(`owner:${sessionId}:${tourId}`, e.manifest, input.value)); }
    catch { return c.json({ error: "Choose a recorded step, view and picture size.", code: "bad-position" }, 400); }
  });
  app.post(`${BASE}/share-preview`, small, async c => {
    const { sessionId, tourId, editionId } = c.req.param();
    const e = readEdition(sessionId!, tourId!, editionId!);
    if (!e) return missing(c);
    try { return c.json(tourShares().previewFor(e)); } catch (err) { return failure(c, err); }
  });
  app.post(`${BASE}/shares`, small, async c => {
    const { sessionId, tourId, editionId } = c.req.param();
    const parsed = await bodyOf(c);
    if (!await ownedNow(sessionId!)) return missing(c);
    try {
      const body = (parsed.ok ? parsed.value : null) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => !["previewId", "expiresAt"].includes(k)) || typeof body.previewId !== "string" || typeof body.expiresAt !== "string") throw new TourShareError(400, "bad-request", "Review the tour and choose an expiry first.");
      // No token is minted until the exact current gateway target has negotiated tours.
      if (typeof routeSetting()?.route === "object" && (!currentTarget() || !gatewayRoutes("t"))) throw new TourShareError(409, "gateway-old", "This gateway does not support tour links. Update it or choose a supported share address.");
      const { result: made, outcome } = await awaitShareLinks(() => tourShares().create(sessionId!, tourId!, editionId!, body.previewId as string, body.expiresAt as string));
      return c.json({ id: made.link.id, url: linkUrl("t", made.token), expiresAt: made.link.expiresAt, editionId: made.link.editionId, ...linkWarning(outcome) }, 201);
    } catch (err) { return failure(c, err); }
  });
  mountTourBindingRoutes(app, tourSessionOwned);
  mountTourJobRoutes(app);
  app.delete(`${BASE}/shares/:id`, c => {
    const { sessionId, tourId, editionId, id } = c.req.param();
    try { return tourShares().revoke(sessionId!, tourId!, editionId!, id!) ? c.json({ ok: true }) : missing(c); } catch (err) { return failure(c, err); }
  });
}
function failure(c: Context, err: unknown): Response {
  if (err instanceof TourShareError) return c.json({ error: err.message, code: err.code }, err.status);
  throw err;
}
