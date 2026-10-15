// Run: pnpm test -- src/lib/coding-worktrees-fresh.browser.test.ts (Solid's reactive build).
// Reopening a project shows its remembered branch details at once (§app.organizations/project-page,
// "Reopening a project"), but no branch gesture acts on them: Merge Branch and Remove Worktree stay
// "Reading its branch" until this page's own branch read has landed
// (§app.project-overseer/coding-worktrees, "Read in two steps").
import assert from "node:assert/strict";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

// The poll listens for visibility changes; a bare stand-in is enough here.
(globalThis as { document?: unknown }).document ??= { hidden: false, addEventListener() {}, removeEventListener() {} };

const solid = await import("solid-js");
const { createPoll } = await import("./poll");
const { remember, forgetAll } = await import("./page-cache");
const { codingRows, READING_BRANCH, rowGestures } = await import("./coding-worktrees");
type Trees = import("../../shared/project-overseer").ProjectWorktrees;
type Rec = import("../../shared/project-overseer").CodingSession;

const rec: Rec = { sessionId: "s1", path: "/sessions/a.jsonl", title: "Build it", startedBy: "operator", branch: "sova/build-it-abc123", base: "0123", target: "main", running: false, workers: 0, createdAt: "2026-09-27T10:00:00Z" };
const remembered: Trees = {
  available: true,
  sessions: [{ ...rec, worktree: "/src/.worktrees/app-build-it-abc123", state: "open", merged: false, ahead: 2, dirty: false }],
};

test("remembered branch details show, but the gestures wait for this page's own branch read", async () => {
  forgetAll();
  remember("project:p:worktrees", remembered);
  let release: ((t: Trees) => void) | null = null;
  await new Promise<void>((done) => {
    solid.createRoot(async (dispose) => {
      const poll = createPoll<Trees>(() => new Promise((r) => (release = r)), 60_000, { cacheKey: "project:p:worktrees" });
      const row = () => codingRows([rec], [], poll.data()?.sessions)[0]!;
      // The remembered facts are shown at once: the branch line has what it needs.
      assert.equal(row().facts, true);
      assert.equal(row().state, "open");
      // Yet neither gesture can run on them.
      assert.deepEqual(rowGestures(row(), poll.fresh()), { merge: READING_BRANCH, remove: READING_BRANCH });
      // The fresh read lands: git's gates decide.
      release!(remembered);
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(poll.fresh(), true);
      assert.deepEqual(rowGestures(row(), poll.fresh()), { merge: null, remove: null });
      dispose();
      done();
    });
  });
  forgetAll();
});

test("a failed first read leaves the remembered details unknown", async () => {
  forgetAll();
  remember("project:p:worktrees", remembered);
  await new Promise<void>((done) => {
    solid.createRoot(async (dispose) => {
      const poll = createPoll<Trees>(() => Promise.reject(new Error("git is slow")), 60_000, { cacheKey: "project:p:worktrees" });
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(poll.pending(), false, "settled, by failing");
      const row = codingRows([rec], [], poll.data()?.sessions)[0]!;
      assert.deepEqual(rowGestures(row, poll.fresh()), { merge: READING_BRANCH, remove: READING_BRANCH });
      dispose();
      done();
    });
  });
  forgetAll();
});
