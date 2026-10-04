// §chat.worktrees/cleanup against a throwaway repository: what counts as merged, empty and
// unmerged, every reason a tree stays, the dry run, `expect`, git's own remove and `branch -d`, the
// ledger, and readiness's gone-folder reader (server/removed-worktrees.ts).
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { SessionSummary } from "../shared/protocol";
import * as c from "./worktree-cleanup";
import { targetsRoot } from "./targets";
import { besideGone, goneTreeState, resetRemovedWorktrees, type RemovedWorktree } from "./removed-worktrees";

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
/** Every session file the service read (bytes, and active branches parsed). */
const reads = { file: [] as string[], branch: [] as string[] };
const branches = new Map<string, unknown[]>();
let ledger: RemovedWorktree[] = [];
const sleepers: ChildProcess[] = [];

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
  for (const n of ["dirty", "locked", "gone", "cwd", "live-tui", "running", "sandboxed", "idle", "proc", "liverec", "changed"]) add(n);
  for (const n of ["dirty", "locked", "gone", "cwd", "live-tui", "running", "sandboxed", "idle", "proc", "liverec", "changed"]) git(main, "merge", "-q", "--no-edit", `feat/${n}`);
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
  const sleeper = spawn("sleep", ["60"], { cwd: wt("proc"), stdio: "ignore" });
  sleepers.push(sleeper);
  mkdirSync(join(wt("liverec"), ".agent", "sessions", "live"), { recursive: true });
  writeFileSync(join(wt("liverec"), ".agent", "sessions", "live", `p${process.pid}-x.json`), JSON.stringify({ session: { pid: process.pid } }));
  c.configureCleanup({
    summary: async (p) => sessions.find((s) => s.path === p) ?? null,
    sessionFiles: async () => [...new Set([...sessions.map((s) => s.path), join(root, "sessions", "01a1026f-c64e-70a4.jsonl"), HOME_SESSION()])],
    readBranch: async (p) => (reads.branch.push(p), branches.get(p) ?? []),
    readFile: async (p) => (reads.file.push(p), readFileSync(p)),
    ledger: (e) => { ledger.push(...e); },
    now: () => 1000,
  });
});

after(() => {
  for (const s of sleepers) s.kill("SIGKILL");
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

test("the dry run names what goes and why the rest stays", async () => {
  const plan = await c.cleanupPlan(HOME_SESSION());
  assert.ok(plan);
  const goes = new Map(plan.remove.map((r) => [r.path, r]));
  const stays = new Map(plan.keep.map((k) => [k.path, k.reason]));
  for (const n of ["merged", "squash", "empty", "gone", "idle", "changed"]) assert.ok(goes.has(wt(n)), `${n} should go: ${stays.get(wt(n))}`);
  assert.deepEqual(goes.get(wt("squash")), { path: wt("squash"), branch: "feat/squash", kind: "content", branchDeleted: false });
  assert.equal(goes.get(wt("merged"))?.branchDeleted, true);
  assert.equal(stays.get(wt("unmerged")), "Not merged into master.");
  assert.equal(stays.get(wt("dirty")), "1 uncommitted file: notes.md.");
  assert.equal(stays.get(wt("locked")), "Locked.");
  assert.equal(stays.get(wt("cwd")), "Session 01a1026f's folder is inside it.", "an unlisted new session's folder counts too");
  assert.equal(stays.get(wt("live-tui")), "Session “session tui” tracks it and is open in a TUI.");
  assert.equal(stays.get(wt("running")), "Session “session run” tracks it and is running.");
  assert.equal(stays.get(wt("sandboxed")), "Session “session sbx” tracks it and has its sandbox on.");
  assert.match(stays.get(wt("proc")) ?? "", /^A running process is inside it: sleep \(\d+\)\.$/);
  assert.equal(stays.get(wt("liverec")), `A live session under its .agent: ${process.pid}.`);
  // A dry run touches nothing.
  for (const n of ["merged", "squash", "empty", "idle"]) assert.ok(existsSync(wt(n)));
});

test("a second dry run reads no unchanged session file; a changed one is read again, alone, with the same answer", async () => {
  c.resetCleanup();
  reads.file.length = 0;
  reads.branch.length = 0;
  const first = await c.cleanupPlan(HOME_SESSION());
  const onDisk = [...new Set([...sessions.map((s) => s.path), join(root, "sessions", "01a1026f-c64e-70a4.jsonl"), HOME_SESSION()])].filter((p) => existsSync(p));
  assert.deepEqual([...reads.file].sort(), onDisk.sort(), "a cold run reads every session file on disk once");
  assert.equal(new Set(reads.file).size, reads.file.length, "each at most once");
  reads.file.length = 0;
  reads.branch.length = 0;
  const second = await c.cleanupPlan(HOME_SESSION());
  assert.deepEqual(reads.file, [], "no unchanged file is read");
  assert.deepEqual(reads.branch, [], "no unchanged file is parsed");
  assert.deepEqual(second, first, "the same refusals and removals");
  // One file changes: only it is read again, and only it is parsed (it holds a `worktrees` entry).
  const changed = sessions.find((s) => s.id === "sbx")!.path;
  appendFileSync(changed, "\n");
  const third = await c.cleanupPlan(HOME_SESSION());
  assert.deepEqual(reads.file, [changed]);
  assert.deepEqual(reads.branch, [changed]);
  assert.deepEqual(third, first);
  // A file with no `worktrees` entry that changes is read, never parsed.
  reads.file.length = 0;
  reads.branch.length = 0;
  appendFileSync(HOME_SESSION(), "\n");
  await c.cleanupPlan(HOME_SESSION());
  assert.deepEqual([reads.file, reads.branch], [[HOME_SESSION()], []]);
});

test("a removal acts only on the expected paths still removable, with git's own remove and branch -d", async () => {
  const plan = await c.cleanupPlan(HOME_SESSION());
  assert.ok(plan);
  // Changed after the preview: an untracked file appears; the tree stays, with the new reason.
  writeFileSync(join(wt("changed"), "late.txt"), "late\n");
  const expect = plan.remove.map((r) => r.path).filter((p) => p !== wt("idle"));
  ledger = [];
  const r = await c.cleanupRemove(HOME_SESSION(), [...expect, join(root, "not-a-worktree")]);
  assert.ok(r && r !== "busy");
  const removed = new Map(r.removed.map((x) => [x.path, x]));
  const kept = new Map(r.kept.map((k) => [k.path, k.reason]));
  for (const n of ["merged", "squash", "empty", "gone"]) {
    assert.ok(removed.has(wt(n)), `${n}: ${kept.get(wt(n))}`);
    assert.equal(existsSync(wt(n)), false);
  }
  assert.equal(kept.get(wt("changed")), "Changed since the preview: 1 uncommitted file: late.txt.");
  assert.equal(kept.get(join(root, "not-a-worktree")), "No longer in git's worktree list.");
  assert.ok(existsSync(wt("idle")), "a tree not in `expect` is never touched");
  assert.ok(existsSync(join(wt("changed"), "late.txt")));
  // Branches: deleted when an ancestor of master (merged, empty, gone); a content merge keeps its ref.
  const heads = git(main, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n");
  for (const b of ["feat/merged", "feat/empty", "feat/gone"]) assert.ok(!heads.includes(b), `${b} should be deleted`);
  assert.ok(heads.includes("feat/squash"), "a content-merged branch is kept");
  assert.equal(removed.get(wt("squash"))?.branchDeleted, false);
  assert.equal(removed.get(wt("merged"))?.branchDeleted, true);
  // The ledger has one entry per removal.
  assert.deepEqual(ledger.map((e) => [e.path, e.merged, e.branchDeleted]).sort(), [
    [wt("empty"), "empty", true],
    [wt("gone"), "ancestor", true],
    [wt("merged"), "ancestor", true],
    [wt("squash"), "content", false],
  ].sort());
  // git's list no longer has them; the rest stay listed.
  const listed = git(main, "worktree", "list", "--porcelain");
  assert.ok(!listed.includes(`worktree ${wt("merged")}\n`) && listed.includes(`worktree ${wt("idle")}\n`));
  // The count was dropped and reads the new list.
  const s = await c.worktreesSummary(HOME_SESSION());
  assert.equal(s.state === "ok" && s.total, 11);
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
