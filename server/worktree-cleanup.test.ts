// §chat.worktrees/cleanup against a throwaway repository: what counts as merged, empty and
// unmerged, every reason a tree stays, the dry run, `expect`, git's own remove and `branch -d`, the
// ledger, and readiness's gone-folder reader (server/removed-worktrees.ts).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { SessionSummary } from "../shared/protocol";
import * as c from "./worktree-cleanup";
import { targetsRoot } from "./targets";
import { besideGone, goneTreeState, resetRemovedWorktrees, type RemovedWorktree } from "./removed-worktrees";
import type { GitRunner } from "./worktrees";
import { realGit } from "./merge-queue/guard";
import { makeScratchCopy, scratchCopyPath } from "./merge-queue/scratch";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-cleanup-test-")));
const main = join(root, "repo");
const wt = (name: string) => join(root, `wt-${name}`);
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (cwd: string, file: string, text: string, msg: string) => {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", msg);
};
/** A linked worktree on feat/<name>, with `commits` commits of its own. */
const add = (name: string, commits = 1) => {
  git(main, "worktree", "add", "-q", "-b", `feat/${name}`, wt(name));
  for (let i = 0; i < commits; i++) commit(wt(name), `${name}-${i}.txt`, `${name} ${i}\n`, `${name}: ${i}`);
};

const sessions: SessionSummary[] = [];
/** Worktrees the stubbed queueMade calls a merge queue chat's own (owners.ts queueMade in the server). */
const queueMadeTrees = new Set<string>();
/** Every session file the service read (bytes, and active branches parsed). */
const reads = { file: [] as string[], branch: [] as string[] };
const branches = new Map<string, unknown[]>();
let ledger: RemovedWorktree[] = [];

/** A session file whose `worktrees` entry tracks `path` active, with its sandbox on or off. */
function tracker(id: string, path: string, over: Partial<SessionSummary> = {}, sandbox = false): void {
  const file = join(root, "sessions", `${id}.jsonl`);
  const entries = [
    { type: "custom", customType: "worktrees", data: { version: 1, trees: [{ path, branch: "x", base: "b", status: "active", session: id, how: "attached", at: 1 }] } },
    { type: "custom", customType: "sandbox", data: { version: 1, on: sandbox, level: "workspace-write", backend: sandbox ? "linux-bwrap" : "none", enforcement: sandbox ? "full" : "none" } },
  ];
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  branches.set(file, entries);
  sessions.push(summary(id, file, { cwd: join(root, "elsewhere"), ...over }));
}
/** A listed session; its file gets a header with its folder when it has none yet. */
function summary(id: string, path: string, over: Partial<SessionSummary> = {}): SessionSummary {
  if (!existsSync(path)) writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "", cwd: over.cwd ?? main })}\n`);
  return { id, path, cwd: main, title: `session ${id}`, createdAt: "", lastActiveAt: "", model: null, live: null, busy: false, origin: "web", archived: false, ...over };
}
const HOME_SESSION = () => join(root, "sessions", "home.jsonl");

before(() => {
  mkdirSync(join(root, "sessions"), { recursive: true });
  mkdirSync(join(root, "elsewhere"));
  mkdirSync(main);
  git(main, "init", "-q", "-b", "master");
  commit(main, ".gitignore", ".agent/\nnode_modules/\n", "init");
  // merged by ancestry (fast-forward), and its tree has ignored folders git's remove takes along
  add("merged");
  mkdirSync(join(wt("merged"), "node_modules", "x"), { recursive: true });
  git(main, "merge", "-q", "--ff-only", "feat/merged");
  // merged by content (a squash), never an ancestor
  add("squash");
  git(main, "merge", "-q", "--squash", "feat/squash");
  git(main, "commit", "-q", "-m", "squash feat/squash");
  add("empty", 0);
  add("unmerged");
  const merged = ["dirty", "locked", "gone", "cwd", "live-tui", "running", "sandboxed", "idle", "proc", "liverec", "changed"];
  for (const n of merged) add(n);
  // One octopus merge: each branch is an ancestor of master, as with a merge apiece, for one git call.
  git(main, "merge", "-q", "--no-edit", ...merged.map((n) => `feat/${n}`));
  writeFileSync(join(wt("dirty"), "notes.md"), "untracked\n");
  git(main, "worktree", "lock", wt("locked"));
  rmSync(wt("gone"), { recursive: true, force: true });
  mkdirSync(join(wt("cwd"), "sub"));
  sessions.push(summary("home", HOME_SESSION()));
  // A new session with no message yet: not listed, only its file says where it is.
  writeFileSync(join(root, "sessions", "01a1026f-c64e-70a4.jsonl"), `${JSON.stringify({ type: "session", version: 3, id: "01a1026f-c64e-70a4", timestamp: "", cwd: join(wt("cwd"), "sub") })}\n`);
  tracker("tui", wt("live-tui"), { live: { pid: 1, startedAt: "", status: "Idle", lastActivity: "" } as SessionSummary["live"] });
  tracker("run", wt("running"), { busy: true });
  tracker("sbx", wt("sandboxed"), {}, true);
  tracker("idl", wt("idle"));
  mkdirSync(join(wt("liverec"), ".agent", "sessions", "live"), { recursive: true });
  writeFileSync(join(wt("liverec"), ".agent", "sessions", "live", `p${process.pid}-x.json`), JSON.stringify({ session: { pid: process.pid } }));
  c.configureCleanup({
    queueMade: async (p) => queueMadeTrees.has(p),
    summary: async (p) => sessions.find((s) => s.path === p) ?? null,
    sessionFiles: async () => [...new Set([...sessions.map((s) => s.path), join(root, "sessions", "01a1026f-c64e-70a4.jsonl"), HOME_SESSION()])],
    readBranch: async (p) => (reads.branch.push(p), branches.get(p) ?? []),
    readFile: async (p) => (reads.file.push(p), readFileSync(p)),
    now: () => 1000,
  });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

test("classification: ancestry and content merges count as merged; no commit of its own is empty; the rest unmerged", async () => {
  const repo = await c.classifyRepo(main);
  assert.ok(repo);
  assert.equal(repo.main, main);
  assert.equal(repo.mainBranch, "master");
  const of = (n: string) => repo.trees.find((t) => t.path === wt(n));
  assert.deepEqual([of("merged")?.class, of("merged")?.merged, of("merged")?.ancestor], ["merged", "ancestor", true]);
  assert.deepEqual([of("squash")?.class, of("squash")?.merged, of("squash")?.ancestor], ["merged", "content", false]);
  assert.deepEqual([of("empty")?.class, of("empty")?.ancestor], ["empty", true]);
  assert.deepEqual([of("unmerged")?.class, of("unmerged")?.why], ["unmerged", "Not merged into master."]);
  assert.equal(of("gone")?.gone, true);
  assert.equal(repo.trees.some((t) => t.path === main), false, "the main checkout is never one");
});

test("the merge queue's scratch copies (by their creation mark) are never listed; another detached worktree still is", async () => {
  const other = join(root, "scratch-proj");
  mkdirSync(other);
  git(other, "init", "-q", "-b", "master");
  commit(other, "a.txt", "a\n", "init");
  const copy = await makeScratchCopy(realGit, { root: other, entry: "mq_cleanup1", base: git(other, "rev-parse", "HEAD") });
  assert.equal(copy, scratchCopyPath(other, "mq_cleanup1"));
  const plain = join(root, "scratch-proj-detached");
  git(other, "worktree", "add", "-q", "--detach", plain);
  const repo = await c.classifyRepo(other);
  assert.ok(repo);
  assert.deepEqual(repo.trees.map((t) => [t.path, t.why]), [[plain, "Not on a branch."]], "the scratch copy isn't there, as \"Not on a branch\" or anything else");
  // Its folder gone (git still records it): still not listed, it is the queue's own to remove.
  rmSync(copy, { recursive: true, force: true });
  assert.deepEqual((await c.classifyRepo(other))?.trees.map((t) => t.path), [plain]);
});

test("a worktree a merge queue chat made itself (old style, no mark) is never listed, merged or not; a user's beside it is", async () => {
  // Under a folder that sorts after the shared repo: the gone-folder reader below scans siblings in order.
  const other = join(root, "zz-queue-made", "proj");
  mkdirSync(other, { recursive: true });
  git(other, "init", "-q", "-b", "master");
  commit(other, "a.txt", "a\n", "init");
  const made = join(root, "zz-queue-made", "proj-resolve-mq_1");
  const mine = join(root, "zz-queue-made", "proj-mine");
  for (const [path, branch] of [[made, "feat/resolve-mq_1"], [mine, "feat/mine"]] as const) {
    git(other, "worktree", "add", "-q", "-b", branch, path);
    commit(path, `${branch.replace(/\//g, "-")}.txt`, "x\n", branch);
    git(other, "merge", "-q", "--ff-only", branch);
  }
  queueMadeTrees.add(made);
  try {
    const repo = await c.classifyRepo(other);
    assert.ok(repo);
    assert.deepEqual(repo.trees.map((t) => [t.path, t.class]), [[mine, "merged"]], "only the user's merged worktree is listed");
    assert.deepEqual((await c.classifyRepo(other, { withQueueMade: true }))?.trees.map((t) => t.path).sort(), [made, mine].sort(), "retirement still sees it");
  } finally {
    queueMadeTrees.delete(made);
  }
  assert.deepEqual((await c.classifyRepo(other))?.trees.map((t) => t.path).sort(), [made, mine].sort(), "without the stub both are there: the test can tell");
});

test("the count covers every linked worktree in git's list, and a session with no repository gets none", async () => {
  const s = await c.worktreesSummary(HOME_SESSION());
  assert.equal(s.state, "ok");
  if (s.state !== "ok") return;
  assert.deepEqual([s.total, s.merged, s.empty, s.unmerged], [15, 13, 1, 1]);
  sessions.push(summary("nowhere", join(root, "sessions", "nowhere.jsonl"), { cwd: join(root, "elsewhere") }));
  assert.deepEqual(await c.worktreesSummary(join(root, "sessions", "nowhere.jsonl")), { state: "none" });
  sessions.push(summary("remote", join(root, "sessions", "remote.jsonl"), { cwd: join(targetsRoot(), "acme", "srv") }));
  assert.deepEqual(await c.worktreesSummary(join(root, "sessions", "remote.jsonl")), { state: "none" });
});

test("who uses a tree: a folder inside it, or tracking it as active, unlisted new sessions included", async () => {
  const paths = ["cwd", "live-tui", "running", "sandboxed", "idle", "merged"].map(wt);
  const { uses, unreadable } = await c.chatUses(paths);
  assert.deepEqual(unreadable, []);
  const of = (p: string) => uses.filter((u) => u.inside.includes(p) || u.tracks.includes(p));
  assert.equal(of(wt("cwd"))[0]?.name, "01a1026f", "an unlisted new session's folder counts too");
  assert.equal(of(wt("cwd"))[0]?.inside[0], wt("cwd"));
  assert.equal(of(wt("live-tui"))[0]?.tui, true);
  assert.equal(of(wt("running"))[0]?.running, true);
  assert.equal(of(wt("sandboxed"))[0]?.sandbox, true);
  assert.deepEqual(of(wt("idle")).map((u) => [u.running, u.tui, u.sandbox, u.workers]), [[false, false, false, 0]]);
  assert.deepEqual(of(wt("merged")), [], "nobody uses it");
});

test("a second read of the chats reads no unchanged session file; a changed one is read again, alone, with the same answer", async () => {
  const paths = ["sandboxed", "idle", "cwd"].map(wt);
  c.resetCleanup();
  reads.file.length = 0;
  reads.branch.length = 0;
  const first = await c.chatUses(paths);
  const onDisk = [...new Set([...sessions.map((s) => s.path), join(root, "sessions", "01a1026f-c64e-70a4.jsonl"), HOME_SESSION()])].filter((p) => existsSync(p));
  assert.deepEqual([...reads.file].sort(), onDisk.sort(), "a cold read reads every session file on disk once");
  assert.equal(new Set(reads.file).size, reads.file.length, "each at most once");
  reads.file.length = 0;
  reads.branch.length = 0;
  const second = await c.chatUses(paths);
  assert.deepEqual(reads.file, [], "no unchanged file is read");
  assert.deepEqual(second, first, "the same answer");
  const changed = sessions.find((s) => s.id === "sbx")!.path;
  appendFileSync(changed, "\n");
  await c.chatUses(paths);
  assert.deepEqual(reads.file, [changed]);
});

test("a session file that can't be read is named, and a session list that can't be read throws: nobody looks unused for that", async () => {
  const file = join(root, "sessions", "unreadable.jsonl");
  writeFileSync(file, "{}\n");
  sessions.push(summary("unr", file));
  const realRead = (p: string) => (p === file ? Promise.reject(Object.assign(new Error("no"), { code: "EACCES" })) : Promise.resolve(readFileSync(p)));
  c.resetCleanup();
  c.configureCleanup({ summary: async (p) => sessions.find((s) => s.path === p) ?? null, sessionFiles: async () => sessions.map((s) => s.path), readBranch: async (p) => branches.get(p) ?? [], readFile: realRead, now: () => 1000 });
  assert.deepEqual((await c.chatUses([wt("idle")])).unreadable, [file]);
  c.configureCleanup({ summary: async () => null, sessionFiles: () => Promise.reject(new Error("sessions unreadable")), readBranch: async () => [], now: () => 1000 });
  await assert.rejects(c.chatUses([wt("idle")]), /sessions unreadable/);
  sessions.pop();
  c.resetCleanup();
  c.configureCleanup({ queueMade: async (p) => queueMadeTrees.has(p), summary: async (p) => sessions.find((s) => s.path === p) ?? null, sessionFiles: async () => [...new Set([...sessions.map((s) => s.path), join(root, "sessions", "01a1026f-c64e-70a4.jsonl"), HOME_SESSION()])], readBranch: async (p) => (reads.branch.push(p), branches.get(p) ?? []), readFile: async (p) => (reads.file.push(p), readFileSync(p)), now: () => 1000 });
});

test("readiness's gone-folder reader: git first (ancestry, content, or unmerged), the ledger for a deleted branch, else unknown", async () => {
  resetRemovedWorktrees();
  const tip = git(main, "rev-parse", "feat/squash");
  const base = git(main, "merge-base", "feat/squash", "master~1");
  // A branch git still has, in master by ancestry: merged. (feat/idle is merged and still here.)
  const idleBase = git(main, "rev-parse", "feat/idle~1");
  assert.equal(await goneTreeState({ path: "/gone/idle", branch: "feat/idle", base: idleBase }, [main]), "merged");
  // At its base: empty.
  assert.equal(await goneTreeState({ path: "/gone/e", branch: "feat/idle", base: git(main, "rev-parse", "feat/idle") }, [main]), "empty");
  // Merged by content (a squash), no ledger entry: git's trial merge says merged.
  assert.notEqual(tip, base);
  assert.equal(await goneTreeState({ path: "/gone/sq", branch: "feat/squash", base }, [main], { ledger: () => [] }), "merged");
  // Its own commits in neither: unmerged, and git decides over a ledger that says otherwise.
  const unmergedBase = git(main, "rev-parse", "feat/unmerged~1");
  const lie: RemovedWorktree = { v: 1, path: "/gone/u", branch: "feat/unmerged", commonDir: "", tip: "", merged: "ancestor", branchDeleted: false, at: 1 };
  assert.equal(await goneTreeState({ path: "/gone/u", branch: "feat/unmerged", base: unmergedBase }, [main], { ledger: () => [lie] }), "unmerged");
  // Deleted branch: the ledger decides.
  const entry: RemovedWorktree = { v: 1, path: wt("merged"), branch: "feat/merged", commonDir: join(main, ".git"), tip: "x", merged: "ancestor", branchDeleted: true, at: 1 };
  assert.equal(await goneTreeState({ path: wt("merged"), branch: "feat/merged", base: git(main, "rev-list", "--max-parents=0", "HEAD") }, [main], { ledger: () => [entry] }), "merged");
  // Another repository (its base unknown there) is never read as this one.
  const other = join(root, "other");
  mkdirSync(other);
  git(other, "init", "-q", "-b", "master");
  commit(other, "a", "a", "a");
  git(other, "branch", "feat/idle");
  assert.equal(await goneTreeState({ path: "/gone/o", branch: "feat/idle", base: idleBase }, [other], { ledger: () => [] }), null);
});

test("a gone tree whose session runs outside its repository is found beside it", async () => {
  resetRemovedWorktrees();
  const idleBase = git(main, "rev-parse", "feat/idle~1");
  // The session's own folder isn't in the repository: git is asked in a sibling folder instead.
  assert.equal(await goneTreeState({ path: join(root, "wt-was-here"), branch: "feat/idle", base: idleBase }, [join(root, "elsewhere")], { ledger: () => [] }), "merged");
  // The `worktree` tool's layout names the main checkout: <parent>/.worktrees/<repo>-<name> → <parent>/<repo>.
  const parent = join(root, "layout");
  mkdirSync(join(parent, ".worktrees"), { recursive: true });
  mkdirSync(join(parent, "my-repo"));
  assert.deepEqual(besideGone(join(parent, ".worktrees", "my-repo-feature-x")), [join(parent, "my-repo")]);
});

test("off Linux the processes come from lsof: cwd and open files per pid, this process left out; an lsof that fails keeps every tree", async () => {
  const out = ["p100", "csleep", "fcwd", "n/w/tree", "ftxt", "n/bin/sleep", "p200", "cnode", "f3", "n/w/other/log (deleted)", "f4", "nlocalhost:4800", `p${process.pid}`, "cbun", "fcwd", "n/w/tree", "p300", "cnothing", "f5", "npipe"].join("\n");
  assert.deepEqual(c.parseLsof(out, process.pid), [
    { pid: 100, command: "sleep", paths: ["/w/tree", "/bin/sleep"] },
    { pid: 200, command: "node", paths: ["/w/other/log"] },
  ]);
  assert.deepEqual(await c.scanProcesses("darwin", async () => ({ code: 0, stdout: out, stderr: "" })), c.parseLsof(out, process.pid));
  const failed = await c.scanProcesses("darwin", async () => ({ code: 1, stdout: "", stderr: "lsof: WARNING: can't stat()\nmore\n" }));
  assert.equal(failed.length, 1);
  assert.match(failed[0]!.unreadable!, /couldn't be read \(lsof: lsof: WARNING: can't stat\(\)\), so it is kept/);
});

test("own git children: only a direct child of this process whose program is git, read from lsof's fields and /proc's", () => {
  const self = 999;
  for (const [command, parent, own] of [["git", self, true], ["git", 1, false], ["git", NaN, false], ["sh", self, false], ["node", self, false]] as const) assert.equal(c.ownGitChild(command, parent, self), own, `${command} under ${parent}`);
  const proc = (pid: number, parent: number, cmd: string) => [`p${pid}`, `R${parent}`, `c${cmd}`, "fcwd", "n/w/tree"];
  const text = [...proc(10, self, "git"), ...proc(11, 42, "git"), ...proc(12, self, "bash")].join("\n");
  assert.deepEqual(c.parseLsof(text, self).map((p) => p.pid), [11, 12]);
  for (const [line, parent] of [["7 (git) S 42 7 7", 42], ["7 (a b) (c)) R 8 7", 8], ["", NaN]] as const) assert.deepEqual(c.statParent(line), parent, line);
});

test("a process that exits while it is being read isn't running; one still there whose comm or stat can't be read still holds", async () => {
  const err = (code: string) => Object.assign(new Error(code), { code });
  // One process in /w/tree, reading fine until the file a case names, which fails with that case's error.
  const scan = (failing: "comm" | "stat", code: string) =>
    c.scanProcesses("linux", undefined, {
      readdir: async (p) => (p === "/proc" ? ["4242"] : []),
      readlink: async () => "/w/tree",
      readFile: async (p) => {
        if (p.endsWith(`/${failing}`)) throw err(code);
        return p.endsWith("/comm") ? "git\n" : `4242 (git) S 1 4242 4242`;
      },
    });
  for (const failing of ["comm", "stat"] as const) {
    for (const code of ["ENOENT", "ESRCH"]) assert.deepEqual(await scan(failing, code), [], `${failing} ${code}: it has exited, so nothing is running there`);
    for (const code of ["EACCES", "EIO"]) assert.deepEqual((await scan(failing, code)).map((p) => [p.pid, p.paths]), [[4242, ["/w/tree"]]], `${failing} ${code}: still there and unreadable, so it holds`);
  }
});

test("readers of one gone tree share a read while it runs; the next read after its lifetime asks git again", async () => {
  resetRemovedWorktrees();
  let calls = 0;
  let release = () => {};
  const gate = new Promise<void>((go) => { release = go; });
  const fake: GitRunner = async (args) => {
    calls++;
    await gate;
    return { code: 0, stdout: "aaa\n", stderr: "" };
  };
  const t = { path: "/gone/flight", branch: "feat/flight", base: "aaa" };
  const dirs = [main];
  const reads = [goneTreeState(t, dirs, { git: fake, now: 1000, ledger: () => [] }), goneTreeState(t, dirs, { git: fake, now: 1000, ledger: () => [] })];
  const firstCalls = calls;
  release();
  assert.deepEqual(await Promise.all(reads), ["empty", "empty"]);
  assert.equal(firstCalls, 1, "the second reader started no Git");
  const settled = calls;
  assert.equal(await goneTreeState(t, dirs, { git: fake, now: 2000, ledger: () => [] }), "empty");
  assert.equal(calls, settled, "kept");
  // A branch that moved since: the kept answer ends with its lifetime, and git says so.
  const moved: GitRunner = async (args) => ({ code: 0, stdout: args.includes("--verify") ? "bbb\n" : "", stderr: "" });
  assert.equal(await goneTreeState(t, dirs, { git: moved, now: 1000 + 11 * 60_000, ledger: () => [] }), "merged");
});
