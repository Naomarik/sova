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

test("chart: series, gaps, tones, log scale, percent", () => {
  const s = ok<ChartSpec>("chart", 'type: line\nseries: "Merge sort", Quicksort\nscale: log\nunit: ms\n1k 0.1 0.08\n"1M" 150 -\n10M 1_900 1.5e3');
  assert.equal(s.type, "line");
  assert.deepEqual(s.series, ["Merge sort", "Quicksort"]);
  assert.deepEqual(s.rows.map((r) => r.values), [[0.1, 0.08], [150, null], [1900, 1500]]);
  const bar = ok<ChartSpec>("chart", '"parent cacheRead" 138175\n"fork cacheRead" 0 error\nhit 42%');
  assert.equal(bar.type, "bar");
  assert.equal(bar.rows[1]!.tone, "error");
  assert.equal(bar.rows[2]!.values[0], 42);
  assert.match(err("chart", "Merge sort 12").message, /quote labels/);
  assert.match(err("chart", "a 1,000").message, /thousands commas/);
  assert.match(err("chart", "series: a, b\nx 1").message, /1 values; expected 2/);
  assert.match(err("chart", "scale: log\nx 0").message, /above 0/);
  assert.match(err("chart", "type: pie\nx 1").message, /bar, stacked, line, scatter \(no pie or donut/);
  assert.equal(parseVis("bar", "x 1").ok, false, "no shorthand kinds: chart is the one fence");
});

test("chart: scatter rows are label x y, with an optional tone; no series", () => {
  const s = ok<ChartSpec>("chart", 'type: scatter\nx: n\ny: ms\n"a" 1 2\nb 3 4.5 warn');
  assert.deepEqual(s.rows.map((r) => [r.label, r.values, r.tone ?? null]), [["a", [1, 2], null], ["b", [3, 4.5], "warn"]]);
  assert.match(err("chart", "type: scatter\na 1").message, /1 values; expected 2 \(x y\)/);
  assert.match(err("chart", "type: scatter\na 1 -").message, /both x and y/);
  assert.match(err("chart", "type: scatter\nseries: a, b\na 1 2").message, /no series/);
});

test("chart: mark a row by its label; the note is numbered", () => {
  const s = ok<ChartSpec>("chart", '"Quicksort" 120\n"Bubble sort" 9800\nmark "Bubble sort" warn "quadratic"');
  assert.deepEqual(s.emphasis, [{ key: "1", tone: "warn", note: "quadratic", n: 1 }]);
  assert.match(err("chart", 'a 1\nmark "b"').message, /no row "b"/);
});

test("chart: stacked bars refuse a log scale; quoted series names keep their spaces", () => {
  assert.match(err("chart", "type: stacked\nscale: log\nseries: a, b\nx 1 2").message, /stacked bars can't use scale: log/);
  assert.deepEqual(ok<ChartSpec>("chart", 'series: "Merge sort", Quicksort, "Insertion sort"\nx 1 2 3').series, ["Merge sort", "Quicksort", "Insertion sort"]);
});

test("chart: a quoted series name may hold a comma", () => {
  assert.deepEqual(ok<ChartSpec>("chart", 'series: "A, B"\nx 1').series, ["A, B"]);
});
