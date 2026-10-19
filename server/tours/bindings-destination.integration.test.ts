import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import type { BatonView } from "../../shared/baton";
import type { HEntry } from "../../shared/harness";
import { createTourRouteFixture } from "./route-fixture.integration.fixture";

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

test("after the source chat is deleted, the operator detaches by conversation: every reader 404s, and a corrupt snapshot no longer wedges the backup", async () => {
  const f = await createTourRouteFixture();
  try {
    const orgs = await import("../orgs"), baton = await import("../baton"), owner = await import("../owner"), handles = await import("../person-links");
    const { commitAll } = await import("../workspace-git");
    const { closeChat } = await import("../chat-handle");
    const { readView } = await import("../share/hub");
    const { TourBindings } = await import("./bindings");
    const { markTourSessionDeleted } = await import("./deleted");
    const workspace = join(f.root, "organization");
    const org = await orgs.createOrg({ name: "Example Detach Studio", dir: workspace });
    const other = await orgs.createOrg({ name: "Another Example Studio", dir: join(f.root, "other-organization") });
    const projectRoot = join(f.root, "example-project"); mkdirSync(projectRoot);
    const project = await orgs.addProject(org.id, { name: "Example interface", root: projectRoot });
    const person = await orgs.addPerson(org.id, { name: "Ada Example", role: "Reviewer" });
    await owner.setOwner(org.id, person.id);
    const destination = await baton.createBaton({ orgId: org.id, projectId: project.id, to: person.id, publicTitle: "Review the example interface", goal: "Explain the draft" });
    const e = f.sourceEdition.manifest, source = `/api/tours/${f.sid}/${e.id}/editions/${e.editionId}`, body = { destinationSessionId: destination.sessionId };
    const review = await f.requestMain(`${source}/binding-preview`, { method: "POST", body }); assert.equal(review.status, 200, review.text);
    const attached = await f.requestMain(`${source}/bindings`, { method: "POST", body: { ...body, previewId: review.json<{ previewId: string }>().previewId } });
    assert.equal(attached.status, 200, attached.text);
    const handle = attached.json<{ handle: string }>().handle;

    const hToken = baton.rotateLink(destination.sessionId).token, iToken = owner.ownerLinkFor(org.id).token, conversation = handles.handleOf("k", destination.sessionId);
    const h = `/api/h/${hToken}/tours/${handle}`, i = `/api/i/${iToken}/c/${conversation}/tours/${handle}`;
    const p = `/api/orgs/${org.id}/people/${person.id}/preview/tours/${destination.sessionId}/${handle}`, o = `/api/orgs/${org.id}/owner/preview/c/${conversation}/tours/${handle}`;
    const list = `/api/orgs/${org.id}/conversations/${destination.sessionId}/tours`, detach = `${list}/${handle}`;

    // The first backup carries the snapshot; then its bytes go bad on disk.
    const first = await commitAll(workspace, "Back up an attached tour"); assert.equal(first.error, undefined, first.error);
    const branch: { branch?: HEntry[] } = {}, row = () => baton.batonById(destination.sessionId)!.row;
    await readView(row(), workspace, undefined, undefined, branch);
    const attachment = branch.branch!.flatMap(entry => entry.kind === "state" && entry.key === "sova-tour-attachment" && (entry.data as { handle?: string } | undefined)?.handle === handle ? [entry.data as { edition: string; files: string[] }] : [])[0]!;
    const snapshot = join(workspace, "tours", destination.sessionId, handle, attachment.edition);
    const inventory = ["manifest.json", ...attachment.files].map(file => relative(workspace, join(snapshot, file)));
    for (const path of inventory) assert.ok(git(workspace, "ls-tree", "-r", "--name-only", "HEAD").split("\n").includes(path));

    // Delete the source chat: its source-keyed routes are gone, the destination copy survives.
    await closeChat(f.sessionFile, "Delete the made-up source chat."); unlinkSync(f.sessionFile); markTourSessionDeleted(f.stateRoot, f.sid);
    assert.equal((await f.requestMain(`${source}/bindings/${handle}?destinationSessionId=${destination.sessionId}`, { method: "DELETE" })).status, 404, "the source-keyed detach can no longer reach it");
    for (const [path, request] of [[h, f.requestShare], [i, f.requestShare], [p, f.requestMain], [o, f.requestMain]] as const) assert.equal((await request(path)).status, 200, `positive control before detach: ${path}`);
    assert.deepEqual((await f.requestMain(list)).json<{ handle: string }[]>().map(t => t.handle), [handle], "the operator's conversation view lists it");

    const picture = join(snapshot, attachment.files[0]!), good = readFileSync(picture), bad = Buffer.from(good); bad[bad.length - 1] = bad[bad.length - 1]! ^ 1; writeFileSync(picture, bad);
    const head = git(workspace, "rev-parse", "HEAD");
    writeFileSync(join(workspace, "notes.md"), "An unrelated made-up note.\n");
    const wedged = await commitAll(workspace, "A corrupt attached snapshot refuses the backup");
    assert.match(wedged.error ?? "", /Organization backup is incomplete/); assert.equal(git(workspace, "rev-parse", "HEAD"), head);

    // Refusals: no operator auth, another organization, the share listener, a guessed handle. None writes.
    const transcript = async () => { const out: { branch?: HEntry[] } = {}; await readView(row(), workspace, undefined, undefined, out); return JSON.stringify(out.branch); };
    const before = await transcript();
    let reads = 0;
    const originalRead = TourBindings.prototype.read, originalAsset = TourBindings.prototype.asset;
    TourBindings.prototype.read = function (...args) { reads++; return originalRead.apply(this, args); };
    TourBindings.prototype.asset = function (...args) { reads++; return originalAsset.apply(this, args); };
    try {
      assert.equal((await f.requestMain(detach, { method: "DELETE", auth: false })).status, 401);
      assert.equal((await f.requestMain(list, { auth: false })).status, 401);
      for (const path of [`/api/orgs/${other.id}/conversations/${destination.sessionId}/tours/${handle}`, `${list}/tr_guessedguessedgu`, `${list}/not-a-handle`, `/api/orgs/${org.id}/conversations/missing-conversation/tours/${handle}`]) {
        assert.equal((await f.requestMain(path, { method: "DELETE" })).status, 404, path);
      }
      assert.equal((await f.requestMain(`/api/orgs/${other.id}/conversations/${destination.sessionId}/tours`)).status, 404, "another organization cannot list it");
      assert.equal((await f.requestShare(detach, { method: "DELETE" })).status, 404, "the share listener never reaches the operator action");
      assert.equal(await transcript(), before, "no refused call wrote to the conversation");
      // The destination-keyed detach works with an unreadable snapshot and reads none.
      const detached = await f.requestMain(detach, { method: "DELETE" }); assert.equal(detached.status, 200, detached.text);
      assert.equal(reads, 0, "detaching never reads the snapshot");
      for (const [path, request] of [[h, f.requestShare], [i, f.requestShare], [p, f.requestMain], [o, f.requestMain], [`${h}/assets/${attachment.files[1] ?? attachment.files[0]}`, f.requestShare]] as const) {
        assert.equal((await request(path)).status, 404, `revoked after detach: ${path}`);
      }
      assert.equal(reads, 0, "revocation precedes every snapshot read");
    } finally { TourBindings.prototype.read = originalRead; TourBindings.prototype.asset = originalAsset; }
    const view = await f.requestShare(`/api/h/${hToken}`); assert.equal(view.status, 200, view.text);
    assert.ok(!view.json<BatonView>().items.some(item => item.kind === "tour"), "the participant's view drops it");
    assert.deepEqual((await f.requestMain(list)).json<unknown[]>(), []);
    assert.equal((await f.requestMain(detach, { method: "DELETE" })).status, 404, "a second detach is missing, not a new write");

    // The backup is no longer wedged: the next tree drops the snapshot, its bytes and old history stay.
    const next = await commitAll(workspace, "Back up after detaching the corrupt snapshot"); assert.equal(next.error, undefined, next.error);
    assert.ok(!git(workspace, "ls-tree", "-r", "--name-only", "HEAD").split("\n").some(path => path.startsWith("tours/")));
    assert.ok(existsSync(picture), "detaching keeps the bytes on disk");
    assert.ok(git(workspace, "show", `${head}:${inventory[0]}`).includes("\"assets\""), "older history keeps the earlier snapshot");
  } finally { await f.close(); }
});
