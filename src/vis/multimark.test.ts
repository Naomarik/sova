import assert from "node:assert/strict";
import { test } from "node:test";
import { emphasisNotes } from "./core/emphasis";
import type { Emphasis } from "./core/grammar";
import { parseVis } from "./parse";

// `mark a, b, c` across the kind families: synthetic fences only.
const parsed = (kind: string, body: string) => {
  const r = parseVis(kind, body);
  assert.ok(r.ok, r.ok ? "" : `${r.line}: ${r.message}`);
  return r as { spec: { emphasis?: Emphasis[] }; warnings: { line: number; message: string }[] };
};
const marked = (kind: string, body: string) => parsed(kind, body).spec.emphasis!.map((e) => [e.key, e.n ?? null]);

test("multi-mark: flow by id and by label, a label with a comma", () => {
  const body = 'node a "Alpha"\nnode b "Beta, two"\nnode c "Gamma"\na -> b -> c\nmark a, "Beta, two", Gamma warn "the path"';
  assert.deepEqual(marked("flow", body), [["a", 1], ["b", 1], ["c", 1]]);
  assert.deepEqual(emphasisNotes(parsed("flow", body).spec), [{ n: 1, note: "the path", tone: "warn" }]);
});

test("multi-mark: code lines and a range (a range numbers its first line only)", () => {
  assert.deepEqual(marked("code", 'mark 2, 4-5 "the loop"\n---\na\nb\nc\nd\ne'), [["2", 1], ["4", 1], ["5", null]]);
});

test("multi-mark: sequence message numbers and an actor", () => {
  assert.deepEqual(marked("sequence", 'a -> b "one"\nb -> a "two"\na -> b "three"\nmark 1, 3 "requests"\nmark b'), [["step:0", 1], ["step:2", 1], ["actor:b", null]]);
});

test("multi-mark: matrix row and column in one line", () => {
  const got = marked("matrix", 'columns: X, Y\nr1 | yes | no\nr2 | no | yes\nmark r2, Y "look"');
  assert.equal(got.length, 2);
  assert.ok(got.every(([, n]) => n === 1));
});

test("multi-mark: wireframe blocks by their text", () => {
  const body = 'screen "Home"\n  header "Sova"\n  button "Save"\n  button "Cancel"\nmark "Save", "Cancel" "both actions"';
  const got = marked("wireframe", body);
  assert.equal(got.length, 2);
  assert.ok(got.every(([, n]) => n === 1));
});

test("multi-mark: chart rows", () => {
  assert.deepEqual(marked("chart", 'type: bar\nA 1\nB 2\nC 3\nmark A, C ok "ends"').map(([, n]) => n), [1, 1]);
});

test("multi-mark: a partial miss warns and keeps the rest; a stray comma is a hard error", () => {
  const r = parsed("flow", 'a -> b\nmark a, zz, b "kept"');
  assert.deepEqual(r.spec.emphasis!.map((e) => e.key), ["a", "b"]);
  assert.deepEqual(r.warnings, [{ line: 2, message: "mark: no node zz, dropped" }]);
  const bad = parseVis("flow", "a -> b\nmark a,");
  assert.equal(bad.ok, false);
});

test("multi-mark: layers, tree, timeline, steps and state items; a wireframe block word before a list", () => {
  const ns = (kind: string, body: string) => marked(kind, body).map(([, n]) => n);
  assert.deepEqual(ns("layers", 'UI | a\nAPI | b\nDB | c\nmark UI, DB "ends"'), [1, 1]);
  assert.deepEqual(ns("tree", 'root\n  a\n  b\nmark a, b "kids"'), [1, 1]);
  assert.deepEqual(ns("timeline", '2013 | Start\n2016 | Mid\n2019 | End\nmark Start, 2019 "ends"'), [1, 1]);
  assert.deepEqual(ns("steps", '"Login" ok | a -> b\n"Pay" error | c -> d\nmark Login, "Pay" "these"'), [1, 1]);
  assert.deepEqual(marked("state", 'start -> idle\nidle -> busy\nbusy -> idle\nmark idle, busy "both"'), [["idle", 1], ["busy", 1]]);
  assert.deepEqual(ns("wireframe", 'screen "Home"\n  button "Save"\n  button "Cancel"\nmark button "Save", "Cancel" "x"'), [1, 1]);
});
