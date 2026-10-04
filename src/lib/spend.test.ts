// Run: npx tsx --test src/lib/spend.test.ts (or npm test)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptItem } from "../../shared/protocol";
import type { UsageOrigin, UsageSessionModelRow, UsageSessionSpend, UsageSpend, UsageWorkerRow } from "../../shared/usage/wire";
import { absoluteTime, firstLine, headChipSpend, originLabel, paneTitleCost, spendTitle, spendUsd, spentAnything, timelineEntries, transcriptHeaderSpend, usageTabRows, workerRowSpend, workerSpendOf } from "./spend";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
const sum = (input: number, output: number, usd = 0, calls = 1): UsageSpend => ({ usd, tokens: { ...zero, input, output }, usdBy: zero, calls, unpricedTokens: 0 });
const row = (model: string, origin: UsageOrigin, input: number, output: number): UsageSessionModelRow => ({ ...sum(input, output), origin, provider: "p", model, status: "priced" });
const worker = (sid: string, parent: string, id?: string): UsageWorkerRow => ({ ...sum(1, 1), sid, parent, withWorkers: sum(2, 2), ...(id ? { worker: id } : {}) });
const spend = (models: UsageSessionModelRow[], workerList: UsageWorkerRow[] = [], calls = models.length): Pick<UsageSessionSpend, "sid" | "models" | "total" | "workerList"> => ({
  sid: "s1",
  models,
  total: sum(0, 0, 0, calls),
  workerList,
});

const info = (id: string, text: string, timestamp?: string): TranscriptItem => ({
  id,
  kind: "info",
  text,
  meta: { type: "model_change" },
  ...(timestamp ? { at: timestamp } : {}),
});

test("originLabel names the three origins", () => {
  assert.equal(originLabel("main"), "Main thread");
  assert.equal(originLabel("oneshot"), "Side calls");
  assert.equal(originLabel("worker"), "Subagents");
});

test("usageTabRows puts the main thread first, then side calls, then subagents, the biggest spender first in each", () => {
  const rows = usageTabRows(
    spend([row("sub-small", "worker", 1, 1), row("title", "oneshot", 2, 2), row("sub-big", "worker", 100, 100), row("main-b", "main", 5, 5), row("main-a", "main", 50, 50)]),
  );
  assert.deepEqual(
    rows.map((r) => r.model),
    ["main-a", "main-b", "title", "sub-big", "sub-small"],
  );
});

test("usageTabRows keeps two equal rows in a stable order and never mutates its input", () => {
  const source = spend([row("b", "main", 1, 1), row("a", "main", 1, 1)]);
  assert.deepEqual(
    usageTabRows(source).map((r) => r.model),
    ["a", "b"],
  );
  assert.deepEqual(
    source.models.map((r) => r.model),
    ["b", "a"],
  );
  assert.deepEqual(usageTabRows(undefined), []);
});

test("spentAnything: a recorded call, never an absent answer", () => {
  assert.equal(spentAnything(undefined), false);
  assert.equal(spentAnything(spend([])), false);
  assert.equal(spentAnything(spend([], [], 1)), true);
});

test("dollars are always said, at API prices; the title carries the split", () => {
  assert.equal(spendUsd(0), "$0.00");
  assert.equal(spendUsd(0.004), "<$0.01");
  assert.equal(spendUsd(1240.5), "$1,240.50");
  assert.equal(spendTitle({ usd: 0.72, tokens: { ...zero, input: 1200, output: 30, cacheRead: 5000, cacheWrite: 0 } }), "1.2k in · 30 out · 5k cache read · 0 cache write · $0.72");
});

test("a listed worker's spend is its row under this session, matched by worker id", () => {
  const list = [worker("w-a", "s1", "ag_01"), worker("w-b", "w-a", "ag_01"), worker("w-c", "other", "ag_02")];
  assert.equal(workerSpendOf(spend([], list), "ag_01")?.sid, "w-a", "a nested worker with the same id is not this session's");
  assert.equal(workerSpendOf(spend([], list), "ag_02")?.sid, "w-c", "the only row with that id");
  assert.equal(workerSpendOf(spend([], list), "ag_09"), null);
  assert.equal(workerSpendOf(undefined, "ag_01"), null);
});
// One test per surface: each reads its figure straight off the ledger's answer, never a sum of its own.
const answer = (sid: string, total: UsageSpend, workerList: UsageWorkerRow[] = []) => ({ sid, total, workerList });

test("head chip: the answer's total, once it is this session's and something was spoken", () => {
  const t = sum(1000, 200, 0.5, 3);
  assert.equal(headChipSpend(answer("s1", t), "s1"), t, "the very object the ledger sent");
  assert.equal(headChipSpend(answer("s0", t), "s1"), null, "an answer for the previous session never shows");
  assert.equal(headChipSpend(undefined, "s1"), null, "no figure before the answer");
  assert.equal(headChipSpend(answer("s1", sum(0, 0, 0, 0)), "s1"), null, "nothing recorded");
  assert.equal(headChipSpend(answer("s1", { ...sum(0, 0, 0.1, 2), tokens: { ...zero, cacheRead: 900 } }), "s1"), null, "cache only: nothing spoken");
  assert.equal(headChipSpend(answer("s1", t), null), null);
});

test("worker row: the worker's withWorkers figure, nothing for a worker with no call", () => {
  const w = { ...worker("w-a", "s1", "ag_01"), withWorkers: sum(7, 3, 2, 4) };
  const idle = { ...worker("w-b", "s1", "ag_02"), withWorkers: sum(0, 0, 0, 0) };
  const spend = answer("s1", sum(0, 0), [w, idle]);
  assert.equal(workerRowSpend(spend, "ag_01"), w.withWorkers, "own and its workers', never only its own");
  assert.equal(workerRowSpend(spend, "ag_02"), null);
  assert.equal(workerRowSpend(spend, "ag_03"), null, "no row: no tokens, never 0");
  assert.equal(workerRowSpend(undefined, "ag_01"), null);
});

test("transcript header: the worker's own answer's total, once it has a call", () => {
  const t = sum(5, 5, 0.2, 1);
  assert.equal(transcriptHeaderSpend({ total: t }), t);
  assert.equal(transcriptHeaderSpend({ total: sum(0, 0, 0, 0) }), null);
  assert.equal(transcriptHeaderSpend(undefined), null);
});

test("workspace pane title: the answer's total dollars, left out at zero", () => {
  assert.equal(paneTitleCost({ total: sum(1, 1, 12.5) }), "$12.50 this session");
  assert.equal(paneTitleCost({ total: sum(1, 1, 0) }), null);
  assert.equal(paneTitleCost(undefined), null);
});

test("firstLine takes one line and cuts on a word", () => {
  assert.equal(firstLine("Read the router, then changed it.\nAlso ran the tests."), "Read the router, then changed it.");
  assert.equal(firstLine("  \n"), "");
  assert.equal(firstLine(undefined), "");
  assert.equal(firstLine("alpha beta gamma delta", 12), "alpha beta…");
  // No word boundary worth cutting on: the cut lands mid-token rather than losing most of it.
  assert.equal(firstLine("abcdefghijklmnop", 8), "abcdefgh…");
});

test("absoluteTime is the 12-hour clock, dated", () => {
  const now = Date.parse("2026-09-20T12:00:00");
  assert.equal(absoluteTime("2026-09-20T14:06:00", now), "Sep 20 2:06 PM");
  assert.equal(absoluteTime("2024-03-04T09:05:00", now), "Mar 4, 2024 9:05 AM");
  assert.equal(absoluteTime("not a date", now), "");
});

test("timelineEntries keeps model, thinking and mode rows in order", () => {
  const entries = timelineEntries([
    { id: "u1", kind: "user", text: "hi" },
    info("i1", "Model: anthropic/claude-opus-5", "2026-09-20T10:00:00.000Z"),
    info("i2", "Thinking: high"),
    info("i3", "Mode → delegate"),
    info("i4", "Minor mode: align on"),
    info("i5", "Strict mode off"),
    info("i6", "Session name: something"),
    info("i7", "Compacted (900 tokens): …"),
  ]);
  assert.deepEqual(entries, [
    { id: "i1", text: "Model: anthropic/claude-opus-5", at: "2026-09-20T10:00:00.000Z" },
    { id: "i2", text: "Thinking: high" },
    { id: "i3", text: "Mode → delegate" },
    { id: "i4", text: "Minor mode: align on" },
    { id: "i5", text: "Strict mode off" },
  ]);
});

test("timelineEntries collapses consecutive repeats but keeps a real switch back", () => {
  const entries = timelineEntries([
    info("i1", "Model: a/b"),
    info("i2", "Model: a/b"),
    info("i3", "Model: c/d"),
    info("i4", "Model: a/b"),
  ]);
  assert.deepEqual(
    entries.map((e) => e.id),
    ["i1", "i3", "i4"],
  );
});
