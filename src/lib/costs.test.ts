import assert from "node:assert/strict";
import { test } from "node:test";
import type { CostModelRow } from "../../shared/costs";
import { costNotes, emptyLine, KIND_LABEL, KIND_ORDER, moneyWord, modelRows, starterParts, topMeta, usd } from "./costs";

const t = (input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cacheWrite1h = 0) => ({ input, output, cacheRead, cacheWrite, cacheWrite1h });

test("dollars: symbol first, comma thousands, 2 decimals; under a cent is <$0.01, never $0.00", () => {
  assert.equal(usd(1240), "$1,240.00");
  assert.equal(usd(0.56), "$0.56");
  assert.equal(usd(0.004), "<$0.01");
  assert.equal(usd(0.005), "$0.01");
  assert.equal(usd(0), "$0.00");
  assert.equal(usd(1_234_567.891), "$1,234,567.89");
});

test("every card kind the server sends has its own label, coding one row whoever started it", () => {
  assert.equal(new Set(Object.values(KIND_LABEL)).size, KIND_ORDER.length, "every kind has its own label");
  assert.deepEqual(Object.keys(KIND_LABEL).sort(), [...KIND_ORDER].sort(), "a label for exactly the wire's card kinds");
  assert.equal(KIND_LABEL.coding, "Coding sessions");
});

test("who started it: one line, only starters with a cost, in a fixed order; none at all is no line", () => {
  assert.deepEqual(
    starterParts([
      { by: "sova", usd: 0.36 },
      { by: "operator", usd: 4.02 },
      { by: "overseer", usd: 8.1 },
    ]),
    [
      { words: "Started by the overseer", usd: "$8.10" },
      { words: "by you", usd: "$4.02" },
      { words: "by Sova on its own", usd: "$0.36" },
    ],
  );
  assert.deepEqual(starterParts([{ by: "operator", usd: 1 }, { by: "overseer", usd: 0 }]), [{ words: "Started by you", usd: "$1.00" }]);
  assert.deepEqual(starterParts([]), []);
  assert.equal(topMeta("coding-operator", "operator"), "Coding sessions · started by you");
  assert.equal(topMeta("gathering", "overseer"), "Gathering and offers · started by the overseer");
  assert.equal(topMeta("reconcile", "sova"), "Reconciler · run by Sova");
});

const m = (model: string, usd: number, o: Partial<CostModelRow> = {}): CostModelRow => ({ model, status: "priced", tokens: t(10, 10, 10, 10, 4), usdBy: t(usd / 4, usd / 4, usd / 4, usd / 4, usd / 8), usd, ...o });

test("models: most expensive first, then free, then unpriced; an empty row goes", () => {
  const rows = [m("unp", 0, { status: "unpriced", usdBy: t() }), m("cheap", 1), m("local", 0, { status: "free", why: "local" }), m("dear", 5), m("none", 0, { tokens: t() })];
  assert.deepEqual(modelRows(rows).map((r) => r.model), ["dear", "cheap", "local", "unp"]);
  assert.equal(moneyWord({ status: "free", why: "local" }), "local");
  assert.equal(moneyWord({ status: "free", why: "synthetic" }), "usd", "a synthetic message is $0.00, not local");
  assert.equal(moneyWord({ status: "unpriced" }), "unpriced");
});

test("notes: each only when true, in the copy deck's order; the 2 always said last", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  const lines = costNotes(
    {
      unpriced: [
        { model: "openai-codex/gpt-5.3-codex-spark", tokens: 312_000, why: "Codex only." },
        { model: "unknown", tokens: 2_800_000, why: "counted before costs" },
      ],
      notOnHost: { sessions: 2, countedAt: "2026-09-25T10:00:00Z" },
      prices: { source: "models.dev", fetchedAt: "2026-09-28T03:00:00Z" },
    },
    now,
  );
  assert.deepEqual(lines, [
    { text: "312k tokens on openai-codex/gpt-5.3-codex-spark have no API price, so they aren't in the total.", title: "Codex only." },
    { text: "2.8M tokens counted before costs have no model recorded, so they aren't in the total." },
    { text: "2 sessions aren't on this host: their cost is as last counted, Sep 25." },
    { text: "Not counted: Sova's own side calls that name no session of the project." },
    { text: "Prices from models.dev, as of Sep 28." },
  ]);
  const bare = { unpriced: [], notOnHost: null, prices: { source: "models.dev" as const, fetchedAt: null } };
  assert.deepEqual(costNotes(bare, now).map((n) => n.text), ["Not counted: Sova's own side calls that name no session of the project."]);
  assert.equal(emptyLine(4), "4 sessions in this project. Nothing spent yet.");
  assert.equal(emptyLine(0), "Nothing spent yet.");
});
