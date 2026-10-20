// The run-status row's right-hand cluster (§app.overseer/confirm, §chat.alignment/chip).
import assert from "node:assert/strict";
import { test } from "node:test";
import { runStatusEnd } from "./run-status";

const parts = (has: Parameters<typeof runStatusEnd>[0]) => runStatusEnd(has).map((p) => p.part);
const leads = (has: Parameters<typeof runStatusEnd>[0]) => runStatusEnd(has).filter((p) => p.lead).map((p) => p.part);

test("with every part present: running, cards, align, then inputs last; one lead", () => {
  const all = { running: true, cards: true, align: true, inputs: true };
  assert.deepEqual(parts(all), ["running", "cards", "align", "inputs"]);
  assert.deepEqual(leads(all), ["running"], "only the first part takes the auto margin: no gap in the middle");
});

test("every combination has at most one lead, it is the first part, and inputs is last", () => {
  const keys = ["running", "cards", "align", "inputs", "inputsHeld"] as const;
  for (let mask = 0; mask < 1 << keys.length; mask++) {
    const has = Object.fromEntries(keys.map((k, i) => [k, !!(mask & (1 << i))]));
    const items = runStatusEnd(has);
    assert.equal(items.filter((p) => p.lead).length, items.length ? 1 : 0, `mask ${mask}`);
    if (items.length) assert.ok(items[0]!.lead, `mask ${mask}: the lead is first`);
    const inputs = items.findIndex((p) => p.part === "inputs" || p.part === "inputs-held");
    if (inputs >= 0) assert.equal(inputs, items.length - 1, `mask ${mask}: inputs last`);
    assert.ok(items.filter((p) => p.part.startsWith("inputs")).length <= 1, `mask ${mask}: one inputs box`);
  }
});

test("an ordinary chat's align chip still sits right before inputs, and leads the pair", () => {
  assert.deepEqual(runStatusEnd({ align: true, inputs: true }), [
    { part: "align", lead: true },
    { part: "inputs", lead: false },
  ]);
  assert.deepEqual(runStatusEnd({ inputs: true }), [{ part: "inputs", lead: true }]);
  assert.deepEqual(runStatusEnd({ inputsHeld: true }), [{ part: "inputs-held", lead: true }]);
});
