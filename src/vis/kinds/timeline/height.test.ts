import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateWidth } from "../../core/text";
import { parseVis } from "../../parse";
import { estimateHeight, TIMELINE_NARROW } from "./height";
import type { TimelineSpec } from "./parse";

const spec = (body: string) => {
  const r = parseVis("timeline", body);
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
  return r.spec as TimelineSpec;
};
const near = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-9, msg ?? `${a} ≠ ${b}`);
const FRAMEWORKS = spec("== 2010s ==\n2010 | Backbone | MV* in the browser\n2013 | React | virtual DOM | accent\n2016 | Angular 2 | a rewrite, TypeScript first, with a long note that wraps on a phone\n== 2020s ==\n2021 | Solid 1.0 | fine-grained signals, no VDOM | ok\nmark React \"components as functions of state\"");

test("timeline estimateHeight: deterministic, sane, never taller as the body widens (within a layout)", () => {
  let prev = Infinity;
  for (let w = 296; w <= 900; w += 4) {
    const h = estimateHeight(FRAMEWORKS, w, estimateWidth);
    assert.equal(h, estimateHeight(FRAMEWORKS, w, estimateWidth));
    assert.ok(h > 150 && h < 600, `${w}: ${h}`);
    if (w === TIMELINE_NARROW + 4 - (TIMELINE_NARROW % 4)) prev = Infinity; // the phone layout ends here
    assert.ok(h <= prev + 1e-9, `${w}: ${h} after ${prev}`);
    prev = h;
  }
});

test("timeline estimateHeight: rows, notes and sections add up as timeline.css lays them out", () => {
  const one = spec("2013 | React");
  near(estimateHeight(one, 600, estimateWidth), 8 + 14.5 * 1.55);
  near(estimateHeight(one, 300, estimateWidth), 8 + 11 * 1.55 + 14.5 * 1.55, "the when sits above the label on a phone");
  const noted = spec("2013 | React | virtual DOM");
  near(estimateHeight(noted, 600, estimateWidth), 8 + 14.5 * 1.55 + 12.5 * 1.45);
  const sections = spec("== a ==\n2013 | React\n== b ==\n2014 | Vue");
  near(estimateHeight(sections, 600, estimateWidth), 2 * (8 + 14.5 * 1.55) + (4 + 11 * 1.55) + (12 + 4 + 11 * 1.55));
});
