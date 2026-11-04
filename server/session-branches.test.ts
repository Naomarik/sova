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

/** A stand-in for the server's queues: every Git-reading call is counted. */
function listDeps(over: Partial<import("./merge-queue/wire").QueueListDeps> = {}) {
  const asked = { project: 0, setup: 0, view: 0 };
  const state = { refs: "r1", clock: 1_000, setUp: true, checks: "declared" as string, viewAt: 0, needsFix: [] as MergeEntry[] };
  const deps: import("./merge-queue/wire").QueueListDeps = {
    projectOf: async () => (asked.project++, { state: "ok", root: "/repo", name: "repo", git: true }),
    treeStamp: () => "dotgit",
    projectIdOf: () => "prj_1",
    setupOf: async () => (asked.setup++, { target: "master", head: "h", checks: state.checks as never, setUp: state.setUp }),
    stamp: () => state.refs,
    view: async () => {
      asked.view++;
      return { ...view(new Date(Date.UTC(2026, 9, 1, 0, 0, ++state.viewAt)).toISOString(), { needsFix: state.needsFix }), target: "master", checks: state.checks } as unknown as MergeQueueView;
    },
    exists: () => true,
    now: () => state.clock,
    ...over,
  };
  return { asked, state, deps };
}
/** The stand-in's views are in: the first, and the one its needs-fix branches called for. */
const asked0 = (state: { viewAt: number }) => state.viewAt >= 2;
/** A view read by checkQueueViews (or a row) has answered. */
const viewsSettled = async (read: () => boolean) => {
  while (!read()) await new Promise<void>((go) => setImmediate(go));
};

test("a row read builds its queue's view once, then answers from what the queue said; a publish reaches it with no read", async () => {
  wire.resetQueueViewsForTest();
  const { asked, deps } = listDeps();
  wire.setQueueListForTest(deps);
  try {
    const first = await wire.branchQueueFields("/repo/.wt/a", "feat/a");
    assert.deepEqual(first, { root: "/repo", fields: { mergeServed: true, mergeProject: { target: "master", checks: "declared" } } });
    for (let i = 0; i < 5; i++) await wire.branchQueueFields("/repo/.wt/a", "feat/a");
    await wire.branchQueueFields("/repo/.wt/b", "feat/b");
    assert.deepEqual([asked.view, asked.setup], [1, 1], "no view and no setup read while nothing moved");
    assert.equal(asked.project, 2, "one project read per tree");

    wire.noteQueueView({ ...view("2026-12-01T00:00:00.000Z", { waiting: [entry("feat/a", "queued", { position: 1 })] }), target: "master", checks: "declared" } as unknown as MergeQueueView);
    assert.equal((await wire.branchQueueFields("/repo/.wt/a", "feat/a")).fields.queue?.state, "queued");
    assert.equal(asked.view, 1);
  } finally {
    wire.setQueueListForTest(null);
    wire.resetQueueViewsForTest();
  }
});

test("a root's setup never stands past a move of its refs; a repo nothing pins asks each time", async () => {
  wire.resetQueueViewsForTest();
  const { asked, state, deps } = listDeps();
  state.setUp = false;
  wire.setQueueListForTest(deps);
  try {
    assert.equal((await wire.branchQueueFields("/repo/.wt/a", "feat/a")).fields.mergeProject?.checks, "declared");
    state.refs = "r2";
    state.checks = "none";
    state.setUp = true;
    const served = await wire.branchQueueFields("/repo/.wt/a", "feat/a");
    assert.equal(served.fields.mergeServed, true, "the setup landed on the target: served at the next read");
    assert.equal(served.fields.mergeProject?.checks, "none");

    wire.resetQueueViewsForTest();
    wire.setQueueListForTest({ ...deps, stamp: () => null });
    const before = asked.setup;
    await wire.branchQueueFields("/repo/.wt/a", "feat/a");
    await wire.branchQueueFields("/repo/.wt/a", "feat/a");
    assert.equal(asked.setup, before + 2);
  } finally {
    wire.setQueueListForTest(null);
    wire.resetQueueViewsForTest();
  }
});

test("a tree whose .git moved has its project read again; one that isn't a repo is never kept", async () => {
  wire.resetQueueViewsForTest();
  let dot = "d1";
  let git = true;
  const { asked, deps } = listDeps();
  wire.setQueueListForTest({ ...deps, treeStamp: () => dot, projectOf: async () => (asked.project++, { state: "ok", root: "/repo", name: "repo", git }) });
  try {
    await wire.branchQueueFields("/t", "b");
    await wire.branchQueueFields("/t", "b");
    assert.equal(asked.project, 1);
    dot = "d2";
    git = false;
    assert.deepEqual(await wire.branchQueueFields("/t", "b"), { fields: {} });
    assert.equal(asked.project, 2);
    assert.deepEqual(await wire.branchQueueFields("/t", "b"), { fields: {} });
    assert.equal(asked.project, 3, "a plain folder may become a repo");
  } finally {
    wire.setQueueListForTest(null);
    wire.resetQueueViewsForTest();
  }
});

test("a folder with no .git left: its project is kept on a clock, not asked at each row read", async () => {
  wire.resetQueueViewsForTest();
  const { asked, state, deps } = listDeps({ treeStamp: () => null });
  wire.setQueueListForTest(deps);
  try {
    await wire.branchQueueFields("/gone-repo", "b");
    await wire.branchQueueFields("/gone-repo", "b");
    assert.equal(asked.project, 1);
    state.clock += 5 * 60_000;
    await wire.branchQueueFields("/gone-repo", "b");
    assert.equal(asked.project, 2);
  } finally {
    wire.setQueueListForTest(null);
    wire.resetQueueViewsForTest();
  }
});

test("the queue watch reads a view only when what it rests on moved, and the change reaches the list", async () => {
  wire.resetQueueViewsForTest();
  const { asked, state, deps } = listDeps();
  wire.setQueueListForTest(deps);
  try {
    await wire.branchQueueFields("/repo/.wt/a", "feat/a");
    for (let i = 0; i < 5; i++) assert.equal(wire.checkQueueViews(), 0, "the first read's look was taken before it");
    assert.equal(asked.view, 1);

    // The target moved with no save(): its checks changed, and a sent-back entry appears in the view.
    state.refs = "r2";
    state.checks = "none";
    const before = listGeneration();
    assert.equal(wire.checkQueueViews(), 1);
    assert.equal(wire.checkQueueViews(), 0, "one read per move");
    await viewsSettled(() => asked.view === 2 && listGeneration() > before && wire.checkQueueViews() === 0);
    assert.equal(wire.branchProjectNow("/repo")?.checks, "none", "the project facts join at listing time");
    assert.equal(wire.checkQueueViews(), 0);

    state.clock += wire.VIEW_BACKSTOP_MS;
    assert.equal(wire.checkQueueViews(), 1, "the backstop bounds what no stamp sees");
    await viewsSettled(() => asked.view === 3);
  } finally {
    wire.setQueueListForTest(null);
    wire.resetQueueViewsForTest();
  }
});

test("a branch sent back for its drafts: an edit of its drafts alone (no commit, no ref moved) reads its queue's view again", async () => {
  wire.resetQueueViewsForTest();
  const drafts: Record<string, string> = { "/repo/.wt/a": "d1", "/repo/.wt/b": "d1" };
  const { asked, state, deps } = listDeps({ draftsStamp: (w) => drafts[w] ?? "" });
  state.needsFix = [entry("feat/a", "needs-fix", { worktree: "/repo/.wt/a", sentBackFor: "drafts" }), entry("feat/b", "needs-fix", { worktree: "/repo/.wt/b", sentBackFor: "checks" })];
  wire.setQueueListForTest(deps);
  try {
    await wire.branchQueueFields("/repo/.wt/a", "feat/a");
    await viewsSettled(() => wire.checkQueueViews() === 0);
    const n = asked.view;
    // A check's send-back: its drafts aren't watched.
    drafts["/repo/.wt/b"] = "d2";
    assert.equal(wire.checkQueueViews(), 0, "a branch sent back for a check: a drafts edit moves nothing");
    drafts["/repo/.wt/a"] = "d2";
    assert.equal(wire.checkQueueViews(), 1, "the drafts' own send-back: read again");
    await viewsSettled(() => asked.view === n + 1 && wire.checkQueueViews() === 0);
  } finally {
    wire.setQueueListForTest(null);
    wire.resetQueueViewsForTest();
  }
});

test("a sent-back entry's redrafted fact reaches the session list's rows", () => {
  wire.resetQueueViewsForTest();
  try {
    wire.noteQueueView(view("2026-10-01T00:00:01.000Z", { needsFix: [entry("feat/a", "needs-fix", { sentBackFor: "drafts" })] }));
    assert.equal(wire.branchQueueNow("/repo", "feat/a")?.redrafted, undefined);
    const before = listGeneration();
    wire.noteQueueView(view("2026-10-01T00:00:02.000Z", { needsFix: [entry("feat/a", "needs-fix", { sentBackFor: "drafts", redrafted: true })] }));
    assert.equal(wire.branchQueueNow("/repo", "feat/a")?.redrafted, true);
    assert.ok(listGeneration() > before, "the change re-lists the sessions");
  } finally {
    wire.resetQueueViewsForTest();
  }
});

test("a view no look covers is read once: a move before the feed starts is never swallowed as a baseline", async () => {
  wire.resetQueueViewsForTest();
  const { asked, deps } = listDeps();
  wire.setQueueListForTest(deps);
  try {
    wire.noteQueueView({ ...view("2026-10-01T00:00:00.000Z", {}), target: "master", checks: "declared" } as unknown as MergeQueueView);
    assert.equal(wire.checkQueueViews(), 1);
    await viewsSettled(() => asked.view === 1 && !wire.checkQueueViews());
  } finally {
    wire.setQueueListForTest(null);
    wire.resetQueueViewsForTest();
  }
});

test("a read that failed spends no look; a read during which the refs moved is read again", async () => {
  wire.resetQueueViewsForTest();
  const { asked, state, deps } = listDeps();
  let fail = false;
  const inner = deps.view;
  const after: (() => void)[] = [];
  wire.setQueueListForTest({ ...deps, view: async (root) => {
    if (fail) { asked.view++; throw new Error("no"); }
    const v = await inner(root);
    for (const f of after.splice(0)) f();
    return v;
  } });
  const warn = console.warn;
  console.warn = () => {};
  try {
    await wire.branchQueueFields("/repo/.wt/a", "feat/a");
    state.refs = "r2";
    fail = true;
    assert.equal(wire.checkQueueViews(), 1);
    await viewsSettled(() => asked.view === 2);
    fail = false;
    after.push(() => (state.refs = "r3"));
    await viewsSettled(() => wire.checkQueueViews() === 1);
    await viewsSettled(() => asked.view === 3);
    await viewsSettled(() => wire.checkQueueViews() === 1);
    await viewsSettled(() => asked.view === 4);
  } finally {
    console.warn = warn;
    wire.setQueueListForTest(null);
    wire.resetQueueViewsForTest();
  }
});

test("a project leaving the list loses its view at the next look, with no ref moved", async () => {
  wire.resetQueueViewsForTest();
  let listed = true;
  const { deps } = listDeps({ projectIdOf: () => (listed ? "prj_1" : null) });
  const view0 = deps.view;
  wire.setQueueListForTest({ ...deps, view: (root) => (listed ? view0(root) : Promise.resolve(null)) });
  try {
    await wire.branchQueueFields("/repo/.wt/a", "feat/a");
    assert.equal(wire.checkQueueViews(), 0);
    listed = false;
    assert.equal(wire.checkQueueViews(), 1);
    await viewsSettled(() => wire.branchProjectNow("/repo") === null);
  } finally {
    wire.setQueueListForTest(null);
    wire.resetQueueViewsForTest();
  }
});

test("the queue watch sees a sent-back branch's worktree go, and a repo nothing pins is re-read on a clock", async () => {
  wire.resetQueueViewsForTest();
  let there = true;
  const { asked, state, deps } = listDeps({ exists: () => there });
  state.needsFix = [entry("feat/a", "needs-fix", { worktree: "/repo/.wt/a" })];
  wire.setQueueListForTest(deps);
  try {
    await wire.branchQueueFields("/repo/.wt/a", "feat/a");
    assert.equal(wire.checkQueueViews(), 1, "the view named a ref the first look couldn't");
    await viewsSettled(() => asked.view === 2);
    await new Promise<void>((go) => setImmediate(go)); // its flight has closed
    assert.equal(wire.checkQueueViews(), 0);
    there = false;
    assert.equal(wire.checkQueueViews(), 1);
    await viewsSettled(() => asked.view === 3);

    wire.resetQueueViewsForTest();
    state.needsFix = [];
    wire.setQueueListForTest({ ...deps, stamp: () => null });
    await wire.branchQueueFields("/repo/.wt/a", "feat/a");
    assert.equal(wire.checkQueueViews(), 0);
    state.clock += 20_000;
    assert.equal(wire.checkQueueViews(), 1);
  } finally {
    wire.setQueueListForTest(null);
    wire.resetQueueViewsForTest();
  }
});

test("a served queue going away drops its view", async () => {
  wire.resetQueueViewsForTest();
  const { state, deps } = listDeps();
  let served = true;
  const view0 = deps.view;
  wire.setQueueListForTest({ ...deps, view: (root) => (served ? view0(root) : Promise.resolve(null)) });
  try {
    await wire.branchQueueFields("/repo/.wt/a", "feat/a");
    served = false;
    state.refs = "r2";
    assert.equal(wire.checkQueueViews(), 1);
    await viewsSettled(() => wire.branchProjectNow("/repo") === null);
  } finally {
    wire.setQueueListForTest(null);
    wire.resetQueueViewsForTest();
  }
});

test("through the wire: a project leaving the list takes its queue facts off its rows, archived ones too", async () => {
  wire.resetQueueViewsForTest();
  r.resetReadiness();
  let listed = true;
  const { state, deps } = listDeps({ projectIdOf: () => (listed ? "prj_1" : null) });
  state.needsFix = [entry("feat/own", "needs-fix")];
  const view0 = deps.view;
  wire.setQueueListForTest({ ...deps, view: (root) => (listed ? view0(root) : Promise.resolve(null)) });
  r.configureReadiness({ served: async () => true, asksUser: () => undefined, insights: { treeStatus: async (p: string) => status(p) }, branchFields: wire.branchQueueFields, queueNow: wire.branchQueueNow, projectNow: wire.branchProjectNow });
  try {
    const row = { ...summary(sessionFile([tree(own, "feat/own")])), archived: true };
    r.readinessOverlay(row);
    await r.readinessIdle();
    assert.equal(r.branchesOverlay(row)![0]!.queue?.state, "needs-fix");
    assert.equal(r.branchesOverlay(row)![0]!.mergeServed, true);
    await viewsSettled(() => wire.checkQueueViews() === 0 && asked0(state));
    listed = false;
    assert.equal(wire.checkQueueViews(), 1);
    await viewsSettled(() => r.branchesOverlay(row)![0]!.mergeServed === undefined);
    assert.equal(r.branchesOverlay(row)![0]!.queue, undefined);
    assert.equal(r.branchesOverlay(row)![0]!.mergeProject, undefined);
  } finally {
    wire.setQueueListForTest(null);
    wire.resetQueueViewsForTest();
    r.resetReadiness();
  }
});

test("a root's setup: a failed read is never kept, and any answer has a backstop", async () => {
  wire.resetQueueViewsForTest();
  const { asked, state, deps } = listDeps();
  let head = "";
  const setupOf = deps.setupOf;
  wire.setQueueListForTest({ ...deps, setupOf: async (root) => ({ ...(await setupOf(root)), head, setUp: !!head }) });
  try {
    assert.equal((await wire.branchQueueFields("/repo/.wt/a", "feat/a")).fields.mergeServed, undefined);
    head = "h";
    assert.equal((await wire.branchQueueFields("/repo/.wt/a", "feat/a")).fields.mergeServed, true, "no head: the next read asks, refs unmoved");
    await wire.branchQueueFields("/repo/.wt/a", "feat/a");
    const before = asked.setup;
    await wire.branchQueueFields("/repo/.wt/a", "feat/a");
    assert.equal(asked.setup, before, "kept while nothing moved");
    state.clock += wire.VIEW_BACKSTOP_MS;
    await wire.branchQueueFields("/repo/.wt/a", "feat/a");
    assert.equal(asked.setup, before + 1);
  } finally {
    wire.setQueueListForTest(null);
    wire.resetQueueViewsForTest();
  }
});

test("rows read before the queue started gain their queue fields, archived ones too; a queue gone from service leaves its rows", async () => {
  r.resetReadiness();
  let fields: Awaited<ReturnType<NonNullable<Parameters<typeof r.configureReadiness>[0]["branchFields"]>>> = { fields: {} };
  r.configureReadiness({ served: async () => true, asksUser: () => undefined, insights: { treeStatus: async (p: string) => status(p) }, branchFields: async () => fields, queueNow: () => null, projectNow: () => null });
  try {
    const row = { ...summary(sessionFile([tree(own, "feat/own")])), archived: true };
    r.readinessOverlay(row);
    await r.readinessIdle();
    assert.equal(r.branchesOverlay(row)![0]!.mergeServed, undefined);
    assert.equal(r.readinessParked(row), true, "nothing else would ever re-read it");
    const before = listGeneration();
    fields = { root: "/repo", fields: { mergeServed: true, queue: { state: "needs-fix", commit: "a" } } };
    await r.rereadBranches();
    assert.equal(r.branchesOverlay(row)![0]!.queue?.state, "needs-fix");
    assert.ok(listGeneration() > before, "the row pushes");

    fields = { fields: {} };
    await r.rereadBranches("/elsewhere");
    assert.equal(r.branchesOverlay(row)![0]!.mergeServed, true, "another queue's rows stay");
    await r.rereadBranches("/repo");
    assert.equal(r.branchesOverlay(row)![0]!.mergeServed, undefined);
    assert.equal(r.branchesOverlay(row)![0]!.queue, undefined);
  } finally {
    r.resetReadiness();
  }
});

test("a tree's merged answer: one read for every session on it, never kept past a move of its refs", async () => {
  r.resetReadiness();
  let refs = "r1";
  let clock = 1_000;
  let merged: { target: string; sha: string } | undefined;
  const asked: string[] = [];
  const stamped: (readonly string[])[] = [];
  r.configureReadiness({
    now: () => clock,
    mergedInto: async (t) => (asked.push(t.path), merged),
    refsStamp: (_d, list) => (stamped.push(list), refs),
    branchFields: async () => ({ fields: {} }),
  });
  try {
    const t = tree(own, "feat/own") as never;
    const facts = { trees: [t] };
    await r.computeBranches({ id: SID }, facts);
    await r.computeBranches({ id: PARENT }, facts);
    assert.equal(asked.length, 1, "sessions on one tree share the answer");
    assert.deepEqual([...new Set(stamped[0]!)].sort(), ["refs/heads/feat/own", "refs/heads/main", "refs/heads/master"], "the branch, its base and master/main");

    refs = "r2";
    merged = { target: "master", sha: "m" };
    const b = await r.computeBranches({ id: SID }, facts);
    assert.deepEqual(b![0]!.row.mergedInto, merged, "the base moved: the row says merged at once");
    assert.equal(asked.length, 2);

    clock += r.MERGED_BACKSTOP_MS;
    await r.computeBranches({ id: SID }, facts);
    assert.equal(asked.length, 3, "a failed read's answer can't stand forever");

    // A folder with no `.git` left, a reftable repo: nothing pins it, and a row re-read every 20 s doesn't ask each time.
    r.configureReadiness({ refsStamp: () => null });
    await r.computeBranches({ id: SID }, facts);
    assert.equal(asked.length, 4);
    await r.computeBranches({ id: SID }, facts);
    assert.equal(asked.length, 4);
    clock += r.MERGED_UNPINNED_MS;
    await r.computeBranches({ id: SID }, facts);
    assert.equal(asked.length, 5, "the clock bounds it");
  } finally {
    r.resetReadiness();
  }
});

test("a re-read keeps an unchanged file's facts, never a changed file's: its new trees show", async () => {
  r.resetReadiness();
  r.configureReadiness({ served: async () => true, asksUser: () => undefined, insights: { treeStatus: async (p: string) => status(p) }, branchFields: async () => ({ fields: {} }) });
  try {
    const path = sessionFile([tree(own, "feat/own")]);
    const row = summary(path);
    r.readinessOverlay(row);
    await r.readinessIdle();
    assert.equal(r.branchesOverlay(row)!.length, 1);
    const more = { type: "custom", customType: "worktrees", data: { version: 1, trees: [tree(own, "feat/own"), tree(inherited, "feat/two")] }, timestamp: "2026-09-29T15:37:00.000Z", id: `e${++n}`, parentId: `e${n - 1}` };
    writeFileSync(path, `${readFileSync(path, "utf8")}${JSON.stringify(more)}\n`);
    r.readinessOverlay(row);
    await r.readinessIdle();
    assert.equal(r.branchesOverlay(row)!.length, 2);
  } finally {
    r.resetReadiness();
  }
});

test("joinBranches: a served branch's project facts come from its queue's newest view; an unserved one's never do", () => {
  const rows = [
    { row: { path: "/a", branch: "a", status: "active" as const, exists: true, mergeProject: { target: "master", checks: "declared" as never } }, root: "/r" },
    { row: { path: "/b", branch: "b", status: "active" as const, exists: true, mergeProject: { target: "master", checks: "declared" as never } } },
  ];
  const out = r.joinBranches(rows, () => null, () => ({ target: "trunk", checks: "none" as never }));
  assert.equal(out[0]!.mergeProject?.target, "trunk");
  assert.equal(out[1]!.mergeProject?.target, "master");
});
