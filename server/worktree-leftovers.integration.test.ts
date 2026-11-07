// §chat.worktrees/cleanup at git level, the loss t3code shipped (#30998, #23866) reproduced: a merged
// worktree that `git status` calls clean, holding an ignored local.env, a hermetic .agent with a
// session and an auth.json, and a worktree of another repository nested under an ignored folder with
// an uncommitted file. Plain `git worktree remove` deletes all of it without a word; the cleanup keeps
// it and says why, and Remove Anyway deletes exactly what it listed, only while that is unchanged. A
// tree holding only rebuildable folders (node_modules, dist, a generated .agent) still goes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { SessionSummary } from "../shared/protocol";
import * as c from "./worktree-cleanup";
import { leftovers, leftoversDigest } from "./worktree-leftovers";
import type { RemovedWorktree } from "./removed-worktrees";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-leftovers-int-")));
const main = join(root, "umb");
const be = join(root, "be");
const wt = (name: string) => join(root, `wt-${name}`);
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
/** A linked worktree on feat/<name> with no commit of its own: an empty one, removable as far as git's history goes. */
const add = (name: string) => git(main, "worktree", "add", "-q", "-b", `feat/${name}`, wt(name));
const session = join(root, "sessions", "s.jsonl");
let ledger: RemovedWorktree[] = [];

before(() => {
  mkdirSync(main, { recursive: true });
  git(main, "init", "-q", "-b", "master");
  write(join(main, ".gitignore"), "local.env\n.agent/\nbackend/\nnode_modules\ndist/\n");
  write(join(main, "a.txt"), "a\n");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "init");
  mkdirSync(be);
  git(be, "init", "-q", "-b", "master");
  write(join(be, "canary.txt"), "be\n");
  git(be, "add", "-A");
  git(be, "commit", "-q", "-m", "be");
  // The session the dialog runs from: its folder is the main checkout, outside every tree.
  write(session, `${JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "", cwd: main })}\n`);
  c.configureCleanup({
    summary: async (): Promise<SessionSummary | null> => null,
    sessionFiles: async () => [session],
    readBranch: async () => [],
    processes: async () => [],
    ledger: (e) => {
      ledger.push(...e);
    },
    removed: async () => {},
    now: () => 1000,
  });
});

after(() => {
  const locked = join(wt("unreadable"), "backend", "private");
  if (existsSync(locked)) chmodSync(locked, 0o700);
  rmSync(root, { recursive: true, force: true });
});

/** The old loss's fixture: clean to `git status`, full of work git doesn't track. */
function lossy(name: string): void {
  add(name);
  write(join(wt(name), "local.env"), "TOKEN=x\n");
  write(join(wt(name), ".agent", "settings.json"), "{}\n");
  write(join(wt(name), ".agent", "auth.json"), "{}\n");
  write(join(wt(name), ".agent", "sessions", "--x--", "s1.jsonl"), "{}\n");
  git(be, "worktree", "add", "-q", "-b", `wip-${name}`, join(wt(name), "backend"));
  write(join(wt(name), "backend", "wip.txt"), "uncommitted work\n");
}

test("the old blind spot: git calls the tree clean, and its own remove would take the ignored work with it", () => {
  lossy("probe");
  assert.equal(git(wt("probe"), "status", "--porcelain"), "", "git status sees nothing, as the old check did");
  // What the old cleanup ran: plain `git worktree remove` succeeds and deletes it all.
  git(main, "worktree", "remove", "--", wt("probe"));
  assert.equal(existsSync(join(wt("probe"), "local.env")), false);
  assert.equal(existsSync(join(wt("probe"), "backend", "wip.txt")), false, "the nested worktree's uncommitted file is gone");
  assert.equal(readFileSync(join(be, "canary.txt"), "utf8"), "be\n");
});

test("Clean Up Merged keeps such a tree, names what it holds, and lists exactly what Remove Anyway would delete", async () => {
  lossy("lossy");
  const plan = await c.cleanupPlan(session);
  assert.ok(plan);
  assert.equal(plan.remove.some((r) => r.path === wt("lossy")), false, "not offered for removal");
  const kept = plan.keep.find((k) => k.path === wt("lossy"));
  assert.ok(kept, JSON.stringify(plan));
  assert.match(kept.reason, /^Holds what can't be rebuilt: /);
  assert.match(kept.reason, /local\.env/);
  assert.match(kept.reason, /\.agent \(sessions\)/);
  assert.match(kept.reason, /1 nested repository: backend/);
  const a = kept.removeAnyway;
  assert.ok(a, "kept only for what it holds: Remove Anyway is offered");
  assert.deepEqual(a.uncommitted, []);
  assert.deepEqual(a.ignored, [".agent/auth.json", ".agent/sessions/--x--/s1.jsonl", ".agent/settings.json", "local.env"]);
  assert.deepEqual(a.nested, [{ path: "backend", kind: "worktree", of: be }]);
  assert.deepEqual(a.counts, { uncommitted: 0, ignored: 4, nested: 1, rebuildable: 0 });
  // Removal of the confirmed path re-checks and still keeps it: nothing on disk changes.
  const r = await c.removeTrees(main, [wt("lossy")]);
  assert.ok(r && r !== "busy");
  assert.deepEqual(r.removed, []);
  assert.match(r.kept[0]!.reason, /Holds what can't be rebuilt/);
  for (const f of ["local.env", ".agent/auth.json", ".agent/sessions/--x--/s1.jsonl", "backend/wip.txt"]) assert.ok(existsSync(join(wt("lossy"), f)), `${f} kept`);
});

test("Remove Anyway with a listing that no longer matches deletes nothing; with the current one it removes the tree", async () => {
  const before = await leftovers(wt("lossy"));
  const digest = leftoversDigest(before);
  write(join(wt("lossy"), "local2.env"), "new\n");
  const stale = await c.removeTrees(main, [wt("lossy")], { anyway: { path: wt("lossy"), digest } });
  assert.ok(stale && stale !== "busy");
  assert.deepEqual(stale.removed, []);
  assert.match(stale.kept[0]!.reason, /^Changed since the list, nothing was deleted: /);
  assert.match(stale.kept[0]!.reason, /local2\.env/, "the new file is named: it is untracked");
  assert.ok(existsSync(join(wt("lossy"), "backend", "wip.txt")));
  // Another tree's digest never removes this one.
  const other = await c.removeTrees(main, [wt("lossy")], { anyway: { path: wt("elsewhere"), digest } });
  assert.ok(other && other !== "busy");
  assert.deepEqual(other.removed, []);

  const plan = await c.cleanupPlan(session);
  const a = plan!.keep.find((k) => k.path === wt("lossy"))!.removeAnyway!;
  assert.deepEqual(a.uncommitted, ["local2.env"]);
  ledger = [];
  const r = await c.removeTrees(main, [wt("lossy")], { anyway: { path: wt("lossy"), digest: a.digest } });
  assert.ok(r && r !== "busy");
  assert.deepEqual(r.removed.map((x) => [x.path, x.kind, x.branchDeleted]), [[wt("lossy"), "empty", true]]);
  assert.equal(existsSync(wt("lossy")), false, "the folder is gone");
  assert.deepEqual(ledger.map((e) => e.path), [wt("lossy")], "in the ledger like any removal");
  assert.equal(readFileSync(join(be, "canary.txt"), "utf8"), "be\n", "the nested worktree's repository is untouched");
});

test("a tree holding only rebuildable folders and a generated .agent is removed", async () => {
  add("rebuild");
  write(join(wt("rebuild"), "node_modules", "pkg", "index.js"), "x\n");
  write(join(wt("rebuild"), "dist", "app.js"), "x\n");
  write(join(wt("rebuild"), ".agent", "settings.json"), "{}\n");
  write(join(wt("rebuild"), ".agent", "sova", "auth-token"), "t\n");
  mkdirSync(join(wt("rebuild"), ".agent", "extensions"), { recursive: true });
  symlinkSync(join(main, "a.txt"), join(wt("rebuild"), ".agent", "extensions", "link"));
  const l = await leftovers(wt("rebuild"));
  assert.deepEqual([l.dirty, l.ignored, l.nested, l.unreadable], [[], [], [], undefined]);
  assert.deepEqual(l.rebuildable, [".agent/", "dist/", "node_modules/"]);
  const plan = await c.cleanupPlan(session);
  assert.ok(plan!.remove.some((r) => r.path === wt("rebuild")), JSON.stringify(plan!.keep));
  const r = await c.removeTrees(main, [wt("rebuild")]);
  assert.ok(r && r !== "busy");
  assert.deepEqual(r.removed.map((x) => x.path), [wt("rebuild")]);
  assert.equal(existsSync(wt("rebuild")), false);
  assert.equal(readFileSync(join(main, "a.txt"), "utf8"), "a\n", "a symlink's target stays");
});

test("a nested repository inside a rebuildable folder still keeps the tree; a .agent with server state does too", async () => {
  add("nested-dist");
  mkdirSync(join(wt("nested-dist"), "dist", "vendor"), { recursive: true });
  git(join(wt("nested-dist"), "dist", "vendor"), "init", "-q");
  const l = await leftovers(wt("nested-dist"));
  assert.deepEqual(l.nested, [{ path: "dist/vendor", kind: "repository" }]);
  add("agent-state");
  write(join(wt("agent-state"), ".agent", "sova", "chats", "c.json"), "{}\n");
  const s = await leftovers(wt("agent-state"));
  assert.equal(s.agent, "server state");
  assert.deepEqual(s.ignored, [".agent/sova/chats/c.json"]);
  const plan = await c.cleanupPlan(session);
  assert.match(plan!.keep.find((k) => k.path === wt("nested-dist"))!.reason, /nested repository: dist\/vendor/);
  assert.match(plan!.keep.find((k) => k.path === wt("agent-state"))!.reason, /\.agent \(server state\)/);
});

test("a folder that can't be read keeps the tree, with no Remove Anyway", { skip: process.getuid?.() === 0 && "root reads everything" }, async () => {
  add("unreadable");
  write(join(wt("unreadable"), "local.env"), "x\n");
  write(join(wt("unreadable"), ".agent", "sessions", "s.jsonl"), "{}\n");
  mkdirSync(join(wt("unreadable"), "backend", "private"), { recursive: true });
  chmodSync(join(wt("unreadable"), "backend", "private"), 0o000);
  try {
    const plan = await c.cleanupPlan(session);
    const k = plan!.keep.find((x) => x.path === wt("unreadable"));
    assert.ok(k);
    assert.match(k.reason, /^Its files couldn't be read: /);
    assert.equal(k.removeAnyway, undefined);
    const r = await c.removeTrees(main, [wt("unreadable")]);
    assert.ok(r && r !== "busy");
    assert.deepEqual(r.removed, []);
    assert.ok(existsSync(join(wt("unreadable"), "local.env")));
  } finally {
    chmodSync(join(wt("unreadable"), "backend", "private"), 0o700);
  }
});

test("a tree kept for its use never gets Remove Anyway, and a forced request can't take it", async () => {
  add("locked");
  write(join(wt("locked"), "local.env"), "x\n");
  git(main, "worktree", "lock", wt("locked"));
  const plan = await c.cleanupPlan(session);
  const k = plan!.keep.find((x) => x.path === wt("locked"))!;
  assert.equal(k.reason, "Locked.");
  assert.equal(k.removeAnyway, undefined);
  const digest = leftoversDigest(await leftovers(wt("locked")));
  const r = await c.removeTrees(main, [wt("locked")], { anyway: { path: wt("locked"), digest } });
  assert.ok(r && r !== "busy");
  assert.deepEqual(r.removed, []);
  assert.ok(existsSync(join(wt("locked"), "local.env")));
});
