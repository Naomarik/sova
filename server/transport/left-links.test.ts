// What stays here (§app.transport/package, §app.transport/dialog): a dependency or build folder, and a link named
// as one (a worktree's node_modules linking to the main checkout's), is rebuilt there and never offered as a private
// file, an untracked file or a scratch folder's file, whether git ignores it as a folder, as a name, or not at all.
// A plain file that only shares such a name stays the file it is.
import { dropScratchAgentDir } from "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { surveyWorktree } from "./git-snapshot";

const root = scratchRoot("sova-transport-left-");
after(() => {
  rmSync(root, { recursive: true, force: true });
  dropScratchAgentDir();
});
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" });

/** A committed repository with `ignore` as its .gitignore, and a real dependency folder for the links to point at. */
function repo(name: string, ignore: string): { dir: string; deps: string } {
  const dir = join(root, name);
  mkdirSync(dir);
  g(dir, "init", "-q", "-b", "master");
  writeFileSync(join(dir, ".gitignore"), ignore);
  writeFileSync(join(dir, "a.txt"), "a\n");
  g(dir, "add", "-A");
  g(dir, "commit", "-qm", "one");
  const deps = join(root, `${name}-main-deps`);
  mkdirSync(join(deps, "x"), { recursive: true });
  writeFileSync(join(deps, "x", "i.js"), "dep\n");
  return { dir, deps };
}

for (const [rule, ignore] of [
  ["ignored by name", "node_modules\ndist\n.env\nbuild\n.cache/\n"],
  ["ignored as folders only", "node_modules/\ndist/\n.env\nbuild\n.cache/\n"],
] as const) {
  test(`links named as dependency folders stay here, never a private or untracked file (${rule})`, async () => {
    const { dir, deps } = repo(rule.replace(/ /g, "-"), ignore);
    symlinkSync(deps, join(dir, "node_modules"));
    mkdirSync(join(dir, "packages", "ui"), { recursive: true });
    symlinkSync(deps, join(dir, "packages", "ui", "node_modules"));
    symlinkSync(deps, join(dir, "dist"));
    mkdirSync(join(dir, ".cache", "spike"), { recursive: true });
    writeFileSync(join(dir, ".cache", "spike", "notes.md"), "work\n");
    symlinkSync(deps, join(dir, ".cache", "spike", "node_modules"));
    writeFileSync(join(dir, ".env"), "K=1\n");
    // A file, not a folder or a link, that only shares a build folder's name.
    writeFileSync(join(dir, "build"), "a script\n");

    const s = await surveyWorktree("w", dir);
    assert.equal(s.refusal, null);
    const offered = s.loose.map((f) => f.path).sort();
    assert.deepEqual(offered.filter((p) => /(^|\/)(node_modules|dist)$/.test(p)), [], "no link named as a dependency folder is offered");
    assert.deepEqual(s.loose.filter((f) => f.kind === "private").map((f) => f.path).sort(), [".env", "build"]);
    assert.ok(offered.includes(".cache/spike/notes.md"), "the scratch folder's own file still travels");
    for (const p of ["node_modules", "packages/ui/node_modules", "dist"]) assert.ok(s.left.includes(p), `${p} is listed as staying here`);
  });
}
