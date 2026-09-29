import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVis } from "../../parse";
import type { MatrixSpec } from "./parse";

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
/** A fence that still draws: its first warning (parse.ts). */
const warning = (kind: string, body: string) => {
  const r = parseVis(kind, body);
  if (!r.ok) assert.fail(`expected a drawing with a warning, got line ${r.line}: ${r.message}`);
  assert.ok(r.warnings.length, `expected a warning for:\n${body}`);
  assert.deepEqual(r.spec.warnings, r.warnings, "the spec carries the same warnings");
  return r.warnings[0]!;
};

test("matrix: marks with optional notes, text cells, column count checked", () => {
  const s = ok<MatrixSpec>("matrix", 'columns: Merge, Rebase\nLinear history | no | yes\nRewrites commits | no | yes "new SHAs"\nWhen | shared branches | -');
  assert.deepEqual(s.rows[1]!.cells, [{ mark: "no" }, { mark: "yes", text: "new SHAs" }]);
  assert.deepEqual(s.rows[2]!.cells, [{ text: "shared branches" }, {}]);
  assert.match(err("matrix", "columns: A, B\nx | yes").message, /1 cells; expected 2/);
  assert.match(err("matrix", "x | yes").message, /columns:/);
});

test("matrix: mark a row by its label, or a column by its name", () => {
  const s = ok<MatrixSpec>("matrix", 'columns: Merge, Rebase\nLinear history | no | yes\nmark "Linear history" "the point"\nmark Rebase info');
  assert.deepEqual(s.emphasis, [
    { key: "0", tone: "accent", note: "the point", n: 1 },
    { key: "c1", tone: "info" },
  ]);
  assert.match(warning("matrix", "columns: A, B\nx | yes | no\nmark C").message, /no row or column C, dropped/);
  assert.deepEqual(s.rows[0]!.cells, [{ mark: "no" }, { mark: "yes" }]);
});

test("matrix: a quoted column name may hold a comma", () => {
  assert.deepEqual(ok<MatrixSpec>("matrix", 'columns: "Merge, then push"\nx | yes').columns, ["Merge, then push"]);
});
