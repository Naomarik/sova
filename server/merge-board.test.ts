// Run: pnpm test -- server/merge-board.test.ts
// The merge board (§chat.worktrees/merge-board): rows from readiness's cache, the owner rule (not
// archived first, then the most recent; never a merge captain), unread sessions counted as pending,
// the common git directory from a worktree's `.git` file, and the file written whole at mode 0600.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { SessionReadiness, SessionSummary, WorktreeReadiness } from "../shared/protocol";
import { BoardSource, buildBoard, commonGitDir, rowsIn, type BoardInputs } from "./merge-board";
import { scratchRoot } from "./test-scratch";

const root = scratchRoot("sova-merge-board-test-");
after(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const session = (id: string, over: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id, path: `/sessions/${id}.jsonl`, cwd: "/work/sova", title: id, lastActiveAt: "2026-10-05T09:00:00.000Z", busy: false, archived: false, live: null, origin: "web", ...over }) as SessionSummary;
const tree = (path: string, branch: string, state: WorktreeReadiness["state"]): WorktreeReadiness => ({ path, branch, state, reason: `${state} reason` });
const readiness = (...trees: WorktreeReadiness[]): SessionReadiness => ({ trees, since: 0 });

function inputs(readings: Record<string, SessionReadiness | null | undefined>, extra: Partial<BoardInputs> = {}): BoardInputs {
  return {
    reading: (path) => {
      const id = path.replace(/^\/sessions\/|\.jsonl$/g, "");
      if (!(id in readings)) return { known: false };
      const v = readings[id];
      return { known: true, at: Date.parse("2026-10-05T09:00:05.000Z"), ...(v ? { value: v } : {}) };
    },
    covers: (s) => !s.workerSession,
    repoOf: () => "/work/sova/.git",
    ...extra,
  };
}

test("a row per tracked worktree, with its state, reason, reading time and owner", () => {
  const sessions = [session("a", { profile: { id: "coder", label: "Coder", icon: "x" } }), session("b", { busy: true }), session("c", { workers: { working: 1, total: 2 } }), session("d")];
  const b = buildBoard(sessions, inputs({ a: readiness(tree("/w/x", "feat/x", "waiting-approval")), b: readiness(tree("/w/y", "feat/y", "ready")), c: readiness(tree("/w/z", "feat/z", "ready")), d: readiness(tree("/w/q", "feat/q", "ready")) }, { queued: (p) => p.includes("/d.") }), Date.parse("2026-10-05T09:01:00.000Z"));
  assert.equal(b.v, 1);
  assert.equal(b.at, "2026-10-05T09:01:00.000Z");
  assert.deepEqual({ read: b.read, pending: b.pending }, { read: 4, pending: 0 });
  const x = b.rows.find((r) => r.branch === "feat/x")!;
  assert.deepEqual(x, { path: "/w/x", branch: "feat/x", repo: "/work/sova/.git", state: "waiting-approval", reason: "waiting-approval reason", readAt: "2026-10-05T09:00:05.000Z", owner: { id: "a", status: "idle", profile: "coder", lastActiveAt: "2026-10-05T09:00:00.000Z" } });
  assert.equal(b.rows.find((r) => r.branch === "feat/y")!.owner.status, "busy", "a turn running");
  assert.equal(b.rows.find((r) => r.branch === "feat/z")!.owner.status, "busy", "workers working");
  assert.equal(b.rows.find((r) => r.branch === "feat/q")!.owner.status, "busy", "a message queued");
});

test("several owners: one not archived wins, then the most recent; a merge captain never owns", () => {
  const sessions = [
    session("old", { lastActiveAt: "2026-10-01T00:00:00.000Z" }),
    session("new", { lastActiveAt: "2026-10-04T00:00:00.000Z" }),
    session("gone", { archived: true, lastActiveAt: "2026-10-05T00:00:00.000Z" }),
    session("captain", { lastActiveAt: "2026-10-06T00:00:00.000Z", profile: { id: "merge-captain", label: "Merge captain", icon: "x" } }),
    session("old-captain", { archived: true, profile: { id: "merge-captain", label: "Merge captain", icon: "x" } }),
  ];
  const t = tree("/w/x", "feat/x", "ready");
  const b = buildBoard(sessions, inputs({ old: readiness(t), new: readiness(t), gone: readiness(t), captain: readiness({ ...t, state: "in-progress" }, tree("/w/only-captain", "feat/c", "in-progress")), "old-captain": readiness(tree("/w/c2", "feat/c2", "ready")) }), 0);
  assert.deepEqual(b.rows.map((r) => [r.branch, r.owner.id]), [["feat/x", "new"]]);
  const archivedOnly = buildBoard([session("gone", { archived: true })], inputs({ gone: readiness(t) }), 0);
  assert.equal(archivedOnly.rows[0]!.owner.status, "archived");
});

test("a session not read yet is pending, never a missing owner; uncovered sessions count for neither", () => {
  const b = buildBoard([session("read"), session("unread"), session("worker", { workerSession: true }), session("none")], inputs({ read: readiness(tree("/w/x", "feat/x", "ready")), none: null }), 0);
  assert.deepEqual({ read: b.read, pending: b.pending, rows: b.rows.length }, { read: 2, pending: 1, rows: 1 });
});

test("the common git directory comes from the worktree's .git file, and rowsIn keeps one repository's rows", () => {
  const main = join(root, "main");
  execFileSync("git", ["init", "-q", "-b", "master", main]);
  git(main, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--allow-empty", "-m", "base");
  const wt = join(root, "wt-x");
  git(main, "worktree", "add", "-q", wt, "-b", "feat/x");
  const repo = commonGitDir(main);
  assert.equal(repo, join(main, ".git"));
  assert.equal(commonGitDir(wt), repo, "a linked worktree belongs to the main checkout's repository");
  assert.equal(commonGitDir(join(root, "nowhere")), null);
  const b = buildBoard([session("a")], inputs({ a: readiness(tree(wt, "feat/x", "ready"), tree("/elsewhere", "feat/e", "ready")) }, { repoOf: commonGitDir }), 0);
  assert.deepEqual(rowsIn(b, main).map((r) => r.branch), ["feat/x"]);
  assert.deepEqual(rowsIn(b, join(root, "nowhere")), []);
});

test("the source waits for readiness, writes the file whole at 0600, and shares a young board", async () => {
  const file = join(root, "state", "merge-board.json");
  let lists = 0;
  let release!: () => void;
  const idle = new Promise<void>((done) => (release = done));
  let t = 1000;
  const readings: Record<string, SessionReadiness | null> = {};
  const src = new BoardSource({ list: async () => (lists++, [session("a")]), idle: () => idle, inputs: inputs(readings), file, now: () => t, waitMs: 60_000 });
  const first = src.get();
  await new Promise((r) => setTimeout(r, 5));
  readings.a = readiness(tree("/w/x", "feat/x", "ready")); // the read the listing queued comes in
  release();
  const b = await first;
  assert.equal(b.pending, 0);
  assert.equal(b.rows.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), b);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  t += 10_000;
  assert.equal(await src.get(30_000), b, "a board younger than maxAge is reused");
  assert.equal(lists, 1);
  t += 30_000;
  await src.get(30_000);
  assert.equal(lists, 2);
});
