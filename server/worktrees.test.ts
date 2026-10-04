// Run: npx tsx --test server/worktrees.test.ts
// Real throwaway git repositories and a throwaway PI_CODING_AGENT_DIR in the OS temp dir, all
// removed afterwards; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync, symlinkSync, unlinkSync, readFileSync, statSync, utimesSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-worktrees-test-")));
after(() => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-worktrees-test--");
mkdirSync(sessionsDir, { recursive: true });

const { WorktreeInsights, execGit, pickBase, sumNumstat, worktreeStamp } = await import("./worktrees");
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
  // Its own scratch root: the OS temp dir is shared with every other process making these.
  const scratchDir = mkdtempSync(join(root, "scratch-"));
  const t = await treeOf(new WorktreeInsights({ scratchDir }), session(wt));
  assert.equal(t.merged, "no"); // merging would add b.txt: a new tree, which must not land in .git
  assert.equal(git(r, "count-objects", "-v"), before);
  assert.deepEqual(readdirSync(scratchDir), [], "the scratch object directory is removed");
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

test("unchanged board/readiness fanout shares Git facts; only dirty polls survive at 20 seconds", async () => {
  const r = repo("fanout");
  const wt = feature(r, "feat-fanout", ["x"]);
  const a = session(wt, [wt]);
  const b = session(wt);
  let now = 1000;
  const calls: string[][] = [];
  const ins = new WorktreeInsights({ now: () => now, run: (args, opts) => { calls.push([...args]); return execGit(args, opts); } });
  const first = await Promise.all([ins.get([a, b]), ins.treeStatus(wt), ins.treeStatus(wt)]);
  assert.equal(calls.filter((a) => a[0] === "status").length, 1);
  assert.equal(calls.filter((a) => a[0] === "for-each-ref").length, 1);
  assert.equal(calls.filter((a) => a[0] === "log").length, 2);
  assert.equal(ins.computeCount, 1);
  assert.ok(calls.some((a) => a[0] === "log" && a.at(-1) !== "HEAD"), "logs use resolved OIDs");
  calls.length = 0;
  now += 15000;
  const second = await Promise.all([ins.get([a, b]), ins.treeStatus(wt)]);
  assert.deepEqual(second[0].sessions, first[0].sessions);
  assert.deepEqual(second[1], first[1]);
  assert.deepEqual(calls.map((a) => a[0]), ["status"]);
  calls.length = 0;
  now += 20000;
  await ins.treeStatus(wt);
  assert.deepEqual(calls.map((a) => a[0]), ["status"], "supported unchanged metadata has no TTL Git refresh");
});

test("equivalent empty worktree configs share facts without token ping-pong, distinct configs remain separate", async () => {
  const r = repo("config-contexts");
  const a = feature(r, "feat-context-a", ["x"]);
  const b = join(root, "feat-context-b-wt");
  git(r, "worktree", "add", "-q", "-b", "feat-context-b", b, "feat-context-a");
  git(r, "config", "extensions.worktreeConfig", "true");
  const configA = join(git(a, "rev-parse", "--absolute-git-dir"), "config.worktree");
  const configB = join(git(b, "rev-parse", "--absolute-git-dir"), "config.worktree");
  writeFileSync(configA, "");
  writeFileSync(configB, "");
  assert.notEqual(statSync(configA).ino, statSync(configB).ino);
  let now = 1000;
  const calls: string[][] = [];
  const ins = new WorktreeInsights({ now: () => now, run: (args, opts) => { calls.push([...args]); return execGit(args, opts); } });
  const initial = await Promise.all([ins.treeStatus(a), ins.treeStatus(b)]);
  assert.equal(initial[0]?.head, initial[1]?.head);
  assert.equal(calls.filter((args) => args[0] === "for-each-ref").length, 1);
  assert.equal(calls.filter((args) => args[0] === "log").length, 2);
  assert.equal(ins.computeCount, 1);
  for (let turn = 0; turn < 3; turn++) {
    calls.length = 0;
    now += 20000;
    await ins.treeStatus(a);
    await ins.treeStatus(b);
    await Promise.all(Array.from({ length: 8 }, (_, i) => ins.treeStatus(i % 2 ? a : b)));
    assert.deepEqual(calls.map((args) => args[0]), ["status", "status"], "warm alternating and parallel contexts do not respawn metadata/log/comparison");
  }
  writeFileSync(configA, "[core]\n\tabbrev = 7\n");
  writeFileSync(configB, "[core]\n\tabbrev = 10\n");
  assert.equal((await execGit(["config", "--get", "core.abbrev"], { cwd: a })).stdout.trim(), "7");
  assert.equal((await execGit(["config", "--get", "core.abbrev"], { cwd: b })).stdout.trim(), "10");
  calls.length = 0;
  await Promise.all([ins.treeStatus(a), ins.treeStatus(b)]);
  assert.equal(calls.filter((args) => args[0] === "for-each-ref").length, 2, "genuinely different effective configurations do not join");
  assert.equal(ins.computeCount, 3);
  calls.length = 0;
  await ins.treeStatus(a);
  await ins.treeStatus(b);
  assert.equal(calls.length, 0, "distinct contexts retain independent settled observations rather than evicting one another");
});

test("an empty config A-B-A change invalidates a shared in-flight answer for every joined reader", async () => {
  const r = repo("config-generation");
  const a = feature(r, "feat-config-generation-a", ["x"]);
  const b = join(root, "feat-config-generation-b-wt");
  git(r, "worktree", "add", "-q", "-b", "feat-config-generation-b", b, "feat-config-generation-a");
  const config = join(git(a, "rev-parse", "--absolute-git-dir"), "config.worktree");
  const other = join(git(b, "rev-parse", "--absolute-git-dir"), "config.worktree");
  writeFileSync(config, "");
  writeFileSync(other, "");
  const head = git(a, "rev-parse", "HEAD");
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  const gate = new Promise<void>((r) => { release = r; });
  let joinedEntered!: () => void;
  const joinedStarted = new Promise<void>((r) => { joinedEntered = r; });
  let once = true;
  const ins = new WorktreeInsights({ run: async (args, opts) => {
    if (opts.cwd === b && args[0] === "rev-parse" && args.at(-1) === "HEAD") joinedEntered();
    if (args[0] === "for-each-ref" && once) {
      once = false;
      writeFileSync(config, "[core]\n\tabbrev = 10\n");
      entered();
      await gate;
      writeFileSync(config, "");
      // A deterministic runner supplies a different valid Git answer for the intermediate
      // context. Neither the owner nor a joined empty context may certify or receive it.
      return { code: 0, stdout: `refs/heads/master\0${head}\0\n`, stderr: "" };
    }
    return execGit(args, opts);
  } });
  const owner = ins.treeStatus(a);
  await started;
  const joined = ins.treeStatus(b);
  await joinedStarted;
  release();
  const values = await Promise.all([owner, joined]);
  assert.equal(values[0]?.ahead, 1);
  assert.equal(values[1]?.ahead, 1);
  assert.equal((await ins.treeStatus(a))?.ahead, 1);
  assert.equal((await ins.treeStatus(b))?.ahead, 1);
});

test("external HEAD/base motion, equal-OID branch switch, packed refs and base preference invalidate", async () => {
  const r = repo("external", "main");
  const wt = feature(r, "feat-external", ["x"]);
  const ins = new WorktreeInsights();
  const original = await ins.treeStatus(wt);
  assert.equal(original?.base, "main");
  git(wt, "branch", "alias");
  git(wt, "checkout", "-q", "alias");
  const switched = await ins.treeStatus(wt);
  assert.equal(switched?.head, original?.head);
  assert.equal(switched?.branch, "alias");
  git(wt, "checkout", "-q", "--detach");
  assert.equal((await ins.treeStatus(wt))?.branch, undefined);
  git(r, "branch", "master", "main");
  assert.equal((await ins.treeStatus(wt))?.base, "master");
  git(r, "pack-refs", "--all", "--prune");
  assert.equal((await ins.treeStatus(wt))?.base, "master");
  git(r, "update-ref", "refs/heads/master", original!.head!);
  const landed = await ins.treeStatus(wt);
  assert.equal(landed?.merged, "ancestor");
  assert.equal(landed?.ahead, 0);
  git(r, "pack-refs", "--all", "--prune");
  git(r, "update-ref", "-d", "refs/heads/master");
  assert.equal((await ins.treeStatus(wt))?.base, "main");
  git(wt, "commit", "-q", "--allow-empty", "-m", "WIP external");
  const newer = await ins.treeStatus(wt);
  assert.notEqual(newer?.head, original?.head);
  assert.equal(newer?.ahead, 2);
  assert.equal(newer?.subjects?.[0], "WIP external");
  git(wt, "commit", "-q", "--allow-empty", "--amend", "-m", "amended external");
  const amended = await ins.treeStatus(wt);
  assert.notEqual(amended?.head, newer?.head);
  assert.equal(amended?.subjects?.[0], "amended external");
  git(wt, "reset", "-q", "--hard", original!.head!);
  assert.equal((await ins.treeStatus(wt))?.head, original?.head);
});

test("packed-only base movement is visible even with unchanged file size and mtime", async () => {
  const r = repo("packed-only");
  const wt = feature(r, "feat-packed-only", ["x"]);
  git(r, "pack-refs", "--all", "--prune");
  const ins = new WorktreeInsights();
  const first = await ins.treeStatus(wt);
  assert.equal(first?.merged, "no");
  const packed = join(r, ".git", "packed-refs");
  const before = statSync(packed);
  const text = readFileSync(packed, "utf8");
  const rewritten = text.replace(/^[a-f0-9]+ refs\/heads\/master$/m, `${first!.head!} refs/heads/master`);
  assert.notEqual(text, rewritten);
  assert.equal(text.length, rewritten.length);
  writeFileSync(packed, rewritten);
  utimesSync(packed, before.atime, before.mtime);
  const landed = await ins.treeStatus(wt);
  assert.equal(landed?.merged, "ancestor");
  assert.equal(landed?.ahead, 0);
});

test("remote symbolic base and push observations track external remote movement without fetching", async () => {
  const r = repo("remote", "trunk");
  const wt = feature(r, "feat-remote", ["x"]);
  const base = git(r, "rev-parse", "trunk");
  const head = git(wt, "rev-parse", "HEAD");
  git(r, "update-ref", "refs/remotes/origin/trunk", base);
  git(r, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
  const calls: string[][] = [];
  const ins = new WorktreeInsights({ run: (args, opts) => { calls.push([...args]); return execGit(args, opts); } });
  assert.equal((await ins.treeStatus(wt))?.base, "origin/trunk");
  assert.equal(await ins.pushed(wt, "trunk", head), false);
  calls.length = 0;
  assert.equal(await ins.pushed(wt, "trunk", head), false);
  assert.equal(calls.length, 0);
  git(r, "update-ref", "refs/remotes/origin/trunk", head);
  assert.equal(await ins.pushed(wt, "trunk", head), true);
  git(r, "update-ref", "refs/remotes/origin/other", base);
  git(r, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/other");
  assert.equal((await ins.treeStatus(wt))?.base, "origin/other");
  git(r, "update-ref", "-d", "refs/remotes/origin/trunk");
  assert.equal(await ins.pushed(wt, "trunk", head), undefined);
  assert.ok(!calls.some((a) => a[0] === "fetch"));
});

test("discovery notices new nested repositories, symlink retarget and same-path worktree recreation", async () => {
  const r = repo("discovery");
  const wt = feature(r, "feat-discovery", ["x"]);
  const plain = join(root, "plain-discovery");
  mkdirSync(plain);
  const ins = new WorktreeInsights();
  const plainSession = session(plain);
  assert.deepEqual(await treesOf(ins, plainSession), []);
  const alias = join(root, "alias-discovery");
  symlinkSync(wt, alias);
  const aliasSession = session(alias);
  assert.equal((await treeOf(ins, aliasSession)).branch, "feat-discovery");
  unlinkSync(alias);
  symlinkSync(r, alias);
  assert.deepEqual(await treesOf(ins, aliasSession), []);
  const deep = join(wt, "nested");
  mkdirSync(deep);
  const deepSession = session(deep);
  assert.equal((await treeOf(ins, deepSession)).path, wt);
  git(deep, "init", "-q", "-b", "nested");
  assert.deepEqual(await treesOf(ins, deepSession), [], "new nested main repo excludes the outer linked tree");
  rmSync(deep, { recursive: true, force: true });
  git(r, "worktree", "remove", "--force", wt);
  assert.deepEqual(await treesOf(ins, aliasSession), []);
  const path = session(wt);
  assert.equal((await treeOf(ins, path)).exists, false);
  git(r, "worktree", "add", "-q", "-b", "recreated", wt);
  assert.equal((await treeOf(ins, path)).branch, "recreated");
});

test("dirty misses singleflight and failures retry without hiding partial successful metadata", async () => {
  const r = repo("dirty-flight");
  const wt = feature(r, "feat-dirty-flight", ["x"]);
  let now = 1000;
  let statuses = 0;
  let fail = false;
  let release!: () => void;
  let entered!: () => void;
  let gate: Promise<void> | null = null;
  const ins = new WorktreeInsights({ now: () => now, run: async (args, opts) => {
    if (args[0] === "status") {
      statuses++;
      if (gate) { entered(); await gate; }
      if (fail) return { code: 128, stdout: "", stderr: "dirty failed" };
    }
    return execGit(args, opts);
  } });
  await ins.treeStatus(wt);
  now += 10000;
  writeFileSync(join(wt, "untracked"), "dirty");
  writeFileSync(join(wt, "b.txt"), "unstaged\n");
  gate = new Promise<void>((r) => { release = r; });
  const started = new Promise<void>((r) => { entered = r; });
  const a = ins.treeStatus(wt);
  await started;
  const b = ins.treeStatus(wt);
  release();
  const values = await Promise.all([a, b]);
  assert.equal(statuses, 2);
  assert.deepEqual(values[0], values[1]);
  assert.equal(values[0]?.dirtyCount, 2);
  gate = null;
  fail = true;
  now += 10000;
  const broken = await ins.treeStatus(wt);
  assert.match(broken?.error ?? "", /dirty failed/);
  assert.equal(broken?.ahead, 1);
  fail = false;
  assert.equal((await ins.treeStatus(wt))?.dirty, true);
  assert.equal(statuses, 4, "failure was not cached");
});

test("old in-flight HEAD generation cannot overwrite a newer completed observation", async () => {
  const r = repo("generation");
  const wt = feature(r, "feat-generation", ["x"]);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const started = new Promise<void>((r) => { entered = r; });
  let hold = true;
  let heads = 0;
  const ins = new WorktreeInsights({ run: async (args, opts) => {
    const result = await execGit(args, opts);
    if (args[0] === "rev-parse" && args.at(-1) === "HEAD") {
      heads++;
      if (hold) { hold = false; entered(); await gate; }
    }
    return result;
  } });
  const old = ins.treeStatus(wt);
  await started;
  git(wt, "commit", "-q", "--allow-empty", "-m", "new generation");
  const fresh = await ins.treeStatus(wt);
  assert.equal(fresh?.subjects?.[0], "new generation");
  release();
  await old;
  const again = await ins.treeStatus(wt);
  assert.equal(again?.head, fresh?.head);
  assert.equal(heads, 2, "old completion did not evict or replace the newer cached HEAD");
});

test("packed replacement refs and replacement environment changes invalidate immutable facts", async () => {
  const r = repo("replacements");
  const wt = feature(r, "feat-replacements", ["x"]);
  const head = git(wt, "rev-parse", "HEAD");
  const base = git(r, "rev-parse", "master");
  const tree = git(wt, "rev-parse", "HEAD^{tree}");
  const one = git(wt, "commit-tree", tree, "-p", base, "-m", "WIP replacement one");
  const two = git(wt, "commit-tree", tree, "-p", base, "-m", "WIP replacement two");
  const ins = new WorktreeInsights();
  assert.equal((await ins.treeStatus(wt))?.subjects?.[0], "feat-replacements");
  git(wt, "replace", head, one);
  git(r, "pack-refs", "--all", "--prune");
  assert.ok(readFileSync(join(r, ".git/packed-refs"), "utf8").includes(`refs/replace/${head}`));
  assert.equal((await ins.treeStatus(wt))?.subjects?.[0], "WIP replacement one");
  git(wt, "replace", "-f", head, two);
  git(r, "pack-refs", "--all", "--prune");
  assert.equal((await ins.treeStatus(wt))?.subjects?.[0], "WIP replacement two");
  const before = process.env.GIT_NO_REPLACE_OBJECTS;
  try {
    process.env.GIT_NO_REPLACE_OBJECTS = "1";
    assert.equal((await ins.treeStatus(wt))?.subjects?.[0], "feat-replacements");
  } finally {
    if (before === undefined) delete process.env.GIT_NO_REPLACE_OBJECTS;
    else process.env.GIT_NO_REPLACE_OBJECTS = before;
  }
  assert.equal((await ins.treeStatus(wt))?.subjects?.[0], "WIP replacement two");
});

test("symlinked subdirectories validate physical ancestor discovery boundaries", async () => {
  const r = repo("physical");
  const wt = feature(r, "feat-physical", ["x"]);
  const deep = join(wt, "deep");
  const inner = join(deep, "inner");
  mkdirSync(inner, { recursive: true });
  const alias = join(root, "physical-alias");
  symlinkSync(inner, alias);
  const path = session(alias);
  const ins = new WorktreeInsights();
  assert.equal((await treeOf(ins, path)).path, wt);
  renameSync(join(wt, ".git"), join(wt, ".git-hidden"));
  assert.deepEqual(await treesOf(ins, path), [], "physical marker deletion invalidates cached layout");
  renameSync(join(wt, ".git-hidden"), join(wt, ".git"));
  assert.equal((await treeOf(ins, path)).path, wt);
  git(deep, "init", "-q", "-b", "physical-nested");
  assert.deepEqual(await treesOf(ins, path), [], "physical intermediate main repo changes discovery boundary");
});

test("a dependency changed A to B to A during a read cannot certify the intermediate answer", async () => {
  const r = repo("aba");
  const wt = feature(r, "feat-aba", ["x"]);
  const original = git(wt, "rev-parse", "HEAD");
  git(wt, "commit", "-q", "--allow-empty", "-m", "intermediate B");
  const intermediate = git(wt, "rev-parse", "HEAD");
  git(wt, "reset", "-q", "--hard", original);
  const ref = join(r, ".git/refs/heads/feat-aba");
  const identity = statSync(ref).ino;
  let once = true;
  let heads = 0;
  const ins = new WorktreeInsights({ run: async (args, opts) => {
    if (args[0] === "rev-parse" && args.at(-1) === "HEAD") {
      heads++;
      if (once) {
        once = false;
        // In-place writes keep inode/birthtime unchanged; a content/identity-only token would
        // wrongly certify the intervening B result after the same A bytes are restored.
        writeFileSync(ref, `${intermediate}\n`);
        const answer = await execGit(args, opts);
        writeFileSync(ref, `${original}\n`);
        assert.equal(statSync(ref).ino, identity);
        return answer;
      }
    }
    return execGit(args, opts);
  } });
  await ins.treeStatus(wt);
  assert.equal((await ins.treeStatus(wt))?.head, original);
  assert.equal(heads, 2, "ctime prevents certifying intermediate B under restored contents A");
});

test("independent repositories with identical OIDs never share facts", async () => {
  const r = repo("identity-a");
  const a = feature(r, "feat-identity", ["x"]);
  const other = join(root, "identity-b");
  git(root, "clone", "-q", "--no-local", r, other);
  const b = join(root, "identity-b-wt");
  git(other, "worktree", "add", "-q", "-b", "identity-other", b, "origin/feat-identity");
  const ins = new WorktreeInsights();
  const values = await Promise.all([ins.treeStatus(a), ins.treeStatus(b)]);
  assert.equal(values[0]?.head, values[1]?.head);
  assert.notEqual(values[0]?.branch, values[1]?.branch);
  assert.equal(ins.computeCount, 2, "same OIDs in separate repositories cannot collide");
});

test("injected configuration includes cannot certify a reusable discovery answer", async () => {
  const r = repo("injected-config");
  const wt = feature(r, "feat-injected-config", ["x"]);
  const config = join(root, "injected-config-fixture");
  writeFileSync(config, "[core]\n\tbare = false\n");
  const keys = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
  const saved = keys.map((key) => process.env[key]);
  try {
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "include.path";
    process.env.GIT_CONFIG_VALUE_0 = config;
    let discoveries = 0;
    const ins = new WorktreeInsights({ run: (args, opts) => {
      if (args[0] === "rev-parse" && args.includes("--show-toplevel")) discoveries++;
      return execGit(args, opts);
    } });
    const path = session(wt);
    assert.equal((await treeOf(ins, path)).exists, true);
    writeFileSync(config, "[core]\n\tbare = true\n");
    const actual = await execGit(["config", "--get", "core.bare"], { cwd: wt });
    assert.equal(actual.stdout.trim(), "true", "Git sees the external included config's changed value");
    await treesOf(ins, path);
    assert.equal(discoveries, 2, "injected includes force requested Git discovery, not indefinite layout reuse");
  } finally {
    for (let i = 0; i < keys.length; i++) {
      if (saved[i] === undefined) delete process.env[keys[i]!]; else process.env[keys[i]!] = saved[i];
    }
  }
});

test("system configuration with Git's false NOSYSTEM value remains a validated dependency", async () => {
  const r = repo("system-config");
  const wt = feature(r, "feat-system-config", ["x"]);
  const config = join(root, "system-config-fixture");
  writeFileSync(config, "[core]\n\tabbrev = 7\n");
  const oldSystem = process.env.GIT_CONFIG_SYSTEM;
  const oldNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  let logs = 0;
  try {
    process.env.GIT_CONFIG_SYSTEM = config;
    process.env.GIT_CONFIG_NOSYSTEM = "0";
    const ins = new WorktreeInsights({ run: (args, opts) => { if (args[0] === "log") logs++; return execGit(args, opts); } });
    await ins.treeStatus(wt);
    const before = logs;
    await ins.treeStatus(wt);
    assert.equal(logs, before);
    writeFileSync(config, "[core]\n\tabbrev = 10\n");
    const actual = await execGit(["config", "--get", "core.abbrev"], { cwd: wt });
    assert.equal(actual.stdout.trim(), "10", "Git really reads the enabled system fixture");
    await ins.treeStatus(wt);
    assert.ok(logs > before, "mutable system configuration invalidates immutable-fact reuse");
  } finally {
    if (oldSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = oldSystem;
    if (oldNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = oldNoSystem;
  }
});

test("unsupported dependency configuration is conservatively read again", async () => {
  const r = repo("unsupported");
  const wt = feature(r, "feat-unsupported", ["x"]);
  const included = join(root, "included-config");
  writeFileSync(included, "[core]\n\tbare = false\n");
  git(r, "config", "include.path", included);
  let heads = 0;
  const ins = new WorktreeInsights({ run: (args, opts) => {
    if (args[0] === "rev-parse" && args.at(-1) === "HEAD") heads++;
    return execGit(args, opts);
  } });
  await ins.treeStatus(wt);
  await ins.treeStatus(wt);
  assert.equal(heads, 2, "unknown included configuration never certifies indefinite metadata reuse");
  git(r, "config", "--unset", "include.path");
  const repoConfig = join(r, ".git/config");
  writeFileSync(repoConfig, `${readFileSync(repoConfig, "utf8")}\n[merge.fixture]\n\tdriver = false\n`);
  assert.equal(git(r, "config", "--get", "merge.fixture.driver"), "false", "Git accepts the deprecated subsection syntax");
  await ins.treeStatus(wt);
  await ins.treeStatus(wt);
  assert.equal(heads, 4, "external merge drivers in either subsection syntax are unsupported dependencies");
});

test("settled observations are capped and unseen values expire without stranding flights", async () => {
  let now = 0;
  const ins = new WorktreeInsights({ now: () => now });
  // Exercise the generic cache with deterministic successful observations rather than creating
  // hundreds of repositories; real Git sharing/generation assertions above verify its callers.
  const internals = ins as unknown as { observe<T>(key: string, token: () => string, load: () => Promise<T>, good: (v: T) => boolean): Promise<T>; observations: Map<string, unknown> };
  let reads = 0;
  const read = () => { reads++; return Promise.resolve(reads); };
  for (let i = 0; i < 520; i++) { now++; await internals.observe(`bounded-${i}`, () => "same", read, () => true); }
  assert.equal(internals.observations.size, 512);
  await internals.observe("bounded-0", () => "same", read, () => true);
  assert.equal(reads, 521, "evicted fact is read again");
  now += 3600001;
  await ins.get([]);
  assert.equal(internals.observations.size, 0);
  let release!: (n: number) => void;
  const flight = internals.observe("active", () => "same", () => new Promise<number>((r) => { release = r; }), () => true);
  await Promise.resolve();
  await ins.get([]);
  const joined = internals.observe("active", () => "same", () => Promise.resolve(-1), () => true);
  release(42);
  assert.deepEqual(await Promise.all([flight, joined]), [42, 42]);
});

test("distinct worktrees share repo refs but not HEAD or dirty; runner concurrency never exceeds four", async () => {
  const r = repo("separate");
  const a = feature(r, "feat-separate-a", ["a"]);
  const b = feature(r, "feat-separate-b", ["b"]);
  writeFileSync(join(a, "untracked"), "dirty");
  let peak = 0;
  let running = 0;
  let refs = 0;
  const ins = new WorktreeInsights({ run: async (args, opts) => {
    peak = Math.max(peak, ++running);
    if (args[0] === "for-each-ref") refs++;
    try { return await execGit(args, opts); } finally { running--; }
  } });
  const values = await Promise.all(Array.from({ length: 12 }, (_, i) => ins.treeStatus(i % 2 ? a : b)));
  assert.equal(values[0]?.dirty, false);
  assert.equal(values[1]?.dirty, true);
  assert.notEqual(values[0]?.head, values[1]?.head);
  assert.equal(refs, 1);
  assert.ok(peak <= 4, `peak ${peak}`);
});

test("pickBase and sumNumstat", () => {
  assert.deepEqual(pickBase("refs/heads/main\0aaa\0\nrefs/heads/master\0bbb\0\n"), { name: "master", oid: "bbb" });
  assert.deepEqual(pickBase("refs/remotes/origin/HEAD\0ccc\0refs/remotes/origin/dev\n"), { name: "origin/dev", oid: "ccc" });
  assert.equal(pickBase(""), null);
  assert.deepEqual(sumNumstat("3\t1\ta.txt\n-\t-\tbin.png\n2\t0\told => new\n"), { added: 5, removed: 1 });
});

test("a dirty reading ends at once on an index or HEAD change; readiness's lifetime holds it otherwise, 0 reads now; the board keeps 10 s", async () => {
  const r = repo("lifetime");
  const wt = feature(r, "feat-life", ["x"]);
  let now = 1_000_000;
  const calls: string[][] = [];
  const ins = new WorktreeInsights({ now: () => now, run: (args, opts) => { calls.push([...args]); return execGit(args, opts); } });
  const statuses = () => calls.filter((a) => a[0] === "status").length;
  ins.dirtyLifetime(wt, 300_000);
  assert.equal((await ins.treeStatus(wt))?.dirty, false);
  assert.equal(statuses(), 1);
  now += 60_000;
  writeFileSync(join(wt, "c.txt"), "untracked\n");
  assert.equal((await ins.treeStatus(wt))?.dirty, false, "an untracked file waits out the lifetime");
  assert.equal(statuses(), 1);
  git(wt, "add", "c.txt");
  assert.equal((await ins.treeStatus(wt))?.dirty, true, "git add ends the reading at once");
  assert.equal(statuses(), 2);
  git(wt, "commit", "-q", "-m", "c");
  assert.equal((await ins.treeStatus(wt))?.dirty, false, "a commit ends it too");
  assert.equal(statuses(), 3);
  git(wt, "checkout", "-q", "-b", "feat-life-2");
  await ins.treeStatus(wt);
  assert.equal(statuses(), 4, "a branch switch ends it too");
  writeFileSync(join(wt, "d.txt"), "x\n");
  now += 60_000;
  const board = await treeOf(ins, session(wt));
  assert.equal(board.dirty, true, "the board's own reads keep DIRTY_TTL_MS");
  assert.equal(statuses(), 5);
  rmSync(join(wt, "d.txt"));
  ins.dirtyLifetime(wt, 0);
  assert.equal((await ins.treeStatus(wt))?.dirty, false, "0 reads now");
  assert.equal(statuses(), 6);
});

test("worktreeStamp: an untracked file leaves it; add, commit and a branch switch move it; a removed folder is gone; no Git reads it as null", () => {
  const r = repo("stamp");
  const wt = feature(r, "feat-stamp", ["x"]);
  const first = worktreeStamp(wt);
  assert.ok(first && first !== "gone");
  writeFileSync(join(wt, "u.txt"), "untracked\n");
  assert.equal(worktreeStamp(wt), first, "untracked files are the dirty reading's business, not the stamp's");
  git(wt, "add", "u.txt");
  const added = worktreeStamp(wt);
  assert.notEqual(added, first, "git add moves the index");
  git(wt, "commit", "-q", "-m", "u");
  const committed = worktreeStamp(wt);
  assert.notEqual(committed, added, "a commit moves the branch ref");
  git(wt, "checkout", "-q", "-b", "feat-stamp-2");
  assert.notEqual(worktreeStamp(wt), committed, "a branch switch moves HEAD");
  const plain = join(root, "stamp-plain");
  mkdirSync(plain);
  assert.equal(worktreeStamp(plain), null);
  git(r, "worktree", "remove", "--force", wt);
  assert.equal(worktreeStamp(wt), "gone");
});
