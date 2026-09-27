import assert from "node:assert/strict";
import { test } from "node:test";
import { allModels, costNotes, emptyLine, KIND_LABEL, KIND_ORDER, kindRows, type ModelCost, modelRows, starterLine, topMeta, usd } from "./costs";

test("dollars: symbol first, comma thousands, 2 decimals; under a cent is <$0.01, never $0.00; ≈ marks an estimate", () => {
  assert.equal(usd(1240), "$1,240.00");
  assert.equal(usd(0.56), "$0.56");
  assert.equal(usd(0.004), "<$0.01");
  assert.equal(usd(0.005), "$0.01");
  assert.equal(usd(0), "$0.00");
  assert.equal(usd(1_234_567.891), "$1,234,567.89");
  assert.equal(usd(4.1, true), "≈$4.10");
  assert.equal(usd(0.001, true), "≈<$0.01");
});

test("kinds read in the scope's order, whatever their size, and only those with a cost", () => {
  const rows = [
    { kind: "workers" as const, usd: 9, estimate: false },
    { kind: "overseer" as const, usd: 1, estimate: false },
    { kind: "settle" as const, usd: 0, estimate: false },
    { kind: "coding" as const, usd: 3, estimate: true },
  ];
  assert.deepEqual(kindRows(rows).map((r) => r.kind), ["overseer", "coding", "workers"]);
  assert.equal(new Set(Object.values(KIND_LABEL)).size, KIND_ORDER.length, "every kind has its own label");
});

test("who started it: one line, only starters with a cost, in a fixed order; none at all is no line", () => {
  assert.equal(
    starterLine([
      { by: "sova", usd: 0.36, estimate: false },
      { by: "operator", usd: 4.02, estimate: false },
      { by: "overseer", usd: 8.1, estimate: true },
    ]),
    "Started by the overseer ≈$8.10 · by you $4.02 · by Sova on its own $0.36",
  );
  assert.equal(starterLine([{ by: "operator", usd: 1, estimate: false }, { by: "sova", usd: 0, estimate: false }]), "Started by you $1.00");
  assert.equal(starterLine([]), null);
  assert.equal(topMeta("coding", "operator"), "Coding sessions · started by you");
  assert.equal(topMeta("reconcile", "sova"), "Reconciler · run by Sova");
});

const t = (input = 0, output = 0, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });
const m = (model: string, totalUsd: number, o: Partial<ModelCost> = {}): ModelCost => ({ model, tokens: t(10, 10, 10, 10), usd: t(totalUsd / 4, totalUsd / 4, totalUsd / 4, totalUsd / 4), totalUsd, estimate: false, ...o });

test("models: most expensive first, then local, then unpriced; an empty row goes", () => {
  const rows = [m("unp", 0, { unpriced: "no price" }), m("cheap", 1), m("local", 0, { local: true }), m("dear", 5), m("none", 0, { tokens: t() })];
  assert.deepEqual(modelRows(rows).map((r) => r.model), ["dear", "cheap", "local", "unp"]);
});

test("All models sums every column; an unpriced model adds tokens, never dollars", () => {
  const all = allModels([m("a", 4), m("b", 2, { estimate: true }), m("u", 8, { unpriced: "" })]);
  assert.deepEqual(all.tokens, t(30, 30, 30, 30));
  assert.equal(all.totalUsd, 6);
  assert.deepEqual(all.usd, t(1.5, 1.5, 1.5, 1.5));
  assert.equal(all.estimate, true);
});

test("notes: each only when true, in the copy deck's order; the 2 always said last", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  const lines = costNotes(
    {
      unpriced: [{ model: "qwen3.5:397b", tokens: 312_000, why: "Ollama's page doesn't list it." }],
      legacyTokens: 2_800_000,
      estimate: true,
      notOnHost: { sessions: 2, countedAt: "2026-09-25T10:00:00Z" },
      pricesAsOf: "2026-09-28T03:00:00Z",
    },
    now,
  );
  assert.deepEqual(lines, [
    { text: "312k tokens on qwen3.5:397b have no API price, so they aren't in the total.", title: "Ollama's page doesn't list it." },
    { text: "2.8M tokens counted before costs have no model recorded, so they aren't in the total." },
    { text: "≈ Older Claude Code messages didn't record how long their cache was kept, so their cache writes are priced at the 1-hour rate." },
    { text: "2 sessions aren't on this host: their cost is as last counted, Sep 25." },
    { text: "Not counted: topic summaries, image descriptions, and Sova's own side calls." },
    { text: "Prices from models.dev, as of Sep 28." },
  ]);
  const bare = costNotes({ unpriced: [], legacyTokens: 0, estimate: false, notOnHost: null, pricesAsOf: null }, now);
  assert.deepEqual(bare.map((n) => n.text), ["Not counted: topic summaries, image descriptions, and Sova's own side calls."]);
  assert.equal(emptyLine(4), "4 sessions in this project. Nothing spent yet.");
  assert.equal(emptyLine(0), "Nothing spent yet.");
});
