// Run: npx tsx --test src/lib/spend.test.ts (or npm test)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelSpend, SessionUsage, TranscriptItem } from "../../shared/protocol";
import { absoluteTime, anyCost, firstLine, originLabel, spendRows, timelineEntries } from "./spend";

const spend = (model: string, origin: ModelSpend["origin"], input: number, output: number, cost?: number): ModelSpend => ({
  model,
  origin,
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  ...(cost === undefined ? {} : { cost }),
});

const usage = (models: ModelSpend[]): SessionUsage => ({
  total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  main: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  models,
});

const info = (id: string, text: string, timestamp?: string): TranscriptItem => ({
  id,
  kind: "info",
  text,
  raw: timestamp ? { type: "model_change", timestamp } : {},
});

test("originLabel names the three origins", () => {
  assert.equal(originLabel("main"), "Main thread");
  assert.equal(originLabel("subagents"), "Subagents");
  assert.equal(originLabel("team"), "Team");
});

test("spendRows puts the main thread first, then the biggest spender", () => {
  const rows = spendRows(
    usage([
      spend("team-model", "team", 10, 10),
      spend("sub-small", "subagents", 1, 1),
      spend("sub-big", "subagents", 100, 100),
      spend("main-b", "main", 5, 5),
      spend("main-a", "main", 50, 50),
    ]),
  );
  assert.deepEqual(
    rows.map((r) => r.model),
    ["main-a", "main-b", "sub-big", "sub-small", "team-model"],
  );
});

test("spendRows keeps two equal rows in a stable order and never mutates its input", () => {
  const models = [spend("b", "main", 1, 1), spend("a", "main", 1, 1)];
  const source = usage(models);
  assert.deepEqual(
    spendRows(source).map((r) => r.model),
    ["a", "b"],
  );
  assert.deepEqual(
    source.models.map((r) => r.model),
    ["b", "a"],
  );
});

test("spendRows survives an older server with no usage at all", () => {
  assert.deepEqual(spendRows(undefined), []);
});

test("anyCost asks whether a Cost column would say anything", () => {
  assert.equal(anyCost([]), false);
  assert.equal(anyCost([spend("a", "main", 1, 1)]), false);
  assert.equal(anyCost([spend("a", "main", 1, 1, 0)]), false);
  assert.equal(anyCost([spend("a", "main", 1, 1), spend("b", "team", 1, 1, 0.004)]), true);
});

test("firstLine takes one line and cuts on a word", () => {
  assert.equal(firstLine("Read the router, then changed it.\nAlso ran the tests."), "Read the router, then changed it.");
  assert.equal(firstLine("  \n"), "");
  assert.equal(firstLine(undefined), "");
  assert.equal(firstLine("alpha beta gamma delta", 12), "alpha beta…");
  // No word boundary worth cutting on: the cut lands mid-token rather than losing most of it.
  assert.equal(firstLine("abcdefghijklmnop", 8), "abcdefgh…");
});

test("absoluteTime is the 24-hour clock, dated", () => {
  const now = Date.parse("2026-09-20T12:00:00");
  assert.equal(absoluteTime("2026-09-20T14:06:00", now), "Sep 20 14:06");
  assert.equal(absoluteTime("2024-03-04T09:05:00", now), "Mar 4, 2024 09:05");
  assert.equal(absoluteTime("not a date", now), "");
});

test("timelineEntries keeps model, thinking and mode rows in order", () => {
  const entries = timelineEntries([
    { id: "u1", kind: "user", text: "hi", raw: {} },
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
