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

test("matrix cell tones: an unquoted text cell ending in a tone word; quoted text, lone words and yes/no cells unchanged", () => {
  const s = ok<MatrixSpec>(
    "matrix",
    'columns: A, B, C, D\nr1 | 72% warn | 83% ok | "works ok" | "72%" error\nr2 | ok | no error | yes "fine" | partial\nr3 | fast and good accent | - | slow muted | n/a info',
  );
  assert.deepEqual(s.rows[0]!.cells, [{ text: "72%", tone: "warn" }, { text: "83%", tone: "ok" }, { text: "works ok" }, { text: "72%", tone: "error" }]);
  assert.deepEqual(s.rows[1]!.cells, [{ text: "ok" }, { mark: "no", text: "error" }, { mark: "yes", text: "fine" }, { mark: "partial" }]);
  assert.deepEqual(s.rows[2]!.cells, [{ text: "fast and good", tone: "accent" }, {}, { text: "slow", tone: "muted" }, { text: "n/a", tone: "info" }]);
  // A word that only starts like a tone, or a capitalised one, is text.
  assert.deepEqual(ok<MatrixSpec>("matrix", "columns: A, B\nr | 5 okay | 5 OK").rows[0]!.cells, [{ text: "5 okay" }, { text: "5 OK" }]);
  // An escaped pipe inside a cell doesn't shift which cells were quoted.
  assert.deepEqual(ok<MatrixSpec>("matrix", 'columns: A, B\nr | a \\| b warn | "c ok"').rows[0]!.cells, [{ text: "a | b", tone: "warn" }, { text: "c ok" }]);
});

test("matrix columns: a comma inside parentheses doesn't split a column name", () => {
  const s = ok<MatrixSpec>(
    "matrix",
    `columns: Critic (Astra), Advocate (K3, your side), Coordinator (Opus, partial)
Fixed verb API for every project | yes | yes | yes
Default isolation | native + slots; Compose where the project already uses it | container per worktree | per-instance network namespace
mark "Default isolation" "the one real disagreement"`,
  );
  assert.deepEqual(s.columns, ["Critic (Astra)", "Advocate (K3, your side)", "Coordinator (Opus, partial)"]);
  assert.equal(s.rows.length, 2);
  assert.deepEqual(s.emphasis!.map((e) => [s.rows[Number(e.key)]!.label, e.note]), [["Default isolation", "the one real disagreement"]]);
  // Parentheses that don't balance split at every comma, as before.
  assert.deepEqual(ok<MatrixSpec>("matrix", "columns: Happy :), Sad :(\nMood | yes | no").columns, ["Happy :)", "Sad :("]);
});

test("matrix columns: the rows' agreed cell count picks the one reading that gives it", () => {
  // A quoted stretch inside a name: two columns, as the rows have.
  const q = ok<MatrixSpec>("matrix", 'columns: The "fast, cheap" plan, Other\nCost | low | high\nSpeed | yes | no');
  assert.deepEqual(q.columns, ['The "fast, cheap" plan', "Other"]);
  // Rows of three cells under a parenthesised comma: split inside the parentheses too, as before.
  const p = ok<MatrixSpec>("matrix", "columns: Dev (local, CI), Prod\nFast | yes | yes | no");
  assert.deepEqual(p.columns, ["Dev (local", "CI)", "Prod"]);
});

test("matrix columns: no reading gives the rows' count, or the rows disagree: still an error", () => {
  assert.match(err("matrix", "columns: A, B, C, D\nX | yes | no | yes\nY | no | no | yes").message, /3 cells; expected 4/);
  assert.match(err("matrix", "columns: Dev (local, CI), Prod\nFast | yes | yes | no\nSlow | yes | no").message, /cells; expected 2/);
});
