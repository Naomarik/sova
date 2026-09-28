import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVis } from "../../parse";
import { unweighted } from "../tree/measure";
import { estimateHeight, STEPS_NARROW } from "./height";
import type { StepsSpec } from "./parse";

const spec = (body: string) => {
  const r = parseVis("steps", body);
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
  return r.spec as StepsSpec;
};
/** 7px a character: easy to reason about. */
const flat = unweighted((t) => t.length * 7);

const SCENARIOS = spec(`== Asking people ==
"Simple question" ok | You -> "Maria gets a link" -> "she answers" -> "decision recorded"
"Tony vs Bob" warn | "$5k vs $10k" -> "conflict spotted" -> "Tony settles"
== Autopilot ==
"Project overseer" muted | "set level" -> "notices a gap" -> "starts a conversation"
mark "Tony vs Bob" "settle step not run yet"`);

test("steps height: the css geometry, wide and on a phone", () => {
  const one = spec("Done | a -> b");
  // Wide: 12 padding + 2 border + max(label 22, chips 24).
  assert.equal(estimateHeight(one, 600, flat), 14 + 24);
  // Phone: the label above the chain, 4px apart.
  assert.equal(estimateHeight(one, 300, flat), 14 + 22 + 4 + 24);
  // A lane head: 18px, and 8px more above it when something comes before; items are 4px apart.
  assert.equal(estimateHeight(spec("== L ==\nDone | a"), 600, flat), 18 + 4 + 38);
  assert.equal(estimateHeight(spec("Done | a\n== L ==\nNext | b"), 600, flat), 38 + 4 + 8 + 18 + 4 + 38);
  // Chips wrap into more rows when the chain can't hold them: here 430px holds 3 (109 + 2 × 129).
  const long = spec(`Done | ${Array.from({ length: 6 }, (_, i) => `step number ${i}`).join(" -> ")}`);
  assert.equal(estimateHeight(long, 600, flat), 14 + 24 + 4 + 24);
});

test("steps height: deterministic, and never grows as the pane widens within a layout", () => {
  for (const [from, to] of [[296, STEPS_NARROW], [STEPS_NARROW + 1, 900]] as const) {
    let last = Infinity;
    for (let w = from; w <= to; w++) {
      const h = estimateHeight(SCENARIOS, w);
      assert.equal(h, estimateHeight(SCENARIOS, w));
      assert.ok(h > 0 && h <= last, `height ${h} at ${w} after ${last}`);
      last = h;
    }
  }
  assert.ok(estimateHeight(SCENARIOS, 900) < estimateHeight(SCENARIOS, 296));
});
