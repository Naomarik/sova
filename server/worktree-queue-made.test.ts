// Which worktrees the merge queue's own chats created (merge-queue/owners.ts queueMade), as a worktree list asks it:
// from the per-chat record the cleanup scan keeps (worktree-cleanup.ts), each chat file read at most once and again
// only when it changed, and the record itself holding exactly the files the last full sweep listed.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import type { SessionSummary } from "../shared/protocol";
import type { TrackedWorktree } from "../pi-config/extensions/worktrees/state.ts";
import { canonical } from "../pi-config/extensions/worktrees/state.ts";
import { parsePiBranch, readBranch } from "./harness/pi/reader";
import { type OwnerDeps, WorktreeOwners } from "./merge-queue/owners";
import * as c from "./worktree-cleanup";
import type { GitRunner } from "./worktrees";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-queue-made-")));
after(() => rmSync(root, { recursive: true, force: true }));
const sessionsDir = join(root, "sessions");
const repo = join(root, "repo");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(repo, ".git"), { recursive: true });

const AT = "2026-11-03T00:00:00.000Z";
const idOf = (n: number) => `01a1a104-72f3-75b6-8a92-${String(n).padStart(12, "0")}`;
const tree = (id: string, path: string, how: string, status = "active") => ({ path, branch: `feat/${path.split("/").pop()}`, base: "b".repeat(40), baseBranch: "master", status, session: id, how, at: 1 });
/** A session file: its header, some turns, and (when given) a `worktrees` entry. */
function chatFile(n: number, trees?: ReturnType<typeof tree>[]): string {
  const id = idOf(n);
  const file = join(sessionsDir, `2026-11-03T00-00-00-000Z_${id}.jsonl`);
  const lines: unknown[] = [{ type: "session", version: 3, id, timestamp: AT, cwd: repo }];
  for (let i = 0; i < 3; i++) lines.push({ type: "message", id: `m${n}-${i}`, parentId: i ? `m${n}-${i - 1}` : null, timestamp: AT, message: { role: "user", content: [{ type: "text", text: `turn ${i}` }], timestamp: 1 } });
  if (trees) lines.push({ type: "custom", customType: "worktrees", id: `w${n}`, parentId: `m${n}-2`, timestamp: AT, data: { version: 1, trees } });
  writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return file;
}
const row = (n: number, path: string, x: Partial<SessionSummary> = {}) => ({ id: idOf(n), path, cwd: repo, archived: false, lastActiveAt: AT, ...x }) as SessionSummary;

const wt = (name: string) => join(root, "trees", name);
const OLD = wt("proj-resolve-mq_1");
const ATT = wt("proj-attached");
const DROPPED = wt("proj-dropped");
const USERS = wt("proj-users");
for (const p of [OLD, ATT, DROPPED, USERS]) mkdirSync(p, { recursive: true });
const LISTED = [OLD, ATT, DROPPED, USERS, ...Array.from({ length: 76 }, (_, i) => wt(`feat-${i}`))];

/** git, as classifyRepo asks it: the repository and its 80 linked worktrees (none on a branch: no further reads). */
const git: GitRunner = async (args) => {
  if (args[0] === "rev-parse" && args.includes("--git-common-dir")) return { code: 0, stdout: `${join(repo, ".git")}\n`, stderr: "" };
  if (args[0] === "worktree" && args[1] === "list") return { code: 0, stdout: [`worktree ${repo}\nHEAD ${"a".repeat(40)}\nbranch refs/heads/master`, ...LISTED.map((p) => `worktree ${p}\nHEAD ${"c".repeat(40)}\ndetached`)].join("\n\n") + "\n", stderr: "" };
  return { code: 1, stdout: "", stderr: "" };
};

interface World {
  thread: string;
  queue: string[];
  user: string;
  owners: WorktreeOwners;
  /** Every read of a session file, by any path: the cleanup scan's bytes and branch reads, and the old per-chat read. */
  reads: Map<string, number>;
  treesOfChat: number;
}

function world(): World {
  rmSync(sessionsDir, { recursive: true, force: true });
  mkdirSync(sessionsDir, { recursive: true });
  // 100 queue chats: the merge thread (n = 0) created OLD, only attached ATT, dropped DROPPED; 99 reviewers created nothing.
  const thread = chatFile(0, [tree(idOf(0), OLD, "created"), tree(idOf(0), ATT, "attached"), tree(idOf(0), DROPPED, "created", "dropped")]);
  const queue = [thread, ...Array.from({ length: 99 }, (_, i) => chatFile(i + 1))];
  // A user's chat created USERS and ATT.
  const user = chatFile(500, [tree(idOf(500), USERS, "created"), tree(idOf(500), ATT, "created")]);
  const sessions = [...queue.map((p, i) => row(i, p, { queueChat: { role: i ? "reviewer" : "thread" } as SessionSummary["queueChat"] })), row(500, user)];
  const reads = new Map<string, number>();
  const count = (p: string) => reads.set(p, (reads.get(p) ?? 0) + 1);
  const w = { thread, queue, user, reads, treesOfChat: 0 } as World;
  c.resetCleanup();
  c.configureCleanup({
    git,
    summary: async (p) => sessions.find((s) => s.path === p) ?? null,
    sessionFiles: async () => sessions.map((s) => s.path),
    readFile: async (p) => (count(p), readFileSync(p)),
    readBranch: async (p) => (count(p), readBranch(p)),
    // As the server wires it: the bytes the scan read are parsed, not read again.
    parseBranch: (text) => parsePiBranch(text).branch,
    queueMade: () => w.owners.queueMadeNow(),
    now: () => 1000,
  });
  // The old way's read (a queue chat's file, asked once per chat per worktree) is counted too, should anything still call it.
  const deps: OwnerDeps & { treesOfChat: (path: string) => Promise<readonly TrackedWorktree[]> } = {
    sessions: async () => sessions,
    tracked: () => ({ version: 1, each: () => [] }),
    canonical,
    createdBy: (paths) => c.createdByChats(paths),
    treesOfChat: async (p) => (w.treesOfChat++, count(p), []),
  };
  w.owners = new WorktreeOwners(deps);
  return w;
}

const most = (reads: Map<string, number>) => Math.max(0, ...reads.values());

describe("the worktrees the queue's own chats created, as a list of 80 asks it", () => {
  beforeEach(() => c.resetCleanup());

  test("each of 100 queue chats' files is read at most once for 80 rows, and a second list with nothing changed reads none", async () => {
    const w = world();
    const r = await c.classifyRepo(repo, { git, withQueueMade: true });
    assert.equal(w.treesOfChat, 0, "no per-chat read of a queue chat's file");
    assert.ok(most(w.reads) <= 1, `a file was read ${most(w.reads)} times`);
    assert.deepEqual(r!.trees.filter((t) => t.queueMade).map((t) => t.path), [OLD]);
    // A single check (Land, a retirement's recheck) uses the same remembered answer.
    for (const p of LISTED) assert.equal(await w.owners.queueMade(p), p === OLD);
    assert.equal(w.treesOfChat, 0);
    assert.ok(most(w.reads) <= 1, `a file was read ${most(w.reads)} times`);
    w.reads.clear();
    const again = await c.classifyRepo(repo, { git });
    assert.deepEqual(again!.trees.map((t) => t.path), LISTED.filter((p) => p !== OLD), "hidden from the list");
    assert.deepEqual([...w.reads.keys()], [], "nothing changed: no file read");
  });

  test("when one queue chat grows, only that chat is read again, and what it now created counts", async () => {
    const w = world();
    await c.classifyRepo(repo, { git });
    w.reads.clear();
    const grown = w.queue[42]!;
    appendFileSync(grown, `${JSON.stringify({ type: "custom", customType: "worktrees", id: "w42b", parentId: "m42-2", timestamp: AT, data: { version: 1, trees: [tree(idOf(42), USERS, "attached"), tree(idOf(42), wt("feat-3"), "created")] } })}\n`);
    const r = await c.classifyRepo(repo, { git, withQueueMade: true });
    assert.deepEqual([...new Set(w.reads.keys())], [grown]);
    assert.deepEqual(r!.trees.filter((t) => t.queueMade).map((t) => t.path), [OLD, wt("feat-3")]);
    assert.equal(w.treesOfChat, 0);
  });

  test("created by the thread is the queue's own; only attached, dropped, or made by a user's chat is not", async () => {
    const w = world();
    const made = await w.owners.queueMadeNow();
    assert.equal(made(OLD), true);
    assert.equal(made(ATT), false, "the thread only attached it (a user's chat made it)");
    assert.equal(made(DROPPED), false, "dropped");
    assert.equal(made(USERS), false, "a user's chat made it");
    assert.equal(made(wt("nobody")), false);
  });
});

describe("the per-chat record holds exactly what the last full sweep listed", () => {
  beforeEach(() => c.resetCleanup());

  test("more than 5,000 chats: none is read again on a second sweep", async () => {
    const files = Array.from({ length: 5200 }, (_, i) => join(root, "stubs", `${i}.jsonl`));
    mkdirSync(join(root, "stubs"), { recursive: true });
    for (const f of files) writeFileSync(f, "{}\n");
    let reads = 0;
    c.configureCleanup({ git, summary: async () => null, sessionFiles: async () => files, readFile: async (p) => (reads++, readFileSync(p)), readBranch: async () => [], now: () => 1000 });
    await c.treeRecords();
    assert.equal(reads, files.length);
    reads = 0;
    await c.treeRecords();
    await c.chatUses([repo]);
    assert.equal(reads, 0, "every file stays remembered");
    assert.equal(c.scannedFiles(), files.length);
    rmSync(join(root, "stubs"), { recursive: true, force: true });
  });

  test("scan 10, take 5 off the listing, scan again: the record holds exactly those 5", async () => {
    const files = Array.from({ length: 10 }, (_, i) => chatFile(1000 + i));
    let listed = files;
    c.configureCleanup({ git, summary: async () => null, sessionFiles: async () => listed, readFile: async (p) => readFileSync(p), readBranch: (p) => readBranch(p), now: () => 1000 });
    await c.chatUses([repo]);
    assert.equal(c.scannedFiles(), 10);
    listed = files.slice(5);
    await c.treeRecords();
    assert.equal(c.scannedFiles(), 5);
    // And a file that is gone on disk is dropped on the next look, as before.
    rmSync(listed[0]!);
    await c.chatUses([repo]);
    assert.equal(c.scannedFiles(), 4);
  });
});
