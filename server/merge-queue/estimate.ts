/**
 * How long a run takes, from this project's run history: the median of its last 9 runs that passed (start to end),
 * else a first guess from the median of each check's own passing steps, else null (never timed). A run or step that
 * reused passes from identical code (RunStep.reused) teaches nothing: its time isn't the checks'. "Starts in" for an
 * entry is the sum over the entries ahead of it plus what is left of the run now checking.
 */
import type { MergeRun } from "../../shared/merge-queue";

export const median = (xs: readonly number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

const span = (r: Pick<MergeRun, "startedAt" | "endedAt">): number | null => {
  if (!r.endedAt) return null;
  const ms = Date.parse(r.endedAt) - Date.parse(r.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
};

/** A run's expected length (ms) from `runs` (any order), or null when none passed yet. */
export function estimateFromRuns(runs: readonly MergeRun[]): number | null {
  const passed = runs
    .filter((r) => r.verdict === "passed" && r.endedAt && !r.steps.some((s) => s.reused))
    .sort((a, b) => Date.parse(b.endedAt!) - Date.parse(a.endedAt!))
    .slice(0, 9)
    .map(span)
    .filter((x): x is number => x !== null);
  if (passed.length) return median(passed);
  // No whole run passed yet: the sum of each step kind's median over the steps that passed.
  const byStep = new Map<string, number[]>();
  for (const r of runs) for (const s of r.steps) if (s.result === "passed" && s.ms > 0 && !s.reused) byStep.set(s.id, [...(byStep.get(s.id) ?? []), s.ms]);
  if (!byStep.size) return null;
  let sum = 0;
  for (const xs of byStep.values()) sum += median(xs.slice(-9))!;
  return sum;
}

/** How long the run now checking still needs (never below 0), from its start and the estimate. */
export function remainingMs(current: Pick<MergeRun, "startedAt"> | undefined, takesMs: number | null, now = Date.now()): number {
  if (!current || takesMs === null) return 0;
  return Math.max(0, takesMs - (now - Date.parse(current.startedAt)));
}

/** Each waiting entry's {startsInMs, takesMs}, in line order. Null estimate: nothing known (no eta shown). */
export function etas(waiting: number, current: Pick<MergeRun, "startedAt"> | undefined, takesMs: number | null, now = Date.now()): ({ startsInMs: number; takesMs: number } | null)[] {
  if (takesMs === null) return Array.from({ length: waiting }, () => null);
  const first = remainingMs(current, takesMs, now);
  return Array.from({ length: waiting }, (_, i) => ({ startsInMs: first + i * takesMs, takesMs }));
}
