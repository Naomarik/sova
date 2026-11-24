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
import { havesOf, packWorktrees, publishTrees, rebuildWorktrees, SnapshotError, surveyWorktree } from "./git-snapshot";

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

test("a folder that filled up after the rebuild is never removed at publish: it refuses", async () => {
  const src = join(root, "src2");
  mkdirSync(src);
  g(src, "init", "-q", "-b", "master");
  writeFileSync(join(src, "a"), "a\n");
  g(src, "add", "a");
  g(src, "commit", "-qm", "a");
  const s = await surveyWorktree("src2", src);
  const p = await packWorktrees({ tid: "t3", trees: [s], haves: [], outDir: join(root, "pack3") });
  const target = join(root, "there3", "src2");
  const staged = await rebuildWorktrees({ repo: null, codeDir: join(root, "pack3"), tid: "t3", metas: p.metas, targets: { src2: target } });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "x"), "mine\n");
  await assert.rejects(publishTrees(staged, "t3"), (e: unknown) => e instanceof SnapshotError && e.reason === "taken");
  assert.equal(readFileSync(join(target, "x"), "utf8"), "mine\n");
});

test("a folder there that already holds the code gets the arrived loose files, replacing nothing: a differing private file is kept, the arrived one beside it", async () => {
  const src = join(root, "src4");
  mkdirSync(src);
  g(src, "init", "-q", "-b", "master");
  writeFileSync(join(src, ".gitignore"), ".env\n");
  writeFileSync(join(src, "a"), "a\n");
  g(src, "add", "-A");
  g(src, "commit", "-qm", "a");
  const target = join(root, "there4", "src4");
  g(root, "clone", "-q", src, target);
  writeFileSync(join(target, ".env"), "DSN=there\n");
  writeFileSync(join(src, ".env"), "DSN=lab\nDATA=/src/data\n");
  writeFileSync(join(src, "new.txt"), "n\n");
  const s = await surveyWorktree("src4", src);
  const p = await packWorktrees({ tid: "t4", trees: [s], haves: [], outDir: join(root, "pack4") });
  assert.deepEqual(p.metas[0]!.private, [".env"]);
  const staged = await rebuildWorktrees({ repo: null, codeDir: join(root, "pack4"), tid: "t4", metas: p.metas, targets: { src4: target } });
  assert.ok(!existsSync(join(target, "new.txt")), "nothing is in place before publish");
  const put = await publishTrees(staged, "t4", { from: "Lab A" });
  assert.equal(readFileSync(join(target, ".env"), "utf8"), "DSN=there\n", "the file there is kept");
  assert.equal(readFileSync(join(target, ".env.from-Lab-A"), "utf8"), "DSN=lab\nDATA=/src/data\n");
  assert.equal(readFileSync(join(target, "new.txt"), "utf8"), "n\n");
  assert.deepEqual(put.kept, [{ tree: "src4", path: ".env", beside: ".env.from-Lab-A" }]);
  assert.deepEqual(put.privateFiles, [join(target, ".env.from-Lab-A")]);
  assert.equal(g(target, "status", "--porcelain"), "?? new.txt\n", "the arrived private copy stays hidden from git");
  // A retry puts nothing twice.
  const again = await publishTrees(await rebuildWorktrees({ repo: null, codeDir: join(root, "pack4"), tid: "t4", metas: p.metas, targets: { src4: target } }), "t4", { from: "Lab A" });
  assert.deepEqual(again.kept, [{ tree: "src4", path: ".env", beside: ".env.from-Lab-A" }]);
  assert.ok(!existsSync(join(target, ".env.from-Lab-A-2")));
});

test("a main checkout already there (held) gets the package's commits, so the chat's linked worktree builds on them", async () => {
  const src = join(root, "src5");
  mkdirSync(src);
  g(src, "init", "-q", "-b", "master");
  writeFileSync(join(src, "a"), "a\n");
  g(src, "add", "a");
  g(src, "commit", "-qm", "a");
  const target = join(root, "there5", "src5");
  g(root, "clone", "-q", src, target);
  const wt = join(root, "wt5");
  g(src, "worktree", "add", "-q", wt, "-b", "feat5");
  writeFileSync(join(wt, "a"), "a\nnew commit\n");
  g(wt, "commit", "-qam", "on feat5");
  writeFileSync(join(wt, "a"), "a\nnew commit\nstaged\n");
  g(wt, "add", "a");
  writeFileSync(join(wt, "u.txt"), "u\n");
  const trees = [await surveyWorktree("src5", src), await surveyWorktree("wt5", wt)];
  const p = await packWorktrees({ tid: "t5", trees, haves: await havesOf(target), outDir: join(root, "pack5") });
  const there = join(root, "there5", "wt5");
  const staged = await rebuildWorktrees({ repo: null, codeDir: join(root, "pack5"), tid: "t5", metas: p.metas, targets: { src5: target, wt5: there } });
  await publishTrees(staged, "t5");
  assert.equal(facts(there), facts(wt));
  assert.equal(readFileSync(join(there, "u.txt"), "utf8"), "u\n");
  assert.equal(g(target, "for-each-ref", "refs/sova"), "", "the transport's refs are dropped");
});

test("a clean checkout of the same commit there (a project prepared there) takes the chat's tracked changes and new files; one standing on a file the changes add is refused, replacing nothing", async () => {
  const src = join(root, "src6");
  mkdirSync(src);
  g(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "lib.rs"), "fn a() {}\n");
  g(src, "add", "lib.rs");
  g(src, "commit", "-qm", "a");
  const target = join(root, "there6", "src6");
  g(root, "clone", "-q", src, target);
  const blocked = join(root, "there6b", "src6");
  g(root, "clone", "-q", src, blocked);
  writeFileSync(join(blocked, "added.rs"), "mine\n");
  writeFileSync(join(src, "lib.rs"), "fn a() {}\nfn b() {}\n");
  writeFileSync(join(src, "added.rs"), "new\n");
  g(src, "add", "added.rs");
  writeFileSync(join(src, "Cargo.lock"), "lock\n");
  const s = await surveyWorktree("src6", src);
  const p = await packWorktrees({ tid: "t6", trees: [s], haves: await havesOf(target), outDir: join(root, "pack6") });
  const staged = await rebuildWorktrees({ repo: null, codeDir: join(root, "pack6"), tid: "t6", metas: p.metas, targets: { src6: target } });
  assert.equal(readFileSync(join(target, "lib.rs"), "utf8"), "fn a() {}\n", "nothing is in place before publish");
  await publishTrees(staged, "t6");
  assert.equal(facts(target), facts(src));
  assert.equal(readFileSync(join(target, "Cargo.lock"), "utf8"), "lock\n");
  assert.equal(g(target, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1, "the check's scratch worktree is gone");
  await assert.rejects(rebuildWorktrees({ repo: null, codeDir: join(root, "pack6"), tid: "t6", metas: p.metas, targets: { src6: blocked } }), (e: unknown) => e instanceof SnapshotError && e.reason === "taken" && /added\.rs/.test(e.message));
  assert.equal(readFileSync(join(blocked, "added.rs"), "utf8"), "mine\n");
  assert.equal(g(blocked, "for-each-ref", "refs/sova"), "", "nothing of the attempt stays in that repository");
});

test("a clean clone behind the chat's commit takes its commits, branch and changes; one with changes of its own, or of another repository, is refused with the reason", async () => {
  const src = join(root, "src7");
  mkdirSync(src);
  g(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "a"), "a\n");
  g(src, "add", "a");
  g(src, "commit", "-qm", "a");
  const behind = join(root, "there7", "src7");
  g(root, "clone", "-q", src, behind);
  mkdirSync(join(behind, "target"));
  writeFileSync(join(behind, "target", "build.o"), "agent's build\n");
  const dirty = join(root, "there7d", "src7");
  g(root, "clone", "-q", src, dirty);
  writeFileSync(join(dirty, "a"), "theirs\n");
  const other = join(root, "there7o", "src7");
  mkdirSync(other, { recursive: true });
  g(other, "init", "-q", "-b", "main");
  writeFileSync(join(other, "z"), "z\n");
  g(other, "add", "z");
  g(other, "commit", "-qm", "z");
  writeFileSync(join(src, ".gitignore"), "target/\n");
  g(src, "add", ".gitignore");
  g(src, "checkout", "-qb", "feat");
  writeFileSync(join(src, "b"), "b\n");
  g(src, "add", "b");
  g(src, "commit", "-qm", "b");
  writeFileSync(join(src, "a"), "a\nunfinished\n");
  const s = await surveyWorktree("src7", src);
  const p = await packWorktrees({ tid: "t7", trees: [s], haves: [], outDir: join(root, "pack7") });
  // Yours, on main while the chat is on feat: left as it is.
  const mineBefore = facts(behind);
  await assert.rejects(rebuildWorktrees({ repo: null, codeDir: join(root, "pack7"), tid: "t7", metas: p.metas, targets: { src7: behind } }), (e: unknown) => e instanceof SnapshotError && /on its own branch main, and the chat's code is on feat; nothing was changed/.test(e.message));
  assert.equal(facts(behind), mineBefore, "the user's clone stays on main, untouched");
  // The same clone made for this transport (the Transport agent's): taken over.
  const staged = await rebuildWorktrees({ repo: null, codeDir: join(root, "pack7"), tid: "t7", metas: p.metas, targets: { src7: behind }, ours: [behind] });
  await publishTrees(staged, "t7");
  assert.equal(facts(behind), facts(src));
  assert.equal(readFileSync(join(behind, "target", "build.o"), "utf8"), "agent's build\n", "the agent's build output stays");
  assert.equal(g(behind, "rev-parse", "main").trim(), g(src, "rev-parse", "main").trim(), "its own branch stays where it was");
  const why = async (target: string) =>
    rebuildWorktrees({ repo: null, codeDir: join(root, "pack7"), tid: "t7", metas: p.metas, targets: { src7: target }, ours: [target] }).then(
      () => "",
      (e: unknown) => (e instanceof SnapshotError && e.reason === "taken" ? e.message : String(e)),
    );
  assert.match(await why(dirty), /changes of its own \(1 file\); nothing was replaced/);
  assert.equal(readFileSync(join(dirty, "a"), "utf8"), "theirs\n");
  assert.match(await why(other), /doesn't build on|another repository/);
  for (const t of [dirty, other]) assert.equal(g(t, "for-each-ref", "refs/sova"), "", "nothing of the attempt stays there");
});

test("a file there where the chat's new file needs a folder is in the way: refused by name, the file kept", async () => {
  const src = join(root, "src8");
  mkdirSync(src);
  g(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "a"), "a\n");
  g(src, "add", "a");
  g(src, "commit", "-qm", "a");
  const target = join(root, "there8", "src8");
  g(root, "clone", "-q", src, target);
  writeFileSync(join(target, "cfg"), "my cfg\n");
  mkdirSync(join(src, "cfg"));
  writeFileSync(join(src, "cfg", "app.toml"), "x = 1\n");
  g(src, "add", "cfg/app.toml");
  const p = await packWorktrees({ tid: "t8", trees: [await surveyWorktree("src8", src)], haves: [], outDir: join(root, "pack8") });
  await assert.rejects(rebuildWorktrees({ repo: null, codeDir: join(root, "pack8"), tid: "t8", metas: p.metas, targets: { src8: target } }), (e: unknown) => e instanceof SnapshotError && e.reason === "taken" && /already has cfg,/.test(e.message));
  assert.equal(readFileSync(join(target, "cfg"), "utf8"), "my cfg\n");
  assert.equal(g(target, "for-each-ref", "refs/sova"), "");
});

test("a detached clone behind the chat's commit gets the chat's branch by the edge-case rule: a suffix when that name holds another commit there", async () => {
  const src = join(root, "src9");
  mkdirSync(src);
  g(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "a"), "a\n");
  g(src, "add", "a");
  g(src, "commit", "-qm", "a");
  const target = join(root, "there9", "src9");
  g(root, "clone", "-q", src, target);
  const base = g(target, "rev-parse", "HEAD").trim();
  g(target, "checkout", "-q", "--detach");
  writeFileSync(join(src, "a"), "a\nb\n");
  g(src, "commit", "-qam", "b");
  writeFileSync(join(src, "a"), "a\nb\nwip\n");
  const p = await packWorktrees({ tid: "t9", trees: [await surveyWorktree("src9", src)], haves: [], outDir: join(root, "pack9") });
  const staged = await rebuildWorktrees({ repo: null, codeDir: join(root, "pack9"), tid: "t9", metas: p.metas, targets: { src9: target } });
  assert.equal(staged[0]!.branch, "main-2");
  assert.equal(staged[0]!.renamedFrom, "main");
  await publishTrees(staged, "t9");
  assert.equal(g(target, "rev-parse", "main").trim(), base, "its own main stays where it was");
  assert.equal(g(target, "branch", "--show-current").trim(), "main-2");
  assert.equal(g(target, "diff"), g(src, "diff"));
});
