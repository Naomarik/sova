import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVis } from "../../parse";
import { unweighted } from "../tree/measure";
import { estimateHeight, LAYERS_NARROW } from "./height";
import type { LayersSpec } from "./parse";

const spec = (body: string) => {
  const r = parseVis("layers", body);
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
  return r.spec as LayersSpec;
};
/** 7px a character: easy to reason about. */
const flat = unweighted((t) => t.length * 7);

const STACK = spec(`Browser | Solid app, service worker, "IndexedDB, caches" | accent
Server | Hono REST, /ws/chat, pi SDK sessions | one process per checkout
Disk | session JSONL, ~/.pi/agent/settings.json | muted
mark Server "holds every live session"`);

test("layers height: the css geometry, wide and on a phone", () => {
  const one = spec("Disk | a, b");
  // Wide: 8+8 padding, 2 border, max(label 23, one row of chips 24).
  assert.equal(estimateHeight(one, 600, flat), 16 + 2 + 24);
  // Phone: label 23, a 4px row gap, then the chips.
  assert.equal(estimateHeight(one, 300, flat), 16 + 2 + 23 + 4 + 24);
  // A note adds 4 + 18; an empty layer on a phone keeps the row gap.
  assert.equal(estimateHeight(spec("Disk | a | a note"), 600, flat), 16 + 2 + 24 + 4 + 18);
  assert.equal(estimateHeight(spec("Disk | | muted"), 300, flat), 16 + 2 + 23 + 4);
  // Bands are 4px apart.
  assert.equal(estimateHeight(spec("A | a\nB | b"), 600, flat), 2 * 42 + 4);
});

test("layers height: deterministic, and never grows as the pane widens within a layout", () => {
  // Each layout on its own; at the switch the height may go either way (the label column takes 136px).
  for (const [from, to] of [[296, LAYERS_NARROW], [LAYERS_NARROW + 1, 900]] as const) {
    let last = Infinity;
    for (let w = from; w <= to; w++) {
      const h = estimateHeight(STACK, w);
      assert.equal(h, estimateHeight(STACK, w));
      assert.ok(h > 0 && h <= last, `height ${h} at ${w} after ${last}`);
      last = h;
    }
  }
  assert.ok(estimateHeight(STACK, 900) < estimateHeight(STACK, 296));
});

test("layers height: chips wrap into more rows as the body narrows", () => {
  const many = spec(`Server | ${Array.from({ length: 12 }, (_, i) => `service-${i}`).join(", ")}`);
  assert.ok(estimateHeight(many, 296) > estimateHeight(many, 900));
});
