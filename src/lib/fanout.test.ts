// Run: npx tsx --test src/lib/fanout.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BatchRefusal } from "../../shared/protocol";
import {
  addModel,
  COUNT_MAX,
  createLabel,
  defaultGroupName,
  failureLines,
  partialClosing,
  partialTitle,
  removeModel,
  rowFill,
  sharedTurnLine,
  stepCount,
  totalMembers,
} from "./fanout";

const failure = (ref: string, message: string): BatchRefusal => ({ id: "", path: "", code: "internal", message, ref });

test("picking a listed model increments its row instead of adding a second one", () => {
  let rows = addModel([], "anthropic/claude-opus-5");
  rows = addModel(rows, "zai/glm-5.3");
  rows = addModel(rows, "anthropic/claude-opus-5");
  assert.deepEqual(rows, [
    { ref: "anthropic/claude-opus-5", count: 2 },
    { ref: "zai/glm-5.3", count: 1 },
  ]);
  assert.equal(totalMembers(rows), 3);
});

test("a count stops at 9, and − at 1 removes the row", () => {
  let rows: { ref: string; count: number }[] = [{ ref: "a/b", count: COUNT_MAX }];
  assert.deepEqual(stepCount(rows, "a/b", 1), [{ ref: "a/b", count: COUNT_MAX }]);
  assert.deepEqual(addModel(rows, "a/b"), [{ ref: "a/b", count: COUNT_MAX }]);
  rows = [{ ref: "a/b", count: 2 }, { ref: "c/d", count: 1 }];
  assert.deepEqual(stepCount(rows, "a/b", -1), [{ ref: "a/b", count: 1 }, { ref: "c/d", count: 1 }]);
  assert.deepEqual(stepCount(rows, "c/d", -1), [{ ref: "a/b", count: 2 }]);
  assert.deepEqual(removeModel(rows, "a/b"), [{ ref: "c/d", count: 1 }]);
  // A ref that isn't in the plan changes nothing rather than throwing.
  assert.deepEqual(stepCount(rows, "gone/x", 1), rows);
});

test("the default group name is six words of the source, capped at the name limit", () => {
  assert.equal(defaultGroupName("Retry backoff with jitter and a cap on attempts"), "Fanout · Retry backoff with jitter and a");
  assert.equal(defaultGroupName("  spaced   out  "), "Fanout · spaced out");
  assert.equal(defaultGroupName(""), "Fanout");
  const long = defaultGroupName("supercalifragilistic expialidocious antidisestablishmentarianism pneumonoultramicroscopic floccinaucinihilipilification incomprehensibilities");
  assert.ok(long.length <= 60, `trimmed to 60, got ${long.length}`);
});

test("a row's fill compares against THAT model's window, which is the point of the preview", () => {
  // The same 48k against two windows: 4% of one, 24% of the other — §14b's own worked example,
  // and the percent is §4f's formatter, which floors rather than rounds.
  assert.equal(rowFill(48_000, 1_000_000).text, "48k of 1M · 4%");
  assert.equal(rowFill(48_000, 200_000).text, "48k of 200k · 24%");
});

test("an unknown window shows tokens alone and never blocks; fresh mode has no fill at all", () => {
  const unknown = rowFill(48_000, undefined);
  assert.equal(unknown.text, "48k, window unknown");
  assert.equal(unknown.step, "");
  assert.equal(unknown.overflows, false, "we don't know that it doesn't fit");
  const fresh = rowFill(null, 200_000);
  assert.equal(fresh.text, "new session");
  assert.equal(fresh.overflows, false);
});

test("a fork bigger than the window overflows, and carries §4f's error step", () => {
  const over = rowFill(250_000, 200_000);
  assert.equal(over.overflows, true);
  assert.equal(over.step, "context-error");
  assert.equal(over.text, "250k of 200k");
  // Right at the window is still over: a session that starts full fails on its first turn.
  assert.equal(rowFill(200_000, 200_000).overflows, true);
  // Under it is not, and the warn step is §4f's, not a second opinion.
  assert.equal(rowFill(170_000, 200_000).overflows, false);
  assert.equal(rowFill(170_000, 200_000).step, "context-warn");
});

test("the shared-turn line says what every future turn costs, in both modes", () => {
  assert.equal(sharedTurnLine(5, 48_000), "5 members × ~48k tokens re-sent every shared turn.");
  assert.equal(
    sharedTurnLine(3, null),
    "3 members, each starting empty. Every shared turn is re-sent 3 times as they grow.",
  );
});

test("a fanout of one agrees in number, in both modes", () => {
  // A row at count 1 is a legal plan, and §9's plural-only copy reads "1 members … 1 times" there.
  assert.equal(sharedTurnLine(1, 48_000), "1 member × ~48k tokens re-sent every shared turn.");
  assert.equal(sharedTurnLine(1, null), "1 member, starting empty. Every shared turn is re-sent 1 time as it grows.");
});

test("the primary counts what it will do", () => {
  assert.equal(createLabel(1), "Create 1 Member");
  assert.equal(createLabel(5), "Create 5 Members");
});

test("failures sharing a ref AND a reason collapse to a count", () => {
  assert.deepEqual(
    failureLines([failure("anthropic/claude-opus-5", "the provider returned 429."), failure("anthropic/claude-opus-5", "the provider returned 429.")]),
    ["2 × claude-opus-5 couldn't start: the provider returned 429."],
  );
});

test("the same model failing two ways gets two lines, because the reasons are the information", () => {
  assert.deepEqual(
    failureLines([failure("anthropic/claude-opus-5", "the provider returned 429."), failure("anthropic/claude-opus-5", "no credentials for anthropic.")]),
    [
      "claude-opus-5 couldn't start: the provider returned 429.",
      "claude-opus-5 couldn't start: no credentials for anthropic.",
    ],
  );
});

test("distinct models each get their own line, in the order they failed", () => {
  assert.deepEqual(
    failureLines([failure("anthropic/claude-opus-5", "the provider returned 429."), failure("zai/glm-5.3", "no credentials for zai.")]),
    [
      "claude-opus-5 couldn't start: the provider returned 429.",
      "glm-5.3 couldn't start: no credentials for zai.",
    ],
  );
});

test("a failure with no ref still gets a line rather than vanishing", () => {
  // The route always sets `ref` on a creation failure; an older server that doesn't must not make
  // the reason disappear, because the reason is the only thing the user can act on.
  assert.deepEqual(failureLines([{ id: "", path: "", code: "internal", message: "the runtime gave no reason." }]), [
    "A member couldn't start: the runtime gave no reason.",
  ]);
});

test("the banner's claim and closing line agree with each other about how many exist", () => {
  assert.equal(partialTitle(4, 5), "4 of 5 members were created.");
  assert.equal(partialTitle(1, 5), "1 of 5 members was created.");
  assert.equal(partialClosing(4), "The 4 that exist are running; add another from Add Members.");
  assert.equal(partialClosing(1), "It is running; add another from Add Members.");
});
