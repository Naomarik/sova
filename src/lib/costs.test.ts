import assert from "node:assert/strict";
import { test } from "node:test";
import { byCost, costNotes, KIND_LABEL, totalRow, usd } from "./costs";

test("dollars: symbol first, comma thousands, 2 decimals; a spend under a cent is <$0.01, never $0.00", () => {
  assert.equal(usd(1240), "$1,240.00");
  assert.equal(usd(12.475), "$12.48");
  assert.equal(usd(0.08), "$0.08");
  assert.equal(usd(0.004), "<$0.01");
  assert.equal(usd(0.005), "$0.01");
  assert.equal(usd(0), "$0.00");
  assert.equal(usd(1_234_567.891), "$1,234,567.89");
});

const t = (input = 0, output = 0, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });

test("rows go most expensive first; an unpriced row with tokens stays, an empty one goes", () => {
  const rows = [
    { kind: "a", usd: 1, tokens: t(10) },
    { kind: "b", usd: 0, tokens: t(0) },
    { kind: "c", usd: 0, tokens: t(500) },
    { kind: "d", usd: 4, tokens: t(1) },
    { kind: "e", usd: 1, tokens: t(20) },
  ];
  assert.deepEqual(byCost(rows, (r) => r.kind).map((r) => r.kind), ["d", "e", "a", "c"]);
});

test("the total line sums every token kind and the dollars", () => {
  assert.deepEqual(totalRow([{ usd: 1.5, tokens: t(1, 2, 3, 4) }, { usd: 0.25, tokens: t(10, 20, 30, 40) }]), { usd: 1.75, tokens: t(11, 22, 33, 44) });
  assert.deepEqual(totalRow([]), { usd: 0, tokens: t() });
});

test("notes: unpriced, each estimate once, other hosts, not counted, then when prices were refreshed", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  const lines = costNotes(
    {
      unpriced: [{ model: "qwen3.5:397b", tokens: 312_000, why: "" }],
      estimates: ["cc-ttl-assumed-1h", "cc-ttl-assumed-1h", "new-code"],
      notOnHost: { sessions: 2, countedAt: "2026-09-28T10:00:00Z" },
      notCounted: ["topic outlines", "image descriptions"],
      prices: { refreshedAt: "2026-09-28T11:00:00Z" },
    },
    now,
  );
  assert.equal(lines.length, 6);
  assert.equal(lines[0], "312k tokens on qwen3.5:397b have no API price, so they aren't in the total.");
  assert.match(lines[1]!, /1-hour rate/);
  assert.equal(lines[2], "Some figures are estimates.", "an unknown code still says it's an estimate");
  assert.equal(lines[3], "2 sessions aren't on this host: as last counted 2h ago.");
  assert.equal(lines[4], "Not counted: topic outlines, image descriptions.");
  assert.equal(lines[5], "Prices refreshed 1h ago.");
  const bare = costNotes({ unpriced: [], estimates: [], notOnHost: null, notCounted: [], prices: { refreshedAt: null } }, now);
  assert.deepEqual(bare, ["Prices from the built-in table; not refreshed yet."]);
});

test("every kind has a label, and no 2 share one", () => {
  const labels = Object.values(KIND_LABEL);
  assert.equal(new Set(labels).size, labels.length);
});
