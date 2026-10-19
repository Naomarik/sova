import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tourEditionAssetsFixture, tourEditionFixture } from "../../shared/tour-fixtures";
import { TourStore } from "./store";
import { TourShareError, TourShares } from "./shares";
import { TourProgressStore } from "./progress";
import { sharedTourResource, type TourShareSource } from "../share/tour-routes";
function setup() {
  const root = mkdtempSync(join(tmpdir(), "tour-share-")), store = new TourStore(join(root, "tours")), e = tourEditionFixture();
  store.publishEdition(e, tourEditionAssetsFixture());
  return { root, store, e, shares: new TourShares(root, store), close: () => rmSync(root, { recursive: true, force: true }) };
}
test("a link requires exact edition, audience and fresh one-use full preview", () => {
  const f = setup(); try {
    const { sessionId: s, manifest: m } = f.e, now = Date.now(), expiry = new Date(now + 60_000).toISOString();
    assert.throws(() => f.shares.create(s, m.id, m.editionId, "guessed", expiry, now), /Review every picture/);
    const p = f.shares.previewFor(f.e, "public", undefined, now);
    assert.equal(p.manifest.assets.length, 2, "only reviewed desktop+phone captures; no contact sheet");
    assert.equal(f.shares.consumePreview(p.previewId, "foreign-session", m.id, m.editionId, "public", now), null);
    assert.equal(f.shares.consumePreview(p.previewId, s, "foreign-tour", m.editionId, "public", now), null);
    assert.equal(f.shares.consumePreview(p.previewId, s, m.id, "wrong", "public", now), null);
    assert.equal(f.shares.consumePreview(p.previewId, s, m.id, m.editionId, "baton:other", now), null);
    const made = f.shares.create(s, m.id, m.editionId, p.previewId, expiry, now);
    assert.throws(() => f.shares.create(s, m.id, m.editionId, p.previewId, expiry, now), /Review every picture/);
    assert.ok(f.shares.access(made.token, now));
    assert.equal(f.shares.access(made.token, now + 60_000), null, "expiry equality is dead, not one millisecond later");
    assert.equal(f.shares.access("wrong"), null);
    const stored = readFileSync(join(f.root, "tour-shares.json"), "utf8");
    assert.equal(stored.includes(made.token), false, "authority is hash-only");
    assert.ok(stored.includes(made.link.hash));
    const stale = f.shares.previewFor(f.e, "public", undefined, now);
    assert.throws(() => f.shares.create(s, m.id, m.editionId, stale.previewId, new Date(now + 1_000_000).toISOString(), now + 600_000), /Review every picture/);
  } finally { f.close(); }
});
test("old links stay on the reviewed edition after a new publish and revoke checks exact scope", () => {
  const f = setup(); try {
    const now = Date.now(), m = f.e.manifest, p = f.shares.previewFor(f.e);
    const made = f.shares.create(f.e.sessionId, m.id, m.editionId, p.previewId, new Date(now + 60_000).toISOString());
    const next = structuredClone(f.e); next.manifest.editionId = "new-edition"; next.manifest.title = "New content"; f.store.publishEdition(next, tourEditionAssetsFixture());
    assert.equal(f.shares.access(made.token)?.editionId, m.editionId);
    assert.equal(f.shares.manifest(made.link)?.title, m.title);
    assert.equal(f.shares.revoke("another-session", m.id, m.editionId, made.link.id), false);
    assert.equal(f.shares.revoke(f.e.sessionId, m.id, next.manifest.editionId, made.link.id), false);
    assert.ok(f.shares.access(made.token));
    assert.equal(f.shares.revoke(f.e.sessionId, m.id, m.editionId, made.link.id), true);
    assert.equal(f.shares.access(made.token), null);
    const json = JSON.stringify(f.shares.manifest(made.link));
    for (const key of ["source", "provenance", "scriptDigest", "contactSheets", "check", "origin", "sessionId"]) assert.equal(json.includes(`\"${key}\"`), false, key);
    assert.equal(json.includes(f.e.provenance.origin), false);
    assert.ok(f.shares.manifest(made.link)?.steps.every(s => s.views.every(v => v.route === null)));
  } finally { f.close(); }
});
test("source digest changes, revoked handoff previews and malformed authority fail closed", () => {
  const f = setup(); try {
    const m = f.e.manifest, s = f.e.sessionId, now = Date.now(), p = f.shares.previewFor(f.e);
    const changed = structuredClone(f.e); changed.manifest.title = "Changed after review";
    writeFileSync(join(f.store.root, s, m.id, "editions", m.editionId, "edition.json"), JSON.stringify(changed));
    assert.throws(() => f.shares.create(s, m.id, m.editionId, p.previewId, new Date(now + 60_000).toISOString(), now), /Review every picture/);
    const baton = f.shares.previewFor(changed, "baton:destination");
    f.shares.invalidatePreviews("baton:destination");
    assert.equal(f.shares.consumePreview(baton.previewId, s, m.id, m.editionId, "baton:destination"), null, "pre-detach preview cannot rebind");
    const fresh = f.shares.previewFor(changed, "baton:destination");
    assert.ok(f.shares.consumePreview(fresh.previewId, s, m.id, m.editionId, "baton:destination"), "fresh review works");
    writeFileSync(join(f.root, "tour-shares.json"), "{bad JSON");
    assert.equal(f.shares.access("a".repeat(43)), null);
    const again = f.shares.previewFor(changed);
    assert.throws(() => f.shares.create(s, m.id, m.editionId, again.previewId, new Date(now + 60_000).toISOString()), /cannot be read/);
    assert.equal(readFileSync(join(f.root, "tour-shares.json"), "utf8"), "{bad JSON", "mutation cannot overwrite corrupt authority");
  } finally { f.close(); }
});
test("known recording addresses and phrase-secret copy are removed before review and retained sharing", () => {
  const f = setup(); try {
    const e = structuredClone(f.e); e.manifest.editionId = "private-copy"; e.manifest.summary = `Recorded ${e.source.kind === "site" ? e.source.origin : ""} in ${e.sessionId}: hidden phrase.`;
    f.store.publishEdition(e, tourEditionAssetsFixture());
    const p = f.shares.previewFor(e, "public", text => text.replace("hidden phrase", "[private]"));
    const made = f.shares.create(e.sessionId, e.manifest.id, e.manifest.editionId, p.previewId, new Date(Date.now() + 60_000).toISOString());
    const json = JSON.stringify(f.shares.manifest(made.link));
    for (const privateText of [e.provenance.origin, e.sessionId, "hidden phrase", e.manifest.editionId]) assert.equal(json.includes(privateText), false, privateText);
    assert.ok(json.includes("[private]")); assert.ok(json.includes("[recorded source]"));
  } finally { f.close(); }
});
test("actual deletion withdraws source links and every unused preview before source bytes, preserving unrelated chats", () => {
  const f = setup(); try {
    const e = f.e, second = structuredClone(e); second.sessionId = "another-chat"; f.store.publishEdition(second, tourEditionAssetsFixture());
    const make = (input: typeof e) => { const p = f.shares.previewFor(input); return f.shares.create(input.sessionId, input.manifest.id, input.manifest.editionId, p.previewId, new Date(Date.now() + 60_000).toISOString()); };
    const firstLink = make(e), otherLink = make(second);
    const unusedPublic = f.shares.previewFor(e), unusedBaton = f.shares.previewFor(e, "baton:destination");
    const progress = new TourProgressStore(join(f.root, "tour-progress")), reader = progress.createReader(firstLink.link.hash), scope = progress.readerScope(firstLink.link.hash, reader)!, manifest = f.shares.manifest(firstLink.link)!;
    progress.put(scope, manifest, { stepId: manifest.steps[0]!.id, viewId: manifest.steps[0]!.views[0]!.id, size: "phone" });
    f.shares.deleteSession(e.sessionId);
    assert.equal(f.shares.access(firstLink.token), null); assert.ok(f.shares.access(otherLink.token));
    assert.equal(f.shares.consumePreview(unusedPublic.previewId, e.sessionId, e.manifest.id, e.manifest.editionId), null);
    assert.equal(f.shares.consumePreview(unusedBaton.previewId, e.sessionId, e.manifest.id, e.manifest.editionId, "baton:destination"), null);
    assert.equal(existsSync(join(f.root, "tour-share-snapshots", `${firstLink.link.id}.json`)), false); assert.ok(f.shares.manifest(otherLink.link));
    assert.equal(progress.readerScope(firstLink.link.hash, reader), null); assert.equal(progress.get(scope, manifest), null);
    assert.ok(f.store.readEdition(e.sessionId, e.manifest.id, e.manifest.editionId), "withdrawal happens before source edition cleanup");
    f.store.deleteSession(e.sessionId); assert.equal(f.store.readEdition(e.sessionId, e.manifest.id, e.manifest.editionId), null); assert.ok(f.store.readEdition(second.sessionId, second.manifest.id, second.manifest.editionId));
    assert.throws(() => f.store.deleteSession(".."), /Invalid tour session/);
  } finally { f.close(); }
});
test("invalid expiries and tampered snapshot authority fail closed", () => {
  const f = setup(); try {
    const now = Date.now(), m = f.e.manifest, p = f.shares.previewFor(f.e);
    for (const expiry of ["invalid", new Date(now).toISOString(), new Date(now + 91 * 86400_000).toISOString()]) assert.throws(() => f.shares.create(f.e.sessionId, m.id, m.editionId, p.previewId, expiry, now), /expiry/);
    const made = f.shares.create(f.e.sessionId, m.id, m.editionId, p.previewId, new Date(now + 60_000).toISOString(), now);
    assert.equal(f.shares.manifest({ ...made.link, manifestDigest: "0".repeat(64) }), null);
    assert.equal(f.shares.manifest({ ...made.link, publicEdition: "other-edition" }), null);
    assert.equal(f.shares.manifest({ ...made.link, files: ["guessed.png"] }), null);
    f.shares.revokeSession(f.e.sessionId); assert.equal(f.shares.access(made.token), null);
    assert.ok(f.store.readEdition(f.e.sessionId, m.id, m.editionId), "archiving revokes access, never deletes retained edition bytes");
  } finally { f.close(); }
});
/** A form sign-in ran (q9). An edition recorded with a stored Basic test account carries no flag. */
function signedInSetup() {
  const f = setup(), signed = structuredClone(f.e);
  signed.manifest.id = "tour-signed"; signed.manifest.editionId = "edition-signed"; signed.provenance.signedIn = true;
  f.store.publishEdition(signed, tourEditionAssetsFixture());
  return { ...f, signed };
}
test("a signed-in edition can't be previewed or linked; the same tour unflagged (a Basic test account) still can", () => {
  const f = signedInSetup(); try {
    const now = Date.now(), expiry = new Date(now + 60_000).toISOString();
    assert.throws(() => f.shares.previewFor(f.signed, "public", undefined, now), (e: unknown) => e instanceof TourShareError && e.status === 409 && e.code === "signed-in-locked");
    assert.throws(() => f.shares.previewFor(f.signed, "baton:destination", undefined, now), (e: unknown) => e instanceof TourShareError && e.code === "signed-in-locked", "hand-off previews too");
    assert.throws(() => f.shares.create(f.signed.sessionId, f.signed.manifest.id, f.signed.manifest.editionId, "guessed", expiry, now), /Review every picture/);
    // Control: the unflagged edition previews and links.
    const p = f.shares.previewFor(f.e, "public", undefined, now);
    const made = f.shares.create(f.e.sessionId, f.e.manifest.id, f.e.manifest.editionId, p.previewId, expiry, now);
    assert.ok(f.shares.access(made.token, now));
  } finally { f.close(); }
});
test("a preview made before the flag was written can't be consumed after it", () => {
  const f = setup(); try {
    const { sessionId: s, manifest: m } = f.e, now = Date.now();
    const p = f.shares.previewFor(f.e, "public", undefined, now), b = f.shares.previewFor(f.e, "baton:destination", undefined, now);
    const flagged = structuredClone(f.e); flagged.provenance.signedIn = true;
    writeFileSync(join(f.store.root, s, m.id, "editions", m.editionId, "edition.json"), JSON.stringify(flagged));
    assert.throws(() => f.shares.create(s, m.id, m.editionId, p.previewId, new Date(now + 60_000).toISOString(), now), (e: unknown) => e instanceof TourShareError && e.code === "stale-preview");
    assert.equal(f.shares.consumePreview(b.previewId, s, m.id, m.editionId, "baton:destination", now), null);
  } finally { f.close(); }
});
test("read-time lock: a link row for a signed-in edition opens nothing, while an unflagged link keeps serving", () => {
  const f = setup(); try {
    const { sessionId: s, manifest: m } = f.e, now = Date.now();
    const made = f.shares.create(s, m.id, m.editionId, f.shares.previewFor(f.e, "public", undefined, now).previewId, new Date(now + 60_000).toISOString(), now);
    assert.ok(f.shares.manifest(made.link), "control: the unflagged link opens");
    assert.equal(f.shares.locked(made.link), false);
    // The edition record turns signed-in under an existing link (a hand-written or corrupted store).
    const flagged = structuredClone(f.e); flagged.provenance.signedIn = true;
    writeFileSync(join(f.store.root, s, m.id, "editions", m.editionId, "edition.json"), JSON.stringify(flagged));
    assert.equal(f.shares.locked(made.link), true);
    assert.equal(f.shares.manifest(made.link), null, "the snapshot's other readers (the Shares page) get nothing either");
  } finally { f.close(); }
});

test("/t order: token, row, membership, then the lock, then the rate bucket and bytes; a locked valid member reads no picture", async () => {
  const f = setup(); try {
    const { sessionId: s, manifest: m } = f.e, now = Date.now();
    const made = f.shares.create(s, m.id, m.editionId, f.shares.previewFor(f.e, "public", undefined, now).previewId, new Date(now + 3_600_000).toISOString(), now);
    let order: string[] = [], lockedNow = false;
    const from: TourShareSource = {
      access: token => { order.push("access"); return f.shares.access(token); },
      locked: link => { order.push("locked"); return lockedNow || f.shares.locked(link); },
      manifest: link => { order.push("manifest"); return f.shares.manifest(link); },
      asset: (link, file) => { order.push("asset"); return f.store.readAsset(link.sessionId, link.tourId, link.editionId, file); },
    };
    const bucket = () => { order.push("bucket"); };
    // Invalid member: refused on the row's own file list, before the lock (no edition read) or anything after it.
    assert.equal(await sharedTourResource(made.token, "guessed.png", from, bucket), null);
    assert.deepEqual(order, ["access"]);
    // Control: a valid member of an unlocked link runs the whole chain in order.
    order = [];
    const file = made.link.files[0]!;
    assert.ok(await sharedTourResource(made.token, file, from, bucket));
    assert.deepEqual(order.slice(0, 4), ["access", "locked", "bucket", "manifest"]);
    assert.ok(order.includes("asset"));
    // Locked, valid member: stops at the lock, before the rate bucket, the snapshot and the picture.
    order = []; lockedNow = true;
    assert.equal(await sharedTourResource(made.token, file, from, bucket), null);
    assert.deepEqual(order, ["access", "locked"]);
    order = [];
    assert.equal(await sharedTourResource(made.token, undefined, from, bucket), null, "the manifest read too");
    assert.deepEqual(order, ["access", "locked"]);
  } finally { f.close(); }
});
