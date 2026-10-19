import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import type { HEntry } from "../../shared/harness";
import { projectTourPublic, TOUR_ATTACHMENT_ENTRY } from "../../shared/tour";
import { tourEditionAssetsFixture, tourManifestFixture } from "../../shared/tour-fixtures";
import { commitAll, initRepo } from "../workspace-git";
import { TourBindings } from "./bindings";

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

// Integration tier only because the fault needs a git shim (a second program).
test("anything else staged under tours/ beside the exact inventory refuses the backup", async () => {
  const root = mkdtempSync(join(tmpdir(), "sova-tour-reserved-")), savedPath = process.env.PATH;
  try {
    const workspace = join(root, "workspace"); mkdirSync(workspace);
    writeFileSync(join(workspace, ".gitignore"), "/tours/\n");
    await initRepo(workspace);
    const pictures = tourEditionAssetsFixture(); pictures.delete("contact-sheet.png");
    const attachment = new TourBindings(workspace).publish("conversation-one", projectTourPublic(tourManifestFixture(), { id: "public-tour", editionId: "checked-edition" }), pictures);
    const extra = ["tours", "conversation-one", attachment.handle, attachment.edition, "recording-script.json"].join("/");
    writeFileSync(join(workspace, extra), "A private made-up script.");
    mkdirSync(join(workspace, "sessions")); writeFileSync(join(workspace, "sessions", "conversation-one.jsonl"), "A made-up transcript.\n");
    const branch: HEntry[] = [{ kind: "state", id: "bound", parentId: null, key: TOUR_ATTACHMENT_ENTRY, data: attachment }];
    const readTourConversation = async () => ({ id: "conversation-one", branch });
    const inventory = ["manifest.json", ...attachment.files].map(file => ["tours", "conversation-one", attachment.handle, attachment.edition, file].join("/")).sort();
    // A stager slipping the private sibling in right behind the exact force-add.
    const nativeGit = (savedPath ?? "").split(delimiter).map(dir => join(dir, "git")).find(path => existsSync(path)); assert.ok(nativeGit);
    const bin = join(root, "bin"), used = join(root, "extra-staged"); mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!${process.execPath}\nconst fs=require("node:fs"), cp=require("node:child_process"), args=process.argv.slice(2);\nconst result=cp.spawnSync(${JSON.stringify(nativeGit)}, args, {stdio:"inherit"});\nif (result.status===0 && args.includes("add") && args.includes("--force") && !fs.existsSync(${JSON.stringify(used)})) { fs.writeFileSync(${JSON.stringify(used)}, "used"); const extra=cp.spawnSync(${JSON.stringify(nativeGit)}, ["-C", ${JSON.stringify(workspace)}, "add", "--force", "--", ${JSON.stringify(extra)}], {stdio:"ignore"}); if (extra.status!==0) process.exit(75); }\nprocess.exit(result.status ?? 74);\n`, { mode: 0o700 });
    process.env.PATH = `${bin}${delimiter}${savedPath ?? ""}`;
    let refused;
    try { refused = await commitAll(workspace, "A sibling slipped into the index", { readTourConversation }); }
    finally { if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; }
    assert.ok(existsSync(used), "the extra file really was staged behind the exact force-add");
    assert.match(refused.error ?? "", /Organization backup is incomplete/, "the reserved namespace must hold exactly the inventory");
    assert.equal(refused.committed, false);
    assert.throws(() => git(workspace, "rev-parse", "--verify", "HEAD"), "nothing was committed");
    // The foreign entry stays refused (unknown staged tour paths are never swept) until it is unstaged.
    assert.match((await commitAll(workspace, "Still refused", { readTourConversation })).error ?? "", /Organization backup is incomplete/);
    git(workspace, "rm", "--cached", "-q", "--", extra);
    // Positive control: the same workspace without the stager backs up exactly the inventory.
    const clean = await commitAll(workspace, "Back up the checked tour", { readTourConversation });
    assert.equal(clean.error, undefined, clean.error);
    assert.deepEqual(git(workspace, "ls-tree", "-r", "--name-only", "HEAD").split("\n").filter(path => path.startsWith("tours/")).sort(), inventory);
  } finally { if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; rmSync(root, { recursive: true, force: true }); }
});
