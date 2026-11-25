// A Move's old worktree holding a submodule (§app.transport/moved-row): kept whole in the safety copy, its submodule's
// git data too, then removed, never left usable; Move Back rebuilds it from the package and puts back what was kept,
// so parent and submodule are as they were. Real git.
import { dropScratchAgentDir } from "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { packWorktrees, publishTrees, rebuildWorktrees, surveyWorktree } from "./git-snapshot";
import { keepAndRemoveTree, keptFolder, keptGitData, restoreKept, unzstd } from "./retire";
import { listTar } from "./tar";

const root = scratchRoot("sova-transport-retire-");
after(() => {
  rmSync(root, { recursive: true, force: true });
  dropScratchAgentDir();
});
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "protocol.file.allow=always", ...args], { cwd, env, encoding: "utf8" });
const facts = (cwd: string) => [g(cwd, "rev-parse", "HEAD"), g(cwd, "branch", "--show-current"), g(cwd, "status", "--porcelain=v1", "-uall"), g(cwd, "ls-files", "-s", "-v"), g(cwd, "diff", "--cached"), g(cwd, "diff")].join("\n--\n");
const fileHashes = (dir: string): string => {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const n of readdirSync(join(dir, rel)).sort()) {
      if (n === ".git") continue;
      const r = rel ? `${rel}/${n}` : n;
      const st = lstatSync(join(dir, r));
      if (st.isDirectory()) walk(r);
      else out.push(`${r} ${st.isSymbolicLink() ? readlinkSync(join(dir, r)) : createHash("sha256").update(readFileSync(join(dir, r))).digest("hex")}`);
    }
  };
  walk("");
  return out.join("\n");
};
const members = async (archive: string, out: string) => {
  await unzstd(archive, out);
  return (await listTar(out)).map((m) => m.name.replace(/\/$/, ""));
};

test("a Move's worktree holding a submodule with unfinished work is kept whole (its git data too) and removed; Move Back restores parent and submodule as they were", async () => {
  const samba = join(root, "samba");
  mkdirSync(samba);
  g(samba, "init", "-q", "-b", "master");
  writeFileSync(join(samba, "lib.c"), "1\n");
  g(samba, "add", "-A");
  g(samba, "commit", "-qm", "one");
  const src = join(root, "proj");
  mkdirSync(src);
  g(src, "init", "-q", "-b", "master");
  writeFileSync(join(src, ".gitignore"), "dist/\n");
  writeFileSync(join(src, "a.txt"), "a\n");
  g(src, "add", "-A");
  g(src, "commit", "-qm", "one");
  g(src, "submodule", "add", "-q", samba, "lib/samba");
  g(src, "commit", "-qm", "samba");
  const wt = join(root, "proj-wt");
  g(src, "worktree", "add", "-q", wt, "-b", "feat");
  g(wt, "submodule", "update", "-q", "--init");
  const sub = join(wt, "lib", "samba");
  // Git data only this device has (a side branch), a commit past the gitlink, and unfinished work in both.
  g(sub, "branch", "side");
  writeFileSync(join(sub, "lib.c"), "1\n2\n");
  g(sub, "commit", "-qam", "local");
  writeFileSync(join(sub, "lib.c"), "1\n2\nunstaged\n");
  writeFileSync(join(sub, "new.c"), "untracked\n");
  writeFileSync(join(wt, "a.txt"), "a\nwip\n");
  mkdirSync(join(wt, "dist"));
  writeFileSync(join(wt, "dist", "out.js"), "build output, never in the package\n");
  const before = { parent: facts(wt), sub: facts(sub), files: fileHashes(wt), side: g(sub, "rev-parse", "side") };

  // The package (kept in the safety copy), then the switch's end here.
  const p = await packWorktrees({ tid: "tm1", trees: [await surveyWorktree("proj-wt", wt)], haves: [], outDir: join(root, "pack") });
  // The control: git refuses a plain removal, and its --force (the removal before this) deletes the submodule's git
  // data, which lives in the worktree's git folder and not in the folder the safety copy kept.
  assert.throws(() => execFileSync("git", ["worktree", "remove", wt], { cwd: src, stdio: "pipe" }), /submodules cannot be moved or removed/);
  assert.ok(existsSync(join(g(wt, "rev-parse", "--absolute-git-dir").trim(), "modules", "lib", "samba", "HEAD")));
  const keep = join(root, "home", "transport");
  const done = await keepAndRemoveTree(wt, keep, "tm1", "proj-wt");
  assert.ok(done.removed, done.removed ? "" : done.why);
  assert.ok(!existsSync(wt), "no worktree is left here");
  assert.ok(!g(src, "worktree", "list", "--porcelain").includes("proj-wt"), "git doesn't list it: its branch can't be landed from here");
  const work = join(root, "work");
  mkdirSync(work);
  const folder = await members(keptFolder(keep, "tm1", "proj-wt"), join(work, "f.tar"));
  for (const f of ["proj-wt/lib/samba/new.c", "proj-wt/lib/samba/lib.c", "proj-wt/dist/out.js"]) assert.ok(folder.includes(f), `the safety copy holds ${f}`);
  const data = await members(keptGitData(keep, "tm1", "proj-wt"), join(work, "g.tar"));
  for (const f of ["modules/lib/samba/HEAD", "modules/lib/samba/refs/heads/side", "modules/lib/samba/index"]) assert.ok(data.includes(f), `the safety copy holds the submodule's git data: ${f}`);

  // Move Back: rebuilt from the package, then what was kept put back.
  const staged = await rebuildWorktrees({ repo: src, codeDir: join(root, "pack"), tid: "tm1", metas: p.metas, targets: { "proj-wt": wt } });
  await publishTrees(staged, "tm1");
  await restoreKept(keep, "tm1", "proj-wt", wt, work);
  assert.equal(facts(wt), before.parent);
  assert.equal(facts(sub), before.sub);
  assert.equal(fileHashes(wt), before.files, "every file, the build output and the submodule's included");
  assert.equal(g(sub, "rev-parse", "side"), before.side, "its git data came back too");
  assert.equal(g(sub, "status", "--porcelain=v1"), " M lib.c\n?? new.c\n");
  const common = g(wt, "rev-parse", "--path-format=absolute", "--git-common-dir").trim();
  assert.equal(g(wt, "rev-parse", "--absolute-git-dir").trim(), join(common, "worktrees", "proj-wt"), "its records are named for its folder");
  assert.deepEqual(readdirSync(join(common, "worktrees")).filter((n) => n.includes("incoming")), [], "nothing named for the staging folder");
  assert.equal(g(src, "worktree", "prune", "--dry-run", "-v"), "");
});
