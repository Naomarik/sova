// Run: npx tsx --test server/worktrees.test.ts
// Real throwaway git repositories and a throwaway PI_CODING_AGENT_DIR in the OS temp dir, all
// removed afterwards; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-worktrees-test-")));
after(() => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-worktrees-test--");
mkdirSync(sessionsDir, { recursive: true });

const { WorktreeInsights, execGit, pickBase, sumNumstat } = await import("./worktrees");
type Runner = typeof execGit;

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

/** A repository with `base` checked out and one commit. */
function repo(name: string, base = "master"): string {
  const dir = join(root, name);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", base);
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** A linked worktree on a new branch with `lines` added to b.txt in one commit. */
function feature(repoDir: string, name: string, lines: string[]): string {
  const wt = join(root, `${name}-wt`);
  git(repoDir, "worktree", "add", "-q", "-b", name, wt);
  writeFileSync(join(wt, "b.txt"), lines.map((l) => `${l}\n`).join(""));
  git(wt, "add", ".");
  git(wt, "commit", "-q", "-m", name);
  return wt;
}

let n = 0;
/** A session file whose header cwd is `cwd`, with one worker manifest per `workerCwds`. */
function session(cwd: string, workerCwds: string[] = []): string {
  const id = `s${++n}`;
  const path = join(sessionsDir, `2026-09-27T00-00-00-000Z_${id}.jsonl`);
  const lines = [
    { type: "session", version: 3, id, timestamp: "2026-09-27T00:00:00.000Z", cwd },
    { type: "message", id: "m1", parentId: null, timestamp: "2026-09-27T00:00:01.000Z", message: { role: "user", content: "hi" } },
    ...workerCwds.map((c, i) => ({
      type: "custom", customType: "subagents-worker-manifest", id: `w${i}`, parentId: "m1", timestamp: "2026-09-27T00:00:02.000Z",
      data: { v: 1, kind: "worker-manifest", workerId: `ag_${i}`, backend: "pi", at: 1, spec: { cwd: c, taskPreview: "t", wake: false } },
    })),
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return path;
}

async function treesOf(ins: InstanceType<typeof WorktreeInsights>, path: string) {
  const r = await ins.get([path]);
  const [only] = r.sessions;
  assert.ok(only && r.sessions.length === 1);
  assert.equal(only.sessionPath, path);
  return only.trees;
}

/** The one tree a session lists. */
async function treeOf(ins: InstanceType<typeof WorktreeInsights>, path: string) {
  const trees = await treesOf(ins, path);
  assert.equal(trees.length, 1);
  return trees[0]!;
}

test("a linked worktree with commits ahead is unmerged, with its counts", async () => {
  const r = repo("ahead");
  const wt = feature(r, "feat-a", ["x", "y", "z"]);
  git(r, "commit", "-q", "--allow-empty", "-m", "base moves");
  const trees = await treesOf(new WorktreeInsights(), session(wt));
  assert.deepEqual(trees, [
    { path: wt, source: "session", exists: true, dirty: false, branch: "feat-a", base: "master", merged: "no", ahead: 1, behind: 1, added: 3, removed: 0 },
  ]);
});

test("a fast-forward merged branch is an ancestor of the base", async () => {
  const r = repo("ff");
  const wt = feature(r, "feat-ff", ["x"]);
  git(r, "merge", "-q", "--ff-only", "feat-ff");
  const t = await treeOf(new WorktreeInsights(), session(wt));
  assert.equal(t.merged, "ancestor");
  assert.equal(t.ahead, 0);
  assert.equal(t.added, 0);
});

test("a squash-merged branch is merged by content, even after the base moved on", async () => {
  const r = repo("squash");
  const wt = feature(r, "feat-sq", ["x", "y"]);
  git(r, "merge", "-q", "--squash", "feat-sq");
  git(r, "commit", "-q", "-m", "squashed");
  writeFileSync(join(r, "a.txt"), "one\ntwo\nlater\n");
  git(r, "commit", "-q", "-am", "base moves on");
  const t = await treeOf(new WorktreeInsights(), session(wt));
  assert.equal(t.merged, "content");
  assert.equal(t.ahead, 1);
  assert.equal(t.error, undefined);
});

test("merge-tree leaves the repository's object store as it was", async () => {
  const r = repo("readonly");
  const wt = feature(r, "feat-ro", ["x"]);
  writeFileSync(join(r, "c.txt"), "base\n");
  git(r, "add", ".");
  git(r, "commit", "-q", "-m", "base adds c");
  const before = git(r, "count-objects", "-v");
  const t = await treeOf(new WorktreeInsights(), session(wt));
  assert.equal(t.merged, "no"); // merging would add b.txt: a new tree, which must not land in .git
  assert.equal(git(r, "count-objects", "-v"), before);
  assert.deepEqual(readdirSync(tmpdir()).filter((f) => f.startsWith("sova-merge-tree-")), []);
});

test("a dirty tree, untracked files included", async () => {
  const r = repo("dirty");
  const wt = feature(r, "feat-d", ["x"]);
  writeFileSync(join(wt, "new.txt"), "untracked\n");
  const t = await treeOf(new WorktreeInsights(), session(wt));
  assert.equal(t.dirty, true);
});

test("a deleted path is exists:false with nothing else; a worker in it is listed once", async () => {
  const gone = join(root, "deleted-wt");
  const trees = await treesOf(new WorktreeInsights(), session(gone, [join(gone, "sub")]));
  assert.deepEqual(trees, [{ path: gone, source: "session", exists: false }]);
});

test("no base branch: no base fields", async () => {
  const r = repo("nobase", "trunk");
  const wt = feature(r, "feat-nb", ["x"]);
  const t = await treeOf(new WorktreeInsights(), session(wt));
  assert.equal(t.branch, "feat-nb");
  for (const k of ["base", "merged", "ahead", "behind", "added", "removed", "error"] as const) assert.equal(t[k], undefined, k);
});

test("workers: the main checkout is never listed, for a worker or the session; deduped by top level", async () => {
  const r = repo("workers");
  const wt = feature(r, "feat-w", ["x"]);
  mkdirSync(join(wt, "deep"));
  const plain = join(root, "not-git");
  mkdirSync(plain);
  const trees = await treesOf(new WorktreeInsights(), session(r, [join(wt, "deep"), wt, r, plain, "relative/path"]));
  assert.deepEqual(trees.map((t) => [t.path, t.source]), [[wt, "worker"]]);
});

test("the comparison is cached until HEAD or the base moves; dirty is re-read after its TTL", async () => {
  const r = repo("cache");
  const wt = feature(r, "feat-c", ["x"]);
  const path = session(wt);
  let now = 1_000_000;
  const calls: string[][] = [];
  const run: Runner = (args, opts) => {
    calls.push([...args]);
    return execGit(args, opts);
  };
  const ins = new WorktreeInsights({ run, now: () => now });
  await treesOf(ins, path);
  assert.equal(ins.computeCount, 1);
  calls.length = 0;
  now += 1_000;
  const t = await treeOf(ins, path);
  assert.equal(ins.computeCount, 1);
  assert.equal(t.ahead, 1);
  assert.ok(!calls.some((a) => a[0] === "status"), "dirty within its TTL is not re-read");
  assert.ok(!calls.some((a) => a[0] === "rev-list" || a[0] === "merge-tree" || a[0] === "diff-tree"));

  now += 20_000;
  writeFileSync(join(wt, "b.txt"), "x\nmore\n");
  const dirty = await treeOf(ins, path);
  assert.equal(dirty.dirty, true);
  assert.equal(ins.computeCount, 1, "a working-tree change is not a new HEAD");

  git(wt, "commit", "-q", "-am", "more");
  const moved = await treeOf(ins, path);
  assert.equal(ins.computeCount, 2);
  assert.equal(moved.ahead, 2);
  assert.equal(moved.added, 2);
});

test("unknown and invalid session paths come back with no trees", async () => {
  const ins = new WorktreeInsights();
  const r = await ins.get(["/etc/passwd", join(sessionsDir, "missing.jsonl"), "relative.jsonl"]);
  assert.deepEqual(r.sessions.map((s) => s.trees), [[], [], []]);
});

test("a git failure is the tree's error, never a throw", async () => {
  const r = repo("fails");
  const wt = feature(r, "feat-f", ["x"]);
  const run: Runner = (args, opts) =>
    args[0] === "rev-list" ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: boom\n" }) : execGit(args, opts);
  const t = await treeOf(new WorktreeInsights({ run }), session(wt));
  assert.equal(t.merged, "no");
  assert.equal(t.ahead, undefined);
  assert.match(t.error ?? "", /rev-list --count: fatal: boom/);
});

test("pickBase and sumNumstat", () => {
  assert.deepEqual(pickBase("refs/heads/main\0aaa\0\nrefs/heads/master\0bbb\0\n"), { name: "master", oid: "bbb" });
  assert.deepEqual(pickBase("refs/remotes/origin/HEAD\0ccc\0refs/remotes/origin/dev\n"), { name: "origin/dev", oid: "ccc" });
  assert.equal(pickBase(""), null);
  assert.deepEqual(sumNumstat("3\t1\ta.txt\n-\t-\tbin.png\n2\t0\told => new\n"), { added: 5, removed: 1 });
});
