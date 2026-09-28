import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVis } from "../../parse";
import { estimateHeight } from "./height";
import { unweighted } from "./measure";
import type { TreeSpec } from "./parse";

const spec = (body: string) => {
  const r = parseVis("tree", body);
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
  return r.spec as TreeSpec;
};
const flat = unweighted((t) => t.length * 7);

const TREE = spec(`src/
  lib/
    markdown.ts "renders fences, and a note long enough to wrap below its name on a phone"
  vis/
    registry.ts "the kind list"
  main.tsx
mark markdown.ts "the vis hook lives here"
mark registry.ts warn`);

test("tree height: 26px a row, a note beside its name when it fits, else below", () => {
  assert.equal(estimateHeight(spec("a\n  b\n    c"), 400, flat), 3 * 26);
  // "name" 28 + gap 8 + "note" 28 fits in 400 - 8: one line.
  assert.equal(estimateHeight(spec('name "note"'), 400, flat), 26);
  // In 60px it doesn't: the note takes a second line.
  assert.equal(estimateHeight(spec('name "note"'), 68, flat), 26 + 22);
  // Deeper rows have 20px less per level.
  const deep = spec('a\n  b\n    c "0123456789"');
  // At depth 2 in 100px, 52px are left: the 70px note goes below, over 2 lines.
  assert.equal(estimateHeight(deep, 100, flat), 3 * 26 + 2 * 22);
  assert.equal(estimateHeight(deep, 200, flat), 3 * 26);
});

test("tree height: deterministic, and never grows as the pane widens", () => {
  let last = Infinity;
  for (let w = 296; w <= 900; w += 2) {
    const h = estimateHeight(TREE, w);
    assert.equal(h, estimateHeight(TREE, w));
    assert.ok(h >= 6 * 26 && h <= last, `height ${h} at ${w} after ${last}`);
    last = h;
  }
});
