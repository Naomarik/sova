import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVis } from "../../parse";
import type { ChartSpec } from "./parse";

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

test("chart: series, gaps, tones, log scale, percent; aliases preset the type", () => {
  const s = ok<ChartSpec>("chart", 'type: line\nseries: "Merge sort", Quicksort\nscale: log\nunit: ms\n1k 0.1 0.08\n"1M" 150 -\n10M 1_900 1.5e3');
  assert.equal(s.type, "line");
  assert.deepEqual(s.series, ["Merge sort", "Quicksort"]);
  assert.deepEqual(s.rows.map((r) => r.values), [[0.1, 0.08], [150, null], [1900, 1500]]);
  const bar = ok<ChartSpec>("bar", '"parent cacheRead" 138175\n"fork cacheRead" 0 error\nhit 42%');
  assert.equal(bar.type, "bar");
  assert.equal(bar.rows[1]!.tone, "error");
  assert.equal(bar.rows[2]!.values[0], 42);
  assert.match(err("chart", "Merge sort 12").message, /quote labels/);
  assert.match(err("chart", "a 1,000").message, /thousands commas/);
  assert.match(err("chart", "series: a, b\nx 1").message, /1 values; expected 2/);
  assert.match(err("chart", "scale: log\nx 0").message, /above 0/);
  assert.match(err("chart", "type: pie\nx 1").message, /bar, hbar, line, stacked/);
  assert.match(err("line", "type: bar\nx 1").message, /already/);
});
