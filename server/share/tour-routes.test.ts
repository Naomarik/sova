import assert from "node:assert/strict";
import { test } from "node:test";
import { projectTourPublic } from "../../shared/tour";
import { tourEditionAssetsFixture, tourEditionFixture, tourManifestFixture, tourPngFixture } from "../../shared/tour-fixtures";
import { sharedTourResource, type TourShareSource } from "./tour-routes";
import { type TourShare } from "../tours/shares";
import { digest } from "../tours/assets";
import { TourShares } from "../tours/shares";
import { TourStore } from "../tours/store";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture() {
  const manifest = projectTourPublic(tourManifestFixture(), { id: "opaque-tour", editionId: "opaque-edition" });
  const link: TourShare = { id: "ts_0123456789abcdef01234567", hash: digest("token"), sessionId: "private-session", tourId: "private-tour", editionId: "private-edition", publicId: manifest.id, publicEdition: manifest.editionId, manifestDigest: digest(JSON.stringify(manifest)), files: manifest.assets.map(a => a.file), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  let allowed = true, snapshotReads = 0, assetReads = 0;
  const source: TourShareSource = { access: () => allowed ? link : null, manifest: () => { snapshotReads++; return manifest; }, asset: () => { assetReads++; return { bytes: Buffer.from(tourPngFixture()), mime: "image/png" }; } };
  return { manifest, link, source, revoke: () => { allowed = false; }, counts: () => ({ snapshotReads, assetReads }) };
}
test("unauthorized and guessed-file requests do no tour I/O, authorized bytes authenticate edition inventory", async () => {
  const f = fixture();
  for (const file of ["guessed.png", "../desktop.png", "contact-sheet.png", "other-edition.png"]) assert.equal(await sharedTourResource("token", file, f.source), null);
  assert.deepEqual(f.counts(), { snapshotReads: 0, assetReads: 0 });
  assert.ok(await sharedTourResource("token", "desktop.png", f.source));
  assert.deepEqual(f.counts(), { snapshotReads: 1, assetReads: 1 });
  f.revoke(); assert.equal(await sharedTourResource("token", undefined, f.source), null); assert.equal(await sharedTourResource("token", "desktop.png", f.source), null);
  assert.deepEqual(f.counts(), { snapshotReads: 1, assetReads: 1 });
});
test("expiry/revocation while either async read is pending returns no manifest or picture", async () => {
  const f = fixture(); f.source.manifest = async () => { await Promise.resolve(); f.revoke(); return f.manifest; };
  assert.equal(await sharedTourResource("token", undefined, f.source), null);
  const b = fixture(); b.source.asset = async () => { await Promise.resolve(); b.revoke(); return { bytes: Buffer.from(tourPngFixture()), mime: "image/png" }; };
  assert.equal(await sharedTourResource("token", "desktop.png", b.source), null);
});
test("real hash authority rejects unknown, expired and revoked tokens before snapshot/asset I/O, including async expiry", async () => {
  const root = mkdtempSync(join(tmpdir(), "tour-real-authority-"));
  try {
    const store = new TourStore(join(root, "tours")), e = tourEditionFixture(), assets = tourEditionAssetsFixture(); store.publishEdition(e, assets);
    const shares = new TourShares(root, store), start = Date.now(); let now = start;
    const preview = shares.previewFor(e, "public", undefined, now), expiry = now + 60_000;
    const made = shares.create(e.sessionId, e.manifest.id, e.manifest.editionId, preview.previewId, new Date(expiry).toISOString(), now);
    let snapshots = 0, pictures = 0;
    const actual: TourShareSource = { access: token => shares.access(token, now), manifest: link => { snapshots++; return shares.manifest(link); }, asset: (link, file) => { pictures++; return store.readAsset(link.sessionId, link.tourId, link.editionId, file); } };
    assert.equal(await sharedTourResource("z".repeat(43), "desktop.png", actual), null); assert.equal(await sharedTourResource(made.token, "guessed.png", actual), null);
    assert.deepEqual({ snapshots, pictures }, { snapshots: 0, pictures: 0 });
    const manifest = await sharedTourResource(made.token, undefined, actual); assert.ok(manifest && "steps" in manifest);
    const oldBytes = assets.get("desktop.png")!;
    const newer = structuredClone(e); newer.manifest.editionId = "new-edition";
    const changed = Buffer.concat([oldBytes, Buffer.from([0])]), inventory = newer.manifest.assets.find(a => a.file === "desktop.png")!; inventory.bytes = changed.length; inventory.sha256 = digest(changed);
    store.publishEdition(newer, new Map(assets).set("desktop.png", changed));
    const pinned = await sharedTourResource(made.token, "desktop.png", actual); assert.ok(pinned && "bytes" in pinned); assert.deepEqual(pinned.bytes, Buffer.from(oldBytes), "new latest edition has distinct bytes and cannot replace pinned share");
    snapshots = pictures = 0; now = expiry;
    assert.equal(await sharedTourResource(made.token, "desktop.png", actual), null); assert.deepEqual({ snapshots, pictures }, { snapshots: 0, pictures: 0 }, "exact expiry boundary rejects before both I/O seams");
    now = start;
    actual.manifest = async link => { snapshots++; const m = shares.manifest(link); await Promise.resolve(); now = expiry; return m; };
    assert.equal(await sharedTourResource(made.token, "desktop.png", actual), null); assert.equal(pictures, 0, "expiry while snapshot pending blocks the later asset read");
    now = start; actual.manifest = link => { snapshots++; return shares.manifest(link); };
    actual.asset = async (link, file) => { pictures++; const result = store.readAsset(link.sessionId, link.tourId, link.editionId, file); await Promise.resolve(); shares.revoke(e.sessionId, e.manifest.id, e.manifest.editionId, made.link.id, now); return result; };
    assert.equal(await sharedTourResource(made.token, "desktop.png", actual), null, "revocation during actual asset read returns no bytes");
    snapshots = pictures = 0; assert.equal(await sharedTourResource(made.token, undefined, actual), null); assert.equal(await sharedTourResource(made.token, "desktop.png", actual), null); assert.deepEqual({ snapshots, pictures }, { snapshots: 0, pictures: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("cross-edition manifest, mismatched bytes and wrong MIME are refused", async () => {
  const f = fixture(); f.source.manifest = () => ({ ...f.manifest, editionId: "other-edition" });
  assert.equal(await sharedTourResource("token", "desktop.png", f.source), null); assert.equal(f.counts().assetReads, 0);
  const b = fixture(); b.source.asset = () => ({ bytes: Buffer.from("incomplete"), mime: "image/png" });
  assert.equal(await sharedTourResource("token", "desktop.png", b.source), null);
  const c = fixture(); c.source.asset = () => ({ bytes: Buffer.from(tourPngFixture()), mime: "text/html" });
  assert.equal(await sharedTourResource("token", "desktop.png", c.source), null);
});
