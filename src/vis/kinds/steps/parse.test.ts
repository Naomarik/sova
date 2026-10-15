import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVis } from "../../parse";
import type { StepsRow, StepsSpec } from "./parse";

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
    ['"A" | "quoted" "twice" -> b', /one "quoted label" or bare words, not two labels: "quoted" "twice" \(join steps with ->\)/, 1],
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

const rows = (s: StepsSpec) => s.items.filter((i): i is StepsRow => i.type === "row");

test("steps: a tone after a quoted step tones that step; on the last, the row takes it when it has none", () => {
  const [a, b, c] = rows(ok(`A | "Open app" -> "token expired" error -> "sign in" ok\nB warn | x -> "y" error\nC | x -> "y" warn | ok`));
  assert.deepEqual(a, { type: "row", label: "A", tone: "ok", steps: ["Open app", "token expired", "sign in"], stepTones: [null, "error", "ok"] });
  // A toned label keeps its tone; the step keeps its own.
  assert.deepEqual(b, { type: "row", label: "B", tone: "warn", steps: ["x", "y"], stepTones: [null, "error"] });
  // `| ok` is the row's; the last step's tone is the step's only.
  assert.deepEqual(c, { type: "row", label: "C", tone: "ok", steps: ["x", "y"], stepTones: [null, "warn"] });
  // A bare word before a tone is still one step of words.
  assert.deepEqual(rows(ok("D | timeout error -> retry"))[0]!.steps, ["timeout error", "retry"]);
});

test("steps: ^ is the step at that position in the row above (text and tone), resolved when parsed", () => {
  const s = ok(`"Before" error | "Open app" -> "Tap Log In" -> "request times out" warn -> "spinner forever" error
"After" ok | ^ -> ^ -> ^ -> "Retry button" -> "signed in" ok
"Offline" muted | ^ -> ^ -> "no request sent" -> _ -> "offline banner"`);
  const [, after, offline] = rows(s);
  assert.deepEqual(after, { type: "row", label: "After", tone: "ok", steps: ["Open app", "Tap Log In", "request times out", "Retry button", "signed in"], stepTones: [null, null, "warn", null, "ok"] });
  // `^` reads the row right above, itself resolved.
  assert.deepEqual(offline, { type: "row", label: "Offline", tone: "muted", steps: ["Open app", "Tap Log In", "no request sent", "", "offline banner"], gaps: [3] });
  // A last ^ copies a tone that becomes the row's when it has none, as if written out.
  assert.deepEqual(rows(ok(`A | x -> "done" ok\nB | y -> ^`))[1], { type: "row", label: "B", tone: "ok", steps: ["y", "done"], stepTones: [null, "ok"] });
  // ^ under a lane head reads the row above in that lane.
  assert.deepEqual(rows(ok("== L ==\nA | x -> y\nB | ^ -> z"))[1]!.steps, ["x", "z"]);
});

test("steps: _ is nothing at a position and counts toward the 10 steps", () => {
  assert.deepEqual(rows(ok("A | a -> _ -> _ -> b"))[0], { type: "row", label: "A", steps: ["a", "", "", "b"], gaps: [1, 2] });
  assert.match(err(`A | ${Array.from({ length: 10 }, () => "_ ->").join(" ")} done`).message, /11 steps; at most 10/);
  assert.equal(rows(ok(`A | ${Array.from({ length: 9 }, () => "_ ->").join(" ")} done`))[0]!.steps.length, 10);
});

test("steps: a second | ends the row with an outcome; a lone tone word there keeps today's reading", () => {
  const out = (body: string) => rows(ok(body)).map((r) => [r.label, r.tone ?? null, r.steps, r.outcome ?? null]);
  assert.deepEqual(out(`A | a -> b | "3 tries"\nB warn | a -> b | 6 days\nC | a -> b | "lost" error\nD | a -> "b" ok | "1 day"`), [
    ["A", null, ["a", "b"], { text: "3 tries" }],
    ["B", "warn", ["a", "b"], { text: "6 days" }],
    ["C", null, ["a", "b"], { text: "lost", tone: "error" }],
    // The last step's tone is still the row's when the label has none.
    ["D", "ok", ["a", "b"], { text: "1 day" }],
  ]);
  // A lone tone word: the row's when its label has none; under a toned label, part of the last step (as before).
  assert.deepEqual(out("E | a -> b | ok\nF warn | a -> b | ok\nG warn | a -> \"b\" | ok"), [
    ["E", "ok", ["a", "b"], null],
    ["F", "warn", ["a", "b | ok"], null],
    ["G", "warn", ["a", '"b" | ok'], null],
  ]);
  // A | inside quotes is text, in the chain and in the outcome.
  assert.deepEqual(out('H | "a | b" -> c | "x | y"'), [["H", null, ["a | b", "c"], { text: "x | y" }]]);
});

test("steps: errors for the additions say what to write", () => {
  const cases: [string, RegExp, number][] = [
    ["A | ^ -> b", /\^ repeats the step at this position in the row above, but there is no row above: write step 1 out/, 1],
    ["A | a -> b\n== L ==\nB | ^ -> c", /a lane head comes between: write step 1 out/, 3],
    ["== L ==\nB | ^ -> c", /there is no row above/, 2],
    ["A | a\nB | x -> ^", /\^ is step 2, but the row above has no step 2: write it out/, 2],
    ["A | _ -> a\nB | ^ -> b", /\^ is step 1, but the row above leaves step 1 empty \(_\): write it out/, 2],
    ["A | a\nB | b | ^", /\^ stands for a step, not an outcome/, 2],
    ["A | a -> _", /_ leaves a position empty, so it can't end a row/, 1],
    ["A | _", /_ leaves a position empty, so it can't end a row/, 1],
    ["A | a |", /an empty outcome/, 1],
    ["A | a | b -> c", /an outcome has no ->/, 1],
  ];
  for (const [body, re, line] of cases) {
    const e = err(body);
    assert.match(e.message, re, body);
    assert.equal(e.line, line, body);
  }
});

test("steps: a mark naming a shared step marks every row with it, through ^ or written out", () => {
  const s = ok(`"Before" error | "Open app" -> "Tap Log In" -> "times out"
"After" ok | ^ -> ^ -> "Retry button"
"Offline" | "Open app" -> "no request"
"Elsewhere" | x
mark "Tap Log In" "every path taps it"`);
  // Through ^ (row 1) as well as written (row 0); the note's number sits on the first, as for `mark a, b`.
  assert.deepEqual(s.emphasis, [
    { key: "0", tone: "accent", note: "every path taps it", n: 1 },
    { key: "1", tone: "accent" },
  ]);
  // Written out the same in rows that don't touch; an empty position (_) is no step to name.
  assert.deepEqual(ok('A | "Open app" -> x\nB | y\nC | "Open app"\nmark "Open app" warn').emphasis?.map((e) => e.key), ["0", "2"]);
  assert.match(warning('A | a -> _ -> b\nmark ""').message, /no row/);
});
