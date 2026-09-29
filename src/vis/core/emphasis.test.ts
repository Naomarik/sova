import assert from "node:assert/strict";
import { test } from "node:test";
import { applyMarks, byIdOrLabel, emphasisMap, emphasisNotes, resolveMarks, takeMarks } from "./emphasis";
import { collectWarnings, lines, VisError } from "./grammar";

const throws = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof VisError && re.test(e.message));

test("takeMarks splits out mark lines: targets, tone, note, in any order after the target", () => {
  const { rest, marks } = takeMarks(lines('a -> b\nmark a\nmark "Merge sort" warn "slow"\nmark 3 "x" error\nmark 4-6\n  mark indented'));
  assert.deepEqual(rest.map((l) => l.text), ["a -> b", "mark indented"], "an indented line is never a mark");
  assert.deepEqual(marks.map((m) => [m.target.t, m.target.text, m.tone ?? null, m.note ?? null]), [
    ["id", "a", null, null],
    ["label", "Merge sort", "warn", "slow"],
    ["number", "3", "error", "x"],
    ["range", "4-6", null, null],
  ]);
});

test("takeMarks errors: no target, junk, backwards ranges", () => {
  throws(() => takeMarks(lines("mark")), /needs a target/);
  throws(() => takeMarks(lines("mark a sparkly")), /unexpected sparkly/);
  throws(() => takeMarks(lines("mark 5-3")), /backwards/);
});

test("takeMarks warnings: a long note is cut, marks past the 8th are dropped", () => {
  const long = collectWarnings(() => takeMarks(lines(`mark a "${"x".repeat(121)}"`)));
  assert.equal(long.value.marks[0]!.note, `${"x".repeat(119)}…`);
  assert.deepEqual(long.warnings, [{ line: 1, message: "mark note over 120 characters, shortened" }]);
  const many = collectWarnings(() => takeMarks(lines(Array.from({ length: 10 }, (_, i) => `mark n${i}`).join("\n"))));
  assert.deepEqual(many.value.marks.map((m) => m.target.text), ["n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7"]);
  assert.deepEqual(many.warnings.map((w) => w.line), [9, 10]);
  assert.match(many.warnings[0]!.message, /past the 8th, dropped/);
});

test("resolveMarks: keys from the kind, numbers only for notes, accent by default, a range's note on its first item", () => {
  const { marks } = takeMarks(lines('mark a\nmark b "first"\nmark 2-3 ok "range"'));
  const em = resolveMarks(marks, (t) => (t.t === "range" ? [`L${t.from}`, `L${t.to}`] : t.text), "item");
  assert.deepEqual(em, [
    { key: "a", tone: "accent" },
    { key: "b", tone: "accent", note: "first", n: 1 },
    { key: "L2", tone: "ok", note: "range", n: 2 },
    { key: "L3", tone: "ok" },
  ]);
  assert.deepEqual(emphasisNotes({ emphasis: em }), [{ n: 1, note: "first", tone: "accent" }, { n: 2, note: "range", tone: "ok" }]);
  assert.equal(emphasisMap({ emphasis: em }).get("L3")!.tone, "ok");
});

test("resolveMarks drops, with a warning naming the kind's item, a mark that names nothing or an item already marked", () => {
  const none = collectWarnings(() => resolveMarks(takeMarks(lines('mark zz "gone"\nmark a "kept"')).marks, (t) => (t.text === "a" ? "a" : null), "node"));
  // The dropped mark takes no number: the kept note is 1.
  assert.deepEqual(none.value, [{ key: "a", tone: "accent", note: "kept", n: 1 }]);
  assert.deepEqual(none.warnings, [{ line: 1, message: "mark: no node zz, dropped" }]);
  const twice = collectWarnings(() => resolveMarks(takeMarks(lines("mark a\nmark A")).marks, byIdOrLabel([{ key: "k", id: "a", label: "A" }]), "node"));
  assert.deepEqual(twice.value, [{ key: "k", tone: "accent" }]);
  assert.deepEqual(twice.warnings, [{ line: 2, message: "mark A: already marked, dropped" }]);
  // A range overlapping an earlier mark keeps the rest, its note on its first unmarked item.
  const range = collectWarnings(() => resolveMarks(takeMarks(lines('mark 2\nmark 1-3 "r"')).marks, (t) => (t.t === "range" ? ["1", "2", "3"] : t.text), "line"));
  assert.deepEqual(range.value, [{ key: "2", tone: "accent" }, { key: "1", tone: "accent", note: "r", n: 1 }, { key: "3", tone: "accent" }]);
  assert.match(range.warnings[0]!.message, /mark 1-3: part of it is already marked, the rest kept/);
});

test("applyMarks: when every mark is dropped the spec has no emphasis", () => {
  const spec: { emphasis?: unknown } = {};
  const { warnings } = collectWarnings(() => applyMarks(spec as never, takeMarks(lines("mark zz")).marks, () => null, "x"));
  assert.equal("emphasis" in spec, false);
  assert.equal(warnings.length, 1);
});

test("applyMarks leaves a spec without marks untouched", () => {
  const spec: { emphasis?: unknown } = {};
  applyMarks(spec as never, [], () => null, "x");
  assert.equal("emphasis" in spec, false);
});

test("takeMarks: commas outside quotes separate several targets; a quoted comma is one label", () => {
  const { marks } = takeMarks(lines('mark a, b\nmark a,b,c warn "scope"\nmark "Tokyo, Japan", Paris\nmark 2, 4-5 "two"'));
  assert.deepEqual(
    marks.map((m) => m.targets.map((t) => [t.t, t.text])),
    [
      [["id", "a"], ["id", "b"]],
      [["id", "a"], ["id", "b"], ["id", "c"]],
      [["label", "Tokyo, Japan"], ["id", "Paris"]],
      [["number", "2"], ["range", "4-5"]],
    ],
  );
  assert.deepEqual([marks[1]!.tone, marks[1]!.note], ["warn", "scope"]);
  assert.equal(marks[0]!.target, marks[0]!.targets[0], "target is the first of targets");
});

test("takeMarks: a stray or trailing comma is an error; mark lines, not targets, count toward 8", () => {
  throws(() => takeMarks(lines("mark a,")), /comma needs a target on each side/);
  throws(() => takeMarks(lines("mark a, , b")), /comma needs a target on each side/);
  throws(() => takeMarks(lines("mark , a")), /comma needs a target on each side/);
  const many = collectWarnings(() => takeMarks(lines(Array.from({ length: 8 }, (_, i) => `mark n${i}, m${i}, k${i}`).join("\n"))));
  assert.equal(many.value.marks.length, 8);
  assert.deepEqual(many.warnings, []);
});

test("resolveMarks: one mark over several targets lists its note once, the same number on each target's first item", () => {
  const { marks } = takeMarks(lines('mark a, b, c "scope"\nmark 1-2, d ok "range and one"\nmark e "last"'));
  const em = resolveMarks(marks, (t) => (t.t === "range" ? ["L1", "L2"] : t.text), "item");
  assert.deepEqual(em, [
    { key: "a", tone: "accent", note: "scope", n: 1 },
    { key: "b", tone: "accent", note: "scope", n: 1 },
    { key: "c", tone: "accent", note: "scope", n: 1 },
    { key: "L1", tone: "ok", note: "range and one", n: 2 },
    { key: "L2", tone: "ok" },
    { key: "d", tone: "ok", note: "range and one", n: 2 },
    { key: "e", tone: "accent", note: "last", n: 3 },
  ]);
  assert.deepEqual(emphasisNotes({ emphasis: em }).map((x) => [x.n, x.note]), [[1, "scope"], [2, "range and one"], [3, "last"]]);
});

test("resolveMarks: a target that names nothing is dropped with the usual warning; the rest of its line stays", () => {
  const got = collectWarnings(() => resolveMarks(takeMarks(lines('mark a, zz, b "kept"')).marks, (t) => (t.text === "zz" ? null : t.text), "node"));
  assert.deepEqual(got.value.map((e) => [e.key, e.n]), [["a", 1], ["b", 1]]);
  assert.deepEqual(got.warnings, [{ line: 1, message: "mark: no node zz, dropped" }]);
  const all = collectWarnings(() => resolveMarks(takeMarks(lines('mark x, y "gone"\nmark a "one"')).marks, (t) => (t.text === "a" ? "a" : null), "node"));
  assert.deepEqual(all.value, [{ key: "a", tone: "accent", note: "one", n: 1 }], "a line naming nothing takes no number");
  assert.equal(all.warnings.length, 2);
  // An item named twice in one line is marked once; one already marked by an earlier line is kept there.
  const dup = collectWarnings(() => resolveMarks(takeMarks(lines('mark a\nmark a, b, b "n"')).marks, (t) => t.text, "node"));
  assert.deepEqual(dup.value, [{ key: "a", tone: "accent" }, { key: "b", tone: "accent", note: "n", n: 1 }]);
  assert.deepEqual(dup.warnings, [{ line: 2, message: "mark a, b, b: part of it is already marked, the rest kept" }]);
});
