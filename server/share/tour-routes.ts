import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { TOUR_LIMITS, type TourPresentation } from "../../shared/tour";
import { digest } from "../tours/assets";
import { readAsset } from "../tours/store";
import { tourShares, TOUR_VISIT_RECIPIENT, type TourShare } from "../tours/shares";
import { readVisitorLogging } from "../visitor-logging";
import { classify, recordOpen, recordShellFetch, type SessionVisitLink } from "../visits";
import { noteShareVisit } from "../visitor-identity";
import { redactShareLinks } from "../link-tokens";
import { serverRedactor } from "../overseer-redact";
import { tourProgress } from "../tours/progress";
import { RateLimiter } from "./rate-limit";
import { ensureAssetsCurrent } from "./registry-push";
import { shareDist } from "./share-dist";
import { tourImageTokenLimited, TourReadRateLimit } from "./tour-limits";

const readerCreates = new RateLimiter(12), positionWrites = new RateLimiter(120);
const MISSING = { error: "Tour not found.", code: "not-found" };
const SAME = (a: TourShare, b: TourShare | null) => !!b && a.id === b.id && a.hash === b.hash && a.manifestDigest === b.manifestDigest && a.editionId === b.editionId && a.publicEdition === b.publicEdition;
export interface TourShareSource {
  access(token: string): TourShare | null | Promise<TourShare | null>;
  /** The edition was recorded signed in (§app.tours/sharing): checked after membership, before any rate or byte I/O. */
  locked?(link: TourShare): boolean | Promise<boolean>;
  manifest(link: TourShare): TourPresentation | null | Promise<TourPresentation | null>;
  asset(link: TourShare, file: string): { bytes: Buffer; mime: string } | null | Promise<{ bytes: Buffer; mime: string } | null>;
}
const source: TourShareSource = {
  access: async token => {
    const link = tourShares().access(token);
    if (!link) return null;
    const { tourSessionOwned } = await import("../tour-routes");
    if (!await tourSessionOwned(link.sessionId)) return null;
    const current = tourShares().access(token);
    return SAME(link, current) ? current : null;
  },
  locked: link => tourShares().locked(link),
  manifest: link => tourShares().manifest(link),
  asset: (link, file) => readAsset(link.sessionId, link.tourId, link.editionId, file),
};
/** A tour link's visits: opt-in only (§mesh.public/visitor-log), keyed by the link, never by a reader. */
const visitLinkOf = (link: TourShare): SessionVisitLink => ({ via: "session", shareId: link.id, recipientId: TOUR_VISIT_RECIPIENT });
function logTourVisit(fn: () => void): void {
  if (!readVisitorLogging().logVisitors) return;
  try { fn(); } catch { console.warn("[tours] Visitor logging could not be completed."); }
}
/** Auth and inventory before I/O/rate accounting, then re-authorize after every asynchronous read. */
export async function sharedTourResource(token: string, file?: string, from: TourShareSource = source, beforeRead?: () => void): Promise<TourPresentation | { bytes: Buffer; mime: string } | null> {
  const link = await from.access(token);
  if (!link || (file !== undefined && !link.files.includes(file))) return null;
  if (await from.locked?.(link)) return null;
  beforeRead?.();
  const manifest = await from.manifest(link);
  if (!manifest || !SAME(link, await from.access(token)) || manifest.id !== link.publicId || manifest.editionId !== link.publicEdition) return null;
  if (file === undefined) return manifest;
  const asset = manifest.assets.find(a => a.file === file);
  if (!asset) return null;
  const data = await from.asset(link, file);
  return data && data.mime === asset.mime && data.bytes.length === asset.bytes && data.bytes.length <= TOUR_LIMITS.assetBytes && digest(data.bytes) === asset.sha256 && SAME(link, await from.access(token)) ? data : null;
}
export function mountPublicTourRoutes(app: Hono, pageCsp: string): void {
  app.get("/t/:token", async c => {
    await ensureAssetsCurrent();
    const page = join(shareDist(), "index.html");
    const ua = c.req.header("user-agent");
    // A link previewer never runs the page's API call; its shell fetch is its whole visit (as /s/).
    if (existsSync(page) && classify(ua).kind === "preview" && readVisitorLogging().logVisitors) {
      const link = await source.access(c.req.param("token"));
      if (link) logTourVisit(() => { recordShellFetch(visitLinkOf(link), ua); });
    }
    return existsSync(page) ? c.body(readFileSync(page, "utf8"), 200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": pageCsp }) : c.text("The share page is not built on this host.", 503);
  });
  app.get("/api/t/:token", async c => {
    const token = c.req.param("token"), manifest = await sharedTourResource(token);
    if (!manifest || !("steps" in manifest)) return c.json(MISSING, 404);
    const current = await source.access(token);
    if (!current || manifest.id !== current.publicId || manifest.editionId !== current.publicEdition) return c.json(MISSING, 404);
    // Opt-in only, and only after current source/link/edition admission. Resume routes never log visits.
    logTourVisit(() => {
      const redact = (text: string) => serverRedactor().redact(redactShareLinks(text));
      noteShareVisit(recordOpen(visitLinkOf(current), { tab: c.req.query("v"), userAgent: c.req.header("user-agent") }), c.env, redact);
    });
    return c.json(manifest);
  });
  app.get("/api/t/:token/assets/:file", async c => {
    const token = c.req.param("token");
    try {
      const data = await sharedTourResource(token, c.req.param("file"), source, () => { if (tourImageTokenLimited("t", token)) throw new TourReadRateLimit(); });
      return data && "bytes" in data ? c.body(new Uint8Array(data.bytes), 200, { "Content-Type": data.mime, "Content-Security-Policy": "default-src 'none'; sandbox" }) : c.json(MISSING, 404);
    } catch (error) { if (error instanceof TourReadRateLimit) return c.json({ error: error.message }, 429); throw error; }
  });
  app.post("/api/t/:token/readers", async c => {
    const token = c.req.param("token"), link = await source.access(token);
    if (!link) return c.json(MISSING, 404);
    if (readerCreates.limited(link.hash)) return c.json({ error: "Too many resume links. Wait a minute, then try again." }, 429);
    try {
      const reader = tourProgress().createReader(link.hash);
      if (!SAME(link, await source.access(token))) return c.json(MISSING, 404);
      return c.json({ reader, resumeUrl: `/t/${token}?reader=${reader}` }, 201);
    } catch { return c.json({ error: "A resume link could not be made. Try again later." }, 409); }
  });
  app.get("/api/t/:token/progress", async c => {
    const token = c.req.param("token"), link = await source.access(token);
    const scope = link ? tourProgress().readerScope(link.hash, c.req.query("reader") ?? "") : null;
    if (!link || !scope) return c.json(MISSING, 404);
    const manifest = await sharedTourResource(token);
    if (!manifest || !("steps" in manifest) || !SAME(link, await source.access(token))) return c.json(MISSING, 404);
    return c.json(tourProgress().get(scope, manifest));
  });
  app.put("/api/t/:token/progress", bodyLimit({ maxSize: 2048 }), async c => {
    const token = c.req.param("token"), link = await source.access(token);
    const scope = link ? tourProgress().readerScope(link.hash, c.req.query("reader") ?? "") : null;
    if (!link || !scope) return c.json(MISSING, 404);
    if (positionWrites.limited(scope)) return c.json({ error: "Too many position updates. Wait a minute, then try again." }, 429);
    try {
      const body: unknown = await c.req.json(), manifest = await sharedTourResource(token);
      if (!manifest || !("steps" in manifest) || !SAME(link, await source.access(token))) return c.json(MISSING, 404);
      return c.json(tourProgress().put(scope, manifest, body));
    } catch { return c.json({ error: "Choose a recorded step, view and picture size.", code: "bad-position" }, 400); }
  });
}
