import { describe, test } from "node:test";
import { expect } from "./testing/expect";
import type { MergeRun } from "../../shared/merge-queue";
import { estimateFromRuns, etas, median } from "./estimate";

const run = (i: number, verdict: MergeRun["verdict"], mins: number, steps: MergeRun["steps"] = []): MergeRun => {
  const start = Date.UTC(2026, 10, 1, 0, i);
  return { id: `r${i}`, entry: "e", project: "p", branch: "b", base: "x", commit: "y", steps, checks: [], verdict, startedAt: new Date(start).toISOString(), endedAt: new Date(start + mins * 60_000).toISOString() };
};

describe("estimates", () => {
  test("median", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(3);
  });

  test("the median of the last 9 passed runs; failed and void runs don't count", () => {
    const runs = [...Array.from({ length: 12 }, (_, i) => run(i, "passed", i < 3 ? 100 : 5)), run(20, "failed", 1), run(21, "void", 1)];
    expect(estimateFromRuns(runs)).toBe(5 * 60_000);
  });

  test("a run or step that reused passes from identical code teaches no duration", () => {
    const reusing: MergeRun["steps"] = [{ id: "check:unit", kind: "check", label: "u", result: "passed", ms: 1000, log: "x", reused: 568, detail: "412 ran, 568 already passed on identical code (28 re-checked)" }];
    // Nine fast reusing runs, then three full ones: only the full runs set the estimate.
    const runs = [...Array.from({ length: 9 }, (_, i) => run(10 + i, "passed", 1, reusing)), ...Array.from({ length: 3 }, (_, i) => run(i, "passed", 7))];
    expect(estimateFromRuns(runs)).toBe(7 * 60_000);
    // Only reusing runs: no whole-run estimate; their reused steps teach nothing either.
    const only = Array.from({ length: 3 }, (_, i) => run(i, "passed", 1, [...reusing, { id: "copy", kind: "copy", label: "c", result: "passed", ms: 500, log: "x" }]));
    expect(estimateFromRuns(only)).toBe(500);
    expect(estimateFromRuns([run(1, "passed", 1, reusing)])).toBeNull();
  });

  test("no passed run yet: the sum of each step's median; nothing timed: null", () => {
    const steps = (ms: number): MergeRun["steps"] => [
      { id: "copy", kind: "copy", label: "c", result: "passed", ms, log: "x" },
      { id: "check:unit", kind: "check", label: "u", result: "passed", ms: ms * 10, log: "x" },
      { id: "check:build", kind: "check", label: "b", result: "failed", ms: 999_999, log: "x" },
    ];
    expect(estimateFromRuns([run(1, "failed", 1, steps(1000)), run(2, "failed", 1, steps(3000))])).toBe(2000 + 20000);
    expect(estimateFromRuns([])).toBeNull();
  });

  test("each waiting entry starts after what's left of the current run and the ones ahead", () => {
    const now = Date.UTC(2026, 10, 1, 1, 0);
    const current = { startedAt: new Date(now - 4 * 60_000).toISOString() };
    expect(etas(3, current, 10 * 60_000, now)).toEqual([
      { startsInMs: 6 * 60_000, takesMs: 10 * 60_000 },
      { startsInMs: 16 * 60_000, takesMs: 10 * 60_000 },
      { startsInMs: 26 * 60_000, takesMs: 10 * 60_000 },
    ]);
    expect(etas(1, undefined, 60_000, now)).toEqual([{ startsInMs: 0, takesMs: 60_000 }]);
    expect(etas(2, current, null, now)).toEqual([null, null]);
  });
});
