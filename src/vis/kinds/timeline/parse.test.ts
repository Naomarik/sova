import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVis } from "../../parse";
import type { TimelineSpec } from "./parse";

const ok = <T>(kind: string, body: string): T => {
  const r = parseVis(kind, body);
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
  return r.spec as T;
};
const err = (kind: string, body: string) => {
  const r = parseVis(kind, body);
  assert.equal(r.ok, false, `expected an error for:\n${body}`);
  return r as { ok: false; line: number; message: string };
};

test("timeline: rows, optional note and tone, sections", () => {
  const s = ok<TimelineSpec>("timeline", "== 2010s ==\n2010 | Backbone | MV* in the browser\n2013 | React | accent\n2016 | Vue 2 | reactivity | ok");
  assert.deepEqual(s.items, [
    { type: "section", label: "2010s" },
    { type: "event", when: "2010", label: "Backbone", note: "MV* in the browser" },
    { type: "event", when: "2013", label: "React", tone: "accent" },
    { type: "event", when: "2016", label: "Vue 2", note: "reactivity", tone: "ok" },
  ]);
  assert.match(err("timeline", "2013 React").message, /when \| label/);
});
