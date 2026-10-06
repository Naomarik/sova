// The usage history (§app.insights/usage-burn): each subscription window's provider-reported
// percent, recorded over time on this device, so the Usage page can say how fast it is going, how
// that compares with the last period and when it runs out at this pace.
//
// Append-only `<state root>/usage-history/v1/<UTC day>.jsonl`, one sample per line, written by this
// server alone; kept KEEP_DAYS days, pruned at start and once a day; never synced. Node builtins
// only, plus types.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CacheFile } from "../pi-config/extensions/usage-status/fetch.ts";
import { stateRoot } from "./state-root";

/** Raw samples are kept this many days; a closed period's summary, a year. */
export const KEEP_DAYS = 30;
export const SUMMARY_KEEP_DAYS = 365;
/** A period closes by its reset this long after it: a reading stamped before the reset (an adopted cache, the file read at start) may still arrive. */
export const CLOSE_GRACE_MS = 15 * 60_000;
/** A held-back plateau reading is written once it is this much newer than the last line. */
export const PENDING_FLUSH_MS = 60 * 60_000;
const DAY_MS = 86_400_000;
/** A reading is in the open period when its reset is within this of the period's, or 1% of the span if more. */
export const PERIOD_TOLERANCE_MS = 2 * 60_000;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
/** The balance's window key (DeepSeek reports money left, not windows). */
export const BALANCE_WINDOW = "balance";

/** One recorded window reading. Times are ms epochs; `startsAt` only when the reading says it. */
export interface UsageSample {
  t: number;
  pct: number;
  resetsAt?: number;
  startsAt?: number;
}
/** One recorded balance reading. */
export interface BalanceSample {
  t: number;
  total: number;
  currency: string;
}
/** One reading of the cache, keyed for the history. */
export type UsageReading =
  | ({ series: string; window: string; label: string } & UsageSample)
  | ({ series: string; window: typeof BALANCE_WINDOW } & BalanceSample);

type Line = { v: 1; s: string; w: string } & (UsageSample | BalanceSample);

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const key = (series: string, window: string) => `${series}\u0000${window}`;

/** The window key: its label plus its scope ("7d scoped/Fable"). */
export const windowKey = (label: string, scope?: string) => (scope ? `${label}/${scope}` : label);

/** UTC day of a time, as its file is named. */
export const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/** A window's span in ms from its label ("5h", "7d", "7d scoped", "45m", "1w", "month"), or null. */
export function labelSpanMs(label: string): number | null {
  if (label === "month") return 30 * DAY_MS;
  const m = /^(\d+)([mhdw])$/.exec(label.replace(/ scoped$/, ""));
  if (!m) return null;
  const unit = { m: 60_000, h: 3_600_000, d: DAY_MS, w: 7 * DAY_MS }[m[2] as "m" | "h" | "d" | "w"];
  return Number(m[1]) * unit;
}

/** What identifies a reading's period: a declared month's start, else its reset. */
const anchor = (s: UsageSample) => s.startsAt ?? s.resetsAt;

/**
 * Whether `next` is a reading of the period `prev` belongs to: the anchor (reset, or a declared
 * month's start) within the tolerance and the percent not dropped. A window with no anchor starts
 * a new period only when the percent drops; one that gains an anchor starts one.
 */
export function samePeriod(prev: UsageSample, next: UsageSample, label: string): boolean {
  if (next.pct < prev.pct) return false;
  const a = anchor(prev);
  const b = anchor(next);
  if (a === undefined || b === undefined) return a === undefined && b === undefined;
  const span = prev.resetsAt !== undefined && prev.startsAt !== undefined ? prev.resetsAt - prev.startsAt : labelSpanMs(label);
  const tolerance = Math.max(PERIOD_TOLERANCE_MS, span ? span * 0.01 : 0);
  return Math.abs(b - a) <= tolerance;
}

/** Samples split into periods, in time order. */
export function splitPeriods(samples: readonly UsageSample[], label: string): UsageSample[][] {
  const out: UsageSample[][] = [];
  for (const s of samples) {
    const open = out[out.length - 1];
    if (open && samePeriod(open[open.length - 1]!, s, label)) open.push(s);
    else out.push([s]);
  }
  return out;
}

/** Balance samples split into runs: a rise of the total (a top-up) or a new currency starts one. */
export function splitRuns(samples: readonly BalanceSample[]): BalanceSample[][] {
  const out: BalanceSample[][] = [];
  for (const s of samples) {
    const open = out[out.length - 1];
    const prev = open?.[open.length - 1];
    if (open && prev && prev.currency === s.currency && s.total <= prev.total + 0.005) open.push(s);
    else out.push([s]);
  }
  return out;
}

/** One line, strictly: anything else is skipped. */
export function parseLine(text: string): Line | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRec(v) || v.v !== 1 || typeof v.s !== "string" || !v.s || v.s.length > 200 || typeof v.w !== "string" || !v.w || v.w.length > 200) return null;
  if (!finite(v.t) || v.t <= 0) return null;
  if (v.w === BALANCE_WINDOW) {
    if (!finite(v.total) || typeof v.currency !== "string" || !v.currency) return null;
    return { v: 1, s: v.s, w: v.w, t: v.t, total: v.total, currency: v.currency };
  }
  if (!finite(v.pct) || v.pct < 0) return null;
  if (v.resetsAt !== undefined && !finite(v.resetsAt)) return null;
  if (v.startsAt !== undefined && !finite(v.startsAt)) return null;
  return {
    v: 1,
    s: v.s,
    w: v.w,
    t: v.t,
    pct: v.pct,
    ...(v.resetsAt !== undefined ? { resetsAt: v.resetsAt as number } : {}),
    ...(v.startsAt !== undefined ? { startsAt: v.startsAt as number } : {}),
  };
}

const time = (iso: unknown): number | undefined => {
  const t = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? undefined : t;
};

/** A window of the cache: `{label, pct, resetsAt?}` (+ `scope`, OpenAI's `seconds`). */
function windowReading(series: string, t: number, w: unknown, label?: string): UsageReading | null {
  if (!isRec(w) || !finite(w.pct)) return null;
  const name = label ?? (typeof w.label === "string" && w.label ? w.label : null);
  if (!name) return null;
  const resetsAt = time(w.resetsAt);
  const startsAt = resetsAt !== undefined && finite(w.seconds) && w.seconds > 0 ? resetsAt - w.seconds * 1000 : undefined;
  const scope = typeof w.scope === "string" && w.scope ? w.scope : undefined;
  return {
    series,
    window: windowKey(name, scope),
    label: name,
    t,
    pct: w.pct,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(startsAt !== undefined ? { startsAt } : {}),
  };
}

/** A Claude reading's windows: `limits[]` when it has one, else the legacy named windows. */
function claudeReadings(series: string, t: number, data: unknown): UsageReading[] {
  if (!isRec(data) || data.state !== "ok") return [];
  if (Array.isArray(data.limits) && data.limits.length) {
    const out = data.limits.map((l) => windowReading(series, t, l)).filter((r): r is UsageReading => r !== null);
    if (out.length) return out;
  }
  return [windowReading(series, t, data.fiveHour, "5h"), windowReading(series, t, data.sevenDay, "7d"), windowReading(series, t, data.sevenDayOpus, "7d opus")].filter(
    (r): r is UsageReading => r !== null,
  );
}

export interface SampleInput {
  /** login id → its account's uuid; a login without one (identity not known yet) is skipped. */
  accounts: Readonly<Record<string, string | undefined>>;
  /** Ollama's declared month at a time (§app.insights/usage-reset-day), or null when no day is set. */
  ollamaMonth?: (t: number) => { startsAt: string; resetsAt: string } | null;
}

/**
 * Every reading a cache carries, keyed for the history. Claude: one series per account, each
 * login stamped with its own fetchedAt; a login with no known account, or none at all, is left
 * out. Other providers: stamped with the cache's fetchedAt, and left out while their `errors`
 * entry is set (a failed fetch keeps the old value under a fresh cache time).
 */
export function readingsOf(cache: CacheFile, input: SampleInput): UsageReading[] {
  const out: UsageReading[] = [];
  const errors: Record<string, unknown> = isRec(cache.errors) ? cache.errors : {};
  const claude = (login: string, data: unknown, t: number | undefined) => {
    const uuid = input.accounts[login];
    if (!uuid || !finite(t)) return;
    out.push(...claudeReadings(`claude:${uuid}`, t, data));
  };
  if (!errors.claude) claude("default", cache.claude, cache.claudeFetchedAt ?? cache.fetchedAt);
  for (const [id, a] of Object.entries(cache.claudeAccounts ?? {})) if (isRec(a) && !a.error) claude(id, a.data, a.fetchedAt);
  const t = cache.fetchedAt;
  if (!finite(t)) return out;
  const ok = (id: "openai" | "zai" | "ollama" | "deepseek"): Record<string, unknown> | null => {
    const d = cache[id];
    return !errors[id] && isRec(d) && d.state === "ok" ? d : null;
  };
  const openai = ok("openai");
  if (openai && Array.isArray(openai.windows)) for (const w of openai.windows) {
    const r = windowReading("openai", t, w);
    if (r) out.push(r);
  }
  const zai = ok("zai");
  if (zai) {
    const plan = windowReading("zai", t, zai.fiveHour, isRec(zai.fiveHour) && typeof zai.fiveHour.label === "string" ? zai.fiveHour.label : "plan");
    const mcp = windowReading("zai", t, zai.mcp, "mcp");
    for (const r of [plan, mcp]) if (r) out.push(r);
  }
  const ollama = ok("ollama");
  if (ollama && finite(ollama.usedPct)) {
    const month = input.ollamaMonth?.(t) ?? null;
    const resetsAt = time(month?.resetsAt);
    const startsAt = time(month?.startsAt);
    out.push({ series: "ollama", window: "month", label: "month", t, pct: ollama.usedPct, ...(resetsAt !== undefined && startsAt !== undefined ? { resetsAt, startsAt } : {}) });
  }
  const deepseek = ok("deepseek");
  if (deepseek && Array.isArray(deepseek.balances)) {
    const b = deepseek.balances.find((x) => isRec(x) && finite(x.total) && typeof x.currency === "string" && x.currency);
    if (isRec(b)) out.push({ series: "deepseek", window: BALANCE_WINDOW, t, total: b.total as number, currency: b.currency as string });
  }
  return out;
}

// ---- Period summaries (`<state root>/usage-history/periods/v1.jsonl`) -------------------------

/**
 * A closed window period, written once: its span, final percent, when it reached 100%, its
 * average rate (percent per hour to the 100% mark, else to its end) and its percent at each tenth
 * of the span (null before the first recorded reading). `firstAt`/`lastAt`: its recorded readings.
 */
export interface WindowSummary {
  series: string;
  window: string;
  startsAt: number;
  resetsAt: number;
  finalPct: number;
  hitLimitAt?: number;
  avgRate: number;
  tenths: (number | null)[];
  firstAt: number;
  lastAt: number;
}
/** A closed balance run (a top-up ended it): what it started and ended at, its spend and spend per day. */
export interface BalanceSummary {
  series: string;
  window: typeof BALANCE_WINDOW;
  firstAt: number;
  lastAt: number;
  startTotal: number;
  endTotal: number;
  spent: number;
  perDay: number;
  currency: string;
}
export type PeriodSummary = WindowSummary | BalanceSummary;

/** The percent at `t` along samples: linear between two, held after the last, null before the first. */
function valueAt(samples: readonly { t: number; v: number }[], t: number): number | null {
  if (!samples.length || t < samples[0]!.t) return null;
  for (let i = 1; i < samples.length; i++) {
    const b = samples[i]!;
    if (t > b.t) continue;
    const a = samples[i - 1]!;
    return b.t === a.t ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t);
  }
  return samples[samples.length - 1]!.v;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** One closed period's summary from its samples; null for an empty one. */
export function summarizePeriod(series: string, window: string, label: string, period: readonly UsageSample[]): WindowSummary | null {
  const first = period[0];
  const last = period[period.length - 1];
  if (!first || !last) return null;
  const len = last.resetsAt !== undefined ? (last.startsAt !== undefined ? last.resetsAt - last.startsAt : labelSpanMs(label)) : null;
  const end = last.resetsAt !== undefined && len ? last.resetsAt : last.t;
  const start = last.resetsAt !== undefined && len ? end - len : first.t;
  const hit = period.find((s) => s.pct >= 100);
  const pts = period.map((s) => ({ t: s.t, v: s.pct }));
  const tenths = Array.from({ length: 11 }, (_, k) => {
    const v = valueAt(pts, start + ((end - start) * k) / 10);
    return v === null ? null : round1(v);
  });
  const hours = Math.max(0, ((hit?.t ?? end) - start) / 3_600_000);
  return {
    series,
    window,
    startsAt: start,
    resetsAt: end,
    finalPct: last.pct,
    ...(hit ? { hitLimitAt: hit.t } : {}),
    avgRate: hours > 0 ? last.pct / hours : 0,
    tenths,
    firstAt: first.t,
    lastAt: last.t,
  };
}

/** One closed balance run's summary; null for an empty one. */
export function summarizeRun(series: string, run: readonly BalanceSample[]): BalanceSummary | null {
  const first = run[0];
  const last = run[run.length - 1];
  if (!first || !last) return null;
  const spent = Math.max(0, first.total - last.total);
  const days = (last.t - first.t) / DAY_MS;
  return { series, window: BALANCE_WINDOW, firstAt: first.t, lastAt: last.t, startTotal: first.total, endTotal: last.total, spent, perDay: days > 0 ? spent / days : 0, currency: last.currency };
}

/** One summary line, strictly: anything else is skipped. */
export function parseSummaryLine(text: string): PeriodSummary | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRec(v) || v.v !== 1 || typeof v.series !== "string" || !v.series || typeof v.window !== "string" || !v.window) return null;
  if (!finite(v.firstAt) || !finite(v.lastAt) || v.lastAt < v.firstAt) return null;
  if (v.window === BALANCE_WINDOW) {
    if (![v.startTotal, v.endTotal, v.spent, v.perDay].every(finite) || typeof v.currency !== "string" || !v.currency) return null;
    const { series, firstAt, lastAt, startTotal, endTotal, spent, perDay, currency } = v as unknown as BalanceSummary;
    return { series, window: BALANCE_WINDOW, firstAt, lastAt, startTotal, endTotal, spent, perDay, currency };
  }
  if (![v.startsAt, v.resetsAt, v.finalPct, v.avgRate].every(finite) || (v.startsAt as number) > (v.resetsAt as number)) return null;
  if (v.hitLimitAt !== undefined && !finite(v.hitLimitAt)) return null;
  if (!Array.isArray(v.tenths) || v.tenths.length !== 11 || !v.tenths.every((x) => x === null || finite(x))) return null;
  const s = v as unknown as WindowSummary;
  return {
    series: s.series,
    window: s.window,
    startsAt: s.startsAt,
    resetsAt: s.resetsAt,
    finalPct: s.finalPct,
    ...(s.hitLimitAt !== undefined ? { hitLimitAt: s.hitLimitAt } : {}),
    avgRate: s.avgRate,
    tenths: [...s.tenths],
    firstAt: s.firstAt,
    lastAt: s.lastAt,
  };
}

type Entry = { label: string; samples: (UsageSample | BalanceSample)[]; pending?: UsageSample | BalanceSample };

export interface UsageHistoryOptions {
  /** The `v1` directory. */
  dir: string;
  now?: () => number;
  keepDays?: number;
  /** The period summaries' file; defaults to `<dir>/../periods/v1.jsonl`. */
  periodsFile?: string;
  log?: (message: string) => void;
}

/** The one writer of a server's usage history, with its in-memory index (loaded once, on first use). */
export class UsageHistory {
  private readonly dir: string;
  private readonly periodsFile: string;
  private readonly now: () => number;
  private readonly keepDays: number;
  private readonly log: (message: string) => void;
  private index: Map<string, Entry> | null = null;
  private summaryIndex = new Map<string, PeriodSummary[]>();
  private prunedDay = "";

  constructor(opts: UsageHistoryOptions) {
    this.dir = opts.dir;
    this.periodsFile = opts.periodsFile ?? join(dirname(opts.dir), "periods", "v1.jsonl");
    this.now = opts.now ?? Date.now;
    this.keepDays = opts.keepDays ?? KEEP_DAYS;
    this.log = opts.log ?? ((m) => console.warn(`[usage-history] ${m}`));
  }

  // ---- Period summaries ----------------------------------------------------------------------

  private loadSummaries(): void {
    let text = "";
    try {
      text = readFileSync(this.periodsFile, "utf8");
    } catch {
      return;
    }
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      const s = parseSummaryLine(raw);
      if (s) this.addSummary(s);
    }
  }

  private addSummary(s: PeriodSummary): void {
    const k = key(s.series, s.window);
    const list = this.summaryIndex.get(k) ?? [];
    list.push(s);
    list.sort((a, b) => a.firstAt - b.firstAt);
    this.summaryIndex.set(k, list);
  }

  /** Whether a summary of this series and window already covers any of [from, to]: a period's time range never overlaps another's. */
  private summarized(series: string, window: string, from: number, to: number): boolean {
    return (this.summaryIndex.get(key(series, window)) ?? []).some((s) => s.firstAt <= to && s.lastAt >= from);
  }

  private appendSummary(s: PeriodSummary): void {
    this.addSummary(s);
    try {
      mkdirSync(dirname(this.periodsFile), { recursive: true });
      appendFileSync(this.periodsFile, `${JSON.stringify({ v: 1, ...s })}\n`);
    } catch (err) {
      this.log(`couldn't record a period summary: ${(err as Error).message}`);
    }
  }

  /**
   * Writes a summary, once, for every closed period that has none: every period but the newest of
   * each window, and the newest too once its reset has passed; every balance run but the newest.
   * Also catches up periods that closed while the server was stopped. Returns the number written.
   */
  closePeriods(): number {
    const index = this.load();
    const now = this.now();
    let written = 0;
    for (const [k, e] of index) {
      const [series, window] = k.split("\u0000") as [string, string];
      const all = e.pending ? [...e.samples, e.pending] : e.samples;
      if (window === BALANCE_WINDOW) {
        const runs = splitRuns(all as BalanceSample[]);
        for (const run of runs.slice(0, -1)) {
          if (this.summarized(series, window, run[0]!.t, run[run.length - 1]!.t)) continue;
          const s = summarizeRun(series, run);
          if (s) (this.appendSummary(s), written++);
        }
        continue;
      }
      const periods = splitPeriods(all as UsageSample[], e.label);
      const newest = periods[periods.length - 1];
      const end = newest?.[newest.length - 1]?.resetsAt;
      const closed = end !== undefined && end + CLOSE_GRACE_MS <= now ? periods : periods.slice(0, -1);
      for (const p of closed) {
        if (this.summarized(series, window, p[0]!.t, p[p.length - 1]!.t)) continue;
        const s = summarizePeriod(series, window, e.label, p);
        if (s) (this.appendSummary(s), written++);
      }
    }
    return written;
  }

  /** Drops summaries a year old (by `lastAt`), rewriting the file atomically when any go. */
  private pruneSummaries(): void {
    const cutoff = this.now() - SUMMARY_KEEP_DAYS * DAY_MS;
    let dropped = false;
    for (const [k, list] of this.summaryIndex) {
      const kept = list.filter((s) => s.lastAt >= cutoff);
      if (kept.length !== list.length) dropped = true;
      if (kept.length) this.summaryIndex.set(k, kept);
      else this.summaryIndex.delete(k);
    }
    if (!dropped) return;
    const lines = [...this.summaryIndex.values()].flat().sort((a, b) => a.lastAt - b.lastAt).map((s) => `${JSON.stringify({ v: 1, ...s })}\n`);
    try {
      const tmp = `${this.periodsFile}.${process.pid}.tmp`;
      writeFileSync(tmp, lines.join(""));
      renameSync(tmp, this.periodsFile);
    } catch (err) {
      this.log(`couldn't prune period summaries: ${(err as Error).message}`);
    }
  }

  /** The summaries of one series and window, oldest first. */
  summaries(series: string, window: string): PeriodSummary[] {
    this.load();
    return this.summaryIndex.get(key(series, window)) ?? [];
  }

  private cutoff(): number {
    return this.now() - this.keepDays * DAY_MS;
  }

  private load(): Map<string, Entry> {
    if (this.index) return this.index;
    const index = new Map<string, Entry>();
    this.index = index;
    let files: string[] = [];
    try {
      files = readdirSync(this.dir).filter((f) => DAY_FILE.test(f)).sort();
    } catch {
      // No history yet.
    }
    // Every line is read, old ones included: a period older than the kept days that has no summary
    // yet gets one (closePeriods) before prune() drops its samples.
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(join(this.dir, f), "utf8");
      } catch {
        continue;
      }
      for (const raw of text.split("\n")) {
        if (!raw.trim()) continue;
        const line = parseLine(raw);
        if (!line) continue;
        const { v: _v, s, w, ...sample } = line;
        const k = key(s, w);
        let e = index.get(k);
        if (!e) index.set(k, (e = { label: w.split("/")[0]!, samples: [] }));
        e.samples.push(sample);
      }
    }
    for (const e of index.values()) e.samples.sort((a, b) => a.t - b.t);
    this.loadSummaries();
    // Summaries first: a period whose samples are about to be pruned still gets one.
    this.closePeriods();
    this.prune();
    return index;
  }

  /**
   * Deletes day files older than the kept days and drops their samples from the index. Runs at
   * load and, from then on, at the first write of each UTC day.
   */
  prune(): void {
    const index = this.load();
    const today = utcDay(this.now());
    this.prunedDay = today;
    this.pruneSummaries();
    // The cutoff applies to closed periods only: a period still open (a 31-day month) keeps its
    // first readings until it closes and its summary is written. So each series and window keeps
    // from the older of the cutoff and its open period's first reading, and a day file goes only
    // when it is older than every one of those.
    const cutoff = this.cutoff();
    let oldest = cutoff;
    const keepFrom = new Map<Entry, number>();
    for (const [k, e] of index) {
      const open = this.openSince(k, e);
      const from = open !== null ? Math.min(cutoff, open) : cutoff;
      keepFrom.set(e, from);
      oldest = Math.min(oldest, from);
    }
    const oldestKept = utcDay(oldest);
    for (const e of index.values()) {
      const from = keepFrom.get(e)!;
      const keep = e.samples.findIndex((s) => s.t >= from);
      if (keep > 0) e.samples.splice(0, keep);
      else if (keep < 0) e.samples.length = 0;
    }
    let files: string[] = [];
    try {
      files = readdirSync(this.dir).filter((f) => DAY_FILE.test(f));
    } catch {
      return;
    }
    for (const f of files) {
      if (f.slice(0, 10) >= oldestKept) continue;
      try {
        rmSync(join(this.dir, f), { force: true });
      } catch (err) {
        this.log(`couldn't prune ${f}: ${(err as Error).message}`);
      }
    }
  }

  /** When this series and window's open period (or balance run) began; null when its newest one has closed. */
  private openSince(k: string, e: Entry): number | null {
    const all = e.pending ? [...e.samples, e.pending] : e.samples;
    if (!all.length) return null;
    if (k.endsWith(`\u0000${BALANCE_WINDOW}`)) return splitRuns(all as BalanceSample[]).at(-1)![0]!.t;
    const newest = splitPeriods(all as UsageSample[], e.label).at(-1)!;
    const end = newest[newest.length - 1]!.resetsAt;
    return end !== undefined && end + CLOSE_GRACE_MS <= this.now() ? null : newest[0]!.t;
  }

  private write(series: string, window: string, s: UsageSample | BalanceSample): void {
    const line: Line = { v: 1, s: series, w: window, ...s };
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(join(this.dir, `${utcDay(s.t)}.jsonl`), `${JSON.stringify(line)}\n`);
    } catch (err) {
      this.log(`couldn't record a reading: ${(err as Error).message}`);
    }
  }

  /**
   * Records the readings of one cache: a reading no newer than the series and window's last is
   * skipped; one that changes neither the percent (the total) nor the period is held back, and
   * written only before the next change, so a plateau keeps its first and last reading. Returns
   * the number of lines written.
   */
  record(readings: readonly UsageReading[]): number {
    const index = this.load();
    if (utcDay(this.now()) !== this.prunedDay) {
      this.closePeriods();
      this.prune();
    }
    let written = 0;
    for (const r of readings) {
      const k = key(r.series, r.window);
      let e = index.get(k);
      if (!e) index.set(k, (e = { label: "label" in r ? r.label : BALANCE_WINDOW, samples: [] }));
      const { series, window, ...rest } = r;
      const sample: UsageSample | BalanceSample = "label" in rest ? (({ label: _l, ...s }) => s)(rest) : rest;
      const last = e.samples[e.samples.length - 1];
      const newest = Math.max(last?.t ?? 0, e.pending?.t ?? 0);
      if (sample.t <= newest) continue;
      if (last && unchanged(last, sample, e.label)) {
        // A plateau's newest reading is held back, but written at most an hour after the last
        // line, so a restart never loses more than an hour of it.
        if (sample.t - last.t >= PENDING_FLUSH_MS) {
          this.write(series, window, sample);
          e.samples.push(sample);
          written++;
          e.pending = undefined;
        } else e.pending = sample;
        continue;
      }
      if (e.pending) {
        this.write(series, window, e.pending);
        e.samples.push(e.pending);
        written++;
        e.pending = undefined;
      }
      this.write(series, window, sample);
      e.samples.push(sample);
      written++;
    }
    this.closePeriods();
    return written;
  }

  /** Writes every held-back plateau reading (the server's shutdown): the next start knows how long each plateau lasted. */
  flush(): number {
    if (!this.index) return 0;
    let written = 0;
    for (const [k, e] of this.index) {
      if (!e.pending) continue;
      const [series, window] = k.split("\u0000") as [string, string];
      this.write(series, window, e.pending);
      e.samples.push(e.pending);
      e.pending = undefined;
      written++;
    }
    return written;
  }

  /** The recorded readings of one series and window, in time order (the held-back last one included). */
  samples(series: string, window: string): UsageSample[] {
    const e = this.load().get(key(series, window));
    if (!e || window === BALANCE_WINDOW) return [];
    const all = e.pending ? [...e.samples, e.pending] : e.samples;
    return all as UsageSample[];
  }

  /** The recorded balance readings of a series, in time order. */
  balances(series: string): BalanceSample[] {
    const e = this.load().get(key(series, BALANCE_WINDOW));
    if (!e) return [];
    return (e.pending ? [...e.samples, e.pending] : e.samples) as BalanceSample[];
  }

  /** The window's label as recorded (for its span), or null when nothing is. */
  labelOf(series: string, window: string): string | null {
    return this.load().get(key(series, window))?.label ?? null;
  }
}

/** Neither the value nor the period changed. */
function unchanged(last: UsageSample | BalanceSample, next: UsageSample | BalanceSample, label: string): boolean {
  if ("total" in last || "total" in next) {
    return "total" in last && "total" in next && last.currency === next.currency && last.total === next.total;
  }
  return last.pct === next.pct && samePeriod(last, next, label);
}

/** This server's history, at `<state root>/usage-history/v1`; one writer per server. */
let shared: UsageHistory | null = null;
export function usageHistory(): UsageHistory {
  shared ??= new UsageHistory({ dir: join(stateRoot(), "usage-history", "v1") });
  return shared;
}

/** Tests: the history the server reads and writes (null: back to the state root's). */
export function useUsageHistoryForTests(h: UsageHistory | null): void {
  shared = h;
}
