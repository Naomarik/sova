import assert from "node:assert/strict";
import { test } from "node:test";
import type { MergeEntry, MergeQueueView } from "../../shared/merge-queue";
import type { QueueFile } from "./store";
import { buildView, pushedOf, sentBack, worktreeQueueInfo } from "./view";

// §app.merge-queue/view

const entry = (o: Partial<MergeEntry>): MergeEntry =>
  ({ id: "mq_1", project: "p", target: "master", branch: "feat/a", commit: "c".repeat(40), approval: { by: "land-button", at: "t", commit: "c" }, state: "queued", runs: [], picks: [], notes: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...o }) as MergeEntry;
const view = (o: Partial<MergeQueueView>): MergeQueueView =>
  ({ project: "p", root: "/r", target: "master", batch: 1, state: "idle", checks: "declared", review: false, checking: [], waiting: [], needsYou: [], needsFix: [], recent: [], heads: { target: "t" }, at: "x", ...o }) as MergeQueueView;

test("a branch waiting on the host still has its worktree row, with its request", () => {
  const request = { how: "github-pr", branch: "feat/a", base: "master", number: 7, url: "https://example.invalid/pr/7" } as unknown as MergeEntry["request"];
  const info = worktreeQueueInfo(view({ waitingOnHost: [entry({ state: "requested", request })] }), "feat/a");
  assert.equal(info?.state, "requested");
  assert.deepEqual(info?.request, request);
  assert.equal(worktreeQueueInfo(view({}), "feat/a"), undefined);
});

test("pushedOf: the queue's record wins, else origin's tracking ref; No remote only without origin", () => {
  assert.deepEqual(pushedOf(undefined, { has: true, tracking: "abc" }), { pushed: "abc", hasOrigin: true });
  assert.deepEqual(pushedOf("own", { has: true, tracking: "abc" }), { pushed: "own", hasOrigin: true });
  assert.deepEqual(pushedOf(undefined, { has: false, tracking: null }), { hasOrigin: false });
  assert.deepEqual(pushedOf("own", undefined), { pushed: "own" });
});

type Stored = QueueFile["entries"][number];
let n = 0;
const stored = (o: Partial<Stored>): Stored => {
  n += 1;
  const at = new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
  return { ...entry({ id: `mq_${n}`, createdAt: at, updatedAt: at }), seq: n, ...o } as Stored;
};

test("a sent-back entry is superseded by any later entry for the same branch and target, whatever its state", () => {
  for (const state of ["cancelled", "landed", "queued", "checking", "needs-fix"] as const) {
    const old = stored({ state: "needs-fix" });
    const next = stored({ state });
    const list = sentBack([old, next]);
    assert.equal(list.find((e) => e.id === old.id)?.settled, "superseded", state);
    if (state === "needs-fix") assert.equal(list.find((e) => e.id === next.id)?.settled, undefined, "the newest one still needs its fix");
  }
  const old = stored({ state: "needs-fix" });
  assert.equal(sentBack([old, stored({ state: "landed", target: "release" })])[0]?.settled, undefined, "another target doesn't count");
  assert.equal(sentBack([old, stored({ state: "landed", branch: "feat/b" })])[0]?.settled, undefined, "another branch doesn't count");
  // Without a sequence (an older record), creation time decides.
  const a = { ...stored({ state: "needs-fix" }), seq: undefined } as unknown as Stored;
  const b = { ...stored({ state: "queued" }), seq: undefined } as unknown as Stored;
  assert.equal(sentBack([a, b])[0]?.settled, "superseded");
});

test("merged and gone come from the queue's git facts; a superseded one stays superseded", () => {
  const m = stored({ state: "needs-fix", branch: "feat/m" });
  const g = stored({ state: "needs-fix", branch: "feat/g" });
  const c = stored({ state: "needs-fix", branch: "feat/c" });
  const facts = new Map([[m.id, "merged" as const], [g.id, "gone" as const]]);
  const by = new Map(sentBack([m, g, c], facts).map((e) => [e.id, e.settled]));
  assert.deepEqual([by.get(m.id), by.get(g.id), by.get(c.id)], ["merged", "gone", undefined]);
  const q: QueueFile = { v: 1, project: "p", root: "/r", target: "master", entries: [m, g, c], landed: [], heads: {}, machineTries: {}, seq: n } as unknown as QueueFile;
  const v = buildView({ q, root: "/r", current: null, checks: "declared", review: false, head: "h", takesMs: null, now: 0, readRun: () => null, settled: facts });
  assert.equal(v.needsFix.find((e) => e.id === c.id)?.settled, undefined);
  assert.equal(v.needsFix.find((e) => e.id === m.id)?.settled, "merged");
});

test("the 20-row cap counts only current entries; settled ones ride along only from the 20 newest", () => {
  const old = Array.from({ length: 5 }, (_, i) => stored({ state: "needs-fix", branch: `feat/old${i}` }));
  const settledNew = Array.from({ length: 25 }, (_, i) => stored({ state: "needs-fix", branch: `feat/s${i}` }));
  const facts = new Map(settledNew.map((e) => [e.id, "gone" as const]));
  const list = sentBack([...old, ...settledNew], facts);
  const current = list.filter((e) => !e.settled);
  assert.deepEqual(current.map((e) => e.id).sort(), old.map((e) => e.id).sort(), "older current entries aren't pushed out by newer settled ones");
  assert.equal(list.filter((e) => e.settled).length, 20, "settled ones only from the 20 newest overall");
  const many = Array.from({ length: 30 }, (_, i) => stored({ state: "needs-fix", branch: `feat/n${i}` }));
  const capped = sentBack(many);
  assert.equal(capped.length, 20);
  assert.deepEqual(capped.map((e) => e.id), many.slice(-20).reverse().map((e) => e.id), "the newest 20 current, newest first");
});

test("the worktree row takes the newest entry by creation, not by its last note", () => {
  const old = entry({ id: "mq_old", state: "needs-fix", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-03T00:00:00Z" });
  const landed = entry({ id: "mq_new", state: "landed", createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" });
  assert.equal(worktreeQueueInfo(view({ needsFix: [old], recent: [{ entry: landed }] }), "feat/a")?.id, "mq_new");
});
