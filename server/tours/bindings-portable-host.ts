// Test-only, never imported by product code: the SECOND host of bindings-portable.integration.test.ts.
// A second host is a separate process, so it is one here: started with only the second state root in its
// environment, it attaches the cloned organization, reads its tours over its own share listener, backs up,
// prunes and detaches, then checks that nothing recreated the first host's removed agent dir. Every check
// throws (non-zero exit, stack on stderr); stdout carries exactly one JSON result line and nothing else.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Anything a module logs goes to stderr: stdout is the result channel.
console.log = console.error;
console.info = console.error;

export interface SecondHostInput {
  /** The first host's removed agent dir: only ever asserted absent. */
  absent: string;
  agentDir: string;
  restored: string;
  scratch: string;
  orgId: string;
  projectId: string;
  personId: string;
  destination: string;
  handle: string;
  edition: string;
  oldH: string;
  oldI: string;
  manifest: import("../../shared/tour").TourPresentation;
  inventory: string[];
}
export interface SecondHostResult {
  oldRootAbsent: true;
  orgId: string;
  picturesRead: number;
  appended: { path: string; entryId: string; handle: string };
  agentDir: string;
}

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

async function main(input: SecondHostInput): Promise<SecondHostResult> {
  assert.equal(process.env.PI_CODING_AGENT_DIR, input.agentDir, "this process runs on the second root");
  assert.ok(!Object.values(process.env).some(value => value?.includes(input.absent)), "the first root is nowhere in this host's environment");
  assert.equal(existsSync(input.absent), false, "the first root is gone before this host starts");
  mkdirSync(join(input.agentDir, "sessions", "live"), { recursive: true });
  const { linkPiConfigExtensions } = await import("../testing/agent-dir"); linkPiConfigExtensions(input.agentDir);
  await import("../testing/in-process-chats");
  // Names the first step after which the first root exists again, and what was written there.
  let recreatedAfter: string | null = null;
  const probe = (step: string) => { if (!recreatedAfter && existsSync(input.absent)) recreatedAfter = step; };
  const recreated = (): string => { try { return (readdirSync(input.absent, { recursive: true }) as string[]).map(path => `${path}${statSync(join(input.absent, path)).isDirectory() ? "/" : ""}`).sort().join(", "); } catch { return "(absent)"; } };

  const { createShareServer } = await import("../share/edge");
  const share: Server = createShareServer();
  await new Promise<void>(resolve => share.listen(0, "127.0.0.1", resolve));
  const shareURL = `http://127.0.0.1:${(share.address() as AddressInfo).port}`;
  process.env.SOVA_SHARE_PUBLIC_URL = shareURL;
  const read = async (path: string) => {
    const response = await fetch(`${shareURL}${path}`, { redirect: "manual" });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, bytes, text: bytes.toString("utf8"), json: <T>() => JSON.parse(bytes.toString("utf8")) as T };
  };
  const { closeChat, acquireChatHandle } = await import("../chat-handle");
  const { heldChats } = await import("../chat-manager");
  try {
    const orgs = await import("../orgs"), baton = await import("../baton"), owner = await import("../owner"), handles = await import("../person-links");
    const { changedPaths, commitAll, gitStatus } = await import("../workspace-git");
    const { readStoredConversation } = await import("../share/hub");
    const { TourBindings } = await import("./bindings");
    const { tourEditionAssetsFixture } = await import("../../shared/tour-fixtures");
    const { TOUR_ATTACHMENT, TOUR_DETACHMENT } = await import("../harness/state-kinds");
    const { restored, handle, manifest, inventory } = input;

    const restoredOrg = await orgs.attachOrg({ dir: restored, confirm: true }); assert.equal(restoredOrg.id, input.orgId); probe("attachOrg");
    const restoredRow = baton.batonById(input.destination); assert.ok(restoredRow); assert.equal(restoredRow.dir, restored);
    const renewedH = baton.rotateLink(input.destination).token, renewedI = owner.ownerLinkFor(input.orgId).token; probe("rotateLink/ownerLinkFor");
    const newViewResponse = await read(`/api/h/${renewedH}`); assert.equal(newViewResponse.status, 200, newViewResponse.text);
    const restoredTour = newViewResponse.json<import("../../shared/baton").BatonView>().items.find(item => item.kind === "tour");
    assert.ok(restoredTour?.kind === "tour"); assert.equal(restoredTour.handle, handle);
    const h = `/api/h/${renewedH}/tours/${restoredTour.handle}`;
    const i = `/api/i/${renewedI}/c/${handles.handleOf("k", input.destination)}/tours/${restoredTour.handle}`;
    let picturesRead = 0;
    for (const path of [h, i]) {
      const response = await read(path); assert.equal(response.status, 200, response.text);
      const restoredManifest = response.json<import("../../shared/tour").TourPresentation>(); assert.deepEqual(restoredManifest, manifest);
      for (const picture of restoredManifest.assets) {
        const image = await read(`${path}/assets/${picture.file}`); assert.equal(image.status, 200);
        assert.deepEqual(image.bytes, readFileSync(join(restored, "tours", input.destination, handle, input.edition, picture.file)));
        picturesRead++;
      }
    }
    probe("restored h/i reads"); assert.equal((await read(`/api/h/${input.oldH}/tours/${handle}`)).status, 404);
    assert.equal((await read(`/api/i/${input.oldI}/c/${handles.handleOf("k", input.destination)}/tours/${handle}`)).status, 404);

    probe("old-token reads"); const removedConversation = await baton.createBaton({ orgId: input.orgId, projectId: input.projectId, to: input.personId, publicTitle: "A removable explanation", goal: "Review" });
    const unboundPictures = tourEditionAssetsFixture(); unboundPictures.delete("contact-sheet.png");
    const removedAttachment = new TourBindings(restored).publish(removedConversation.sessionId, manifest, unboundPictures);
    probe("createBaton on the restored host"); await (await acquireChatHandle(removedConversation.path)).appendStateRow(TOUR_ATTACHMENT, removedAttachment); probe("chat open + attachment append");
    // Positive control: this host's chat really opened and appended, on the second root's restored conversation.
    const appendedBranch = (await readStoredConversation(removedConversation.path)).branch;
    const appendedEntry = appendedBranch.find(entry => entry.kind === "state" && entry.key === "sova-tour-attachment" && (entry.data as { handle?: string } | undefined)?.handle === removedAttachment.handle);
    assert.ok(appendedEntry?.id, "the attachment row is in the restored conversation");
    const appended = { path: removedConversation.path, entryId: appendedEntry.id, handle: removedAttachment.handle };
    const removedInventory = ["manifest.json", ...removedAttachment.files].map(file => ["tours", removedConversation.sessionId, removedAttachment.handle, removedAttachment.edition, file].join("/"));
    assert.equal((await commitAll(restored, "Back up another checked conversation")).error, undefined);
    probe("restored backup"); const beforeRemoval = git(restored, "rev-parse", "HEAD");
    for (const path of removedInventory) assert.ok(git(restored, "ls-tree", "-r", "--name-only", "HEAD").split("\n").includes(path));
    await closeChat(removedConversation.path, "Remove this made-up transcript fixture."); probe("closeChat");
    const outsideTranscript = join(input.scratch, "outside-conversation.jsonl"); writeFileSync(outsideTranscript, readFileSync(removedConversation.path));
    rmSync(removedConversation.path); symlinkSync(outsideTranscript, removedConversation.path);
    const unsafeRemoval = await commitAll(restored, "An unsafe transcript is not confirmed deletion");
    assert.match(unsafeRemoval.error ?? "", /Organization backup is incomplete/);
    assert.equal(git(restored, "rev-parse", "HEAD"), beforeRemoval, "a symlink never authorizes pruning committed tour inventory");
    assert.ok(existsSync(outsideTranscript));
    rmSync(removedConversation.path);
    writeFileSync(join(restored, "manual-notes.txt"), "Unrelated operator work stays in the backup.\n"); git(restored, "add", "--", "manual-notes.txt");
    const afterRemoval = await commitAll(restored, "Back up removal of an attached conversation");
    assert.equal(afterRemoval.error, undefined, afterRemoval.error);
    const afterRemovalTree = git(restored, "ls-tree", "-r", "--name-only", "HEAD").split("\n");
    for (const path of removedInventory) {
      assert.ok(!afterRemovalTree.includes(path), "only exact formerly-bound inventory is pruned from the next tree");
      assert.ok(existsSync(join(restored, path)), "pruning the backup index never deletes retained public bytes");
    }
    assert.ok(afterRemovalTree.includes("manual-notes.txt"), "unrelated user-staged work is not unstaged or removed");
    assert.ok(git(restored, "show", `${beforeRemoval}:${removedInventory[0]}`).includes("\"assets\""));
    assert.equal((await read(h)).status, 200, "another conversation's checked tour remains readable");
    assert.equal((await commitAll(restored, "Retry a normal backup after conversation removal")).error, undefined, "a removed conversation cannot wedge later backups");

    // Change the attached neutral conversation exactly between inventory capture and git add, not by timing a lucky race.
    probe("removal backups"); const savedPath = process.env.PATH, gitPath = (savedPath ?? "").split(delimiter).map(dir => join(dir, "git")).find(path => existsSync(path));
    assert.ok(gitPath);
    const shim = join(input.scratch, "backup-race-bin"), entered = join(input.scratch, "backup-add-entered"), release = join(input.scratch, "backup-add-release"); mkdirSync(shim);
    writeFileSync(join(shim, "git"), `#!${process.execPath}\nconst fs = require("node:fs"); const cp = require("node:child_process"); const args = process.argv.slice(2);\nif (args.includes("add") && args.includes("-A") && !fs.existsSync(${JSON.stringify(entered)})) { fs.writeFileSync(${JSON.stringify(entered)}, "ready"); const end=Date.now()+15000; while (!fs.existsSync(${JSON.stringify(release)})) { if(Date.now()>end) process.exit(71); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); } }\nconst result=cp.spawnSync(${JSON.stringify(gitPath)}, args, {stdio:"inherit"}); process.exit(result.status ?? 72);\n`, { mode: 0o700 });
    const headBeforeRace = git(restored, "rev-parse", "HEAD");
    process.env.PATH = `${shim}${delimiter}${savedPath ?? ""}`;
    const racingBackup = commitAll(restored, "A conversation changed during backup");
    try {
      const deadline = Date.now() + 10000;
      while (!existsSync(entered) && Date.now() < deadline) await delay(10);
      assert.ok(existsSync(entered), "git add barrier was actually reached");
      // git clone wrote this transcript (not Sova's write): open it the way "Chat anyway" does.
      await (await acquireChatHandle(baton.sessionPathOf(restored, restoredRow.row), true)).appendState(TOUR_DETACHMENT, { v: 1, handle });
      writeFileSync(release, "continue");
      const raced = await racingBackup;
      assert.match(raced.error ?? "", /Organization backup is incomplete/);
      assert.equal(raced.committed, false, "a newer transcript is not committed with an older snapshot inventory");
    } finally { writeFileSync(release, "continue"); await racingBackup; if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; }
    probe("detach during backup race"); assert.equal(git(restored, "rev-parse", "HEAD"), headBeforeRace);
    assert.equal((await read(h)).status, 404);
    const detachedBackup = await commitAll(restored, "Back up tour detachment"); assert.equal(detachedBackup.error, undefined, detachedBackup.error);
    assert.ok(!git(restored, "ls-tree", "-r", "--name-only", "HEAD").split("\n").some(path => path.startsWith("tours/")), "detached snapshot absent from next committed tree");
    assert.ok(existsSync(join(restored, inventory[0]!)), "detachment retains physical snapshot bytes");
    assert.ok(git(restored, "show", `${headBeforeRace}:${inventory[0]}`).includes(manifest.title), "detachment does not erase older backup history");
    assert.deepEqual((await changedPaths(restored)).filter(path => path.startsWith("tours/")), []);
    assert.equal((await gitStatus(restored)).dirty, false, "retained untracked snapshots do not cause a perpetual dirty/no-op backup loop");
    probe("final checks");
    assert.equal(existsSync(input.absent), false, `no restored read or neutral write recreates the old host's state root (first seen after: ${recreatedAfter}; contents: ${recreated()})`);
    return { oldRootAbsent: true, orgId: restoredOrg.id, picturesRead, appended, agentDir: process.env.PI_CODING_AGENT_DIR! };
  } finally {
    for (const chat of heldChats()) await closeChat(chat.path, "The second host finished.").catch(() => false);
    share.closeAllConnections(); await new Promise<void>(resolve => share.close(() => resolve()));
  }
}

const raw = process.argv[2];
if (!raw) { console.error("usage: bindings-portable-host.ts <input json>"); process.exit(2); }
main(JSON.parse(raw) as SecondHostInput).then(
  result => process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0)),
  error => { console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exit(1); },
);
