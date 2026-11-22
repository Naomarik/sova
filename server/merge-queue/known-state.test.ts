import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { MergeHistoryRow, MergeRun } from "../../shared/merge-queue";
import { FLAKY_RUNS_KEPT, type MergeFlakyTest } from "../../shared/merge-queue-health";
import { afterRun, CLEAN_EVERY_MS, cleanFor, cleanInfo } from "./clean-run";
import { countFlaky, FlakyStore, flakyFixText, flakyKey } from "./flaky";
import { healthOf, historyPage } from "./health";

const T0 = Date.UTC(2026, 10, 1);
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const DAY = 86_400_000;

describe("clean runs: when a run starts from an empty copy", () => {
  test("asked for wins; else the weekly one is due a week after the last clean run, or with none recorded", () => {
    const last = { at: new Date(T0).toISOString(), run: "mr_a", why: "operator" as const };
    // Every edge of the week: just before it reuses, at it and after it is clean.
    assert.equal(cleanFor({ last }, T0 + CLEAN_EVERY_MS - 1), undefined);
    assert.equal(cleanFor({ last }, T0 + CLEAN_EVERY_MS), "weekly");
    assert.equal(cleanFor({ last }, T0 + 30 * DAY), "weekly");
    assert.equal(cleanFor(undefined, T0), "weekly");
    assert.equal(cleanFor({ last: { ...last, at: "garbage" } }, T0), "weekly");
    // Asked for: clean whatever the week says, the moment after a clean run too.
    assert.equal(cleanFor({ last, next: { why: "operator", at: last.at } }, T0 + 1), "operator");
  });

  test("a clean run spends the ask and restarts the week; a reusing run changes nothing", () => {
    const asked = { next: { why: "operator" as const, at: at(0), entry: "mq_1" } };
    assert.deepEqual(afterRun(asked, { id: "mr_b", startedAt: at(5) }), asked);
    const after = afterRun(asked, { id: "mr_b", startedAt: at(5), clean: "operator" });
    assert.deepEqual(after, { last: { at: at(5), run: "mr_b", why: "operator" } });
    assert.equal(cleanFor(after, Date.parse(at(6))), undefined);
  });

  test("a Clean Run pressed while a clean run checks survives it; one asked on a branch's entry waits for that branch's run", () => {
    // Pressed at minute 3, during the weekly clean run that started at minute 1: its end keeps the ask.
    const during = afterRun({ next: { why: "operator", at: at(3) } }, { id: "mr_w", branch: "feat/y", startedAt: at(1), clean: "weekly" });
    assert.deepEqual(during, { next: { why: "operator", at: at(3) }, last: { at: at(1), run: "mr_w", why: "weekly" } });
    // Asked on feat/x's entry: feat/y's run doesn't take it (nor spend it), feat/x's does.
    const onX = { next: { why: "operator" as const, at: at(0), entry: "mq_x", branch: "feat/x" }, last: { at: at(0), run: "mr_a", why: "new" as const } };
    assert.equal(cleanFor(onX, Date.parse(at(1)), "feat/y"), undefined);
    assert.equal(cleanFor(onX, Date.parse(at(1)), "feat/x"), "operator");
    assert.deepEqual(afterRun(onX, { id: "mr_y", branch: "feat/y", startedAt: at(2), clean: "weekly" })?.next, onX.next);
    assert.equal(afterRun(onX, { id: "mr_x", branch: "feat/x", startedAt: at(2), clean: "operator" })?.next, undefined);
  });

  test("the view says what is asked, the last clean run and when the weekly one is due (never in the past)", () => {
    const last = { at: at(0), run: "mr_a", why: "new" as const };
    assert.deepEqual(cleanInfo({ last }, T0 + DAY), { last, dueAt: new Date(T0 + CLEAN_EVERY_MS).toISOString() });
    assert.equal(cleanInfo({ last }, T0 + 9 * DAY).dueAt, new Date(T0 + 9 * DAY).toISOString());
    assert.deepEqual(cleanInfo(undefined, T0), { dueAt: new Date(T0).toISOString() });
    assert.equal(cleanInfo({ next: { why: "operator", at: at(1) } }, T0).next?.why, "operator");
  });
});

const run = (id: string, minutes: number, branch = "feat/a") => ({ run: id, entry: `mq_${id}`, branch, at: at(minutes) });

describe("flaky tests, counted across landings", () => {
  test("one count per run per test; a test named by file and by name stays two rows; nothing is merged by guess", () => {
    let tests: MergeFlakyTest[] = [];
    tests = countFlaky(tests, [{ check: "unit", label: "Unit", file: "a.test.ts" }, { check: "unit", label: "Unit", file: "a.test.ts" }], run("mr_1", 1));
    tests = countFlaky(tests, [{ check: "unit", label: "Unit", file: "a.test.ts" }], run("mr_1", 1));
    tests = countFlaky(tests, [{ check: "unit", label: "Unit", file: "a.test.ts" }, { check: "unit", label: "Unit", name: "adds" }], run("mr_2", 9, "feat/b"));
    assert.deepEqual(
      tests.map((t) => [t.key, t.count, t.firstAt, t.lastAt, t.runs.map((r) => r.run)]),
      [
        [flakyKey({ check: "unit", file: "a.test.ts" }), 2, at(1), at(9), ["mr_2", "mr_1"]],
        [flakyKey({ check: "unit", name: "adds" }), 1, at(9), at(9), ["mr_2"]],
      ],
    );
    // A key can't be faked by joining fields: check "a" + file "b" is not check "a\0b".
    assert.notEqual(flakyKey({ check: "a", file: "b" }), flakyKey({ check: "a", name: "b" }));
  });

  test("runs kept are the newest FLAKY_RUNS_KEPT; the count goes on past them", () => {
    let tests: MergeFlakyTest[] = [];
    for (let i = 0; i < FLAKY_RUNS_KEPT + 5; i++) tests = countFlaky(tests, [{ check: "unit", label: "Unit", name: "x" }], run(`mr_${i}`, i));
    assert.equal(tests[0]!.count, FLAKY_RUNS_KEPT + 5);
    assert.equal(tests[0]!.runs.length, FLAKY_RUNS_KEPT);
    assert.equal(tests[0]!.runs[0]!.run, `mr_${FLAKY_RUNS_KEPT + 4}`);
    assert.equal(tests[0]!.firstAt, at(0));
  });

  test("the store keeps them for good, survives a damaged file, and marks a fix", () => {
    const dir = mkdtempSync(join(tmpdir(), "flaky-"));
    try {
      const s = new FlakyStore(dir);
      assert.deepEqual(s.record([], run("mr_0", 0)), []);
      assert.equal(s.record([{ check: "unit", label: "Unit", file: "a.test.ts" }], run("mr_1", 1)).length, 1);
      assert.equal(s.record([{ check: "unit", label: "Unit", file: "a.test.ts" }], run("mr_1", 1)).length, 0);
      const key = s.list()[0]!.key;
      s.markFix(key, { at: at(2), session: "s1", path: "/x.jsonl" });
      assert.equal(new FlakyStore(dir).get(key)?.fix?.session, "s1");
      // The fix stays through a later count.
      s.record([{ check: "unit", label: "Unit", file: "a.test.ts" }], run("mr_3", 3));
      assert.equal(s.get(key)?.count, 2);
      assert.equal(s.get(key)?.fix?.session, "s1");
      writeFileSync(s.file, "{not json");
      assert.deepEqual(s.list(), []);
      assert.equal(s.record([{ check: "unit", label: "Unit", name: "n" }], run("mr_4", 4)).length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Fix in New Chat's message names the test, how often, its runs and logs, and never asks to skip it", () => {
    const t = countFlaky([], [{ check: "unit", label: "Unit", file: "a.test.ts", name: "adds" }], run("mr_1", 1))[0]!;
    const text = flakyFixText(t, { target: "main", runPage: (r) => `#/runs/${r}`, logs: [{ run: "mr_1", path: "/state/runs/mr_1/check-unit.log" }] });
    for (const want of ['"adds"', "a.test.ts", "Unit", "1 merge queue run", "#/runs/mr_1", "/state/runs/mr_1/check-unit.log", "new branch from main", "Never skip it"]) assert.ok(text.includes(want), want);
  });
});

const row = (n: number, over: Partial<MergeHistoryRow> = {}): MergeHistoryRow => ({ id: `mq_${String(n).padStart(4, "0")}`, finalAt: at(n), branch: `feat/b${n}`, target: "main", commit: "c".repeat(40), state: "landed", ...over });

describe("the history's pages", () => {
  const months = { "2026-10": [row(-50_000), row(-40_000)], "2026-11": Array.from({ length: 25 }, (_, i) => row(i + 1)) } as Record<string, MergeHistoryRow[]>;
  const read = (m: string) => months[m] ?? [];

  test("Show Older walks every row exactly once, newest first, across months, and ends with no next", () => {
    const seen: string[] = [];
    let before: string | undefined;
    for (let i = 0; i < 10; i++) {
      const p = historyPage(Object.keys(months), read, { limit: 7, ...(before ? { before } : {}) });
      seen.push(...p.rows.map((r) => r.id));
      if (!p.next) break;
      before = p.next;
    }
    const all = Object.values(months).flat().sort((a, b) => b.finalAt.localeCompare(a.finalAt));
    assert.deepEqual(seen, all.map((r) => r.id));
  });

  test("search by branch (any case) pages too; limits are clamped", () => {
    const p = historyPage(Object.keys(months), read, { branch: "B1", limit: 3 });
    assert.deepEqual(p.rows.map((r) => r.branch), ["feat/b19", "feat/b18", "feat/b17"]);
    const rest = historyPage(Object.keys(months), read, { branch: "b1", limit: 100, before: p.next! });
    assert.ok(rest.rows.every((r) => r.branch.includes("b1")) && !rest.next);
    assert.equal(historyPage(Object.keys(months), read, { limit: 0 }).rows.length, 1);
    assert.equal(historyPage(Object.keys(months), read, { limit: 10_000 }).rows.length, 27);
  });

  test("a row says when it was approved and landed, how long that took, its runs and why it went back", () => {
    const entry = { id: "mq_x", approval: { at: at(0) }, landed: { at: at(90) }, runs: ["mr_1", "mr_2"], run: "mr_2", session: "s", reason: "unit failed", requests: [{ kind: "fix", cause: "checks" }, { kind: "thread-ask" }, { kind: "fix", cause: "drafts" }] } as never;
    const [slim] = historyPage(["2026-11"], () => [row(100, { entry })], {}).rows;
    assert.deepEqual(slim, { id: row(100).id, branch: "feat/b100", commit: "c".repeat(40), state: "landed", finalAt: at(100), approvedAt: at(0), landedAt: at(90), timeToLandMs: 90 * 60_000, runs: 2, sentBack: ["checks", "drafts"], run: "mr_2", session: "s", reason: "unit failed" });
  });
});

const mrun = (i: number, verdict: MergeRun["verdict"], startMin: number, steps: MergeRun["steps"] = [], over: Partial<MergeRun> = {}): MergeRun => ({ id: `mr_${i}`, entry: `mq_${i}`, project: "p", branch: "b", base: "x", commit: "y", steps, checks: [], verdict, startedAt: at(startMin), ...over });
const step = (id: string, ms: number, over: Partial<MergeRun["steps"][number]> = {}): MergeRun["steps"][number] => ({ id: `check:${id}`, kind: "check", label: id.toUpperCase(), result: "passed", ms, log: "x", ...over });

describe("the health summary", () => {
  test("over the window only: time to land, pass rate (void, cancelled and dry runs left out), slowest checks, send-backs, flaky, clean runs", () => {
    const now = at(60 * 24 * 40);
    const old = 0;
    const recent = 60 * 24 * 35;
    const landedRow = (n: number, mins: number, over: Partial<MergeHistoryRow> = {}) => row(recent + n, { entry: { approval: { at: at(recent + n - mins) }, landed: { at: at(recent + n) }, runs: [], requests: [{ kind: "fix", cause: "checks" }] } as never, ...over });
    const rows = [landedRow(1, 10), landedRow(2, 30), landedRow(3, 20, { state: "pushed" }), row(recent + 4, { state: "cancelled", entry: { runs: [], requests: [{ kind: "fix", cause: "conflict" }, { kind: "fix", cause: "checks" }] } as never }), row(old, { state: "landed" })];
    const runs = [
      mrun(1, "passed", recent, [step("unit", 100), step("e2e", 900), step("unit", 300, { reused: 5 })], { ranWith: { copy: "fresh" } as never }),
      mrun(2, "failed", recent + 1, [step("unit", 200), step("e2e", 0)]),
      mrun(7, "machine", recent + 5),
      mrun(3, "void", recent + 2),
      mrun(4, "cancelled", recent + 3),
      { ...mrun(5, "passed", recent + 4), entry: "trial" },
      mrun(6, "failed", old, [step("slow", 99_999)]),
    ];
    const flaky = countFlaky(countFlaky([], [{ check: "unit", label: "Unit", name: "old" }], run("mr_o", old)), [{ check: "unit", label: "Unit", name: "new" }], run("mr_n", recent));
    const h = healthOf({ rows, runs, flaky, now, days: 30 });
    assert.equal(h.landed, 3);
    assert.equal(h.finished, 4);
    assert.deepEqual(h.timeToLand, { medianMs: 20 * 60_000, p90Ms: 30 * 60_000 });
    assert.deepEqual(h.passRate, { passed: 1, runs: 2, rate: 0.5 });
    assert.deepEqual(h.slowestChecks, [{ id: "e2e", label: "E2E", medianMs: 900, runs: 1 }, { id: "unit", label: "UNIT", medianMs: 150, runs: 2 }]);
    assert.deepEqual(h.sendBacks, [{ why: "checks", count: 4 }, { why: "conflict", count: 1 }]);
    assert.deepEqual(h.flaky.map((t) => t.name), ["new"]);
    assert.equal(h.cleanRuns, 1);
  });

  test("nothing yet: every number says so (null, never 0 % or 0 ms)", () => {
    const h = healthOf({ rows: [], runs: [], flaky: [], now: at(0), days: 30 });
    assert.deepEqual([h.timeToLand, h.passRate, h.slowestChecks, h.flaky, h.sendBacks, h.cleanRuns], [{ medianMs: null, p90Ms: null }, { passed: 0, runs: 0, rate: null }, [], [], [], 0]);
  });
});
