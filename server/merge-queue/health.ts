/**
 * Landed's numbers (pure): the history's pages (newest first, Show Older, search by branch) and the health summary on
 * top (time to land, pass rate, slowest checks, flaky tests, usual send-back reasons, clean runs), from the history's
 * rows, the runs still on disk and the flaky store.
 */
import type { MergeHistoryRow, MergeRun, SentBackFor } from "../../shared/merge-queue";
import type { MergeFlakyTest, MergeHistoryPage, MergeHistorySlim, MergeQueueHealth } from "../../shared/merge-queue-health";
import { median } from "./estimate";
import { byFlakiness } from "./flaky";

export const HISTORY_PAGE_DEFAULT = 20;
export const HISTORY_PAGE_MAX = 100;

const ms = (a?: string, b?: string): number | undefined => {
  if (!a || !b) return undefined;
  const d = Date.parse(b) - Date.parse(a);
  return Number.isFinite(d) && d >= 0 ? d : undefined;
};

/** The causes an entry was sent back for, oldest first: each fix request's, else its stored one. */
function sendBacksOf(r: MergeHistoryRow): SentBackFor[] {
  const e = r.entry;
  if (!e) return [];
  const causes = (e.requests ?? []).filter((q) => q.kind === "fix" && q.cause).map((q) => q.cause!);
  if (!causes.length && e.sentBackFor) causes.push(e.sentBackFor);
  return causes;
}

/** A history row as a page lists it. */
export function slimOf(r: MergeHistoryRow): MergeHistorySlim {
  const e = r.entry;
  const approvedAt = e?.approval?.at ?? r.startedAt;
  const landedAt = e?.landed?.at;
  const ttl = landedAt ? ms(approvedAt, landedAt) : undefined;
  const sent = sendBacksOf(r);
  const run = e?.run ?? r.runs?.at(-1);
  return {
    id: r.id,
    branch: r.branch,
    commit: r.commit,
    ...(r.state ? { state: r.state } : {}),
    finalAt: r.finalAt,
    ...(approvedAt ? { approvedAt } : {}),
    ...(landedAt ? { landedAt } : {}),
    ...(ttl !== undefined ? { timeToLandMs: ttl } : {}),
    runs: e?.runs?.length ?? r.runs?.length ?? 0,
    ...(sent.length ? { sentBack: sent } : {}),
    ...(run ? { run } : {}),
    ...(r.verdict ? { verdict: r.verdict } : {}),
    ...(e?.session ? { session: e.session } : {}),
    ...(e?.reason ? { reason: e.reason } : {}),
    ...(r.partial ? { partial: true as const } : {}),
  };
}

/** Newest first: by finalAt, then id (ids are time-ordered). The cursor is that pair. */
const newestFirst = (a: Pick<MergeHistoryRow, "finalAt" | "id">, b: Pick<MergeHistoryRow, "finalAt" | "id">): number => b.finalAt.localeCompare(a.finalAt) || b.id.localeCompare(a.id);
export const cursorOf = (r: Pick<MergeHistoryRow, "finalAt" | "id">): string => `${r.finalAt}|${r.id}`;
const isOlder = (r: Pick<MergeHistoryRow, "finalAt" | "id">, cursor: string): boolean => {
  const bar = cursor.lastIndexOf("|");
  const at = bar >= 0 ? cursor.slice(0, bar) : cursor;
  const id = bar >= 0 ? cursor.slice(bar + 1) : "";
  return newestFirst({ finalAt: at, id }, r) < 0;
};

/**
 * One page of the history, newest first. `months`: the history's months, any order; `read`: a month's rows. Reads
 * newest months first and stops once the page is full plus one row (to know there is more). `branch`: rows whose
 * branch contains it (case-insensitive). `before`: the previous page's `next`.
 */
export function historyPage(months: readonly string[], read: (month: string) => MergeHistoryRow[], o: { branch?: string; before?: string; limit?: number } = {}): MergeHistoryPage {
  const limit = Math.max(1, Math.min(HISTORY_PAGE_MAX, Math.floor(o.limit ?? HISTORY_PAGE_DEFAULT)));
  const needle = o.branch?.trim().toLowerCase();
  const beforeMonth = o.before ? o.before.slice(0, 7) : null;
  const picked: MergeHistoryRow[] = [];
  for (const month of [...months].sort().reverse()) {
    if (beforeMonth && month > beforeMonth) continue;
    const rows = read(month)
      .filter((r) => (!needle || r.branch.toLowerCase().includes(needle)) && (!o.before || isOlder(r, o.before)))
      .sort(newestFirst);
    picked.push(...rows);
    if (picked.length > limit) break;
  }
  picked.sort(newestFirst);
  const page = picked.slice(0, limit);
  return { rows: page.map(slimOf), ...(picked.length > limit ? { next: cursorOf(page.at(-1)!) } : {}) };
}

const p90 = (xs: readonly number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)]!;
};

/** Verdicts a pass rate counts: the run reached a verdict about the code. */
const COUNTED = new Set(["passed", "failed", "conflict", "waiting", "machine"]);

/**
 * The health summary over [since, until]: `rows` the history rows finished in or after `since` (more are filtered
 * out), `runs` every run on disk (landing runs only are read: dry runs and trials aren't landings), `flaky` the store.
 */
export function healthOf(o: { rows: readonly MergeHistoryRow[]; runs: readonly MergeRun[]; flaky: readonly MergeFlakyTest[]; now: string; days: number; top?: number }): MergeQueueHealth {
  const top = o.top ?? 5;
  const until = o.now;
  const since = new Date(Date.parse(o.now) - o.days * 86_400_000).toISOString();
  const rows = o.rows.filter((r) => r.finalAt >= since && r.finalAt <= until);
  const slim = rows.map(slimOf);
  const landed = slim.filter((r) => r.state === "landed" || r.state === "pushed");
  const ttl = landed.map((r) => r.timeToLandMs).filter((x): x is number => x !== undefined);
  const runs = o.runs.filter((r) => r.entry?.startsWith("mq_") && r.startedAt >= since && r.startedAt <= until);
  const counted = runs.filter((r) => COUNTED.has(r.verdict));
  const passed = counted.filter((r) => r.verdict === "passed").length;
  const byCheck = new Map<string, { label: string; ms: number[] }>();
  for (const r of runs)
    for (const s of r.steps) {
      if (s.kind !== "check" || s.result !== "passed" || s.reused || !(s.ms > 0)) continue;
      const id = s.id.replace(/^check:/, "");
      const c = byCheck.get(id) ?? { label: s.label, ms: [] };
      c.ms.push(s.ms);
      byCheck.set(id, c);
    }
  const slowestChecks = [...byCheck.entries()]
    .map(([id, c]) => ({ id, label: c.label, medianMs: median(c.ms)!, runs: c.ms.length }))
    .sort((a, b) => b.medianMs - a.medianMs || a.id.localeCompare(b.id))
    .slice(0, top);
  const sends = new Map<SentBackFor, number>();
  for (const r of slim) for (const why of r.sentBack ?? []) sends.set(why, (sends.get(why) ?? 0) + 1);
  const sendBacks = [...sends.entries()].map(([why, count]) => ({ why, count })).sort((a, b) => b.count - a.count || a.why.localeCompare(b.why));
  const flaky = o.flaky
    .filter((t) => t.lastAt >= since)
    // Seen first inside the window: every count is the window's; else the runs kept that fall in it.
    .map((t) => ({ ...t, count: t.firstAt >= since ? t.count : t.runs.filter((r) => r.at >= since).length }))
    .filter((t) => t.count > 0)
    .sort(byFlakiness)
    .slice(0, top);
  return {
    since,
    until,
    landed: landed.length,
    finished: slim.length,
    timeToLand: { medianMs: median(ttl), p90Ms: p90(ttl) },
    passRate: { passed, runs: counted.length, rate: counted.length ? passed / counted.length : null },
    slowestChecks,
    flaky,
    sendBacks,
    cleanRuns: runs.filter((r) => (r as MergeRun & { ranWith?: { copy?: string } }).ranWith?.copy === "fresh").length,
  };
}
