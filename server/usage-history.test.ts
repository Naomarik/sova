// Run: pnpm test -- server/usage-history.test.ts
// Each test writes into its own temp directory; nothing under the agent dir or ~/.pi is touched.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { CacheFile } from "../pi-config/extensions/usage-status/fetch.ts";
import { KEEP_DAYS, parseLine, parseSummaryLine, readingsOf, samePeriod, splitPeriods, UsageHistory, type UsageReading, utcDay } from "./usage-history";

const root = mkdtempSync(join(tmpdir(), "sova-usage-history-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
// Each test its own `v1` dir, so each has its own `periods/v1.jsonl` beside it.
const freshDir = () => join(root, `h${n++}`, "v1");

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-01T12:00:00Z");
const reading = (t: number, pct: number, resetsAt?: number, window = "7d"): UsageReading => ({ series: "openai", window, label: window, t, pct, ...(resetsAt !== undefined ? { resetsAt } : {}) });
const lines = (dir: string) =>
  readdirSync(dir)
    .sort()
    .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean))
    .map((l) => JSON.parse(l));

test("append and dedupe: an older or equal reading is skipped; a plateau keeps its first and last reading", () => {
  const dir = freshDir();
  const h = new UsageHistory({ dir, now: () => T0 });
  const reset = T0 + 3 * DAY;
  assert.equal(h.record([reading(T0, 10, reset)]), 1, "the first reading is written");
  assert.equal(h.record([reading(T0, 10, reset)]), 0, "the same reading again is skipped");
  assert.equal(h.record([reading(T0 - 1000, 9, reset)]), 0, "an older one is skipped");
  assert.equal(h.record([reading(T0 + 150_000, 10, reset)]), 0, "unchanged: held back");
  assert.equal(h.record([reading(T0 + 300_000, 10, reset)]), 0, "still unchanged: held back");
  assert.equal(h.record([reading(T0 + 450_000, 12, reset)]), 2, "a change writes the plateau's last reading, then itself");
  assert.deepEqual(
    lines(dir).map((l) => [l.t, l.pct]),
    [
      [T0, 10],
      [T0 + 300_000, 10],
      [T0 + 450_000, 12],
    ],
  );
  assert.deepEqual(lines(dir)[0], { v: 1, s: "openai", w: "7d", t: T0, pct: 10, resetsAt: reset });
  // The held-back reading is still read back.
  h.record([reading(T0 + 600_000, 12, reset)]);
  assert.equal(h.samples("openai", "7d").at(-1)!.t, T0 + 600_000);
  // A second history on the same directory reads what was written.
  const again = new UsageHistory({ dir, now: () => T0 });
  assert.deepEqual(
    again.samples("openai", "7d").map((s) => s.pct),
    [10, 10, 12],
  );
});

test("one period for resets at 14:23:29.8 and 14:23:30.3", () => {
  const a = Date.parse("2026-10-09T14:23:29.800Z");
  const b = Date.parse("2026-10-09T14:23:30.300Z");
  assert.ok(samePeriod({ t: T0, pct: 10, resetsAt: a }, { t: T0 + 1, pct: 11, resetsAt: b }, "7d"));
  assert.ok(samePeriod({ t: T0, pct: 10, resetsAt: b }, { t: T0 + 1, pct: 10, resetsAt: a }, "5h"), "jitter either way");
  const dir = freshDir();
  const h = new UsageHistory({ dir, now: () => T0 });
  h.record([reading(T0, 10, a)]);
  assert.equal(h.record([reading(T0 + 150_000, 10, b)]), 0, "same pct, same period: nothing written");
  assert.equal(splitPeriods(h.samples("openai", "7d"), "7d").length, 1);
});

test("a forward reset jump starts a period, and so does a pct drop", () => {
  const reset = T0 + 3 * DAY;
  const samples = [
    { t: T0, pct: 40, resetsAt: reset },
    { t: T0 + 1000, pct: 50, resetsAt: reset + 60_000 }, // within 2 min: same period
    { t: T0 + 2000, pct: 50, resetsAt: reset + 7 * DAY }, // a week later: new period, same pct
    { t: T0 + 3000, pct: 3, resetsAt: reset + 7 * DAY }, // a drop: new period, same reset
    { t: T0 + 4000, pct: 5, resetsAt: reset + 7 * DAY },
  ];
  assert.deepEqual(
    splitPeriods(samples, "7d").map((p) => p.map((s) => s.pct)),
    [[40, 50], [50], [3, 5]],
  );
  // A window with no reset: only a drop starts one.
  assert.deepEqual(
    splitPeriods(
      [
        { t: 1, pct: 10 },
        { t: 2, pct: 30 },
        { t: 3, pct: 2 },
      ],
      "mcp",
    ).map((p) => p.length),
    [2, 1],
  );
  // A reset moving forward past the tolerance is written even at the same percent.
  const dir = freshDir();
  const h = new UsageHistory({ dir, now: () => T0 });
  h.record([reading(T0, 0, reset)]);
  assert.equal(h.record([reading(T0 + 1000, 0, reset + 5 * 60 * 60_000, "7d")]), 1);
});

const cacheOf = (over: Partial<CacheFile>): CacheFile => ({ schemaVersion: 3, fetchedAt: T0, nextFetchAt: T0 + 150_000, errors: {}, ...over }) as CacheFile;

test("no sample for a provider whose errors entry is set, even though fetchedAt moved", () => {
  const openai = { state: "ok" as const, windows: [{ label: "7d", pct: 40, resetsAt: "2026-10-05T00:00:00Z", seconds: 604_800 }] };
  const ok = readingsOf(cacheOf({ openai }), { accounts: {} });
  assert.equal(ok.length, 1);
  assert.equal(ok[0]!.series, "openai");
  assert.equal((ok[0] as { startsAt?: number }).startsAt, Date.parse("2026-10-05T00:00:00Z") - 604_800_000, "OpenAI's own length gives its start");
  const failed = readingsOf(cacheOf({ fetchedAt: T0 + 60_000, openai, errors: { openai: "timeout" } }), { accounts: {} });
  assert.deepEqual(failed, []);
  // Claude's own login too.
  const claude = { state: "ok" as const, limits: [{ label: "5h", pct: 20, resetsAt: "2026-10-01T15:00:00Z" }] };
  assert.equal(readingsOf(cacheOf({ claude, errors: { claude: "HTTP 500" } }), { accounts: { default: "acct-1" } }).length, 0);
});

test("two logins of one account land in one claude:<uuid> series; an unknown identity is skipped", () => {
  const data = (pct: number) => ({ state: "ok" as const, limits: [{ label: "7d", pct, resetsAt: "2026-10-05T18:00:00Z" }, { label: "7d scoped", scope: "Fable", pct: 3, resetsAt: "2026-10-05T18:00:00Z" }] });
  const cache = cacheOf({
    claude: data(40),
    claudeFetchedAt: T0 - 5000,
    claudeAccounts: {
      "l-00000001": { data: data(41), fetchedAt: T0 - 1000, nextFetchAt: T0 },
      "l-00000002": { data: data(99), fetchedAt: T0 - 2000, nextFetchAt: T0 },
    },
  });
  const r = readingsOf(cache, { accounts: { default: "acct-a", "l-00000001": "acct-a", "l-00000002": undefined } });
  assert.deepEqual([...new Set(r.map((x) => x.series))], ["claude:acct-a"], "the unknown login is skipped, never filed under its id");
  assert.deepEqual(
    r.map((x) => [x.window, x.t, "pct" in x ? x.pct : null]),
    [
      ["7d", T0 - 5000, 40],
      ["7d scoped/Fable", T0 - 5000, 3],
      ["7d", T0 - 1000, 41],
      ["7d scoped/Fable", T0 - 1000, 3],
    ],
    "each login stamped with its own fetchedAt (default: claudeFetchedAt)",
  );
  const dir = freshDir();
  const h = new UsageHistory({ dir, now: () => T0 });
  h.record(r);
  assert.deepEqual(
    h.samples("claude:acct-a", "7d").map((s) => s.pct),
    [40, 41],
  );
});

test("per-login fetchedAt stamping: a login not fetched again keeps its old time and records nothing new", () => {
  const data = { state: "ok" as const, limits: [{ label: "5h", pct: 30, resetsAt: "2026-10-01T15:00:00Z" }] };
  const dir = freshDir();
  const h = new UsageHistory({ dir, now: () => T0 });
  const first = cacheOf({ claudeAccounts: { "l-0000000a": { data, fetchedAt: T0 - 100_000, nextFetchAt: T0 } } });
  assert.equal(h.record(readingsOf(first, { accounts: { "l-0000000a": "acct-b" } })), 1);
  // The cache was rewritten later (another provider fetched), the login's own reading wasn't.
  const later = cacheOf({ fetchedAt: T0 + 150_000, claudeAccounts: { "l-0000000a": { data: { ...data, limits: [{ ...data.limits[0]!, pct: 35 }] }, fetchedAt: T0 - 100_000, nextFetchAt: T0 } } });
  assert.equal(h.record(readingsOf(later, { accounts: { "l-0000000a": "acct-b" } })), 0, "same login time: not a newer reading");
  assert.equal(h.samples("claude:acct-b", "5h")[0]!.t, T0 - 100_000);
});

test("corrupt lines are skipped, good ones kept", () => {
  const dir = freshDir();
  mkdirSync(dir, { recursive: true });
  const good = JSON.stringify({ v: 1, s: "zai", w: "5h", t: T0, pct: 12, resetsAt: T0 + 3_600_000 });
  writeFileSync(
    join(dir, `${utcDay(T0)}.jsonl`),
    [
      good,
      "{not json",
      JSON.stringify({ v: 2, s: "zai", w: "5h", t: T0 + 1, pct: 13 }),
      JSON.stringify({ v: 1, s: "zai", w: "5h", t: "soon", pct: 13 }),
      JSON.stringify({ v: 1, s: "zai", w: "5h", t: T0 + 2, pct: -1 }),
      JSON.stringify({ v: 1, s: "zai", w: "5h", t: T0 + 3, pct: 14, resetsAt: "tomorrow" }),
      JSON.stringify({ v: 1, s: "deepseek", w: "balance", t: T0, total: "4" }),
      JSON.stringify({ v: 1, s: "deepseek", w: "balance", t: T0, total: 4.2, currency: "USD" }),
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "notes.txt"), "ignored");
  const h = new UsageHistory({ dir, now: () => T0 });
  assert.deepEqual(h.samples("zai", "5h"), [{ t: T0, pct: 12, resetsAt: T0 + 3_600_000 }]);
  assert.deepEqual(h.balances("deepseek"), [{ t: T0, total: 4.2, currency: "USD" }]);
  assert.equal(parseLine(good)?.s, "zai");
});

test("pruning: days older than the kept days go at load and at the first write of a new day", () => {
  const dir = freshDir();
  mkdirSync(dir, { recursive: true });
  const old = T0 - (KEEP_DAYS + 2) * DAY;
  const kept = T0 - 3 * DAY;
  // Each its own month, the old one long closed (the cutoff never prunes an open period).
  writeFileSync(join(dir, `${utcDay(old)}.jsonl`), `${JSON.stringify({ v: 1, s: "ollama", w: "month", t: old, pct: 10, resetsAt: old + DAY })}\n`);
  writeFileSync(join(dir, `${utcDay(kept)}.jsonl`), `${JSON.stringify({ v: 1, s: "ollama", w: "month", t: kept, pct: 20, resetsAt: kept + DAY })}\n`);
  let now = T0;
  const h = new UsageHistory({ dir, now: () => now });
  assert.deepEqual(
    h.samples("ollama", "month").map((s) => s.pct),
    [20],
  );
  assert.equal(existsSync(join(dir, `${utcDay(old)}.jsonl`)), false, "pruned at load");
  // Time passes until the kept day is too old; the next day's first write prunes it.
  now = kept + (KEEP_DAYS + 2) * DAY;
  h.record([{ series: "ollama", window: "month", label: "month", t: now, pct: 1, resetsAt: now + DAY }]);
  assert.equal(existsSync(join(dir, `${utcDay(kept)}.jsonl`)), false, "pruned on a new day");
  assert.deepEqual(
    h.samples("ollama", "month").map((s) => s.pct),
    [1],
  );
});

test("DeepSeek's balance is recorded as a total, and a declared Ollama month carries its span", () => {
  const cache = cacheOf({
    deepseek: { state: "ok", available: true, balances: [{ currency: "USD", total: 18.4, granted: 0, toppedUp: 18.4 }] },
    ollama: { state: "ok", usedPct: 34.2 },
  });
  const month = { startsAt: "2026-10-01T00:00:00.000Z", resetsAt: "2026-10-31T00:00:00.000Z" };
  const r = readingsOf(cache, { accounts: {}, ollamaMonth: () => month });
  assert.deepEqual(r, [
    { series: "ollama", window: "month", label: "month", t: T0, pct: 34.2, resetsAt: Date.parse(month.resetsAt), startsAt: Date.parse(month.startsAt) },
    { series: "deepseek", window: "balance", t: T0, total: 18.4, currency: "USD" },
  ]);
});

// ---- Period summaries ------------------------------------------------------------------------

const periodsOf = (dir: string) => {
  const file = join(dir, "..", "periods", "v1.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test("a period's summary is written once when the next period's first reading arrives: span, final, 100% time, rate, tenths", () => {
  const dir = freshDir();
  const reset = T0 + 10 * 3_600_000; // a 5h window ending 10h after T0
  const start = reset - 5 * 3_600_000;
  const h = new UsageHistory({ dir, now: () => start + 60_000 });
  const w = (t: number, pct: number, r = reset): UsageReading => ({ series: "claude:a", window: "5h", label: "5h", t, pct, resetsAt: r });
  h.record([w(start, 0), w(start + 2.5 * 3_600_000, 50), w(start + 4 * 3_600_000, 100)]);
  assert.equal(periodsOf(dir).length, 0, "still open: its reset is ahead");
  h.record([w(reset + 3_600_000, 3, reset + 5 * 3_600_000)]);
  const [s] = periodsOf(dir);
  assert.equal(periodsOf(dir).length, 1);
  assert.equal(s.series, "claude:a");
  assert.equal(s.window, "5h");
  assert.equal(s.startsAt, start);
  assert.equal(s.resetsAt, reset);
  assert.equal(s.finalPct, 100);
  assert.equal(s.hitLimitAt, start + 4 * 3_600_000);
  assert.equal(s.avgRate, 100 / 4, "percent per hour to the 100% mark");
  assert.deepEqual(s.tenths, [0, 10, 20, 30, 40, 50, 66.7, 83.3, 100, 100, 100]);
  assert.equal(h.closePeriods(), 0, "never twice");
  h.record([w(reset + 2 * 3_600_000, 4, reset + 5 * 3_600_000)]);
  assert.equal(periodsOf(dir).length, 1);
});

test("a period still open at a restart gets its summary once it closes, derived from its samples, and never twice", () => {
  const dir = freshDir();
  const reset = T0 + 3 * DAY;
  let now = T0;
  const first = new UsageHistory({ dir, now: () => now });
  first.record([reading(T0 - DAY, 10, reset), reading(T0, 40, reset)]);
  assert.equal(periodsOf(dir).length, 0);
  // The server stops; the reset passes while it is down. The next start summarizes it.
  now = reset + DAY;
  const second = new UsageHistory({ dir, now: () => now });
  assert.equal(second.summaries("openai", "7d").length, 1);
  assert.equal(periodsOf(dir).length, 1);
  assert.equal(periodsOf(dir)[0].finalPct, 40);
  // A reset that passes only minutes ago waits out the grace: a reading stamped before it may still come.
  const third = new UsageHistory({ dir, now: () => now });
  assert.equal(third.summaries("openai", "7d").length, 1, "read back, not written again");
  assert.equal(periodsOf(dir).length, 1);
});

test("a period whose reset just passed waits out the grace before it closes", () => {
  const dir = freshDir();
  const reset = T0 + 3_600_000;
  let now = T0;
  const h = new UsageHistory({ dir, now: () => now });
  h.record([reading(T0, 10, reset)]);
  now = reset + 60_000;
  assert.equal(h.closePeriods(), 0);
  now = reset + 16 * 60_000;
  assert.equal(h.closePeriods(), 1);
});

test("a DeepSeek top-up closes its run with a spend summary", () => {
  const dir = freshDir();
  const h = new UsageHistory({ dir, now: () => T0 });
  const b = (t: number, total: number): UsageReading => ({ series: "deepseek", window: "balance", t, total, currency: "USD" });
  h.record([b(T0 - 4 * DAY, 20), b(T0 - 2 * DAY, 16), b(T0 - DAY, 30)]);
  assert.deepEqual(periodsOf(dir), [
    { v: 1, series: "deepseek", window: "balance", firstAt: T0 - 4 * DAY, lastAt: T0 - 2 * DAY, startTotal: 20, endTotal: 16, spent: 4, perDay: 2, currency: "USD" },
  ]);
});

test("summaries are kept a year: older lines go at start, the file rewritten; bad lines are skipped", () => {
  const dir = freshDir();
  const periods = join(dir, "..", "periods");
  mkdirSync(periods, { recursive: true });
  const line = (lastAt: number) => ({ v: 1, series: "ollama", window: "month", startsAt: lastAt - 30 * DAY, resetsAt: lastAt, finalPct: 50, avgRate: 0.07, tenths: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50], firstAt: lastAt - 29 * DAY, lastAt });
  writeFileSync(
    join(periods, "v1.jsonl"),
    [JSON.stringify(line(T0 - 400 * DAY)), "{bad", JSON.stringify({ ...line(T0 - 40 * DAY), tenths: [1, 2] }), JSON.stringify(line(T0 - 40 * DAY))].join("\n") + "\n",
  );
  const h = new UsageHistory({ dir, now: () => T0 });
  assert.deepEqual(
    h.summaries("ollama", "month").map((s) => s.lastAt),
    [T0 - 40 * DAY],
  );
  assert.deepEqual(
    periodsOf(dir).map((s) => s.lastAt),
    [T0 - 40 * DAY],
    "the year-old line and the bad ones are gone from the file",
  );
  const parsed = parseSummaryLine(JSON.stringify(line(T0)));
  assert.equal(parsed && "finalPct" in parsed ? parsed.finalPct : null, 50);
  assert.equal(parseSummaryLine(JSON.stringify({ ...line(T0), startsAt: T0 + 1 })), null, "a span that ends before it starts");
});

test("samples are kept 30 days; a period older than that with no summary gets one before its samples go", () => {
  const dir = freshDir();
  mkdirSync(dir, { recursive: true });
  const old = T0 - 40 * DAY;
  writeFileSync(
    join(dir, `${utcDay(old)}.jsonl`),
    [JSON.stringify({ v: 1, s: "openai", w: "7d", t: old, pct: 20, resetsAt: old + DAY }), JSON.stringify({ v: 1, s: "openai", w: "7d", t: old + 3_600_000, pct: 30, resetsAt: old + DAY })].join("\n") + "\n",
  );
  const h = new UsageHistory({ dir, now: () => T0 });
  assert.deepEqual(h.samples("openai", "7d"), [], "older than 30 days: gone");
  assert.equal(existsSync(join(dir, `${utcDay(old)}.jsonl`)), false);
  assert.deepEqual(
    h.summaries("openai", "7d").map((s) => ("finalPct" in s ? s.finalPct : null)),
    [30],
  );
});

test("a plateau's last reading survives a restart: written once it is an hour newer than the last line (review F1)", () => {
  const dir = freshDir();
  const reset = T0 + 3 * DAY;
  const t1 = T0;
  const t2 = T0 + 2 * 3_600_000;
  const t3 = reset + 3_600_000;
  const first = new UsageHistory({ dir, now: () => t2 });
  first.record([reading(t1, 40, reset)]);
  first.record([reading(t2, 40, reset)]);
  // No shutdown flush: the server dies. The next one picks up from disk.
  const second = new UsageHistory({ dir, now: () => t3 });
  second.record([reading(t3, 5, reset + 7 * DAY)]);
  assert.ok(
    second.samples("openai", "7d").some((s) => s.t === t2),
    "t2 is on disk",
  );
  // Under the hour, readings stay held back: the files stay light.
  const dir2 = freshDir();
  const h = new UsageHistory({ dir: dir2, now: () => T0 });
  h.record([reading(T0, 40, reset)]);
  h.record([reading(T0 + 150_000, 40, reset)]);
  h.record([reading(T0 + 300_000, 40, reset)]);
  assert.equal(lines(dir2).length, 1);
});

test("flush on shutdown writes every held-back reading", () => {
  const dir = freshDir();
  const reset = T0 + 3 * DAY;
  const h = new UsageHistory({ dir, now: () => T0 });
  h.record([reading(T0, 40, reset), { series: "zai", window: "mcp", label: "mcp", t: T0, pct: 3 }]);
  h.record([reading(T0 + 600_000, 40, reset), { series: "zai", window: "mcp", label: "mcp", t: T0 + 600_000, pct: 3 }]);
  assert.equal(lines(dir).length, 2);
  assert.equal(h.flush(), 2);
  assert.equal(h.flush(), 0, "nothing left");
  const again = new UsageHistory({ dir, now: () => T0 + 700_000 });
  assert.deepEqual(
    again.samples("openai", "7d").map((s) => s.t),
    [T0, T0 + 600_000],
  );
});

test("an open period's samples are never pruned: a 31-day month keeps its first day until it closes and is summarized", () => {
  const dir = freshDir();
  const startsAt = T0;
  const resetsAt = T0 + 31 * DAY;
  const m = (t: number, pct: number, s = startsAt, r = resetsAt): UsageReading => ({ series: "ollama", window: "month", label: "month", t, pct, startsAt: s, resetsAt: r });
  let now = T0;
  const h = new UsageHistory({ dir, now: () => now });
  h.record([m(T0 + 3_600_000, 1)]);
  // 30.5 days on: past the 30-day cutoff, but the month is still open.
  now = T0 + 30.5 * DAY;
  h.record([m(now, 60)]);
  const reopened = new UsageHistory({ dir, now: () => now });
  assert.equal(reopened.samples("ollama", "month")[0]!.t, T0 + 3_600_000, "the first day is still there, on disk too");
  // The month closes: its summary has its first tenth; from then on the cutoff applies.
  now = resetsAt + DAY;
  reopened.record([m(now, 2, resetsAt, resetsAt + 30 * DAY)]);
  const s = reopened.summaries("ollama", "month")[0]!;
  assert.ok("tenths" in s && s.tenths[0] === null && s.tenths[1] !== null, "the first tenth is before the first reading; the second is known");
  assert.deepEqual(
    reopened.samples("ollama", "month").map((x) => x.pct),
    [60, 2],
    "closed and summarized, then the cutoff applies: its first day goes, its last 30 days stay",
  );
});
