// A worktree's code arrives exactly (§app.transport/package, §app.transport/arrival): the two states
// the first design lost without a word (a hidden edit under skip-worktree, an intent-to-add file)
// plus a staged and an unstaged edit, an untracked file, a scratch folder and a private file, packed
// and rebuilt into a clone; dependencies stay behind. And a merge in progress is refused.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { havesOf, packWorktrees, publishTrees, rebuildWorktrees, surveyWorktree } from "./git-snapshot";

const root = scratchRoot("sova-transport-git-");
after(() => rmSync(root, { recursive: true, force: true }));
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" });
const facts = (cwd: string) => [g(cwd, "rev-parse", "HEAD"), g(cwd, "status", "--porcelain=v1", "-uall"), g(cwd, "ls-files", "-s", "-v"), g(cwd, "diff", "--cached"), g(cwd, "diff")].join("\n--\n");

test("a worktree with every kind of unfinished change rebuilds exactly in a clone; dependencies stay", async () => {
  const src = join(root, "src");
  mkdirSync(src);
  g(src, "init", "-q", "-b", "master");
  writeFileSync(join(src, ".gitignore"), "node_modules/\n.env\n.cache/\n");
  writeFileSync(join(src, "a.txt"), "a\n");
  writeFileSync(join(src, "hidden.txt"), "h\n");
  g(src, "add", "-A");
  g(src, "commit", "-qm", "one");
  const wt = join(root, "wt");
  g(src, "worktree", "add", "-q", wt, "-b", "feat");
  writeFileSync(join(wt, "staged.txt"), "s\n");
  g(wt, "add", "staged.txt");
  writeFileSync(join(wt, "a.txt"), "a\nunstaged\n");
  writeFileSync(join(wt, "ita.txt"), "i\n");
  g(wt, "add", "-N", "ita.txt");
  g(wt, "update-index", "--skip-worktree", "hidden.txt");
  writeFileSync(join(wt, "hidden.txt"), "h\nhidden edit\n");
  writeFileSync(join(wt, "u.txt"), "u\n");
  writeFileSync(join(wt, ".env"), "K=1\n");
  mkdirSync(join(wt, ".cache", "spike"), { recursive: true });
  writeFileSync(join(wt, ".cache", "spike", "notes.md"), "work\n");
  mkdirSync(join(wt, "node_modules", "x"), { recursive: true });
  writeFileSync(join(wt, "node_modules", "x", "i.js"), "dep\n");

  const s = await surveyWorktree("wt", wt);
  assert.equal(s.refusal, null);
  assert.deepEqual(s.left, ["node_modules"]);
  assert.deepEqual(s.scratch.map((d) => d.dir), [".cache"]);

  const proj = join(root, "there", "proj");
  g(root, "clone", "-q", src, proj);
  const p = await packWorktrees({ tid: "t1", trees: [s], haves: await havesOf(proj), outDir: join(root, "pack") });
  const staged = await rebuildWorktrees({ repo: proj, codeDir: join(root, "pack"), tid: "t1", metas: p.metas, targets: { wt: join(root, "there", "wt") } });
  assert.ok(!existsSync(join(root, "there", "wt")), "nothing is in place before publish");
  await publishTrees(staged, "t1");
  const there = join(root, "there", "wt");
  assert.equal(facts(there), facts(wt));
  assert.equal(readFileSync(join(there, "hidden.txt"), "utf8"), "h\nhidden edit\n");
  for (const f of ["u.txt", ".env", ".cache/spike/notes.md"]) assert.equal(readFileSync(join(there, f), "utf8"), readFileSync(join(wt, f), "utf8"));
  assert.ok(!existsSync(join(there, "node_modules")));
  assert.equal(g(proj, "for-each-ref", "refs/sova"), "", "the transport's refs are dropped");
});

test("a merge in progress is refused with the reason", async () => {
  const r = join(root, "merge");
  mkdirSync(r);
  g(r, "init", "-q", "-b", "master");
  writeFileSync(join(r, "a"), "a\n");
  g(r, "add", "a");
  g(r, "commit", "-qm", "a");
  g(r, "checkout", "-qb", "x");
  writeFileSync(join(r, "a"), "x\n");
  g(r, "commit", "-qam", "x");
  g(r, "checkout", "-q", "master");
  writeFileSync(join(r, "a"), "m\n");
  g(r, "commit", "-qam", "m");
  try {
    g(r, "merge", "-q", "x");
  } catch {
    // the conflict is the point
  }
  assert.equal((await surveyWorktree("merge", r)).refusal, "It has a merge in progress: finish or remove that first.");
});
