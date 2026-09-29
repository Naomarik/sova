import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVis } from "../../parse";
import type { CodeSpec } from "./parse";

const ok = (body: string) => {
  const r = parseVis("code", body);
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
  return r.spec as CodeSpec;
};
const err = (body: string) => {
  const r = parseVis("code", body);
  assert.equal(r.ok, false);
  return r as { ok: false; line: number; message: string };
};
/** A fence that still draws: its first warning (parse.ts). */
const warning = (body: string) => {
  const r = parseVis("code", body);
  if (!r.ok) assert.fail(`expected a drawing with a warning, got line ${r.line}: ${r.message}`);
  assert.ok(r.warnings.length, `expected a warning for:\n${body}`);
  assert.deepEqual(r.spec.warnings, r.warnings, "the spec carries the same warnings");
  return r.warnings[0]!;
};

test("code: header, ---, verbatim lines; marks by displayed line number or range", () => {
  const s = ok('title: Off by one\nlang: TS\nstart: 10\nmark 11 "should be <"\nmark 12-13 warn\n---\nfor (let i = 0;\n  i <= n;\n  i++) {\n# not a comment\n}\n');
  assert.equal(s.lang, "ts");
  assert.equal(s.start, 10);
  assert.deepEqual(s.lines, ["for (let i = 0;", "  i <= n;", "  i++) {", "# not a comment", "}"]);
  assert.deepEqual(s.emphasis, [
    { key: "11", tone: "accent", note: "should be <", n: 1 },
    { key: "12", tone: "warn" },
    { key: "13", tone: "warn" },
  ]);
});

test("code: errors say what to write", () => {
  assert.match(err("x = 1").message, /---/);
  assert.match(err("lang: ts\n---\n").message, /no code/);
  assert.match(warning("mark 5\n---\na\nb").message, /no line \(lines here are 1–2\) 5, dropped/);
  assert.match(err("x = 1\n---\na").message, /only settings/);
  assert.deepEqual(warning("mark 1-3 \"n\"\nmark 2\n---\na\nb\nc"), { line: 2, message: "mark 2: already marked, dropped" });
});
