import assert from "node:assert/strict";
import { test } from "node:test";
import { applyMarks, byIdOrLabel, emphasisMap, emphasisNotes, resolveMarks, takeMarks } from "./emphasis";
import { lines, VisError } from "./grammar";

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

test("takeMarks errors: no target, junk, backwards ranges, long notes, too many", () => {
  throws(() => takeMarks(lines("mark")), /needs a target/);
  throws(() => takeMarks(lines("mark a sparkly")), /unexpected sparkly/);
  throws(() => takeMarks(lines("mark 5-3")), /backwards/);
  throws(() => takeMarks(lines(`mark a "${"x".repeat(121)}"`)), /at most 120/);
  throws(() => takeMarks(lines(Array.from({ length: 9 }, (_, i) => `mark n${i}`).join("\n"))), /at most 8/);
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

test("resolveMarks errors name the kind's item; a twice-marked item is an error", () => {
  const { marks } = takeMarks(lines("mark zz"));
  throws(() => resolveMarks(marks, () => null, "node"), /no node zz/);
  throws(() => resolveMarks(takeMarks(lines("mark a\nmark A")).marks, byIdOrLabel([{ key: "k", id: "a", label: "A" }]), "node"), /marked twice/);
});

test("applyMarks leaves a spec without marks untouched", () => {
  const spec: { emphasis?: unknown } = {};
  applyMarks(spec as never, [], () => null, "x");
  assert.equal("emphasis" in spec, false);
});
