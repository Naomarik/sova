import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { BatonView } from "../../shared/baton";
import type { TourAttachment, TourPresentation } from "../../shared/tour";
import { createTourRouteFixture } from "./route-fixture.integration.fixture";

test("real operator app binds a reviewed edition and real share listener exposes only authorized hand-off and owner cuts", async () => {
  const f = await createTourRouteFixture();
  try {
    const orgs = await import("../orgs"), baton = await import("../baton"), owner = await import("../owner"), handles = await import("../person-links"), links = await import("../baton-links");
    const { TourBindings } = await import("./bindings");
    const org = await orgs.createOrg({ name: "Example Tour Studio", dir: join(f.root, "organization") });
    const projectRoot = join(f.root, "example-project"); mkdirSync(projectRoot);
    const project = await orgs.addProject(org.id, { name: "Example interface", root: projectRoot });
    const person = await orgs.addPerson(org.id, { name: "Ada Example", role: "Reviewer" });
    const other = await orgs.addPerson(org.id, { name: "Bea Example", role: "Reviewer" });
    await owner.setOwner(org.id, person.id);
    const destination = await baton.createBaton({ orgId: org.id, projectId: project.id, to: person.id, publicTitle: "Review the example interface", goal: "Explain the draft" });
    const second = await baton.createBaton({ orgId: org.id, projectId: project.id, to: other.id, publicTitle: "Another conversation", goal: "Review" });
    const edition = f.sourceEdition.manifest;
    const base = `/api/tours/${f.sid}/${edition.id}/editions/${edition.editionId}`;
    const post = (suffix: string, body: unknown, auth = true) => f.requestMain(`${base}/${suffix}`, { method: "POST", body, auth });
    // Real sockets, not app.request: the actual main-listener auth gate sees connection/header facts.
    assert.equal((await post("binding-preview", { destinationSessionId: destination.sessionId }, false)).status, 401);
    assert.equal((await post("bindings", { destinationSessionId: destination.sessionId, previewId: "guessed" }, false)).status, 401);
    const previewReply = await post("binding-preview", { destinationSessionId: destination.sessionId });
    assert.equal(previewReply.status, 200, previewReply.text);
    const preview = previewReply.json<{ previewId: string; manifest: TourPresentation }>();
    assert.ok(preview.previewId);
    assert.equal((await post("bindings", { destinationSessionId: second.sessionId, previewId: preview.previewId })).status, 409, "a different destination cannot borrow this review");
    const attached = await post("bindings", { destinationSessionId: destination.sessionId, previewId: preview.previewId });
    assert.equal(attached.status, 200, attached.text);
    const attachment = attached.json<Pick<TourAttachment, "handle">>();
    assert.ok(attachment.handle.startsWith("tr_"));
    assert.equal((await post("bindings", { destinationSessionId: destination.sessionId, previewId: preview.previewId })).status, 409);
    const hToken = baton.rotateLink(destination.sessionId).token, iToken = owner.ownerLinkFor(org.id).token;
    const conversation = handles.handleOf("k", destination.sessionId);
    const h = `/api/h/${hToken}/tours/${attachment.handle}`;
    const i = `/api/i/${iToken}/c/${conversation}/tours/${attachment.handle}`;
    const p = `/api/orgs/${org.id}/people/${person.id}/preview/tours/${destination.sessionId}/${attachment.handle}`;
    const o = `/api/orgs/${org.id}/owner/preview/c/${conversation}/tours/${attachment.handle}`;
    const filtered = await f.requestShare(`/api/h/${hToken}`);
    assert.equal(filtered.status, 200, filtered.text);
    assert.ok(filtered.json<BatonView>().items.some(item => item.kind === "tour" && item.handle === attachment.handle), "the DEFAULT binding writer appended neutral state to the actual conversation");
    let reads = 0, assetReads = 0;
    const originalRead = TourBindings.prototype.read, originalAsset = TourBindings.prototype.asset;
    TourBindings.prototype.read = function (...args) { reads++; return originalRead.apply(this, args); };
    TourBindings.prototype.asset = function (...args) { assetReads++; return originalAsset.apply(this, args); };
    try {
      for (const [path, request] of [[h, f.requestShare], [i, f.requestShare], [p, f.requestMain], [o, f.requestMain]] as const) {
        const response = await request(path); assert.equal(response.status, 200, `${path}: ${response.text}`);
        assert.equal(response.headers["cache-control"], "no-store"); assert.equal(response.headers["referrer-policy"], "no-referrer");
        const manifest = response.json<TourPresentation>();
        assert.ok(manifest.steps.length); assert.equal((manifest as unknown as Record<string, unknown>).source, undefined);
        assert.equal((manifest as unknown as Record<string, unknown>).check, undefined);
        for (const step of manifest.steps) for (const view of step.views) assert.equal(view.route, null);
        for (const picture of manifest.assets) {
          const image = await request(`${path}/assets/${picture.file}`); assert.equal(image.status, 200, image.text);
          assert.equal(image.headers["content-type"], "image/png"); assert.deepEqual([...image.bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        }
      }
      assert.ok(reads > 0 && assetReads > 0, "positive controls exercised the actual file seams");
      const denied = async (path: string, main = false, auth = true) => {
        reads = 0; assetReads = 0;
        const r = await (main ? f.requestMain(path, { auth }) : f.requestShare(path));
        assert.equal(r.status, main && !auth ? 401 : 404, `${path}: ${r.text}`);
        assert.equal(reads, 0, "denial precedes snapshot read"); assert.equal(assetReads, 0, "denial precedes image read");
      };
      await denied(p, true, false); await denied(o, true, false);
      await denied(p); await denied(o); await denied(`${base}/bindings`); await denied(`${base}/binding-destinations`);
      await denied(h, true); await denied(i, true);
      await denied(`${h}/assets/guessed.png`); await denied(`${i}/assets/contact-sheet.png`);
      await denied(`/api/i/${iToken}/c/${handles.handleOf("k", second.sessionId)}/tours/${attachment.handle}`);
      await baton.setHiddenFromOwner(destination.sessionId, true); await denied(i);
      await baton.setHiddenFromOwner(destination.sessionId, false);
      await orgs.patchPlacement(org.id, project.id, { ownerHidden: true }); await denied(i);
      await orgs.patchPlacement(org.id, project.id, { ownerHidden: false });
      owner.revokeOwnerLinks(org.id); await denied(i);
      const expiredI = owner.ownerLinkFor(org.id, {}, Date.now() - 100 * 86400_000).token;
      await denied(`/api/i/${expiredI}/c/${conversation}/tours/${attachment.handle}`);
      links.revokeLinks(link => link.sessionId === destination.sessionId); await denied(h);
      const expiredH = links.mintLink({ orgId: org.id, sessionId: destination.sessionId, personId: person.id, n: 1 }, Date.now() - 20 * 86400_000);
      await denied(`/api/h/${expiredH}/tours/${attachment.handle}`);
      const readOnlyToken = baton.rotateLink(destination.sessionId).token;
      await baton.takeBack(destination.sessionId);
      const notTheirTurn = await f.requestShare(`/api/h/${readOnlyToken}`);
      assert.equal(notTheirTurn.status, 200, notTheirTurn.text);
      assert.equal(notTheirTurn.json<BatonView>().viewer?.canWrite, false);
      const { readView } = await import("../share/hub");
      const before: { branch?: import("../../shared/harness").HEntry[] } = {};
      await readView(baton.batonById(destination.sessionId)!.row, orgs.orgDir(org.id), undefined, undefined, before);
      const refusedAsk = await f.requestShare(`/api/h/${readOnlyToken}/message`, { method: "POST", body: { text: "Explain this tour step in more detail." } });
      assert.equal(refusedAsk.status, 409, refusedAsk.text);
      const after: { branch?: import("../../shared/harness").HEntry[] } = {};
      await readView(baton.batonById(destination.sessionId)!.row, orgs.orgDir(org.id), undefined, undefined, after);
      assert.deepEqual(after.branch, before.branch, "a participant off-turn cannot submit Ask or coverage text to the conversation");
      // Real-app detach through the operator listener: auth gate first, then every reader loses it before file I/O.
      const detachPath = `${base}/bindings/${attachment.handle}?destinationSessionId=${encodeURIComponent(destination.sessionId)}`;
      assert.equal((await f.requestMain(detachPath, { method: "DELETE", auth: false })).status, 401);
      for (const path of [p, o]) assert.equal((await f.requestMain(path)).status, 200, `${path} still attached before the authorized detach`);
      const freshI = owner.ownerLinkFor(org.id).token, fi = `/api/i/${freshI}/c/${conversation}/tours/${attachment.handle}`;
      assert.equal((await f.requestShare(fi)).status, 200, "positive control: a current owner link reads it before detach");
      // The operator holds it after Take Back, so no new link can be rotated: the participant's live link reads it.
      const fh = `/api/h/${readOnlyToken}/tours/${attachment.handle}`;
      assert.equal((await f.requestShare(fh)).status, 200, "positive control: the participant's current link reads it before detach");
      const detached = await f.requestMain(detachPath, { method: "DELETE" });
      assert.equal(detached.status, 200, detached.text);
      await denied(p, true); await denied(o, true); await denied(fi); await denied(`${fi}/assets/${preview.manifest.assets[0]!.file}`);
      await denied(fh); await denied(`${fh}/assets/${preview.manifest.assets[0]!.file}`);
      const afterDetach = await f.requestShare(`/api/h/${readOnlyToken}`);
      assert.equal(afterDetach.status, 200, afterDetach.text);
      assert.ok(!afterDetach.json<BatonView>().items.some(item => item.kind === "tour"), "the participant's view drops the detached tour");
      assert.deepEqual((await f.requestMain(`${base}/bindings`)).json<unknown[]>(), [], "the operator's attachment list no longer offers it");
      assert.equal((await f.requestMain(detachPath, { method: "DELETE" })).status, 404, "a second detach of the same handle is missing, not a new write");
    } finally { TourBindings.prototype.read = originalRead; TourBindings.prototype.asset = originalAsset; }
  } finally { await f.close(); }
});
