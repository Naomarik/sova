import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVis } from "../../parse";
import type { StepsSpec } from "./parse";

const ok = (body: string): StepsSpec => {
  const r = parseVis("steps", body);
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
  return r.spec as StepsSpec;
};
const err = (body: string) => {
  const r = parseVis("steps", body);
  assert.equal(r.ok, false, `expected an error for:\n${body}`);
  return r as { ok: false; line: number; message: string };
};
/** A fence that still draws: its first warning (parse.ts). */
const warning = (body: string) => {
  const r = parseVis("steps", body);
  if (!r.ok) assert.fail(`expected a drawing with a warning, got line ${r.line}: ${r.message}`);
  assert.ok(r.warnings.length, `expected a warning for:\n${body}`);
  assert.deepEqual(r.spec.warnings, r.warnings, "the spec carries the same warnings");
  return r.warnings[0]!;
};

test("steps: lanes, rows, tones, quoted and bare steps, a mark on a row by its label", () => {
  const s = ok(`title: Organizations scenarios
== Asking people ==
"Simple question" ok | You -> "Maria gets a link" -> "she answers" -> "decision recorded"
"Tony vs Bob" warn | "$5k vs $10k" -> conflict spotted -> "Tony settles"   # bare words make one step
== Autopilot ==
Overseer muted | "set level" -> "notices a gap"
"Pipes | in quotes" | a->b
mark "Tony vs Bob" "settle step not run yet"
mark Overseer`);
  assert.equal(s.title, "Organizations scenarios");
  assert.deepEqual(s.items, [
    { type: "lane", label: "Asking people" },
    { type: "row", label: "Simple question", tone: "ok", steps: ["You", "Maria gets a link", "she answers", "decision recorded"] },
    { type: "row", label: "Tony vs Bob", tone: "warn", steps: ["$5k vs $10k", "conflict spotted", "Tony settles"] },
    { type: "lane", label: "Autopilot" },
    { type: "row", label: "Overseer", tone: "muted", steps: ["set level", "notices a gap"] },
    { type: "row", label: "Pipes | in quotes", steps: ["a", "b"] },
  ]);
  assert.deepEqual(s.emphasis, [
    { key: "2", tone: "accent", note: "settle step not run yet", n: 1 },
    { key: "4", tone: "accent" },
  ]);
  // Rows need no lane; a single step is a row too.
  assert.equal(ok("Done | shipped").items.length, 1);
});

test("steps: each error says what to write", () => {
  const cases: [string, RegExp, number][] = [
    ['"No bar" You -> Maria', /a row is: "Label" \[tone\] \| step -> step/, 1],
    ["| a -> b", /the label is missing/, 1],
    ['"A" ok |', /no steps after the \|/, 1],
    ['"A" | a -> -> b', /an empty step/, 1],
    ['"A" | a ->', /an empty step/, 1],
    ['"A" | a --> b', /steps join with ->, not -->/, 1],
    ['"A" | "quoted" and bare -> b', /one "quoted label" or bare words, not both/, 1],
    ["a -> b | c", /the steps go after the \|/, 1],
    ["== Empty ==\n== Full ==\nA | a", /lane "Empty" is empty/, 1],
    ["A | a\n== Trailing ==", /lane "Trailing" is empty/, 2],
    ["== ==\nA | a", /a lane needs a label/, 1],
    ["title: x", /nothing to draw/, 0],
    [`A | ${Array.from({ length: 11 }, (_, i) => `s${i}`).join(" -> ")}`, /11 steps; at most 10/, 1],
    [Array.from({ length: 17 }, (_, i) => `R${i} | a`).join("\n"), /17 rows; at most 16/, 0],
  ];
  for (const [body, re, line] of cases) {
    const e = err(body);
    assert.match(e.message, re, body);
    assert.equal(e.line, line, body);
  }
});

test("steps: a head mixing quotes and words is its text as written", () => {
  const s = ok(`== Broadcast ==\n'"all"' | "one message" -> "every live sibling"\n"Pi" sibling warn | a -> b\n"A" "B" | c`);
  assert.deepEqual(s.items.filter((i) => i.type === "row").map((r) => [r.label, r.tone ?? null]), [
    [`'"all"'`, null],
    ['"Pi" sibling', "warn"],
    ['"A" "B"', null],
  ]);
  // One quoted label, or bare words (single quotes included), are read as before.
  assert.deepEqual(ok(`"Busy sibling" ok | a\n'Idle' sibling | b`).items.map((r) => (r.type === "row" ? r.label : "")), ["Busy sibling", "'Idle' sibling"]);
  assert.match(warning('A | a\nmark "B"').message, /no row "B", dropped/);
});
