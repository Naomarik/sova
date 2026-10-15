import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVis } from "../../parse";
import { unweighted } from "../tree/measure";
import { estimateHeight, STEPS_NARROW, stepLines } from "./height";
import { stepsLayout, type StepsLayout } from "./layout";
import type { StepsSpec } from "./parse";

const spec = (body: string) => {
  const r = parseVis("steps", body);
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
  return r.spec as StepsSpec;
};
/** 7px a character: easy to reason about. */
const px7 = (t: string) => t.length * 7;
const flat = unweighted(px7);

const SCENARIOS = spec(`== Asking people ==
"Simple question" ok | You -> "Maria gets a link" -> "she answers" -> "decision recorded"
"Tony vs Bob" warn | "$5k vs $10k" -> "conflict spotted" -> "Tony settles"
== Autopilot ==
"Project overseer" muted | "set level" -> "notices a gap" -> "starts a conversation"
mark "Tony vs Bob" "settle step not run yet"`);

/** The prototype's example (c): a merged start across 3 columns, a span of 2, a `_`, a mark. */
const REPRO = spec(`title: Logging in on a slow network
"Before the fix" error | "Open app" -> "Tap Log In" -> "request times out" warn -> "spinner forever" error
"After the fix" ok | ^ -> ^ -> ^ -> "Retry button" -> "signed in" ok
"Offline" muted | ^ -> ^ -> "no request sent" -> _ -> "offline banner"
mark "Before the fix" "reported 41 times this week"`);

/** The guide's example: 2 rows, a merged first step, outcome footers. */
const GUIDE = spec(`"Simple question" ok | You -> "Maria gets a link" -> "decision recorded" | "1 day"
"Tony vs Bob" warn | ^ -> "Tony and Bob get it" -> "they disagree" warn -> "Tony settles" | "6 days"
mark "Tony vs Bob" "settle step not run yet"`);

const rowsOf = (n: number) => spec(Array.from({ length: n }, (_, i) => `R${i} | a -> b`).join("\n"));

test("steps layout: side by side for 2–4 rows without lanes at rows × 180px, else grid above 402px, else the list", () => {
  const cases: [StepsSpec, number, StepsLayout][] = [
    // Both sides of rows × 180.
    [rowsOf(2), 360, "side"],
    [rowsOf(2), 359, "rail"],
    [rowsOf(3), 540, "side"],
    [rowsOf(3), 539, "grid"],
    [rowsOf(4), 720, "side"],
    [rowsOf(4), 719, "grid"],
    // Both sides of 402, where side by side doesn't apply.
    [rowsOf(3), STEPS_NARROW + 1, "grid"],
    [rowsOf(3), STEPS_NARROW, "rail"],
    [SCENARIOS, STEPS_NARROW + 1, "grid"],
    [SCENARIOS, STEPS_NARROW, "rail"],
    // A phone still puts 2 rows side by side when each gets 180px.
    [rowsOf(2), STEPS_NARROW, "side"],
    // Lanes, one row, or more than 4 rows never stand side by side.
    [SCENARIOS, 2000, "grid"],
    [rowsOf(1), 2000, "grid"],
    [rowsOf(5), 2000, "grid"],
    [spec("== L ==\nA | a\nB | b"), 2000, "grid"],
  ];
  for (const [s, w, want] of cases) assert.equal(stepsLayout(s, w), want, `${s.items.length} items at ${w}`);
});

test("steps height, side by side: heads, one line per position with its arrows, outcomes, the room under", () => {
  // 2 columns of 196px at 400: head 7 + 22; each position 18 + a 24px chip; 9 under.
  const two = spec("A | a -> b\nB | a -> c");
  assert.equal(estimateHeight(two, 400, flat), 29 + 42 + 42 + 9);
  // Outcomes: 10 + 18 more, on one line at the bottom.
  assert.equal(estimateHeight(spec('A | a -> b | "3 tries"\nB | a -> c'), 400, flat), 29 + 42 + 42 + 28 + 9);
  // An empty position is 24px, as a one-line chip.
  assert.equal(estimateHeight(spec("A | a -> b -> c\nB | a -> _ -> c"), 400, flat), 29 + 3 * 42 + 9);
  // A shared step spans both columns: 392 - 18 padding - 18 chip = 356px of text, so 50 characters
  // (350px) take one line there, where a single column (196 - 36 = 160px) would take three.
  const long = "x".repeat(50);
  assert.equal(estimateHeight(spec(`A | "${long}" -> b\nB | "${long}" -> c`), 400, flat), 29 + 42 + 42 + 9);
  assert.equal(estimateHeight(spec(`A | "${long}" -> b\nB | z -> c`), 400, flat), 29 + (18 + 6 + 3 * 18) + 42 + 9);
  // A toned step's icon takes 20px of its text: 23 characters (161px) fit 160px only without it.
  const t = "y".repeat(22);
  assert.equal(estimateHeight(spec(`A | "${t}" -> b\nB | z -> c`), 400, flat), 29 + 42 + 42 + 9);
  assert.equal(estimateHeight(spec(`A | "${t}" error -> b\nB | z -> c`), 400, flat), 29 + (18 + 6 + 2 * 18) + 42 + 9);
  // The guide's example at 599: 4 positions, the first merged, and the outcome footers.
  assert.equal(estimateHeight(GUIDE, 599, flat), 29 + 4 * 42 + 28 + 9);
});

test("steps height, grid: bands, the label column, equal step columns that wrap, the outcome column", () => {
  const one = spec("Done | a -> b");
  // 12 padding + 2 border + max(label 22, chips 24).
  assert.equal(estimateHeight(one, 600, flat), 14 + 24);
  // A lane head: 18px, and 8px more above it when something comes before; items are 4px apart.
  assert.equal(estimateHeight(spec("== L ==\nDone | a"), 600, flat), 18 + 4 + 38);
  assert.equal(estimateHeight(spec("Done | a\n== L ==\nNext | b"), 600, flat), 38 + 4 + 8 + 18 + 4 + 38);
  // 6 steps at 600: 430px of steps hold 3 columns of 128px + 20px arrows, so the row takes 2 lines.
  const six = spec(`== L ==\nDone | ${Array.from({ length: 6 }, (_, i) => `s${i}`).join(" -> ")}`);
  assert.equal(estimateHeight(six, 600, flat), 18 + 4 + 14 + 24 + 4 + 24);
  // With an outcome column (128px less), 302px hold 2 columns: 3 lines.
  const out = spec(`== L ==\nDone | ${Array.from({ length: 6 }, (_, i) => `s${i}`).join(" -> ")} | "fine"`);
  assert.equal(estimateHeight(out, 600, flat), 18 + 4 + 14 + 3 * 24 + 2 * 4);
  // A long outcome wraps in its 120px: 3 + 18 per line.
  const longOut = spec(`== L ==\nDone | a | "${"word ".repeat(10).trim()}"`);
  assert.equal(estimateHeight(longOut, 600, flat), 18 + 4 + 14 + 3 + 4 * 18);
});

test("steps height, the list: label above, numbered lines, folds for a shared start and a run of _", () => {
  // 14 + label 22 + 4, then lines 4px apart.
  assert.equal(estimateHeight(spec("Done | a -> b"), 300, flat), 14 + 22 + 4 + 24 + 4 + 24);
  // Under a lane head, B's shared first step folds into one line ("Step 1 as in A").
  const fold = spec("== L ==\nA | a -> b\nB | a -> c");
  assert.equal(estimateHeight(fold, 300, flat), 18 + 4 + (14 + 22 + 4 + 24 + 4 + 24) + 4 + (14 + 22 + 4 + 24 + 4 + 24));
  // A run of _ is one 24px line.
  assert.equal(estimateHeight(spec("A | a -> _ -> _ -> _ -> b"), 300, flat), 14 + 22 + 4 + 3 * 24 + 2 * 4);
  // The outcome is the last line: 6 + 18.
  assert.equal(estimateHeight(spec('A | a | "done"'), 300, flat), 14 + 22 + 4 + 24 + 4 + 24);
});

test("steps height: ids break only after their dashes, words at spaces", () => {
  // 01a126f0- (63) | b8d9- (35) | 763b (28): 2 lines at 70px, never mid-piece.
  assert.equal(stepLines("01a126f0-b8d9-763b", 70, px7), 2);
  assert.equal(stepLines("01a126f0-b8d9-763b", 126, px7), 1);
  // A piece wider than the line breaks anywhere (overflow-wrap).
  assert.equal(stepLines("18107456e443abcdef", 70, px7), 2);
  // "id: 01a126f0" is 2 words: "id:" then the id (7 + 56 = 63 > 60).
  assert.equal(stepLines("id: 01a126f0", 60, px7), 2);
  // Trailing punctuation travels with the id: "01a126f0:" never leaves the ":" alone.
  assert.equal(stepLines("01a126f0: x", 63, px7), 2);
  assert.equal(stepLines("ab cd", 35, px7), 1);
  assert.equal(stepLines("ab cd", 34, px7), 2);
});

test("steps height: deterministic, and never grows as the pane widens within a layout", () => {
  const ranges: [StepsSpec, number, number][] = [
    [SCENARIOS, 296, STEPS_NARROW],
    [SCENARIOS, STEPS_NARROW + 1, 1100],
    [REPRO, 296, STEPS_NARROW],
    [REPRO, STEPS_NARROW + 1, 539],
    [REPRO, 540, 1100],
    [GUIDE, 296, 359],
    [GUIDE, 360, 1100],
  ];
  for (const [s, from, to] of ranges) {
    let last = Infinity;
    const layout = stepsLayout(s, from);
    for (let w = from; w <= to; w++) {
      assert.equal(stepsLayout(s, w), layout, `one layout from ${from} to ${to}`);
      const h = estimateHeight(s, w);
      assert.equal(h, estimateHeight(s, w));
      assert.ok(h > 0 && h <= last, `height ${h} at ${w} after ${last}`);
      last = h;
    }
  }
  assert.ok(estimateHeight(SCENARIOS, 900) < estimateHeight(SCENARIOS, 296));
});

test("steps height: fixtures at 1100, 720 and 380 (content widths 1076, 696, 356) take the layout the rule picks", () => {
  const at = (s: StepsSpec) => [1076, 696, 356].map((w) => [stepsLayout(s, w), estimateHeight(s, w, flat)] as const);
  // REPRO, side by side: 3 columns, the start merged across all 3, a span of 2, a `_`, a note badge.
  const repro = at(REPRO);
  assert.deepEqual(repro.map(([l]) => l), ["side", "side", "rail"]);
  assert.equal(repro[0]![1], 29 + 5 * 42 + 9);
  // GUIDE: 2 rows need 360px side by side, so 356 takes the list.
  assert.deepEqual(at(GUIDE).map(([l]) => l), ["side", "side", "rail"]);
  assert.equal(at(GUIDE)[0]![1], 29 + 4 * 42 + 28 + 9);
  assert.deepEqual(at(SCENARIOS).map(([l]) => l), ["grid", "grid", "rail"]);
  // Each layout's height is its own: the list is taller than the grid, the grid than side by side here.
  assert.ok(repro[2]![1] > repro[1]![1]);
});
