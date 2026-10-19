import type { Context, Hono } from "hono";
import type { HEntry } from "../../shared/harness";
import type { TourAttachment } from "../../shared/tour";
import { allBatons, batonById, nameOf, sessionPathOf } from "../baton";
import { readOrg } from "../orgs";
import { acquireChatHandle } from "../chat-handle";
import { TOUR_ATTACHMENT, TOUR_DETACHMENT } from "../harness/state-kinds";
import { refreshShare, outsiderRedactor, readView } from "../share/hub";
import { conversationVocabulary } from "../baton-view";
import { TourBindings, tourSnapshotFits } from "./bindings";
import { batonTourAuthority, ownerTourAuthority, ownerPreviewTourAuthority, personPreviewTourAuthority, scopedTourRead, sameBindingScope, type BindingAuthority } from "./bindings-scope";
import { readAsset, readEdition } from "./store";
import { consumePreview, invalidatePreviews, previewFor, TOUR_SIGNED_IN_LOCKED, tourSignedIn } from "./shares";
import { tourBindingIndex } from "./bindings-index";
import { tourProgress } from "./progress";
import { ownerReadTokenLimited, tourImageTokenLimited, TourReadRateLimit } from "../share/tour-limits";
import { digest } from "./assets";

const missing = (c: Context) => c.json({ error: "Not found" }, 404);
const p = (c: Context, key: string) => c.req.param(key) ?? "";
const locked = (c: Context) => c.json({ error: TOUR_SIGNED_IN_LOCKED, code: "signed-in-locked" }, 409);
// Serialize confirmations and revocations per destination, including awaits to its chat process.
// A confirmation queued before detachment cannot consume its old review after revocation returns.
const destinations = new Map<string, Promise<void>>();
export async function inDestination<T>(key: string, act: () => Promise<T>): Promise<T> {
  const before = destinations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const tail = before.then(() => hold);
  destinations.set(key, tail);
  await before;
  try { return await act(); }
  finally { release(); if (destinations.get(key) === tail) destinations.delete(key); }
}
async function answer(c: Context, authority: BindingAuthority) {
  c.header("Cache-Control", "no-store"); c.header("Referrer-Policy", "no-referrer"); c.header("X-Content-Type-Options", "nosniff");
  const file = c.req.param("file"), token = p(c, "token");
  const kind = c.req.path.startsWith("/api/h/") ? "h" : c.req.path.startsWith("/api/i/") ? "i" : null;
  try {
    const value = await scopedTourRead(authority, file, undefined, () => {
      // This hook runs only after real current access and exact branch inventory have passed.
      if (kind && (file !== undefined ? tourImageTokenLimited(kind, token) : kind === "i" && ownerReadTokenLimited(token))) throw new TourReadRateLimit();
    });
    if (!value) return missing(c);
    return "bytes" in value ? c.body(new Uint8Array(value.bytes), 200, { "Content-Type": value.mime, "Content-Length": String(value.bytes.length), "Content-Security-Policy": "default-src 'none'; sandbox" }) : c.json(value);
  } catch (error) { if (error instanceof TourReadRateLimit) return c.json({ error: error.message }, 429); throw error; }
}
const h = (c: Context) => batonTourAuthority(p(c, "token"), p(c, "handle"));
const i = (c: Context) => ownerTourAuthority(p(c, "token"), p(c, "conversation"), p(c, "handle"));
async function progress(c: Context, authority: BindingAuthority, write: boolean) {
  const scope = await authority();
  if (!scope) return missing(c);
  const manifest = await scopedTourRead(authority);
  if (!manifest || "bytes" in manifest) return missing(c);
  const key = `baton:${scope.workspace}:${scope.reader}:${scope.sessionId}:${scope.attachment.handle}`;
  try {
    const input: unknown = write ? await c.req.json() : undefined;
    if (!sameBindingScope(scope, await authority())) return missing(c);
    const result = write ? tourProgress().put(key, manifest, input) : tourProgress().get(key, manifest);
    if (!sameBindingScope(scope, await authority())) return missing(c);
    return c.json(result);
  } catch { return c.json({ error: "Choose a step and view in this tour." }, 400); }
}
/** Mounted only on the share listener; no operator ownership or recording endpoints. */
export function mountBatonTourRoutes(app: Hono): void {
  app.get("/api/h/:token/tours/:handle", c => answer(c, h(c)));
  app.get("/api/h/:token/tours/:handle/assets/:file", c => answer(c, h(c)));
  app.get("/api/h/:token/tours/:handle/progress", c => progress(c, h(c), false));
  app.put("/api/h/:token/tours/:handle/progress", c => progress(c, h(c), true));
  app.get("/api/i/:token/c/:conversation/tours/:handle", c => answer(c, i(c)));
  app.get("/api/i/:token/c/:conversation/tours/:handle/assets/:file", c => answer(c, i(c)));
}
/** Operator previews use the same filtered scope, never fallback to a recording's private API. */
export function mountTourPreviewRoutes(app: Hono): void {
  const person = (c: Context) => personPreviewTourAuthority(p(c, "id"), p(c, "pid"), p(c, "session"), p(c, "handle"));
  const owner = (c: Context) => ownerPreviewTourAuthority(p(c, "id"), p(c, "conversation"), p(c, "handle"));
  const pb = "/api/orgs/:id/people/:pid/preview/tours/:session/:handle";
  const ob = "/api/orgs/:id/owner/preview/c/:conversation/tours/:handle";
  app.get(pb, c => answer(c, person(c))); app.get(`${pb}/assets/:file`, c => answer(c, person(c)));
  app.get(ob, c => answer(c, owner(c))); app.get(`${ob}/assets/:file`, c => answer(c, owner(c)));
}
/** A binding requires a destination-specific full-picture preview before any public attachment. */
export interface BindingWriter {
  busy(path: string): Promise<boolean>;
  attach(path: string, attachment: TourAttachment): Promise<void>;
  detach(path: string, handle: string): Promise<void>;
}
export const bindingWriter: BindingWriter = {
  async busy(path) { const c = await acquireChatHandle(path); return c.mirror.running || c.mirror.compacting; },
  async attach(path, attachment) { await (await acquireChatHandle(path)).appendStateRow(TOUR_ATTACHMENT, attachment); },
  async detach(path, handle) { await (await acquireChatHandle(path)).appendState(TOUR_DETACHMENT, { v: 1, handle }); },
};
export function mountTourBindingRoutes(app: Hono, owned: (session: string) => Promise<boolean>, writer: BindingWriter = bindingWriter): void {
  const base = "/api/tours/:sessionId/:tourId/editions/:editionId";
  const prepare = async (c: Context) => {
    if (!(await owned(p(c, "sessionId")))) return null;
    const body: unknown = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const b = body as Record<string, unknown>, dest = typeof b.destinationSessionId === "string" ? batonById(b.destinationSessionId) : null;
    const e = readEdition(p(c, "sessionId"), p(c, "tourId"), p(c, "editionId"));
    if (!dest || !e || !(await owned(dest.row.sessionId)) || dest.row.state === "closed" || dest.row.state === "done" || (e.source.kind === "project" && e.source.projectId !== dest.row.projectId)) return null;
    return { b, dest, e };
  };
  const source = async (c: Context) => await owned(p(c, "sessionId")) ? readEdition(p(c, "sessionId"), p(c, "tourId"), p(c, "editionId")) : null;
  const destination = (session: string) => {
    const hit = batonById(session);
    return hit ? { sessionId: session, orgId: hit.row.orgId, orgName: readOrg(hit.row.orgId).name, publicTitle: hit.row.publicTitle, holder: hit.row.holder ? nameOf(hit.row.orgId, hit.row.holder) : null } : null;
  };
  app.get(`${base}/binding-destinations`, async c => {
    const e = await source(c);
    if (!e) return missing(c);
    if (tourSignedIn(e)) return locked(c);
    const rows = await Promise.all(allBatons().filter(r => (r.state === "open" || r.state === "needs-you") && (e.source.kind !== "project" || e.source.projectId === r.projectId)).map(async r => await owned(r.sessionId) ? destination(r.sessionId) : null));
    return c.json(rows.filter(Boolean));
  });
  app.get(`${base}/bindings`, async c => {
    if (!(await source(c))) return missing(c);
    const rows = await Promise.all(tourBindingIndex().list(p(c, "sessionId"), p(c, "tourId"), p(c, "editionId")).map(async ref => {
      const hit = batonById(ref.destinationSessionId);
      if (!hit || !(await owned(ref.destinationSessionId))) return null;
      const view = await readView(hit.row, hit.dir);
      const item = view.items.find(i => i.kind === "tour" && i.handle === ref.handle);
      const dest = destination(ref.destinationSessionId);
      return item?.kind === "tour" && dest ? { ...dest, destinationSessionId: ref.destinationSessionId, handle: item.handle, title: item.title, summary: item.summary, steps: item.steps } : null;
    }));
    return c.json(rows.filter(Boolean));
  });
  app.delete(`${base}/bindings/:handle`, async c => {
    if (!(await source(c))) return missing(c);
    const ref = tourBindingIndex().list(p(c, "sessionId"), p(c, "tourId"), p(c, "editionId")).find(r => r.handle === p(c, "handle") && r.destinationSessionId === c.req.query("destinationSessionId"));
    const hit = ref && batonById(ref.destinationSessionId);
    if (!ref || !hit || !(await owned(ref.destinationSessionId))) return missing(c);
    return inDestination(ref.destinationSessionId, async () => {
      const view = await readView(hit.row, hit.dir);
      if (!view.items.some(i => i.kind === "tour" && i.handle === ref.handle)) return missing(c);
      // Any outstanding destination review predating this revocation must be reviewed afresh.
      invalidatePreviews(`baton:${ref.destinationSessionId}`);
      await writer.detach(sessionPathOf(hit.dir, hit.row), ref.handle);
      refreshShare(ref.destinationSessionId);
      return c.json({ ok: true });
    });
  });
  app.post(`${base}/binding-preview`, async c => {
    const input = await prepare(c);
    if (!input) return missing(c);
    const { dest, e } = input;
    if (tourSignedIn(e)) return locked(c);
    return inDestination(dest.row.sessionId, async () => {
      const out: { branch?: HEntry[] } = {};
      await readView(dest.row, dest.dir, undefined, undefined, out);
      const r = outsiderRedactor(dest.row.orgId, [dest.row.publicTitle, ...conversationVocabulary(out.branch ?? [])]);
      return c.json(previewFor(e, `baton:${dest.row.sessionId}`, t => r.said(r.redact(t))));
    });
  });
  app.post(`${base}/bindings`, async c => {
    const input = await prepare(c);
    if (!input) return missing(c);
    const { b, dest, e } = input;
    if (tourSignedIn(e)) return locked(c);
    if (typeof b.previewId !== "string") return missing(c);
    const previewId = b.previewId;
    return inDestination(dest.row.sessionId, async () => {
    const manifest = consumePreview(previewId, e.sessionId, e.manifest.id, e.manifest.editionId, `baton:${dest.row.sessionId}`);
    if (!manifest) return c.json({ error: "Review every picture and its text for this conversation again." }, 409);
    const assets = new Map<string, Uint8Array>();
    for (const file of manifest.assets) {
      const asset = readAsset(e.sessionId, e.manifest.id, e.manifest.editionId, file.file);
      if (!asset) return missing(c);
      assets.set(file.file, asset.bytes);
    }
    // Acquire before writing so a busy/refused chat cannot receive a phantom attachment.
    const destinationPath = sessionPathOf(dest.dir, dest.row);
    if (await writer.busy(destinationPath)) return c.json({ error: "Wait for this conversation to finish its reply, then review again." }, 409);
    // Acquisition awaits: a successful open must not publish stale authority.
    const stillCurrent = async () => {
      if (!(await owned(e.sessionId)) || !(await owned(dest.row.sessionId))) return false;
      const latestDestination = batonById(dest.row.sessionId);
      const latestSource = readEdition(e.sessionId, e.manifest.id, e.manifest.editionId);
      return !!latestDestination && latestDestination.dir === dest.dir && ["open", "needs-you"].includes(latestDestination.row.state) && (e.source.kind !== "project" || e.source.projectId === latestDestination.row.projectId) && !!latestSource && !tourSignedIn(latestSource) && digest(JSON.stringify(e)) === digest(JSON.stringify(latestSource));
    };
    if (!(await stillCurrent())) return missing(c);
    const snapshots = new TourBindings(dest.dir);
    if (!tourSnapshotFits(manifest)) return c.json({ error: "This checked tour is too large for an organization backup. Record a smaller tour, then review it again." }, 413);
    const attachment = snapshots.publish(dest.row.sessionId, manifest, assets);
    tourBindingIndex().add({ sessionId: e.sessionId, tourId: e.manifest.id, editionId: e.manifest.editionId, destinationSessionId: dest.row.sessionId, handle: attachment.handle });
    await writer.attach(destinationPath, attachment);
    refreshShare(dest.row.sessionId);
    return c.json({ handle: attachment.handle, title: attachment.title, summary: attachment.summary, steps: attachment.steps });
    });
  });
}
