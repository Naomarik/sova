import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tourEditionAssetsFixture, tourEditionFixture } from "../../shared/tour-fixtures";
import { TourStore } from "./store";
import { digest } from "./assets";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tour-store-"));
  return { root, store: new TourStore(join(root, "store")), close: () => rmSync(root, { recursive: true, force: true }) };
}
test("publication is immutable and exact-edition reads never borrow another session or latest", () => {
  const f = fixture(); try {
    const e = tourEditionFixture(), assets = tourEditionAssetsFixture();
    f.store.publishEdition(e, assets);
    assert.deepEqual(f.store.readEdition(e.sessionId, e.manifest.id, e.manifest.editionId), e);
    assert.deepEqual(f.store.readAsset(e.sessionId, e.manifest.id, e.manifest.editionId, "desktop.png")?.bytes, Buffer.from(assets.get("desktop.png")!));
    assert.throws(() => f.store.publishEdition(e, assets), /immutable/);
    const newer = structuredClone(e); newer.manifest.editionId = "edition-next"; newer.manifest.title = "Changed";
    f.store.publishEdition(newer, assets);
    assert.equal(f.store.latestEdition(e.sessionId, e.manifest.id)?.manifest.editionId, "edition-next");
    assert.equal(f.store.readEdition(e.sessionId, e.manifest.id, e.manifest.editionId)?.manifest.title, e.manifest.title);
    for (const [s, t, ed, file] of [["other-session", e.manifest.id, e.manifest.editionId, "desktop.png"], [e.sessionId, "other-tour", e.manifest.editionId, "desktop.png"], [e.sessionId, e.manifest.id, "other-edition", "desktop.png"], [e.sessionId, e.manifest.id, e.manifest.editionId, "../desktop.png"], [e.sessionId, e.manifest.id, e.manifest.editionId, "guessed.png"]]) assert.equal(f.store.readAsset(s!, t!, ed!, file!), null);
  } finally { f.close(); }
});
test("partial, dishonest, wrong-size and extra inventories cannot replace the previous checked edition", () => {
  const f = fixture(); try {
    const e = tourEditionFixture(), assets = tourEditionAssetsFixture(); f.store.publishEdition(e, assets);
    const variants = [new Map([...assets].filter(([name]) => name !== "phone.png")), new Map([...assets, ["extra.png", assets.get("desktop.png")!] as const]), new Map(assets).set("desktop.png", Buffer.from("bad"))];
    for (const bytes of variants) { const next = structuredClone(e); next.manifest.editionId = "bad-edition"; assert.throws(() => f.store.publishEdition(next, bytes), /inventory|hashes/); }
    const wrong = structuredClone(e); wrong.manifest.editionId = "wrong-size";
    const png = Buffer.from(assets.get("desktop.png")!); png.writeUInt32BE(240, 16);
    const a = wrong.manifest.assets.find(a => a.file === "desktop.png")!; a.sha256 = digest(png);
    assert.throws(() => f.store.publishEdition(wrong, new Map(assets).set("desktop.png", png)), /dimensions/);
    const partial = structuredClone(e); partial.manifest.editionId = "partial"; delete partial.manifest.steps[0]!.views[0]!.captures.phone;
    assert.throws(() => f.store.publishEdition(partial, assets), /complete checked/);
    assert.equal(f.store.latestEdition(e.sessionId, e.manifest.id)?.manifest.editionId, e.manifest.editionId);
  } finally { f.close(); }
});
test("tampered bytes and final or ancestor symlinks are not served", () => {
  const f = fixture(); try {
    const e = tourEditionFixture(), assets = tourEditionAssetsFixture(); f.store.publishEdition(e, assets);
    const dir = join(f.store.root, e.sessionId, e.manifest.id, "editions", e.manifest.editionId), file = join(dir, "desktop.png");
    writeFileSync(file, Buffer.from("tampered"));
    assert.equal(f.store.readAsset(e.sessionId, e.manifest.id, e.manifest.editionId, "desktop.png"), null);
    rmSync(file); const external = join(f.root, "outside.png"); writeFileSync(external, assets.get("desktop.png")!); symlinkSync(external, file);
    assert.equal(f.store.readAsset(e.sessionId, e.manifest.id, e.manifest.editionId, "desktop.png"), null);
    const saved = readFileSync(join(dir, "edition.json")); rmSync(join(f.store.root, e.sessionId), { recursive: true });
    const outside = join(f.root, "outside"); mkdirSync(join(outside, e.manifest.id, "editions", e.manifest.editionId), { recursive: true }); writeFileSync(join(outside, e.manifest.id, "editions", e.manifest.editionId, "edition.json"), saved);
    symlinkSync(outside, join(f.store.root, e.sessionId));
    assert.equal(f.store.readEdition(e.sessionId, e.manifest.id, e.manifest.editionId), null);
    assert.throws(() => f.store.publishEdition(e, assets), /symlink/);
  } finally { f.close(); }
});
