// The run-status row's right-hand cluster (§app.overseer/confirm). No alignment or card chip:
// those are the composer's waiting badge (§chat.composer/waiting-badge).
import assert from "node:assert/strict";
import { test } from "node:test";
import { runStatusEnd } from "./run-status";

const parts = (has: Parameters<typeof runStatusEnd>[0]) => runStatusEnd(has).map((p) => p.part);
const leads = (has: Parameters<typeof runStatusEnd>[0]) => runStatusEnd(has).filter((p) => p.lead).map((p) => p.part);

test("with every part present: running, then inputs last; one lead", () => {
  const all = { running: true, inputs: true };
  assert.deepEqual(parts(all), ["running", "inputs"]);
  assert.deepEqual(leads(all), ["running"], "only the first part takes the auto margin: no gap in the middle");
});

test("every combination has at most one lead, it is the first part, and inputs is last", () => {
  const keys = ["running", "inputs", "inputsHeld"] as const;
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

test("the row never carries an alignment or card part", () => {
  const every = runStatusEnd({ running: true, inputs: true, inputsHeld: true, ...({ align: true, cards: true } as object) });
  assert.deepEqual(every.map((p) => p.part), ["running", "inputs"]);
  assert.deepEqual(runStatusEnd({ inputs: true }), [{ part: "inputs", lead: true }]);
  assert.deepEqual(runStatusEnd({ inputsHeld: true }), [{ part: "inputs-held", lead: true }]);
});
