// The session list's branches (SessionSummary.branches): the trees a chat's composer status row counts, read in the
// background with readiness, each served branch's queue entry joined at listing time from the queue's newest view.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-branches-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths

import type { MergeEntry, MergeQueueView } from "../shared/merge-queue";
import type { SessionBranchQueue, SessionSummary } from "../shared/protocol";
const r = await import("./merge-readiness");
const wire = await import("./merge-queue/wire");
const { listGeneration, onSessionsChanged } = await import("./list-generation");
const { describeWorktrees } = await import("./worktrees-state");
const { rowBranchStatus } = await import("../src/lib/branch-status");
const { controlWords, queueRow } = await import("../src/lib/merge-queue");

const SID = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const PARENT = "0199aaaa-bbbb-7ccc-8ddd-ffffffffffff";
const root = mkdtempSync(join(tmpdir(), "sova-branches-wt-"));
const own = join(root, "own");
const inherited = join(root, "inherited");
const dropped = join(root, "dropped");
const gone = join(root, "gone");
for (const d of [own, inherited, dropped]) mkdirSync(d);

let n = 0;
function sessionFile(trees: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "sova-branches-s-"));
  const path = join(dir, `2026-09-29T15-34-48-453Z_${SID}.jsonl`);
  const lines = [
    { type: "session", version: 3, id: SID, timestamp: "2026-09-29T15:34:48.453Z", cwd: root },
    { type: "custom", customType: "worktrees", data: { version: 1, trees }, timestamp: "2026-09-29T15:36:00.000Z", id: `e${++n}`, parentId: null },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return path;
}
const tree = (path: string, branch: string, over: object = {}) => ({ path, branch, base: "b0", baseBranch: "master", status: "active", session: SID, how: "created", at: 1, ...over });
const summary = (path: string): SessionSummary =>
  ({ id: SID, path, cwd: root, title: "t", createdAt: "", lastActiveAt: "2026-09-29T19:44:00.000Z", model: null, live: null, busy: false, origin: "web", archived: false }) as SessionSummary;
const status = (path: string) => ({ path, source: "session" as const, exists: true, branch: "feat/own", base: "master", merged: "no" as const, ahead: 1, dirty: false, head: "own", headAt: 5 });

test("the branches are every non-dropped tree, own and inherited, read as the chat's rows; the queue joins at listing time", async () => {
  r.resetReadiness();
  const fieldsAsked: string[] = [];
  let now: SessionBranchQueue | undefined | null = null;
  r.configureReadiness({
    served: async () => true,
    asksUser: () => undefined,
    insights: { treeStatus: async (p: string) => status(p) },
    mergedInto: async (t) => (t.path === inherited ? { target: "master", sha: "c".repeat(40) } : undefined),
    branchFields: async (path, branch) => {
      fieldsAsked.push(path);
      return { root, fields: { mergeServed: true, mergeProject: { target: "master", checks: "declared" }, ...(branch === "feat/own" ? { queue: { state: "queued", commit: "a".repeat(40), position: 1 } } : {}) } };
    },
    queueNow: () => now,
  });
  const path = sessionFile([
    tree(own, "feat/own"),
    tree(inherited, "feat/parent", { session: PARENT }),
    tree(dropped, "feat/dropped", { status: "dropped" }),
    tree(gone, "feat/gone"),
    tree(join(root, "merged"), "feat/merged", { status: "merged", merge: { target: "master", sha: "d".repeat(40), how: "tool", at: 2 } }),
  ]);
  const row = summary(path);
  assert.equal(r.branchesOverlay(row), undefined, "listing never awaits the read");
  r.readinessOverlay(row);
  await r.readinessIdle();

  const b = r.branchesOverlay(row)!;
  assert.deepEqual(
    b.map((x) => x.branch),
    ["feat/own", "feat/parent", "feat/gone", "feat/merged"],
    "dropped is left out, as the chat's control leaves it out",
  );
  const [o, p, g, m] = b;
  assert.equal(o!.exists, true);
  assert.equal(o!.sharedWith, undefined);
  assert.deepEqual(o!.queue, { state: "queued", commit: "a".repeat(40), position: 1 }, "no view known yet: the read's entry stands");
  assert.equal(p!.sharedWith, PARENT, "inherited: from the chat it was forked from");
  assert.deepEqual(p!.mergedInto, { target: "master", sha: "c".repeat(40) }, "git's merged answer, as the chat's row has it");
  assert.equal(g!.exists, false);
  assert.equal(m!.status, "merged");
  assert.deepEqual(fieldsAsked.sort(), [inherited, own].sort(), "queue fields only where the folder exists, as describeWorktrees asks");
  // The session's readiness holds its own trees only: the inherited one has none, in the chat too.
  const own1 = r.readinessOverlay(row)!.trees.map((t) => t.path);
  assert.equal(own1.includes(inherited), false);

  // The queue's newest view speaks at once, with no new read.
  now = { state: "checking", commit: "a".repeat(40) };
  assert.equal(r.branchesOverlay(row)![0]!.queue?.state, "checking");
  assert.equal(r.branchesOverlay(row)![1]!.queue?.state, "checking", "every served branch joins its own entry");
  now = undefined;
  assert.equal(r.branchesOverlay(row)![0]!.queue, undefined, "no entry in the view now: none on the row");
  assert.equal(r.branchesOverlay(row)![2]!.queue, undefined);
  // An Overseer's chat shows no worktrees control: its row has no branches either.
  assert.equal(r.branchesOverlay({ ...row, overseer: true } as SessionSummary), undefined);
  assert.equal(r.branchesOverlay({ ...row, projectOverseer: { projectId: "prj_1" } } as SessionSummary), undefined);
  r.resetReadiness();
});

test("joinBranches: unknown view keeps the read's entry; an unserved branch is never joined", () => {
  const rows = [
    { row: { path: "/a", branch: "a", status: "active" as const, exists: true, queue: { state: "queued" as const, commit: "x" } }, root: "/r" },
    { row: { path: "/b", branch: "b", status: "active" as const, exists: true } },
  ];
  assert.deepEqual(r.joinBranches(rows, () => null), rows.map((x) => x.row));
  assert.deepEqual(r.joinBranches(rows, () => ({ state: "landed", commit: "x" }))[0]!.queue, { state: "landed", commit: "x" });
  assert.equal(r.joinBranches(rows, () => ({ state: "landed", commit: "x" }))[1]!.queue, undefined, "no root: not served, never joined");
});

const entry = (branch: string, state: MergeEntry["state"], over: Partial<MergeEntry> = {}): MergeEntry =>
  ({ id: `me_${branch}_${state}`, project: "prj_1", target: "master", branch, commit: "a".repeat(40), state, notes: [], runs: [], picks: [], updatedAt: "2026-10-01T00:00:00.000Z", ...over }) as unknown as MergeEntry;
const view = (at: string, parts: Partial<Pick<MergeQueueView, "checking" | "waiting" | "needsYou" | "needsFix">>): MergeQueueView =>
  ({ project: "prj_1", root: "/repo", at, review: false, checking: [], waiting: [], needsYou: [], needsFix: [], recent: [], ...parts }) as unknown as MergeQueueView;

test("the queue's views: each branch's newest entry, a change re-lists the sessions, an older view never wins", () => {
  wire.resetQueueViewsForTest();
  let bumps = 0;
  const off = onSessionsChanged(() => bumps++);
  try {
    assert.equal(wire.branchQueueNow("/repo", "feat/a"), null, "no view seen yet");
    wire.noteQueueView(view("2026-10-01T00:00:01.000Z", { waiting: [entry("feat/a", "queued", { position: 1 })] }));
    assert.deepEqual(wire.branchQueueNow("/repo", "feat/a"), { state: "queued", commit: "a".repeat(40), position: 1 });
    assert.equal(wire.branchQueueNow("/repo", "feat/b"), undefined, "a view, no entry for it");
    assert.equal(bumps, 1, "a queue's first view after a start re-lists at once: the rows' reads may be a cycle old");

    wire.noteQueueView(view("2026-10-01T00:00:02.000Z", { waiting: [entry("feat/a", "queued", { position: 1 })] }));
    assert.equal(bumps, 1, "the same entries: nothing to push");

    wire.noteQueueView(view("2026-10-01T00:00:03.000Z", { checking: [entry("feat/a", "checking", { updatedAt: "2026-10-01T00:00:03.000Z" })] }));
    assert.equal(wire.branchQueueNow("/repo", "feat/a")?.state, "checking");
    assert.equal(bumps, 2, "a check starting re-lists at once");

    wire.noteQueueView(view("2026-10-01T00:00:02.500Z", { waiting: [entry("feat/a", "queued")] }));
    assert.equal(wire.branchQueueNow("/repo", "feat/a")?.state, "checking", "an older cached view never replaces a newer one");

    wire.noteQueueView(view("2026-10-01T00:00:04.000Z", { needsFix: [entry("feat/a", "needs-fix", { reason: "Unit tests failed", updatedAt: "2026-10-01T00:00:04.000Z" })] }));
    assert.deepEqual(wire.branchQueueNow("/repo", "feat/a"), { state: "needs-fix", commit: "a".repeat(40), reason: "Unit tests failed" });
    assert.equal(bumps, 3, "sent back re-lists");
  } finally {
    off();
    wire.resetQueueViewsForTest();
  }
});

test("a queue's first view after a start, holding entries, moves the list generation; an empty one doesn't", () => {
  wire.resetQueueViewsForTest();
  try {
    const before = listGeneration();
    wire.noteQueueView({ ...view("2026-10-01T00:00:01.000Z", {}), root: "/empty" } as MergeQueueView);
    assert.equal(listGeneration(), before, "nothing in it: nothing to push");
    wire.noteQueueView(view("2026-10-01T00:00:01.000Z", { needsFix: [entry("feat/a", "needs-fix")] }));
    assert.equal(listGeneration(), before + 1);
  } finally {
    wire.resetQueueViewsForTest();
  }
});

test("a worker's and a baton's rows carry their branches, saying what their chats' control says; no readiness for them", async () => {
  for (const kind of [{ workerSession: true }, { baton: { id: "b1" } }] as Partial<SessionSummary>[]) {
    r.resetReadiness();
    r.configureReadiness({ served: async () => true, asksUser: () => undefined, insights: { treeStatus: async (p: string) => status(p) }, branchFields: async () => ({ fields: {} }) });
    const path = sessionFile([tree(own, "feat/own"), tree(inherited, "feat/parent", { session: PARENT })]);
    const row = { ...summary(path), ...kind } as SessionSummary;
    r.readinessOverlay(row);
    await r.readinessIdle();
    const b = r.branchesOverlay(row);
    assert.ok(b, `${Object.keys(kind)[0]}: branches defined`);
    assert.equal(r.readinessOverlay(row), undefined, "readiness still doesn't cover it");
    // Its chat's rows, as insights.ts builds them: describeWorktrees and the session's readiness by path (none here).
    const facts = JSON.parse(readFileSync(path, "utf8").split("\n")[1]!).data;
    const chat = (await describeWorktrees(facts, SID, []))!.map((w) => ({ ...w, readiness: r.treeReadinessOf(path, w.path) }));
    const says = controlWords(chat.filter((w) => w.status !== "dropped").map((w) => queueRow(w)));
    const list = rowBranchStatus({ branches: b, readiness: r.readinessOverlay(row) });
    assert.equal(list?.text, says?.text);
    assert.equal(list?.n, says?.n);
  }
  // A worker's read never makes it a branch's owner.
  assert.equal([...r.trackedWorktrees().each()].length, 0);
  r.resetReadiness();
});
