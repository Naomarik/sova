import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodingWorktree } from "../../shared/project-overseer";
import type { SessionSummary } from "../../shared/protocol";
import { canGo, canGoCount, copyGroups, freedLine, goWord, inUseCount, landedCopies, mergeCopyPath, NO_LANDED, type LandedCopies } from "./free-slots";

const ROOT = "/w/app";
const copy = (o: Partial<{ slot: number; state: "running" | "degraded" | "stopped" | "absent"; branch: string | null; checkout: string; adopted: string }> = {}) => ({
  slot: 3,
  state: "stopped" as const,
  branch: "feat/x",
  checkout: "/w/.worktrees/app-x",
  ...o,
});
const landedAt = (path: string, at: string | null = null): LandedCopies => ({ paths: new Map([[path, at]]), branches: new Map() });

test("mergeCopyPath: beside the project, as the queue cuts it", () => {
  assert.equal(mergeCopyPath("/w/app"), "/w/.worktrees/app-merge");
  assert.equal(mergeCopyPath("/w/app/"), "/w/.worktrees/app-merge");
});

test("canGo: the main checkout and an adopted copy never go, whatever else holds", () => {
  const all: LandedCopies = { paths: new Map([["/w/app", null], ["/w/.worktrees/app-x", null]]), branches: new Map([["feat/x", null]]) };
  assert.equal(canGo(copy({ slot: 0, checkout: "/w/app" }), ROOT, all), null);
  assert.equal(canGo(copy({ adopted: "app.service" }), ROOT, all), null);
});

test("canGo: the merge queue's copy goes only while stopped (running, a check uses it)", () => {
  const q = mergeCopyPath(ROOT);
  assert.deepEqual(canGo(copy({ checkout: q, branch: null, state: "stopped" }), ROOT, NO_LANDED), { kind: "queue" });
  assert.deepEqual(canGo(copy({ checkout: q, branch: null, state: "absent" }), ROOT, NO_LANDED), { kind: "queue" });
  assert.equal(canGo(copy({ checkout: q, branch: null, state: "running" }), ROOT, NO_LANDED), null);
  assert.equal(canGo(copy({ checkout: q, branch: null, state: "degraded" }), ROOT, NO_LANDED), null);
});

test("canGo: a landed copy goes running or not, by its path or its branch; anything else is in use", () => {
  for (const state of ["running", "stopped"] as const) {
    assert.deepEqual(canGo(copy({ state }), ROOT, landedAt("/w/.worktrees/app-x", "2026-11-12T00:00:00Z")), { kind: "landed", at: "2026-11-12T00:00:00Z" });
    assert.deepEqual(canGo(copy({ state }), ROOT, { paths: new Map(), branches: new Map([["feat/x", null]]) }), { kind: "landed", at: null });
    assert.equal(canGo(copy({ state }), ROOT, NO_LANDED), null);
  }
  assert.equal(canGo(copy({ branch: null }), ROOT, { paths: new Map(), branches: new Map([["feat/x", null]]) }), null);
});

test("landedCopies: a coding worktree counts once merged with commits or a recorded merge, and never with commits since", () => {
  const w = (o: Partial<CodingWorktree>): CodingWorktree => ({ sessionId: "s", path: null, title: "t", startedBy: "operator", branch: "feat/a", base: "b", target: "master", running: false, workers: 0, createdAt: "", worktree: "/w/.worktrees/app-a", state: "merged", merged: true, ahead: 2, dirty: false, ...o }) as CodingWorktree;
  const one = (x: CodingWorktree) => landedCopies({ sessions: [x] }, undefined);
  assert.equal(one(w({})).paths.get("/w/.worktrees/app-a"), null);
  assert.equal(one(w({ mergedAt: "2026-11-10T00:00:00Z" })).branches.get("feat/a"), "2026-11-10T00:00:00Z");
  assert.equal(one(w({ ahead: 0, mergedAt: "2026-11-10T00:00:00Z" })).paths.size, 1);
  assert.equal(one(w({ ahead: 0 })).paths.size, 0, "a fresh branch with no commit of its own is not landed");
  assert.equal(one(w({ merged: false })).paths.size, 0);
  assert.equal(one(w({ newSinceMerge: 3 })).paths.size, 0);
});

test("landedCopies: a session's branch counts on a recorded merge, or git and the queue agreeing; the project's own git reading wins", () => {
  const s = (b: Partial<NonNullable<SessionSummary["branches"]>[number]>) => ({ branches: [{ path: "/w/.worktrees/app-b", branch: "feat/b", status: "active", exists: true, ...b }] }) as unknown as SessionSummary;
  const has = (x: SessionSummary, wt?: CodingWorktree[]) => landedCopies(wt ? { sessions: wt } : undefined, [x]).paths.has("/w/.worktrees/app-b");
  assert.equal(has(s({ status: "merged" })), true);
  assert.equal(has(s({ mergedInto: { target: "master", sha: "1" }, queue: { state: "landed", commit: "1" } })), true);
  assert.equal(has(s({ mergedInto: { target: "master", sha: "1" } })), false);
  assert.equal(has(s({ queue: { state: "landed", commit: "1" } })), false);
  const unmerged = { worktree: "/w/.worktrees/app-b", merged: false, ahead: 1, branch: "feat/b" } as CodingWorktree;
  assert.equal(has(s({ status: "merged" }), [unmerged]), false);
});

test("copyGroups keeps order within each group", () => {
  const a = copy({ slot: 1, checkout: "/a" });
  const b = copy({ slot: 2, checkout: "/b" });
  const c = copy({ slot: 3, checkout: "/c" });
  const g = copyGroups([a, b, c], ROOT, { paths: new Map([["/a", null], ["/c", null]]), branches: new Map() });
  assert.deepEqual(g.inUse, [b]);
  assert.deepEqual(g.canGo.map((x) => x.copy), [a, c]);
});

test("the words", () => {
  const now = Date.parse("2026-11-16T00:00:00Z");
  assert.equal(goWord({ kind: "queue" }, now), "left by the merge queue");
  assert.equal(goWord({ kind: "landed", at: null }, now), "landed");
  assert.match(goWord({ kind: "landed", at: "2026-11-12T00:00:00Z" }, now), /^landed 4d ago$/);
  assert.equal(inUseCount([{ state: "running" }, { state: "degraded" }, { state: "stopped" }]), "2 running · 1 stopped");
  assert.equal(canGoCount(0), "nothing to free");
  assert.equal(canGoCount(1), "1 copy · 1 slot back");
  assert.equal(canGoCount(3), "3 copies · 3 slots back");
  assert.equal(freedLine([4]), "Removed 1 copy. Slot 4 is free.");
  assert.equal(freedLine([1, 3, 19]), "Removed 3 copies. Slots 1, 3, 19 are free.");
});
