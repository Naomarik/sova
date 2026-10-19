import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isTourFile, isTourId, normalizeTourPresentation, type TourEdition, type TourPresentation } from "../../shared/tour";
import { dropTokens, keepTokens } from "../link-tokens";
import { shareLinksChanged } from "../share/links-events";
import { stateRoot } from "../state-root";
import { containedPath, digest, readBounded, writePrivate } from "./assets";
import { publicTour } from "./public-view";
import { TourProgressStore } from "./progress";
import { isTourSessionDeleted } from "./deleted";
import { isTourSession, TourStore, tourStore } from "./store";

export const TOUR_SHARES_FILE = "tour-shares.json";
/** Visit attribution is link-only and never uses the anonymous resume reader identity. */
export const TOUR_VISIT_RECIPIENT = "tour";
const TOKEN = /^[A-Za-z0-9_-]{43}$/, HASH = /^[a-f0-9]{64}$/, ID = /^ts_[a-f0-9]{24}$/;
const MAX_LINKS = 2000, MAX_EXPIRY = 90 * 86400_000, PREVIEW_MS = 10 * 60_000;
const opaque = () => randomBytes(12).toString("hex");
export interface TourShare {
  id: string; hash: string; sessionId: string; tourId: string; editionId: string;
  publicId: string; publicEdition: string; files: string[]; manifestDigest: string;
  createdAt: string; expiresAt: string; revokedAt?: string;
}
interface ShareFile { version: 1; links: TourShare[] }
interface Preview { root: string; session: string; tour: string; edition: string; audience: string; sourceDigest: string; manifest: TourPresentation; expiresAt: number }
const previews = new Map<string, Preview>();
export class TourShareError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 503, readonly code: string, message: string) { super(message); }
}
const missing = () => new TourShareError(404, "not-found", "Tour not found.");
export const TOUR_SIGNED_IN_LOCKED = "This tour was recorded signed in, so it stays in its chat. It can't be shared or sent to a hand-off.";
/** A form sign-in ran for this edition: it stays in its chat (no link, no hand-off). Basic test accounts never set it. */
export const tourSignedIn = (e: TourEdition | null | undefined): boolean => e?.provenance.signedIn === true;
export const signedInLocked = () => new TourShareError(409, "signed-in-locked", TOUR_SIGNED_IN_LOCKED);
function validRow(v: unknown): v is TourShare {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as TourShare;
  return Object.keys(r).every(k => ["id", "hash", "sessionId", "tourId", "editionId", "publicId", "publicEdition", "files", "manifestDigest", "createdAt", "expiresAt", "revokedAt"].includes(k)) && ID.test(r.id) && HASH.test(r.hash) && isTourSession(r.sessionId) && [r.tourId, r.editionId, r.publicId, r.publicEdition].every(isTourId) && Array.isArray(r.files) && r.files.length <= 672 && r.files.every(isTourFile) && new Set(r.files).size === r.files.length && HASH.test(r.manifestDigest) && [r.createdAt, r.expiresAt, ...(r.revokedAt !== undefined ? [r.revokedAt] : [])].every(d => typeof d === "string" && Number.isFinite(Date.parse(d)));
}
/** Hash-only bearer authority, immutable reviewed snapshots, host-local and never in org backups. */
export class TourShares {
  constructor(readonly root: string, readonly store: TourStore = tourStore()) {}
  private file(): string { return join(this.root, TOUR_SHARES_FILE); }
  private snapshot(id: string): string { if (!ID.test(id)) throw missing(); return join(this.root, "tour-share-snapshots", `${id}.json`); }
  private read(): ShareFile {
    if (!existsSync(this.file())) return { version: 1, links: [] };
    try {
      const bytes = readBounded(this.root, this.file(), 4 * 1024 * 1024);
      const v = bytes ? JSON.parse(bytes.toString("utf8")) : null;
      if (!v || v.version !== 1 || Object.keys(v).some(k => !["version", "links"].includes(k)) || !Array.isArray(v.links) || v.links.length > MAX_LINKS || !v.links.every(validRow) || new Set(v.links.map((l: TourShare) => l.hash)).size !== v.links.length || new Set(v.links.map((l: TourShare) => l.id)).size !== v.links.length) throw new Error();
      return v;
    } catch { throw new TourShareError(503, "store-unavailable", "Tour links cannot be read. Fix the host-local link store, then try again."); }
  }
  private write(v: ShareFile): void {
    const next = `${this.file()}-${opaque()}.tmp`;
    const json = JSON.stringify(v);
    if (Buffer.byteLength(json) > 4 * 1024 * 1024) throw new TourShareError(409, "too-many-links", "This host's tour link inventory is full. Revoke old links before creating another.");
    writePrivate(this.root, next, json);
    containedPath(this.root, this.file(), true);
    renameSync(next, this.file());
  }
  previewFor(e: TourEdition, audience = "public", phrase?: (text: string) => string, now = Date.now()): { previewId: string; manifest: TourPresentation; expiresAt: string } {
    const current = this.store.readEdition(e.sessionId, e.manifest.id, e.manifest.editionId);
    if (!current || digest(JSON.stringify(e)) !== digest(JSON.stringify(current))) throw missing();
    if (tourSignedIn(current)) throw signedInLocked();
    for (const [id, p] of previews) if (p.expiresAt <= now) previews.delete(id);
    if (previews.size >= 200) throw new TourShareError(409, "too-many-previews", "Too many tour previews. Wait for an older preview to expire.");
    const privateNames = [current.sessionId, current.manifest.id, current.manifest.editionId, current.provenance.origin, ...(current.provenance.publicOrigins ?? []), current.source.kind === "site" ? current.source.origin : current.source.checkout];
    const safeText = (text: string) => { for (const name of privateNames) if (name.length > 3) text = text.split(name).join("[recorded source]"); return phrase ? phrase(text) : text; };
    const previewId = randomBytes(24).toString("base64url"), manifest = publicTour(current.manifest, { id: `tour-${opaque()}`, editionId: `edition-${opaque()}` }, safeText);
    const expiresAt = now + PREVIEW_MS;
    previews.set(previewId, { root: this.root, session: e.sessionId, tour: e.manifest.id, edition: e.manifest.editionId, audience, sourceDigest: digest(JSON.stringify(current)), manifest, expiresAt });
    return { previewId, manifest: structuredClone(manifest), expiresAt: new Date(expiresAt).toISOString() };
  }
  consumePreview(id: string, session: string, tour: string, edition: string, audience = "public", now = Date.now()): TourPresentation | null {
    const p = previews.get(id);
    if (!p || p.root !== this.root || p.session !== session || p.tour !== tour || p.edition !== edition || p.audience !== audience || p.expiresAt <= now || isTourSessionDeleted(this.root, session)) return null;
    const e = this.store.readEdition(session, tour, edition);
    if (!e || digest(JSON.stringify(e)) !== p.sourceDigest || tourSignedIn(e)) return null;
    // Reviewing authorizes these exact text and picture hashes, not whatever a later preview would show.
    previews.delete(id);
    return structuredClone(p.manifest);
  }
  invalidatePreviews(audience: string): void {
    for (const [id, p] of previews) if (p.root === this.root && p.audience === audience) previews.delete(id);
  }
  create(session: string, tour: string, edition: string, previewId: string, expiresAt: string, now = Date.now()): { link: TourShare; token: string } {
    const expiry = typeof expiresAt === "string" ? Date.parse(expiresAt) : NaN;
    if (!Number.isFinite(expiry) || expiry <= now || expiry > now + MAX_EXPIRY) throw new TourShareError(400, "bad-expiry", "Choose an expiry within the next 90 days.");
    const file = this.read();
    if (file.links.length >= MAX_LINKS) throw new TourShareError(409, "too-many-links", "This host has too many tour links. Remove old links before creating another.");
    const manifest = this.consumePreview(previewId, session, tour, edition, "public", now);
    if (!manifest) throw new TourShareError(409, "stale-preview", "Review every picture and its text again before creating this link.");
    const token = randomBytes(32).toString("base64url"), hash = digest(token), id = `ts_${opaque()}`;
    const json = JSON.stringify(manifest);
    const link: TourShare = { id, hash, sessionId: session, tourId: tour, editionId: edition, publicId: manifest.id, publicEdition: manifest.editionId, files: manifest.assets.map(a => a.file), manifestDigest: digest(json), createdAt: new Date(now).toISOString(), expiresAt: new Date(expiry).toISOString() };
    writePrivate(this.root, this.snapshot(id), json);
    file.links.push(link); this.write(file);
    keepTokens("t", [token]); shareLinksChanged({ kind: "t", cause: "mint", hashes: [hash] });
    return { link, token };
  }
  access(token: string, now = Date.now()): TourShare | null {
    if (!TOKEN.test(token)) return null;
    try { const hash = digest(token); return this.read().links.find(l => !l.revokedAt && Date.parse(l.expiresAt) > now && !isTourSessionDeleted(this.root, l.sessionId) && timingSafeEqual(Buffer.from(l.hash, "hex"), Buffer.from(hash, "hex"))) ?? null; }
    catch { return null; }
  }
  /** Read-time lock: a link to a signed-in edition opens nothing, however its row came to exist. Public
      reads ask after the token and membership checks and before any rate or byte I/O (sharedTourResource). */
  locked(link: TourShare): boolean { return tourSignedIn(this.store.readEdition(link.sessionId, link.tourId, link.editionId)); }
  manifest(link: TourShare): TourPresentation | null {
    // The same lock again, for every other reader of a link's snapshot (the Shares page).
    if (this.locked(link)) return null;
    const bytes = readBounded(this.root, this.snapshot(link.id), 2 * 1024 * 1024);
    if (!bytes || digest(bytes) !== link.manifestDigest) return null;
    try {
      const m = normalizeTourPresentation(JSON.parse(bytes.toString("utf8")));
      return m && m.id === link.publicId && m.editionId === link.publicEdition && JSON.stringify(m.assets.map(a => a.file)) === JSON.stringify(link.files) ? m : null;
    } catch { return null; }
  }
  revoke(session: string, tour: string, edition: string, id: string, now = Date.now()): boolean {
    const file = this.read(), l = file.links.find(l => l.id === id && l.sessionId === session && l.tourId === tour && l.editionId === edition);
    if (!l) return false;
    l.revokedAt = new Date(now).toISOString(); this.write(file); dropTokens([l.hash]); shareLinksChanged({ kind: "t", cause: "revoke" }); return true;
  }
  /** Live links (not revoked, unexpired, source not deleted), for the operator's Shares page only. */
  liveLinks(now = Date.now()): TourShare[] {
    return this.read().links.filter(l => !l.revokedAt && Date.parse(l.expiresAt) > now && !isTourSessionDeleted(this.root, l.sessionId)).map(l => ({ ...l, files: [...l.files] }));
  }
  sessions(): string[] { return [...new Set(this.read().links.map(l => l.sessionId))]; }
  deleteSession(session: string): void {
    if (!isTourSession(session)) throw new Error("Invalid tour session.");
    for (const [id, p] of previews) if (p.root === this.root && p.session === session) previews.delete(id);
    const file = this.read(), rows = file.links.filter(l => l.sessionId === session);
    if (!rows.length) return;
    // Keep revoked inventory until cleanup succeeds, so a later sweep can retry leftover files.
    for (const row of rows) row.revokedAt ??= new Date().toISOString();
    this.write(file);
    dropTokens(rows.map(l => l.hash)); shareLinksChanged({ kind: "t", cause: "revoke" });
    for (const row of rows) {
      const path = this.snapshot(row.id); containedPath(this.root, path, true); rmSync(path, { force: true });
      new TourProgressStore(join(this.root, "tour-progress")).deleteShareReaders(row.hash);
    }
    file.links = file.links.filter(l => l.sessionId !== session); this.write(file);
  }
  revokeSession(session: string, now = Date.now()): void {
    const file = this.read(), rows = file.links.filter(l => l.sessionId === session && !l.revokedAt);
    if (!rows.length) return;
    for (const l of rows) l.revokedAt = new Date(now).toISOString();
    this.write(file); dropTokens(rows.map(l => l.hash)); shareLinksChanged({ kind: "t", cause: "revoke" });
  }
}
export const tourShares = () => new TourShares(stateRoot());
export const previewFor = (e: TourEdition, audience = "public", phrase?: (text: string) => string) => tourShares().previewFor(e, audience, phrase);
export const consumePreview = (id: string, s: string, t: string, e: string, audience = "public") => tourShares().consumePreview(id, s, t, e, audience);
export const findTourShare = (token: string) => tourShares().access(token);
export const invalidatePreviews = (audience: string): void => tourShares().invalidatePreviews(audience);
export const deleteTourShares = (session: string): void => tourShares().deleteSession(session);
