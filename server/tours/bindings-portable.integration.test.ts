import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { createTourRouteFixture } from "./route-fixture.integration.fixture";
import type { SecondHostResult } from "./bindings-portable-host";

const REPO = resolve(import.meta.dirname, "..", "..");
const SECOND_HOST = join(import.meta.dirname, "bindings-portable-host.ts");
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

test("real ignored-file backup clone and attach on a second state root carries only checked bound tour inventory", async () => {
  const f = await createTourRouteFixture();
  try {
    const orgs = await import("../orgs"), baton = await import("../baton"), owner = await import("../owner");
    const { changedPaths, commitAll, gitStatus, settled } = await import("../workspace-git");
    const { closeChat } = await import("../chat-handle");
    const { acquireChat, heldChats } = await import("../chat-manager");
    const { readStoredConversation, readView } = await import("../share/hub");
    const { TourBindings, visibleTour } = await import("./bindings");
    const { projectTourPublic } = await import("../../shared/tour");
    const { tourEditionAssetsFixture } = await import("../../shared/tour-fixtures");
    const workspace = join(f.root, "organization"); mkdirSync(workspace);
    const ignore = "/tours/\n*.png\nmanifest.json\n";
    writeFileSync(join(workspace, ".gitignore"), ignore);
    const org = await orgs.createOrg({ name: "Example Portable Studio", dir: workspace });
    const projectRoot = join(f.root, "example-project"); mkdirSync(projectRoot);
    const project = await orgs.addProject(org.id, { name: "Example interface", root: projectRoot });
    const person = await orgs.addPerson(org.id, { name: "Ada Example", role: "Reviewer" });
    await owner.setOwner(org.id, person.id);
    const destination = await baton.createBaton({ orgId: org.id, projectId: project.id, to: person.id, publicTitle: "Portable explanation", goal: "Review" });
    const e = f.sourceEdition.manifest, base = `/api/tours/${f.sid}/${e.id}/editions/${e.editionId}`;
    const body = { destinationSessionId: destination.sessionId };
    const review = await f.requestMain(`${base}/binding-preview`, { method: "POST", body });
    assert.equal(review.status, 200, review.text);
    const attached = await f.requestMain(`${base}/bindings`, { method: "POST", body: { ...body, previewId: review.json<{ previewId: string }>().previewId } });
    assert.equal(attached.status, 200, attached.text);
    const handle = attached.json<{ handle: string }>().handle;
    const branch: { branch?: import("../../shared/harness").HEntry[] } = {};
    const view = await readView(baton.batonById(destination.sessionId)!.row, workspace, undefined, undefined, branch);
    const attachment = visibleTour(view, branch.branch ?? [], handle); assert.ok(attachment, "binding authority is in the neutral conversation, not the source index");
    const snapshots = new TourBindings(workspace), manifest = snapshots.read(destination.sessionId, attachment); assert.ok(manifest);
    const snapshot = join(workspace, "tours", destination.sessionId, attachment.handle, attachment.edition);
    const inventory = ["manifest.json", ...manifest.assets.map(a => a.file)].map(file => relative(workspace, join(snapshot, file)));
    const oldH = baton.rotateLink(destination.sessionId).token, oldI = owner.ownerLinkFor(org.id).token;
    // Unbound snapshots and even siblings beside approved pictures must never be force-staged.
    const unboundPictures = tourEditionAssetsFixture(); unboundPictures.delete("contact-sheet.png");
    const orphan = snapshots.publish(destination.sessionId, projectTourPublic(e, { id: "unbound-tour", editionId: "unbound-edition" }), unboundPictures);
    writeFileSync(join(snapshot, "contact-sheet.png"), "not approved");
    writeFileSync(join(snapshot, "recording-script.json"), "private example script");
    writeFileSync(join(snapshot, "report.json"), "private example report");
    writeFileSync(join(workspace, "tours", "private-profile.json"), "private example profile");
    // Fault the commit seam AFTER index verification: a green git add/commit is not proof of a complete tree.
    {
      const originalPath = process.env.PATH, nativeGit = (originalPath ?? "").split(delimiter).map(dir => join(dir, "git")).find(path => existsSync(path)); assert.ok(nativeGit);
      const bin = join(f.root, "backup-missing-tree-bin"), dropped = join(f.root, "backup-tree-fault-used"); mkdirSync(bin);
      writeFileSync(join(bin, "git"), `#!${process.execPath}\nconst fs=require("node:fs"), cp=require("node:child_process"), args=process.argv.slice(2); if(args.includes("commit") && !fs.existsSync(${JSON.stringify(dropped)})) { const drop=cp.spawnSync(${JSON.stringify(nativeGit)}, ["-C",${JSON.stringify(workspace)},"rm","--cached","--force","--",${JSON.stringify(inventory[1])}], {stdio:"ignore"}); if(drop.status!==0)process.exit(73); fs.writeFileSync(${JSON.stringify(dropped)},"used"); } const result=cp.spawnSync(${JSON.stringify(nativeGit)},args,{stdio:"inherit"}); process.exit(result.status ?? 74);\n`, { mode: 0o700 });
      process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
      try {
        // Something always to commit, even if the org's own residence commit already took the tour in.
        await settled(workspace); writeFileSync(join(workspace, "backup-fault-note.md"), "An unrelated made-up note.\n");
        const incomplete = await commitAll(workspace, "Detect a missing committed picture");
        assert.equal(incomplete.committed, true, `the fault really occurred after a successful commit (error: ${incomplete.error ?? "none"}, fault used: ${existsSync(dropped)})`);
        assert.ok(existsSync(dropped)); assert.match(incomplete.error ?? "", /Organization backup is incomplete/);
        assert.match((await gitStatus(workspace)).lastError ?? "", /Organization backup is incomplete/, "the organization exposes a retryable backup warning");
      } finally { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; }
    }
    const ordinary = await baton.createBaton({ orgId: org.id, projectId: project.id, to: person.id, publicTitle: "An ordinary conversation", goal: "Review without a tour" });
    const ordinaryChat = await acquireChat(ordinary.path);
    let ordinaryMutations = 0, ordinaryChanged = false;
    const ignoredBackup = await commitAll(workspace, "Back up checked pictures despite a concurrent ordinary chat write", {
      async readTourConversation(source) {
        const parsedBytes = typeof source === "string" ? readFileSync(source) : null;
        const conversation = await readStoredConversation(source);
        if (typeof source === "string" && source === ordinary.path && ordinaryMutations++ === 0) {
          ordinaryChat.harness.appendUserMessage("A concurrent ordinary chat update, with no tour attached.");
          ordinaryChanged = !readFileSync(source).equals(parsedBytes!);
        }
        return conversation;
      },
    });
    assert.equal(ordinaryMutations, 1, "the validator really read the ordinary transcript");
    assert.equal(ordinaryChanged, true, "the ordinary transcript's bytes really changed between the validator's before/after reads");
    assert.equal(ignoredBackup.error, undefined, ignoredBackup.error);
    assert.ok(git(workspace, "show", `HEAD:${relative(workspace, ordinary.path)}`).includes("A concurrent ordinary chat update"), "a normal backup includes that update rather than emitting a spurious tour warning");
    const ignoredTree = git(workspace, "ls-tree", "-r", "--name-only", "HEAD").split("\n");
    for (const path of inventory) assert.ok(ignoredTree.includes(path), `ignored checked inventory still committed: ${path}`);
    assert.equal(readFileSync(join(workspace, ".gitignore"), "utf8"), ignore, "backup never rewrites operator ignore rules");
    const trackedPicture = join(snapshot, manifest.assets[0]!.file), checkedBytes = readFileSync(trackedPicture), corrupt = Buffer.from(checkedBytes);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1; writeFileSync(trackedPicture, corrupt);
    assert.ok((await changedPaths(workspace)).includes(relative(workspace, trackedPicture)), "tracked tour changes stay visible even though retained untracked artifacts are excluded");
    assert.equal((await gitStatus(workspace)).dirty, true);
    const beforeCorruption = git(workspace, "rev-parse", "HEAD");
    const corruptBackup = await commitAll(workspace, "Refuse changed checked pictures");
    assert.match(corruptBackup.error ?? "", /Organization backup is incomplete/);
    assert.match((await gitStatus(workspace)).lastError ?? "", /Organization backup is incomplete/);
    assert.equal(git(workspace, "rev-parse", "HEAD"), beforeCorruption);
    writeFileSync(trackedPicture, checkedBytes);
    // Removing the ignore rules must not make unbound/private siblings travel either.
    writeFileSync(join(workspace, ".gitignore"), "# Operator-owned rules remain intact.\n*.tmp\n");
    const outcome = await commitAll(workspace, "Back up reviewed example tour");
    assert.equal(outcome.error, undefined, outcome.error);
    const tree = git(workspace, "ls-tree", "-r", "--name-only", "HEAD").split("\n");
    for (const path of inventory) assert.ok(tree.includes(path), `committed checked inventory: ${path}`);
    const committedTours = tree.filter(path => path.startsWith("tours/"));
    assert.deepEqual(committedTours.sort(), [...inventory].sort(), "only exact checked bound inventory travels; no orphan, contact sheet, script, report or profile");
    assert.equal(readFileSync(join(workspace, ".gitignore"), "utf8"), "# Operator-owned rules remain intact.\n*.tmp\n");
    assert.ok(!tree.some(path => path.includes(orphan.handle)));
    const restored = join(f.root, "restored-organization");
    execFileSync("git", ["clone", "-q", workspace, restored]); git(restored, "remote", "remove", "origin");
    await orgs.detachOrg(org.id); await settled(workspace);
    for (const chat of heldChats()) await closeChat(chat.path, "Move the made-up organization.");
    // Prove there is no fallback to old source editions, tokens, index or workspace.
    rmSync(workspace, { recursive: true, force: true }); rmSync(f.agentDir, { recursive: true, force: true });
    const secondAgent = join(f.root, "second-agent"), scratch = join(f.root, "second-host-scratch"); mkdirSync(scratch);
    assert.equal(existsSync(workspace), false); assert.equal(existsSync(f.agentDir), false);
    // The second host is a separate process, as a real one is: it starts with only the second root in its
    // environment; the first root's path reaches it only as the path it must find absent.
    const input = {
      absent: f.agentDir, agentDir: secondAgent, restored, scratch, orgId: org.id, projectId: project.id, personId: person.id,
      destination: destination.sessionId, handle, edition: attachment.edition, oldH, oldI, manifest, inventory,
    };
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !value.includes(f.agentDir)) env[key] = value;
    env.PI_CODING_AGENT_DIR = secondAgent; env.SOVA_CHAT_STATE_ROOT = join(secondAgent, "sova"); delete env.SOVA_SHARE_PUBLIC_URL;
    assert.ok(!Object.values(env).some(value => value.includes(f.agentDir)), "the first root is nowhere in the second host's environment");
    const host = spawnSync(process.execPath, [SECOND_HOST, JSON.stringify(input)], { cwd: REPO, env, encoding: "utf8", timeout: 240_000, maxBuffer: 16 * 1024 * 1024 });
    const report = `exit ${host.status}, signal ${host.signal}, error ${host.error?.message ?? "none"}\n--- stdout ---\n${host.stdout}\n--- stderr ---\n${host.stderr}`;
    assert.equal(host.error, undefined, report); assert.equal(host.signal, null, report); assert.equal(host.status, 0, report);
    const lines = host.stdout.split("\n").filter(line => line.length);
    assert.equal(lines.length, 1, `exactly one result line on stdout\n${report}`);
    const result = JSON.parse(lines[0]!) as SecondHostResult;
    assert.deepEqual(Object.keys(result).sort(), ["agentDir", "appended", "oldRootAbsent", "orgId", "picturesRead"], report);
    assert.equal(result.oldRootAbsent, true); assert.equal(result.orgId, org.id); assert.equal(result.agentDir, secondAgent);
    assert.equal(result.picturesRead, manifest.assets.length * 2, "the second host read every picture over h and i");
    // Positive control, from disk: the second host's chat opened and appended this exact row on the second root's copy.
    assert.ok(result.appended.path.startsWith(`${restored}/`), result.appended.path);
    // The child later deletes that transcript (the F2c case), after the backup that committed it: read it from history.
    const appendedRows = git(restored, "log", "--format=", "-p", "--", relative(restored, result.appended.path)).split("\n").filter(line => line.startsWith("+{")).map(line => JSON.parse(line.slice(1)) as { id?: string });
    const appendedRow = appendedRows.find(row => row.id === result.appended.entryId);
    assert.ok(appendedRow, "the second host's appended row is in the restored repository's committed transcript");
    assert.ok(JSON.stringify(appendedRow).includes("sova-tour-attachment") && JSON.stringify(appendedRow).includes(result.appended.handle), JSON.stringify(appendedRow));
    assert.equal(existsSync(f.agentDir), false, "no restored read or neutral write recreates the old host's state root");
  } finally { await f.close(); }
});
