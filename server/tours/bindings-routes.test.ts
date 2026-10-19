import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";
import { BATON_WRAPUP_ENTRY } from "../../shared/baton";
import { projectTourPublic, TOUR_ATTACHMENT_ENTRY, TOUR_DETACHMENT_ENTRY, type TourAttachment } from "../../shared/tour";
import { tourEditionAssetsFixture, tourManifestFixture } from "../../shared/tour-fixtures";
const root = mkdtempSync(join(tmpdir(), "sova-tour-scope-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
const orgs = await import("../orgs"), baton = await import("../baton"), owner = await import("../owner"), plinks = await import("../person-links"), links = await import("../baton-links");
const { TourBindings } = await import("./bindings");
const { mountBatonTourRoutes, mountTourPreviewRoutes, mountTourBindingRoutes } = await import("./bindings-routes");
const { resolveBatonTour, scopedTourRead, ownerTourAuthority, batonTourAuthority } = await import("./bindings-scope");
const { showBatonTourTool } = await import("./tools");
const { publishEdition, tourStore } = await import("./store");
const { TourProgressStore } = await import("./progress");
const { ownerReadTokenLimited, tourImageTokenLimited } = await import("../share/tour-limits");
const { tourEditionFixture } = await import("../../shared/tour-fixtures");
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;
function append(path: string, key: string, data: unknown) {
  const parentId = JSON.parse(readFileSync(path, "utf8").trim().split("\n").at(-1)!).id;
  appendFileSync(path, `${JSON.stringify({ type: "custom", id: `tour-fixture-${++seq}`, parentId, timestamp: new Date().toISOString(), customType: key, data })}\n`);
}

test("owner and outsider byte routes enforce real token + filtered conversation authority before ALL tour I/O", async () => {
  const org = await orgs.createOrg({ name: "Example Workshop", dir: join(root, "workspace") });
  mkdirSync(join(root, "project"));
  const project = await orgs.addProject(org.id, { name: "Example interface", root: join(root, "project") });
  const person = await orgs.addPerson(org.id, { name: "Ada Example", role: "Reviewer" });
  const other = await orgs.addPerson(org.id, { name: "Bea Example", role: "Reviewer" });
  await owner.setOwner(org.id, person.id);
  const conversation = await baton.createBaton({ orgId: org.id, projectId: project.id, to: person.id, publicTitle: "The interface", goal: "Review" });
  const second = await baton.createBaton({ orgId: org.id, projectId: project.id, to: other.id, publicTitle: "Another interface", goal: "Review" });
  const offered = await baton.createBaton({ orgId: org.id, projectId: project.id, to: [person.id, other.id], publicTitle: "Choose a view", question: "What matters?", goal: "Review" });
  const workspace = orgs.orgDir(org.id), store = new TourBindings(workspace);
  const m = projectTourPublic(tourManifestFixture(), { id: "reviewed", editionId: "checked" });
  const pictures = tourEditionAssetsFixture(); pictures.delete("contact-sheet.png");
  const attach = (path: string, session: string): TourAttachment => { const a = store.publish(session, m, pictures); append(path, TOUR_ATTACHMENT_ENTRY, a); return a; };
  const a = attach(conversation.path, conversation.sessionId);
  const otherManifest = structuredClone(m), otherPictures = new Map<string, Uint8Array>();
  for (const asset of otherManifest.assets) { const old = asset.file; asset.file = `other-${old}`; otherPictures.set(asset.file, pictures.get(old)!); }
  for (const step of otherManifest.steps) for (const view of step.views) for (const capture of Object.values(view.captures)) capture.image = `other-${capture.image}`;
  const b = store.publish(second.sessionId, otherManifest, otherPictures); append(second.path, TOUR_ATTACHMENT_ENTRY, b);
  const lateOffer = attach(offered.path, offered.sessionId);
  append(conversation.path, BATON_WRAPUP_ENTRY, { v: 1 });
  const late = attach(conversation.path, conversation.sessionId);
  const app = new Hono(); mountBatonTourRoutes(app); mountTourPreviewRoutes(app);
  const token = owner.ownerLinkFor(org.id).token;
  const ch = plinks.handleOf("k", conversation.sessionId), ch2 = plinks.handleOf("k", second.sessionId);
  const base = `/api/i/${token}/c/${ch}/tours/${a.handle}`;
  let snapshotReads = 0, assetReads = 0;
  const originalRead = TourBindings.prototype.read, originalAsset = TourBindings.prototype.asset;
  TourBindings.prototype.read = function (...args) { snapshotReads++; return originalRead.apply(this, args); };
  TourBindings.prototype.asset = function (...args) { assetReads++; return originalAsset.apply(this, args); };
  try {
    const ok = await app.request(base); assert.equal(ok.status, 200);
    const publicData = await ok.json(); assert.ok(publicData.steps.length); assert.equal(publicData.steps[0].views[0].route, null);
    assert.equal(publicData.source, undefined); assert.equal(publicData.check, undefined);
    assert.equal((await app.request(`${base}/assets/desktop.png`)).status, 200);
    assert.ok(snapshotReads > 0 && assetReads > 0, "positive control exercises actual snapshot and asset seams");
    const denied = async (url: string) => { snapshotReads = 0; assetReads = 0; const r = await app.request(url); assert.equal(r.status, 404, url); assert.deepEqual(await r.json(), { error: "Not found" }); assert.equal(snapshotReads, 0, url); assert.equal(assetReads, 0, url); };
    await denied(`/api/i/${token}/c/${ch2}/tours/${a.handle}`);
    await denied(`/api/i/${token}/c/${ch}/tours/${b.handle}`);
    await denied(`/api/i/${token}/c/${ch}/tours/${late.handle}`);
    await denied(`${base}/assets/guessed.png`);
    await denied(`${base}/assets/other-desktop.png`); // Exists in b's checked edition, not a's.
    await denied(`${base}/assets/contact-sheet.png`);
    await baton.setHiddenFromOwner(conversation.sessionId, true); await denied(base); await baton.setHiddenFromOwner(conversation.sessionId, false);
    await orgs.patchPlacement(org.id, project.id, { ownerHidden: true }); await denied(base); await orgs.patchPlacement(org.id, project.id, { ownerHidden: false });
    owner.revokeOwnerLinks(org.id); await denied(base);
    const expired = owner.ownerLinkFor(org.id, {}, Date.now() - 100 * 86400_000).token;
    await denied(`/api/i/${expired}/c/${ch}/tours/${a.handle}`);
    const handoff = baton.rotateLink(second.sessionId).token;
    const hb = `/api/h/${handoff}/tours/${b.handle}`;
    assert.equal((await app.request(hb)).status, 200);
    await denied(`/api/h/${handoff}/tours/${a.handle}`);
    await denied(`${hb}/assets/guessed.png`);
    links.revokeLinks(l => l.sessionId === second.sessionId); await denied(hb);
    const expiredH = links.mintLink({ orgId: org.id, sessionId: second.sessionId, n: 1, personId: other.id }, Date.now() - 20 * 86400_000);
    await denied(`/api/h/${expiredH}/tours/${b.handle}`);
    const offerToken = baton.rotateLink(offered.sessionId, person.id).token;
    await denied(`/api/h/${offerToken}/tours/${lateOffer.handle}`);
    await denied(`/api/orgs/${org.id}/people/${person.id}/preview/tours/${second.sessionId}/${b.handle}`);
    const tool = showBatonTourTool(handle => resolveBatonTour(conversation.sessionId, handle));
    const shown = await tool.execute("show", { handle: a.handle }, undefined, undefined, undefined);
    assert.equal((shown.details as { handle: string }).handle, a.handle);
    await assert.rejects(tool.execute("show", { handle: b.handle }, undefined, undefined, undefined), /not attached/);
    await assert.rejects(tool.execute("show", { handle: "tr_abcdefghijklmnop" }, undefined, undefined, undefined), /not attached/);
    append(conversation.path, TOUR_DETACHMENT_ENTRY, { v: 1, handle: a.handle }); // After wrap-up, still revokes authority.
    const renewed = owner.ownerLinkFor(org.id).token;
    await denied(`/api/i/${renewed}/c/${ch}/tours/${a.handle}`);
    await denied(`/api/i/${renewed}/c/${ch}/tours/${a.handle}/assets/desktop.png`);
    await denied(`/api/orgs/${org.id}/people/${person.id}/preview/tours/${conversation.sessionId}/${a.handle}`);
    await assert.rejects(tool.execute("show", { handle: a.handle }, undefined, undefined, undefined), /not attached/);
    const phraseOwner = owner.ownerLinkFor(org.id).token;
    const phraseRace = await scopedTourRead(ownerTourAuthority(phraseOwner, ch2, b.handle), undefined, dir => ({
      async read(session, attachment) {
        const value = new TourBindings(dir).read(session, attachment); assert.ok(value);
        await orgs.applyChange(org.id, person.id, { voice: m.title }, { kind: "operator" }); return value;
      },
      asset: (session, attachment, file) => new TourBindings(dir).asset(session, attachment, file),
    }));
    assert.ok(phraseRace && !("bytes" in phraseRace));
    assert.equal(phraseRace.title, "[redacted]", "a tightened real roster phrase rule applies after async snapshot read");
    const raceOwner = owner.ownerLinkFor(org.id).token;
    const ownerRace = await scopedTourRead(ownerTourAuthority(raceOwner, ch2, b.handle), "other-desktop.png", dir => ({
      read: (session, attachment) => new TourBindings(dir).read(session, attachment),
      async asset(session, attachment, file) {
        const value = new TourBindings(dir).asset(session, attachment, file);
        assert.ok(value, "race control really read the authorized asset");
        await Promise.resolve(); owner.revokeOwnerLinks(org.id); return value;
      },
    }));
    assert.equal(ownerRace, null, "real ownerAccess revocation after async read discards bytes");
    const progressToken = baton.rotateLink(second.sessionId).token;
    const request = new Request(`http://localhost/api/h/${progressToken}/tours/${b.handle}/progress`, { method: "PUT", body: JSON.stringify({ stepId: "find-draft", viewId: "overview", size: "desktop" }), headers: { "Content-Type": "application/json" } });
    const readText = request.text.bind(request);
    request.text = async () => { const body = await readText(); links.revokeLinks(l => l.sessionId === second.sessionId); return body; };
    const originalPut = TourProgressStore.prototype.put;
    let positionWrites = 0;
    TourProgressStore.prototype.put = function (...args) { positionWrites++; return originalPut.apply(this, args); };
    try { assert.equal((await app.request(request)).status, 404); assert.equal(positionWrites, 0, "revocation during async JSON parsing cannot mutate saved position"); }
    finally { TourProgressStore.prototype.put = originalPut; }
    const raceHandoff = baton.rotateLink(second.sessionId).token;
    const handoffRace = await scopedTourRead(batonTourAuthority(raceHandoff, b.handle), undefined, dir => ({
      async read(session, attachment) {
        const value = new TourBindings(dir).read(session, attachment);
        assert.ok(value); await Promise.resolve(); links.revokeLinks(l => l.sessionId === session); return value;
      },
      asset: (session, attachment, file) => new TourBindings(dir).asset(session, attachment, file),
    }));
    assert.equal(handoffRace, null, "real linkAccess revocation after async read discards manifest");
  } finally { TourBindings.prototype.read = originalRead; TourBindings.prototype.asset = originalAsset; }
});

test("authorized tour byte buckets refuse before I/O without turning missing or guessed assets into rate-limit oracles", async () => {
  const org = await orgs.createOrg({ name: "Example Limits", dir: join(root, "limited-workspace") });
  mkdirSync(join(root, "limited-project"));
  const project = await orgs.addProject(org.id, { name: "Example interface", root: join(root, "limited-project") });
  const person = await orgs.addPerson(org.id, { name: "Dee Example", role: "Reviewer" });
  await owner.setOwner(org.id, person.id);
  const conversation = await baton.createBaton({ orgId: org.id, projectId: project.id, to: person.id, publicTitle: "A bounded explanation", goal: "Understand" });
  const m = projectTourPublic(tourManifestFixture(), { id: "reviewed", editionId: "checked" });
  const pictures = tourEditionAssetsFixture(); pictures.delete("contact-sheet.png");
  const attachment = new TourBindings(orgs.orgDir(org.id)).publish(conversation.sessionId, m, pictures);
  append(conversation.path, TOUR_ATTACHMENT_ENTRY, attachment);
  const handoffToken = baton.rotateLink(conversation.sessionId).token, ownerToken = owner.ownerLinkFor(org.id).token;
  const h = `/api/h/${handoffToken}/tours/${attachment.handle}`;
  const i = `/api/i/${ownerToken}/c/${plinks.handleOf("k", conversation.sessionId)}/tours/${attachment.handle}`;
  const preview = `/api/orgs/${org.id}/people/${person.id}/preview/tours/${conversation.sessionId}/${attachment.handle}`;
  const app = new Hono(); mountBatonTourRoutes(app); mountTourPreviewRoutes(app);
  for (const base of [h, i, preview]) {
    const manifest = await app.request(base); assert.equal(manifest.status, 200);
    const image = await app.request(`${base}/assets/desktop.png`); assert.equal(image.status, 200);
    for (const response of [manifest, image]) {
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
      assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    }
    assert.equal(image.headers.get("Content-Security-Policy"), "default-src 'none'; sandbox");
    assert.equal(image.headers.get("Content-Type"), "image/png");
  }
  for (let n = 0; n < 240; n++) tourImageTokenLimited("h", handoffToken);
  for (let n = 0; n < 120; n++) { tourImageTokenLimited("i", ownerToken); ownerReadTokenLimited(ownerToken); }
  let reads = 0;
  const originalRead = TourBindings.prototype.read, originalAsset = TourBindings.prototype.asset;
  TourBindings.prototype.read = function (...args) { reads++; return originalRead.apply(this, args); };
  TourBindings.prototype.asset = function (...args) { reads++; return originalAsset.apply(this, args); };
  try {
    const noRead = async (url: string, status: number) => {
      reads = 0; const response = await app.request(url); assert.equal(response.status, status, url);
      assert.equal(reads, 0, "bucket or authorization refusal precedes every snapshot/asset read");
      if (status === 404) assert.deepEqual(await response.json(), { error: "Not found" });
    };
    await noRead(`${h}/assets/desktop.png`, 429);
    await noRead(`${i}/assets/desktop.png`, 429);
    await noRead(i, 429);
    for (const base of [h, i]) {
      await noRead(`${base}/assets/guessed.png`, 404);
      await noRead(`${base}/assets/contact-sheet.png`, 404);
      await noRead(base.replace(attachment.handle, "tr_abcdefghijklmnop"), 404);
    }
    assert.equal((await app.request(h)).status, 200, "picture exhaustion does not spend the hand-off manifest's allowance");
    assert.equal((await app.request(`${preview}/assets/desktop.png`)).status, 200, "operator preview does not borrow a public token bucket");
    links.revokeLinks(link => link.sessionId === conversation.sessionId);
    owner.revokeOwnerLinks(org.id);
    await noRead(`${h}/assets/desktop.png`, 404);
    await noRead(i, 404);
  } finally { TourBindings.prototype.read = originalRead; TourBindings.prototype.asset = originalAsset; }
});

test("operator binding is exact edition + destination reviewed; detach revokes bytes and all prior reviews before fresh reattach", async () => {
  const org = await orgs.createOrg({ name: "Example Review", dir: join(root, "binding-workspace") });
  mkdirSync(join(root, "binding-project"));
  const project = await orgs.addProject(org.id, { name: "Example app", root: join(root, "binding-project") });
  const person = await orgs.addPerson(org.id, { name: "Cy Example", role: "Reviewer" });
  await owner.setOwner(org.id, person.id);
  const first = await baton.createBaton({ orgId: org.id, projectId: project.id, to: person.id, publicTitle: "First review", goal: "Understand" });
  const second = await baton.createBaton({ orgId: org.id, projectId: project.id, to: person.id, publicTitle: "Second review", goal: "Understand" });
  const emptyTool = showBatonTourTool(handle => resolveBatonTour(first.sessionId, handle));
  await assert.rejects(emptyTool.execute("show", { handle: "tr_abcdefghijklmnop" }, undefined, undefined, undefined), /not attached/);
  const e = tourEditionFixture(); publishEdition(e, tourEditionAssetsFixture());
  const app = new Hono(); mountBatonTourRoutes(app);
  let beforeAcquire: () => Promise<void> = async () => {};
  mountTourBindingRoutes(app, async s => [e.sessionId, first.sessionId, second.sessionId].includes(s), {
    busy: async () => { await beforeAcquire(); return false; },
    attach: async (path, attachment) => append(path, TOUR_ATTACHMENT_ENTRY, attachment),
    detach: async (path, handle) => append(path, TOUR_DETACHMENT_ENTRY, { v: 1, handle }),
  });
  const base = `/api/tours/${e.sessionId}/${e.manifest.id}/editions/${e.manifest.editionId}`;
  const post = (path: string, body: unknown) => app.request(`${base}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post("bindings", { destinationSessionId: first.sessionId, previewId: "missing" })).status, 409);
  const destinations = await (await app.request(`${base}/binding-destinations`)).json();
  assert.ok(destinations.some((d: { sessionId: string }) => d.sessionId === first.sessionId));
  const preview = await (await post("binding-preview", { destinationSessionId: first.sessionId })).json();
  assert.equal((await post("bindings", { destinationSessionId: second.sessionId, previewId: preview.previewId })).status, 409, "a review for first cannot attach to second");
  const bound = await post("bindings", { destinationSessionId: first.sessionId, previewId: preview.previewId }); assert.equal(bound.status, 200);
  const a = await bound.json();
  assert.equal((await post("bindings", { destinationSessionId: first.sessionId, previewId: preview.previewId })).status, 409, "the approval is single-use");
  const token = baton.rotateLink(first.sessionId).token, ownerToken = owner.ownerLinkFor(org.id).token;
  const publicBase = `/api/h/${token}/tours/${a.handle}`, ownerBase = `/api/i/${ownerToken}/c/${plinks.handleOf("k", first.sessionId)}/tours/${a.handle}`;
  assert.equal((await app.request(publicBase)).status, 200); assert.equal((await app.request(ownerBase)).status, 200);
  const stale = await (await post("binding-preview", { destinationSessionId: first.sessionId })).json();
  const rows = await (await app.request(`${base}/bindings`)).json(); assert.ok(rows.some((r: { handle: string }) => r.handle === a.handle));
  assert.equal((await app.request(`${base}/bindings/${a.handle}?destinationSessionId=${first.sessionId}`, { method: "DELETE" })).status, 200);
  for (const path of [publicBase, `${publicBase}/assets/desktop.png`, ownerBase, `${ownerBase}/assets/desktop.png`]) assert.equal((await app.request(path)).status, 404, path);
  assert.deepEqual(await (await app.request(`${base}/bindings`)).json(), []);
  assert.equal((await post("bindings", { destinationSessionId: first.sessionId, previewId: stale.previewId })).status, 409, "pre-detach review cannot reattach");
  const fresh = await (await post("binding-preview", { destinationSessionId: first.sessionId })).json();
  const reattached = await post("bindings", { destinationSessionId: first.sessionId, previewId: fresh.previewId }); assert.equal(reattached.status, 200);
  const newHandle = (await reattached.json()).handle; assert.notEqual(newHandle, a.handle);
  assert.equal((await app.request(`/api/h/${token}/tours/${newHandle}`)).status, 200);
  assert.equal((await app.request(publicBase)).status, 404, "old detached handle never regains authority");
  const closing = await (await post("binding-preview", { destinationSessionId: second.sessionId })).json();
  beforeAcquire = async () => { await baton.closeBaton(second.sessionId); };
  const originalPublish = TourBindings.prototype.publish;
  let snapshotWrites = 0;
  TourBindings.prototype.publish = function (...args) { snapshotWrites++; return originalPublish.apply(this, args); };
  try {
    assert.equal((await post("bindings", { destinationSessionId: second.sessionId, previewId: closing.previewId })).status, 404);
    assert.equal(snapshotWrites, 0, "a destination closing during chat acquisition cannot receive a snapshot");
    beforeAcquire = async () => {};
    const deleting = await (await post("binding-preview", { destinationSessionId: first.sessionId })).json();
    beforeAcquire = async () => { rmSync(join(tourStore().root, e.sessionId), { recursive: true }); };
    assert.equal((await post("bindings", { destinationSessionId: first.sessionId, previewId: deleting.previewId })).status, 404);
    assert.equal(snapshotWrites, 0, "source deletion during chat acquisition cannot publish a late snapshot");
    assert.equal((await app.request(`/api/h/${token}/tours/${newHandle}`)).status, 200, "a previously approved destination snapshot survives source deletion");
  } finally { TourBindings.prototype.publish = originalPublish; }
});

test("a signed-in edition can't be sent to a hand-off, and its snapshot opens nothing; the unflagged edition (a Basic test account) still binds and serves", async () => {
  const org = await orgs.createOrg({ name: "Example Locks", dir: join(root, "lock-workspace") });
  mkdirSync(join(root, "lock-project"));
  const project = await orgs.addProject(org.id, { name: "Example lock app", root: join(root, "lock-project") });
  const person = await orgs.addPerson(org.id, { name: "Dee Example", role: "Reviewer" });
  await owner.setOwner(org.id, person.id);
  const dest = await baton.createBaton({ orgId: org.id, projectId: project.id, to: person.id, publicTitle: "Lock review", goal: "Understand" });
  const plain = tourEditionFixture(); plain.sessionId = "session-lock"; plain.manifest.id = "tour-plain"; publishEdition(plain, tourEditionAssetsFixture());
  const signed = structuredClone(plain); signed.manifest.id = "tour-signed"; signed.provenance.signedIn = true; publishEdition(signed, tourEditionAssetsFixture());
  let attaches = 0;
  const app = new Hono(); mountBatonTourRoutes(app);
  mountTourBindingRoutes(app, async s => [plain.sessionId, dest.sessionId].includes(s), {
    busy: async () => false,
    attach: async (path, attachment) => { attaches++; append(path, TOUR_ATTACHMENT_ENTRY, attachment); },
    detach: async (path, handle) => append(path, TOUR_DETACHMENT_ENTRY, { v: 1, handle }),
  });
  const base = (e: typeof plain) => `/api/tours/${e.sessionId}/${e.manifest.id}/editions/${e.manifest.editionId}`;
  const post = (e: typeof plain, path: string, body: unknown) => app.request(`${base(e)}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  // Mint time, signed in: every entry point refuses with the lock, and nothing is attached.
  const listed = await app.request(`${base(signed)}/binding-destinations`);
  assert.equal(listed.status, 409); assert.equal((await listed.json()).code, "signed-in-locked");
  const preview = await post(signed, "binding-preview", { destinationSessionId: dest.sessionId });
  assert.equal(preview.status, 409); assert.equal((await preview.json()).code, "signed-in-locked");
  const bind = await post(signed, "bindings", { destinationSessionId: dest.sessionId, previewId: "any" });
  assert.equal(bind.status, 409); assert.equal((await bind.json()).code, "signed-in-locked");
  assert.equal(attaches, 0);
  // Control, unflagged: listed, previewed, bound.
  assert.equal((await app.request(`${base(plain)}/binding-destinations`)).status, 200);
  const ok = await (await post(plain, "binding-preview", { destinationSessionId: dest.sessionId })).json();
  const bound = await post(plain, "bindings", { destinationSessionId: dest.sessionId, previewId: ok.previewId });
  assert.equal(bound.status, 200); assert.equal(attaches, 1);
  const { handle } = await bound.json() as { handle: string };
  const token = baton.rotateLink(dest.sessionId).token, ownerToken = owner.ownerLinkFor(org.id).token;
  const reads = [`/api/h/${token}/tours/${handle}`, `/api/h/${token}/tours/${handle}/assets/desktop.png`, `/api/i/${ownerToken}/c/${plinks.handleOf("k", dest.sessionId)}/tours/${handle}`];
  for (const path of reads) assert.equal((await app.request(path)).status, 200, `control ${path}`);
  assert.equal((await resolveBatonTour(dest.sessionId, handle)).handle, handle);
  // Read time: the indexed source edition turns signed-in under the existing snapshot (a hand-written store).
  const editionFile = join(tourStore().root, plain.sessionId, plain.manifest.id, "editions", plain.manifest.editionId, "edition.json");
  const original = readFileSync(editionFile, "utf8"), flagged = JSON.parse(original); flagged.provenance.signedIn = true;
  writeFileSync(editionFile, JSON.stringify(flagged));
  const { TourStore } = await import("./store");
  let editionReads = 0, snapshotReads = 0, pictureReads = 0;
  const readEditionOf = TourStore.prototype.readEdition, readOf = TourBindings.prototype.read, assetOf = TourBindings.prototype.asset;
  TourStore.prototype.readEdition = function (...args) { editionReads++; return readEditionOf.apply(this, args); };
  TourBindings.prototype.read = function (...args) { snapshotReads++; return readOf.apply(this, args); };
  TourBindings.prototype.asset = function (...args) { pictureReads++; return assetOf.apply(this, args); };
  try {
    // Membership first: a guessed picture of the locked snapshot is refused before the lock reads any edition.
    assert.equal((await app.request(`/api/h/${token}/tours/${handle}/assets/guessed.png`)).status, 404);
    assert.equal(editionReads, 0, "an invalid member reads no edition (membership runs before the lock)");
    // A valid member stops at the lock: the edition is read, the snapshot and picture are not.
    for (const path of reads) assert.equal((await app.request(path)).status, 404, `locked ${path}`);
    assert.ok(editionReads > 0, "the lock did read the source edition");
    assert.deepEqual({ snapshotReads, pictureReads }, { snapshotReads: 0, pictureReads: 0 });
  } finally { TourStore.prototype.readEdition = readEditionOf; TourBindings.prototype.read = readOf; TourBindings.prototype.asset = assetOf; }
  await assert.rejects(resolveBatonTour(dest.sessionId, handle), /not attached/, "the hand-off's agent doesn't see it either");
  writeFileSync(editionFile, original);
  assert.equal((await app.request(reads[0]!)).status, 200, "the flag alone made the difference");
});
