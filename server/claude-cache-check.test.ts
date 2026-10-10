// The developer check of Claude re-sends (§app.insights/usage-resend) on a fixed sample: recorded
// launches count as they say, older records are estimated from their tokens, and the totals add up.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { formatUsageRecord, type UsageRecord } from "../pi-config/extensions/llm-inflight/usage-record.ts";
import { EMPTY_TABLE, mergeFetched, normalizeModelsDev, type Aliases } from "../shared/model-prices/prices";
import { cacheCheck, formatCheck, readLedger } from "./claude-cache-check";
import { ALIASES_FILE } from "./usage-helper/price-book";
import { scratchRoot } from "./test-scratch";

const aliases = JSON.parse(readFileSync(ALIASES_FILE, "utf8")) as Aliases;
// Opus 5.5 at Sova's rates: in 4, out 20, read 0.2, 5m write 5, 1h write 8 ($/M).
const table = mergeFetched(EMPTY_TABLE, normalizeModelsDev({ anthropic: { models: { "claude-opus-5-5": { cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 } } } }, openai: { models: {} }, zai: { models: {} }, deepseek: { models: {} }, "ollama-cloud": { models: {} } }, aliases), "2026-09-01T00:00:00.000Z").table;
const t = (hhmm: string) => Date.parse(`2026-10-08T${hhmm}:00.000Z`);

let n = 0;
const rec = (over: Partial<UsageRecord>): UsageRecord => ({
  v: 1, key: `k${++n}`, ts: t("10:00"), device: null, producer: "p1", src: "claude", provider: "claude-code-cli", model: "claude-opus-5-5",
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, owner: "s1", parent: null, kind: "main", ...over,
});

const sample = (): UsageRecord[] => [
  // An overseer whose every turn re-sends (the opening read only), estimated: 3 calls, 2 re-sends.
  rec({ owner: "o1", kind: "overseer", ts: t("10:00"), cacheRead: 18_000, cacheWrite: 100_000, stop: "end_turn" }),
  rec({ owner: "o1", kind: "overseer", ts: t("10:10"), cacheRead: 18_000, cacheWrite: 110_000, stop: "end_turn" }),
  rec({ owner: "o1", kind: "overseer", ts: t("12:00"), cacheRead: 18_000, cacheWrite: 120_000, stop: "end_turn" }),
  // A main chat: a recorded fold (reaped), a recorded resume, a recorded fresh start, a residual (never counted).
  rec({ owner: "s1", ts: t("10:00"), input: 10, cacheWrite: 50_000, output: 100, launch: { how: "fresh", why: "new" } }),
  rec({ owner: "s1", ts: t("10:05"), input: 10, cacheWrite: 200_000, output: 100, launch: { how: "folded", why: "reaped" } }),
  rec({ owner: "s1", ts: t("10:06"), input: 10, cacheRead: 200_000, output: 100, launch: { how: "resumed", why: "process-start" } }),
  rec({ owner: "s1", ts: t("10:07"), src: "claude-residual", cacheWrite: 999_999 }),
  // A worker turn after a server restart (another producer), estimated.
  rec({ owner: "w1", kind: "worker", ts: t("10:00"), producer: "p1", cacheRead: 0, cacheWrite: 40_000, stop: "end_turn" }),
  rec({ owner: "w1", kind: "worker", ts: t("10:20"), producer: "p2", cacheRead: 2_000, cacheWrite: 41_000 }),
  // Another provider is never in it.
  rec({ provider: "zai", model: "glm-5.3", src: "pi", cacheWrite: 500_000 }),
];

test("the check's totals on a fixed sample", () => {
  const r = cacheCheck(sample(), { table, aliases });
  const kind = (k: string) => r.kinds.find((x) => x.kind === k)!;
  assert.equal(r.records, 8);
  // Overseer: 2 re-sends, 110k and 120k written at $5/M; the second after over an hour idle.
  assert.equal(kind("overseer").resendCalls, 2);
  assert.equal(kind("overseer").resendUsd, 0.55 + 0.6);
  assert.deepEqual(kind("overseer").reasons.map((x) => [x.reason, x.source, x.calls]), [["idle over 1h (cache expired)", "estimated", 1], ["between turns", "estimated", 1]]);
  // Main: only the fold, at its input and writes ($0.00004 + $1.00), never its output or the fresh start.
  assert.equal(kind("main").resendCalls, 1);
  assert.equal(kind("main").resendUsd, 1.00004);
  assert.deepEqual([kind("main").launches, kind("main").resumed], [3, 1]);
  assert.deepEqual(kind("main").reasons.map((x) => [x.reason, x.source]), [["reaped", "recorded"]]);
  assert.equal(kind("worker").reasons[0]!.reason, "server restart");
  assert.equal(r.resendUsd, Math.round((1.15 + 1.00004 + 0.205) * 1e6) / 1e6);
  assert.ok(Math.abs(kind("main").share - 1.00004 / kind("main").usd) < 1e-6);
  assert.match(formatCheck(r), /overseer: 1 conversations, 3 calls/);
});

test("the check reads plain and sealed ledger files, once per key, and writes nothing", () => {
  const root = join(scratchRoot("cache-check-"), "usage", "v1");
  mkdirSync(join(root, "2026-10-08"), { recursive: true });
  const lines = sample().map((r) => formatUsageRecord(r)!).join("");
  writeFileSync(join(root, "2026-10-08", "p1.jsonl"), lines + lines);
  const read = readLedger(root);
  assert.equal(read.length, sample().length);
  assert.equal(readLedger(root, "2026-10-09").length, 0);
});
