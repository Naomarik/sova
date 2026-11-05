// Run: pnpm test -- server/merge-queue/summary-sweep.test.ts
// The branch summaries' sweep (summary-sweep.ts): its first pass is the backfill of every idle Ready row (no chat
// counts as idle), a model service that didn't answer gets one automatic retry once cooled down, unusable bullets
// never do, and a look with nothing moved passes over nothing.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { MergeReady } from "../../shared/merge-queue";
import { scratchRoot } from "../test-scratch";
import { AUTO_RETRY_AFTER_MS, BranchSummaries, type WriterAnswer } from "./branch-summaries";
import { FULL_EVERY_MS, SummarySweep } from "./summary-sweep";

const dir = scratchRoot("sova-summary-sweep-");
const sha = (n: number) => n.toString(16).padStart(40, "0");
const row = (n: number, x: Partial<MergeReady> = {}): MergeReady => ({ branch: `feat/b${n}`, worktree: `/w/${n}`, commit: sha(n), ahead: 1, ...x });

function kit(name: string, answer: (commit: string, call: number) => WriterAnswer) {
  let clock = Date.parse("2026-11-01T00:00:00Z");
  const calls = new Map<string, number>();
  const asks: string[] = [];
  const s = new BranchSummaries({
    fileOf: (root) => join(dir, name, root.replace(/\W/g, "_"), "branch-summaries.json"),
    facts: async (_r, branch, commit) => ({ branch, commit, target: "master", messages: [{ subject: `commit ${commit}`, body: "" }], files: [] }),
    writer: () => async (prompt) => {
      const c = /commit ([0-9a-f]{40})/.exec(prompt)![1]!;
      asks.push(c);
      const n = (calls.get(c) ?? 0) + 1;
      calls.set(c, n);
      return answer(c, n);
    },
    projectOf: () => "p",
    changed: () => {},
    now: () => clock,
  });
  return { s, asks, now: () => clock, tick: (ms: number) => (clock += ms) };
}
const idle = async (s: BranchSummaries, rows: MergeReady[], root: string) => {
  for (let i = 0; i < 100 && rows.some((r) => s.isWriting(root, r.commit)); i++) await new Promise((r) => setTimeout(r, 5));
};

test("backfill, then one cool-down: every branch reaches ready after the provider failed its first calls; unusable waits for Try Again", async () => {
  // The service fails each commit's first call; 4's answer is unusable every time.
  const k = kit("backfill", (c, n) => (c === sha(4) ? { failed: "unusable" } : n === 1 ? null : { bullets: [`Does ${c.slice(-1)}`], model: "prov/a" }));
  const rows = [row(1), row(2, { session: "chat-gone", sessionArchived: true }), row(3, { session: "chat-idle" }), row(4)];
  const sweep = new SummarySweep({ roots: () => ["/p"], readyOf: async () => rows, targetHead: async () => "t1", chatIdle: async () => true, summaries: k.s, now: k.now });
  await sweep.tick();
  await idle(k.s, rows, "/p");
  assert.deepEqual(new Set(k.asks), new Set(rows.map((r) => r.commit)), "the backfill asks for every row, no chat or archived included");
  for (const r of rows) assert.equal(k.s.summaryOf("/p", r.branch, r.commit)?.state, "failed");
  // Nothing moved and not due: no look.
  await sweep.tick();
  assert.equal(k.asks.length, 4);
  // Past the cool-down and a full pass due: the one retry.
  k.tick(Math.max(AUTO_RETRY_AFTER_MS, FULL_EVERY_MS));
  await sweep.tick();
  await idle(k.s, rows, "/p");
  for (const r of rows.slice(0, 3)) assert.equal(k.s.summaryOf("/p", r.branch, r.commit)?.state, "ready", r.branch);
  assert.equal(k.s.summaryOf("/p", "feat/b4", sha(4))?.state, "failed", "unusable bullets aren't retried by themselves");
  assert.equal(k.asks.filter((c) => c === sha(4)).length, 1);
  // Later passes ask for nothing more.
  k.tick(FULL_EVERY_MS * 3);
  await sweep.tick();
  await idle(k.s, rows, "/p");
  assert.equal(k.asks.length, 7);
});

test("a busy chat's branch is skipped; a moved target or a poke passes again at once", async () => {
  const k = kit("busy", () => ({ bullets: ["Ok"], model: "prov/a" }));
  let busy = true;
  let head = "t1";
  const rows = [row(10, { session: "c1" })];
  const sweep = new SummarySweep({ roots: () => ["/p"], readyOf: async () => rows, targetHead: async () => head, chatIdle: async () => !busy, summaries: k.s, now: k.now });
  await sweep.tick();
  assert.equal(k.asks.length, 0);
  busy = false;
  await sweep.tick();
  assert.equal(k.asks.length, 0, "nothing moved: no pass");
  head = "t2";
  await sweep.tick();
  await idle(k.s, rows, "/p");
  assert.equal(k.asks.length, 1, "the target moved: a pass");
  rows.push(row(11));
  sweep.poke("/p");
  await sweep.tick();
  await idle(k.s, rows, "/p");
  assert.equal(k.asks.length, 2, "a poke: a pass");
});
