// A worktree's code arrives exactly (§app.transport/package, §app.transport/arrival): the two states
// the first design lost without a word (a hidden edit under skip-worktree, an intent-to-add file)
// plus a staged and an unstaged edit, an untracked file, a scratch folder and a private file, packed
// and rebuilt into a clone; dependencies stay behind. And a merge in progress is refused. And a destination
// that lacks the repository and can't clone it gets the project from the source, branches and history.
import { dropScratchAgentDir } from "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { scratchRoot } from "../test-scratch";
import { havesOf, packWorktrees, projectComesFrom, publishTrees, rebuildWorktrees, remoteReachable, resolveSubmoduleUrl, SnapshotError, submodulesOf, surveyWorktree } from "./git-snapshot";

const root = scratchRoot("sova-transport-git-");
after(() => {
  rmSync(root, { recursive: true, force: true });
  dropScratchAgentDir();
});
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

/** A project with history on master and a chat's linked worktree on feat, carrying every kind of unfinished change. */
function projectWithChat(name: string): { src: string; wt: string } {
  const src = join(root, name);
  mkdirSync(src);
  g(src, "init", "-q", "-b", "master");
  writeFileSync(join(src, ".gitignore"), ".env\n");
  writeFileSync(join(src, "a.txt"), "a\n");
  g(src, "add", "-A");
  g(src, "commit", "-qm", "one");
  writeFileSync(join(src, "a.txt"), "a\nb\n");
  g(src, "commit", "-qam", "two");
  const wt = join(root, `${name}-wt`);
  g(src, "worktree", "add", "-q", wt, "-b", "feat");
  writeFileSync(join(wt, "f.txt"), "f\n");
  g(wt, "add", "f.txt");
  g(wt, "commit", "-qm", "on feat");
  writeFileSync(join(wt, "staged.txt"), "s\n");
  g(wt, "add", "staged.txt");
  writeFileSync(join(wt, "a.txt"), "a\nb\nunstaged\n");
  writeFileSync(join(wt, "u.txt"), "u\n");
  writeFileSync(join(wt, ".env"), "K=1\n");
  return { src, wt };
}

const blobs = (cwd: string) => g(cwd, "ls-files", "-s") + g(cwd, "hash-object", "a.txt", "f.txt", "staged.txt", "u.txt", ".env");

test("a destination with no repository and no remote gets it from the package: the chat's worktree matches the source, the repository has its branches, no origin", async () => {
  const { src, wt } = projectWithChat("nr");
  const repo = join(root, "there-nr", "nr");
  assert.equal(await projectComesFrom(repo, []), "from-source", "no remote recorded: it comes from the source");
  const p = await packWorktrees({ tid: "t10", trees: [await surveyWorktree("nr-wt", wt)], haves: [], outDir: join(root, "pack10"), repo: true });
  assert.deepEqual(p.repo, { defaultBranch: "master", branches: ["master", "feat"] });
  const there = join(root, "there-nr", "nr-wt");
  const staged = await rebuildWorktrees({ repo, codeDir: join(root, "pack10"), tid: "t10", metas: p.metas, targets: { "nr-wt": there }, makeRepo: { path: repo, origin: null, defaultBranch: p.repo!.defaultBranch } });
  assert.ok(!existsSync(repo) && !existsSync(there), "nothing is in place before publish");
  await publishTrees(staged, "t10");
  assert.equal(facts(there), facts(wt));
  assert.equal(blobs(there), blobs(wt));
  assert.equal(g(repo, "rev-parse", "master"), g(src, "rev-parse", "master"));
  assert.equal(g(repo, "branch", "--show-current").trim(), "master");
  assert.equal(g(repo, "status", "--porcelain"), "");
  assert.equal(g(repo, "remote"), "", "no remote recorded: no origin");
  assert.equal(g(repo, "for-each-ref", "refs/sova", "refs/remotes"), "", "no transport refs, no remote's refs");
  assert.equal(g(repo, "log", "--format=%s", "feat"), g(src, "log", "--format=%s", "feat"), "the whole history came");
});

test("a remote unreachable from there: the project comes from the package too, origin the recorded URL without its credentials; the chat in its main checkout", async () => {
  const src = join(root, "ur");
  mkdirSync(src);
  g(src, "init", "-q", "-b", "master");
  writeFileSync(join(src, "a.txt"), "a\n");
  g(src, "add", "a.txt");
  g(src, "commit", "-qm", "one");
  const url = "https://user:SECRET@127.0.0.1:1/acme/motors.git";
  g(src, "remote", "add", "origin", url);
  g(src, "update-ref", "refs/remotes/origin/master", "HEAD");
  g(src, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/master");
  g(src, "checkout", "-qb", "feat");
  writeFileSync(join(src, "f.txt"), "f\n");
  g(src, "add", "f.txt");
  g(src, "commit", "-qm", "on feat");
  writeFileSync(join(src, "a.txt"), "a\nunstaged\n");
  const target = join(root, "there-ur", "ur");
  assert.equal(await remoteReachable(url), false);
  assert.equal(await projectComesFrom(target, [url]), "from-source");
  const p = await packWorktrees({ tid: "t11", trees: [await surveyWorktree("ur", src)], haves: [], outDir: join(root, "pack11"), repo: true });
  assert.equal(p.repo?.defaultBranch, "master", "its remote's HEAD names the default branch");
  const staged = await rebuildWorktrees({ repo: null, codeDir: join(root, "pack11"), tid: "t11", metas: p.metas, targets: { ur: target }, origin: url });
  await publishTrees(staged, "t11");
  assert.equal(facts(target), facts(src));
  assert.equal(g(target, "remote", "get-url", "origin").trim(), "https://127.0.0.1:1/acme/motors.git");
  assert.ok(!readFileSync(join(target, ".git", "config"), "utf8").includes("SECRET"), "no credentials there");
  assert.equal(g(target, "rev-parse", "master"), g(src, "rev-parse", "master"), "the default branch came");
  assert.equal(g(target, "for-each-ref", "refs/sova", "refs/remotes"), "", "never the remote's refs");
});

test("the needs answer: the project comes from this device for an unreachable remote, a clone for a reachable one; a Retry after a failed clone takes it from the source", async () => {
  const { needsAnswer } = await import("./agent");
  const bare = join(root, "reach.git");
  g(root, "clone", "-q", "--bare", projectWithChat("rc").src, bare);
  const folder = join(root, "there-rc", "rc");
  const deps = {
    stateRoot: () => join(root, "state-rc"),
    home: () => root,
    protectedRoots: () => [join(root, "state-rc")],
    device: () => "air",
    which: async (ps: string[]) => new Set(ps),
    git: async () => ({ code: 1, stdout: "" }),
    reachable: (u: string) => remoteReachable(u),
    doctor: async () => null,
    offeredModels: async () => [],
    claudeUsable: () => false,
    agentHidden: async () => [],
    confine: async () => null,
    startChat: async () => Promise.reject(new Error("no agent here")),
    link: async () => ({ error: "none" }),
    tell: async () => undefined,
    busy: () => false,
    sleep: async () => undefined,
    now: () => 0,
  };
  const gone = join(root, "gone.git");
  const far = await needsAnswer({ remotes: [gone], path: folder }, deps);
  assert.equal(far.fromSource, true);
  assert.deepEqual(far.needs, [], "its folder isn't listed as needed: it comes with the chat");
  const near = await needsAnswer({ remotes: [bare], path: folder }, deps);
  assert.equal(near.fromSource, undefined);
  assert.deepEqual(near.needs, [`${folder} doesn't exist: clone ${bare} there`]);

  // The destination's preparation: a reachable remote is cloned (by the agent) on the first try; a Retry that finds the
  // folder still without it (the clone failed) takes the project from the source, making nothing there.
  const { retry } = await import("./destination");
  const { createTransport, readTransport } = await import("./store");
  const offer = { trees: [{ name: "rc-wt", branch: "feat", main: false, rel: "rc-wt" }], repoRel: "rc", project: { remotes: [bare], roots: [] } };
  createTransport({ tid: "tr_retry01", side: "destination", mode: "copy", chatId: "c", sourceChatId: "c", title: "t", peer: "desk", peerLabel: "Desk", path: "", folder: join(root, "there-rc", "rc-wt"), state: "needs-you", ext: { offer } });
  retry({ id: "desk" }, "tr_retry01");
  for (let i = 0; i < 200 && !readTransport("tr_retry01")?.steps.prepared; i++) await new Promise((ok) => setTimeout(ok, 25));
  const r = readTransport("tr_retry01")!;
  assert.ok(r.steps.prepared, r.needsYou?.reason ?? "prepared");
  assert.equal((r.ext as { fromSource?: boolean }).fromSource, true);
  assert.deepEqual(r.haves, []);
  assert.ok(!existsSync(folder), "nothing was made there: arrival builds it from the package");
});

// ---- submodules travel like the project itself (§app.transport/edge-cases, q32) -------------------------------------

/** git with local-path submodules allowed (git refuses the file transport for them by default). */
const gs = (cwd: string, ...args: string[]) => g(cwd, "-c", "protocol.file.allow=always", ...args);
const subFacts = (cwd: string) => facts(cwd) + g(cwd, "branch", "--show-current");
/** Every file of `dir` (never `.git`) by its sha: what arrived byte for byte. */
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
/** A repository at `dir` with two commits. */
function twoCommits(dir: string, file: string): string {
  mkdirSync(dir, { recursive: true });
  g(dir, "init", "-q", "-b", "master");
  writeFileSync(join(dir, file), "1\n");
  g(dir, "add", "-A");
  g(dir, "commit", "-qm", "one");
  writeFileSync(join(dir, file), "1\n2\n");
  g(dir, "commit", "-qam", "two");
  return dir;
}

test("a parent with a checked-out submodule carrying unfinished work arrives identical where neither repository is and no remote answers", async () => {
  const samba = twoCommits(join(root, "sm1-samba"), "lib.c");
  const src = join(root, "sm1");
  twoCommits(src, "a.txt");
  writeFileSync(join(src, ".gitignore"), ".env\n");
  gs(src, "submodule", "add", "-q", samba, "services/samba");
  const url = "https://user:SECRET@127.0.0.1:1/dataico/dataico-expansion.git";
  g(src, "remote", "add", "origin", url);
  g(src, "config", "-f", ".gitmodules", "submodule.services/samba.url", "../samba.git");
  g(src, "config", "-f", ".gitmodules", "submodule.services/samba.branch", "master");
  g(src, "submodule", "sync", "-q");
  g(src, "add", "-A");
  g(src, "commit", "-qm", "samba");
  const sub = join(src, "services", "samba");
  // The submodule moved past its gitlink (the parent shows it modified), plus every kind of unfinished change.
  writeFileSync(join(sub, "lib.c"), "1\n2\n3\n");
  g(sub, "commit", "-qam", "three");
  writeFileSync(join(sub, "staged.c"), "s\n");
  g(sub, "add", "staged.c");
  writeFileSync(join(sub, "lib.c"), "1\n2\n3\nunstaged\n");
  writeFileSync(join(sub, "ita.c"), "i\n");
  g(sub, "add", "-N", "ita.c");
  writeFileSync(join(sub, "new.c"), "untracked\n");
  writeFileSync(join(sub, ".gitignore"), ".env\n");
  writeFileSync(join(sub, ".env"), "SAMBA=1\n");
  writeFileSync(join(src, "u.txt"), "parent's own\n");
  assert.equal(await remoteReachable("https://127.0.0.1:1/dataico/samba.git"), false);

  const s = await surveyWorktree("sm1", src);
  assert.equal(s.refusal, null, "submodules travel");
  assert.deepEqual(s.submodules.map((x) => [x.key, x.url, !!x.tree]), [["services/samba", "https://127.0.0.1:1/dataico/samba.git", true]]);
  assert.ok(s.loose.some((f) => f.path === "services/samba/.env" && f.kind === "private"), "its private file is listed like the parent's");
  const p = await packWorktrees({ tid: "s1", trees: [s], haves: [], outDir: join(root, "pack-s1"), repo: true, fetchable: [] });
  assert.ok(!readFileSync(join(root, "pack-s1", "sm1", "worktree.json"), "utf8").includes("SECRET"), "no credentials in the package");
  // A repack of the same state gives the same bytes.
  await packWorktrees({ tid: "s1", trees: [await surveyWorktree("sm1", src)], haves: [], outDir: join(root, "pack-s1b"), repo: true, fetchable: [] });
  assert.equal(fileHashes(join(root, "pack-s1b")), fileHashes(join(root, "pack-s1")));

  const target = join(root, "there-s1", "sm1");
  const staged = await rebuildWorktrees({ repo: null, codeDir: join(root, "pack-s1"), tid: "s1", metas: p.metas, targets: { sm1: target }, origin: url });
  assert.ok(!existsSync(target), "nothing is in place before publish");
  await publishTrees(staged, "s1");
  const there = join(target, "services", "samba");
  assert.equal(facts(target), facts(src), "the parent's HEAD, status and index (its gitlink modified) arrived");
  assert.equal(subFacts(there), subFacts(sub), "the submodule's HEAD, branch, status and index arrived");
  assert.equal(fileHashes(there), fileHashes(sub), "every file of the submodule arrived byte for byte");
  assert.equal(g(there, "log", "--format=%s"), g(sub, "log", "--format=%s"), "its whole history came");
  assert.equal(g(there, "rev-parse", "--absolute-git-dir").trim(), realpathSync(join(target, ".git", "modules", "services", "samba")), "git's own layout");
  assert.equal(g(there, "remote", "get-url", "origin").trim(), "https://127.0.0.1:1/dataico/samba.git");
  assert.equal(g(target, "config", "submodule.services/samba.url").trim(), "https://127.0.0.1:1/dataico/samba.git");
  for (const f of [join(target, ".git", "config"), join(target, ".git", "modules", "services", "samba", "config")]) assert.ok(!readFileSync(f, "utf8").includes("SECRET"), `no credentials in ${f}`);
  assert.equal(g(there, "for-each-ref", "refs/sova"), "", "the transport's refs are dropped");
  assert.equal(g(target, "status", "--porcelain=v1", "-uall"), g(src, "status", "--porcelain=v1", "-uall"));
});

test("a relative submodule URL resolves against the parent's recorded remote, an scp-like one too, without asking it anything", async () => {
  assert.equal(resolveSubmoduleUrl("../samba.git", "git@gitlab.example.invalid:dataico/dataico-expansion.git"), "git@gitlab.example.invalid:dataico/samba.git");
  assert.equal(resolveSubmoduleUrl("../../x.git", "git@host.invalid:repo.git"), "", "nothing left to strip");
  assert.equal(resolveSubmoduleUrl("./lib", "https://u:p@host.invalid/a/b.git/"), "https://host.invalid/a/b.git/lib");
  assert.equal(resolveSubmoduleUrl("../samba.git", null), "", "no remote recorded: no address there");
  const samba = twoCommits(join(root, "sm2-samba"), "lib.c");
  const src = twoCommits(join(root, "sm2"), "a.txt");
  gs(src, "submodule", "add", "-q", samba, "services/samba");
  g(src, "config", "-f", ".gitmodules", "submodule.services/samba.url", "../samba.git");
  g(src, "remote", "add", "origin", "git@gitlab.example.invalid:dataico/dataico-expansion.git");
  g(src, "add", "-A");
  g(src, "commit", "-qm", "samba");
  const s = await surveyWorktree("sm2", src);
  assert.equal(s.submodules[0]?.url, "git@gitlab.example.invalid:dataico/samba.git", "resolved against the parent's remote, not the folder it was cloned from");
  const p = await packWorktrees({ tid: "s2", trees: [s], haves: [], outDir: join(root, "pack-s2"), repo: true });
  const target = join(root, "there-s2", "sm2");
  await publishTrees(await rebuildWorktrees({ repo: null, codeDir: join(root, "pack-s2"), tid: "s2", metas: p.metas, targets: { sm2: target }, origin: "git@gitlab.example.invalid:dataico/dataico-expansion.git" }), "s2");
  assert.equal(g(join(target, "services", "samba"), "remote", "get-url", "origin").trim(), "git@gitlab.example.invalid:dataico/samba.git");
  assert.equal(subFacts(join(target, "services", "samba")), subFacts(join(src, "services", "samba")));
});

test("a submodule never checked out arrives as its gitlink only and stays so, and the arrival says so", async () => {
  const samba = twoCommits(join(root, "sm3-samba"), "lib.c");
  const up = twoCommits(join(root, "sm3-up"), "a.txt");
  gs(up, "submodule", "add", "-q", samba, "services/samba");
  g(up, "add", "-A");
  g(up, "commit", "-qm", "samba");
  // A clone without --recurse-submodules: only the gitlink, an empty folder.
  const src = join(root, "sm3");
  g(root, "clone", "-q", up, src);
  writeFileSync(join(src, "a.txt"), "1\n2\nwip\n");
  assert.equal(readdirSync(join(src, "services", "samba")).length, 0);
  const s = await surveyWorktree("sm3", src);
  assert.equal(s.refusal, null);
  assert.equal(s.submodules[0]?.tree, null);
  const p = await packWorktrees({ tid: "s3", trees: [s], haves: [], outDir: join(root, "pack-s3"), repo: true });
  const target = join(root, "there-s3", "sm3");
  const staged = await rebuildWorktrees({ repo: null, codeDir: join(root, "pack-s3"), tid: "s3", metas: p.metas, targets: { sm3: target }, origin: up });
  assert.deepEqual(staged[0]!.uninitialised, ["services/samba"], "the arrival names it");
  await publishTrees(staged, "s3");
  assert.equal(facts(target), facts(src));
  assert.deepEqual(readdirSync(join(target, "services", "samba")), [], "its folder is there, empty, as it was");
  assert.ok(!existsSync(join(target, ".git", "modules")), "no repository was made for it");
  assert.match(g(target, "submodule", "status"), /^-[0-9a-f]{40} services\/samba/, "uninitialised there too");
});

test("a nested submodule in a chat's linked worktree arrives with both repositories in git's layout; the outer one's commits come by its reachable remote, the inner one's history from the package", async () => {
  const inner = twoCommits(join(root, "sm4-inner"), "in.c");
  const outerUp = twoCommits(join(root, "sm4-outer-up"), "out.c");
  gs(outerUp, "submodule", "add", "-q", inner, "vendor/inner");
  g(outerUp, "add", "-A");
  g(outerUp, "commit", "-qm", "inner");
  const outerRemote = join(root, "sm4-outer.git");
  g(root, "clone", "-q", "--bare", outerUp, outerRemote);
  const src = twoCommits(join(root, "sm4"), "a.txt");
  gs(src, "submodule", "add", "-q", outerRemote, "lib/outer");
  gs(src, "submodule", "update", "-q", "--init", "--recursive");
  g(src, "add", "-A");
  g(src, "commit", "-qm", "outer");
  const wt = join(root, "sm4-wt");
  g(src, "worktree", "add", "-q", wt, "-b", "feat");
  gs(wt, "submodule", "update", "-q", "--init", "--recursive");
  const outer = join(wt, "lib", "outer");
  const innerHere = join(outer, "vendor", "inner");
  // Detached, as git submodule update leaves them; work in both, the outer one with a commit its remote lacks.
  writeFileSync(join(outer, "out.c"), "1\n2\nlocal\n");
  g(outer, "commit", "-qam", "local only");
  writeFileSync(join(innerHere, "in.c"), "1\n2\nunstaged\n");
  writeFileSync(join(innerHere, "n.txt"), "untracked\n");
  // The inner one's remote is a local folder this test removes: the destination can't fetch it.
  rmSync(inner, { recursive: true, force: true });
  const s = await surveyWorktree("sm4-wt", wt);
  assert.equal(s.refusal, null);
  assert.deepEqual(s.submodules[0]?.tree?.submodules.map((x) => x.key), ["lib/outer/vendor/inner"]);
  const reach = await Promise.all(submodulesOf([s]).map(async (x) => ((await remoteReachable(x.url)) ? x.key : null)));
  assert.deepEqual(reach.filter(Boolean), ["lib/outer"], "only the outer one's remote answers");
  const p = await packWorktrees({ tid: "s4", trees: [s], haves: [], outDir: join(root, "pack-s4"), repo: true, fetchable: ["lib/outer"] });
  const outerMeta = p.metas[0]!.submodules![0]!.repo!;
  assert.match(g(root, "bundle", "list-heads", join(root, "pack-s4", outerMeta.dir, "commits.bundle")), /refs\/sova\/transport\/s4\/snap/);
  /** A bundle's prerequisites (the commits it builds on), from its header. */
  const needs = (dir: string) => {
    const head = readFileSync(join(root, "pack-s4", dir, "commits.bundle")).toString("latin1");
    return head.slice(0, head.indexOf("\n\n")).split("\n").filter((l) => l.startsWith("-"));
  };
  assert.ok(needs(outerMeta.dir).length > 0, "the outer one carries only what its remote lacks");
  execFileSync("git", ["bundle", "verify", "-q", join(root, "pack-s4", outerMeta.dir, "commits.bundle")], { cwd: outerRemote, stdio: "ignore" });
  assert.deepEqual(needs(outerMeta.submodules![0]!.repo!.dir), [], "the inner one carries its whole history");
  const repo = join(root, "there-s4", "sm4");
  const there = join(root, "there-s4", "sm4-wt");
  const staged = await rebuildWorktrees({ repo, codeDir: join(root, "pack-s4"), tid: "s4", metas: p.metas, targets: { "sm4-wt": there }, makeRepo: { path: repo, origin: null, defaultBranch: p.repo!.defaultBranch } });
  assert.ok(!existsSync(there), "nothing is in place before publish");
  await publishTrees(staged, "s4");
  assert.equal(facts(there), facts(wt));
  assert.equal(subFacts(join(there, "lib", "outer")), subFacts(outer));
  assert.equal(subFacts(join(there, "lib", "outer", "vendor", "inner")), subFacts(innerHere));
  assert.equal(fileHashes(there), fileHashes(wt), "every file, both submodules' included, arrived byte for byte");
  assert.equal(g(join(there, "lib", "outer"), "rev-parse", "--absolute-git-dir").trim(), realpathSync(join(g(there, "rev-parse", "--absolute-git-dir").trim(), "modules", "lib", "outer")), "in the worktree's own git folder, as git lays it out");
  assert.ok(g(repo, "worktree", "list", "--porcelain").includes(`worktree ${realpathSync(there)}\n`), "the worktree is registered where it is");
  assert.equal(g(there, "status", "--porcelain=v1", "-uall"), g(wt, "status", "--porcelain=v1", "-uall"));
});

test("a clone there with its submodule checked out at the gitlink (a project prepared there) takes the chat's submodule state at publish, replacing nothing", async () => {
  const samba = join(root, "sm5-samba.git");
  g(root, "clone", "-q", "--bare", twoCommits(join(root, "sm5-samba-up"), "lib.c"), samba);
  const up = twoCommits(join(root, "sm5-up"), "a.txt");
  gs(up, "submodule", "add", "-q", samba, "services/samba");
  g(up, "add", "-A");
  g(up, "commit", "-qm", "samba");
  const bare = join(root, "sm5.git");
  g(root, "clone", "-q", "--bare", up, bare);
  const src = join(root, "sm5");
  gs(root, "clone", "-q", "--recurse-submodules", bare, src);
  const target = join(root, "there-s5", "sm5");
  gs(root, "clone", "-q", "--recurse-submodules", bare, target);
  writeFileSync(join(target, "services", "samba", "mine.txt"), "the agent's own\n");
  const sub = join(src, "services", "samba");
  writeFileSync(join(sub, "lib.c"), "1\n2\n3\n");
  g(sub, "commit", "-qam", "three");
  writeFileSync(join(sub, "lib.c"), "1\n2\n3\nunstaged\n");
  writeFileSync(join(sub, "mine.txt"), "the chat's\n");
  const s = await surveyWorktree("sm5", src);
  const p = await packWorktrees({ tid: "s5", trees: [s], haves: await havesOf(target), outDir: join(root, "pack-s5"), fetchable: ["services/samba"] });
  const staged = await rebuildWorktrees({ repo: null, codeDir: join(root, "pack-s5"), tid: "s5", metas: p.metas, targets: { sm5: target } });
  assert.equal(readFileSync(join(target, "services", "samba", "lib.c"), "utf8"), "1\n2\n", "nothing is in place before publish");
  const put = await publishTrees(staged, "s5", { from: "Lab" });
  assert.equal(facts(target), facts(src));
  assert.equal(readFileSync(join(target, "services", "samba", "mine.txt"), "utf8"), "the agent's own\n", "the file there is kept");
  assert.equal(readFileSync(join(target, "services", "samba", "mine.txt.from-Lab"), "utf8"), "the chat's\n");
  assert.deepEqual(put.kept, [{ tree: "sm5", path: "services/samba/mine.txt", beside: "services/samba/mine.txt.from-Lab" }]);
  rmSync(join(target, "services", "samba", "mine.txt.from-Lab"));
  assert.equal(subFacts(join(target, "services", "samba")), subFacts(sub), "the submodule's HEAD, status and index are the chat's");
  assert.equal(g(target, "worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree ")).length, 1, "the check's scratch worktree is gone");
});
