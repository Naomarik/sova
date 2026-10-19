import assert from "node:assert/strict";
import { after, test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTourRouteFixture } from "./route-fixture.integration.fixture";

const f = await createTourRouteFixture();
after(() => f.close());

/** The signed-in lock (q9) through the real main app, auth gate and share listener, not a bare mount. */
test("the real app refuses a signed-in edition's share preview with the lock, and its existing link stops serving; the unflagged edition shares", async t => {
  const { publishEdition, tourStore, TourStore } = await import("./store");
  const { TourShares } = await import("./shares");
  let pictureReads = 0, snapshotReads = 0;
  const asset = TourStore.prototype.readAsset, snapshot = TourShares.prototype.manifest;
  t.mock.method(TourStore.prototype, "readAsset", function (this: InstanceType<typeof TourStore>, ...args: Parameters<typeof asset>) { pictureReads++; return asset.apply(this, args); });
  t.mock.method(TourShares.prototype, "manifest", function (this: InstanceType<typeof TourShares>, ...args: Parameters<typeof snapshot>) { snapshotReads++; return snapshot.apply(this, args); });
  const { tourEditionAssetsFixture } = await import("../../shared/tour-fixtures");
  const signed = structuredClone(f.sourceEdition); signed.manifest.id = "tour-signed-lock"; signed.provenance.signedIn = true;
  publishEdition(signed, tourEditionAssetsFixture());
  const base = (id: string, edition: string) => `/api/tours/${f.sid}/${id}/editions/${edition}`;
  const plain = base(f.sourceEdition.manifest.id, f.sourceEdition.manifest.editionId), locked = base(signed.manifest.id, signed.manifest.editionId);
  const post = (path: string, body?: unknown) => f.requestMain(path, { method: "POST", body });

  const refused = await post(`${locked}/share-preview`);
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.json<{ code: string }>().code, "signed-in-locked");
  assert.equal((await f.requestMain(`${locked}/binding-destinations`)).status, 409);

  // Control: the unflagged edition (a Basic test account records one like this) previews and links.
  const preview = await post(`${plain}/share-preview`); assert.equal(preview.status, 200, preview.text);
  const minted = await post(`${plain}/shares`, { previewId: preview.json<{ previewId: string }>().previewId, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal(minted.status, 201, minted.text);
  const token = new URL(minted.json<{ url: string }>().url, f.shareURL).pathname.split("/").pop()!;
  const reads = [`/api/t/${token}`, `/api/t/${token}/assets/desktop.png`];
  for (const path of reads) assert.equal((await f.requestShare(path)).status, 200, `control ${path}`);

  // Read time: the link's edition turns signed-in under it (a hand-written store), so the public listener serves nothing.
  const file = join(tourStore().root, f.sid, f.sourceEdition.manifest.id, "editions", f.sourceEdition.manifest.editionId, "edition.json");
  const original = readFileSync(file, "utf8"), flagged = JSON.parse(original); flagged.provenance.signedIn = true;
  writeFileSync(file, JSON.stringify(flagged));
  pictureReads = snapshotReads = 0;
  try {
    for (const path of reads) assert.equal((await f.requestShare(path)).status, 404, `locked ${path}`);
    assert.deepEqual({ pictureReads, snapshotReads }, { pictureReads: 0, snapshotReads: 0 }, "a locked valid member stops at the lock: no snapshot or picture read");
  }
  finally { writeFileSync(file, original); }
  assert.equal((await f.requestShare(reads[0]!)).status, 200, "the flag alone made the difference");
});
