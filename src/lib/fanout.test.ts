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
  fanoutBody,
  fewerLabel,
  moreLabel,
  partialClosing,
  partialTitle,
  removeModel,
  removeLabel,
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
    ["2 × anthropic/claude-opus-5 couldn't start: the provider returned 429."],
  );
});

test("the same model failing two ways gets two lines, because the reasons are the information", () => {
  assert.deepEqual(
    failureLines([failure("anthropic/claude-opus-5", "the provider returned 429."), failure("anthropic/claude-opus-5", "no credentials for anthropic.")]),
    [
      "anthropic/claude-opus-5 couldn't start: the provider returned 429.",
      "anthropic/claude-opus-5 couldn't start: no credentials for anthropic.",
    ],
  );
});

test("distinct models each get their own line, in the order they failed", () => {
  assert.deepEqual(
    failureLines([failure("anthropic/claude-opus-5", "the provider returned 429."), failure("zai/glm-5.3", "no credentials for zai.")]),
    [
      "anthropic/claude-opus-5 couldn't start: the provider returned 429.",
      "zai/glm-5.3 couldn't start: no credentials for zai.",
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

test("the body carries exactly one of name and groupId, never both", () => {
  const rows = [{ ref: "a/b", count: 2 }];
  const source = { path: "/tmp/src.jsonl", leafId: "leaf1" };

  const created = fanoutBody({ rows, name: "  Fanout · x  ", source });
  assert.deepEqual(created, { name: "Fanout · x", named: "generated", members: rows, source });
  assert.equal("groupId" in created, false, "a new group is named, not addressed");

  const joined = fanoutBody({ rows, into: { id: "g1" }, name: "ignored", source });
  assert.deepEqual(joined, { groupId: "g1", members: rows, source });
  assert.equal("name" in joined, false, "an existing group keeps its own name");
  assert.equal("named" in joined, false, "and provenance would be a claim about a name we aren't setting");
});

test("the body carries exactly one of source and cwd, for the same reason", () => {
  const rows = [{ ref: "a/b", count: 1 }];
  const fresh = fanoutBody({ rows, name: "n", fresh: { cwd: "/w", text: "  go  " } });
  assert.deepEqual(fresh, { name: "n", named: "generated", members: rows, cwd: "/w", text: "go" });
  assert.equal("source" in fresh, false);
  const forked = fanoutBody({ rows, name: "n", source: { path: "/p", leafId: "l" } });
  assert.equal("cwd" in forked, false);
  assert.equal("text" in forked, false);
});

test("provenance is the EDIT EVENT, in all four cases", () => {
  const rows = [{ ref: "a/b", count: 1 }];
  const source = { path: "/p", leafId: "l" };
  const named = (nameTouched: boolean, name = "Fanout · retry backoff") =>
    (fanoutBody({ rows, name, nameTouched, source }) as { named?: string }).named;

  assert.equal(named(false), "generated", "untouched, however many times we regenerated it");
  assert.equal(named(true, "Backoff experiments"), "user", "typed over");
  // TYPED OVER, THEN RESTORED TO OUR EXACT TEXT → "user", and the reason matters more than the
  // assertion. This row is NOT one that deserves to survive: the group ends up carrying pi-web's
  // own string, so dissolving would be the better answer and what ships here is litter. It is
  // simply what the edit event yields, and we accept that cost rather than rebuild on a
  // comparison — which is correct only while regeneration stops at the first touch, and fails the
  // other way: reporting "generated" for a name the user typed, and deleting it. An empty group
  // nobody dissolves costs a gesture; a deleted name costs work.
  // Dissolving looks obviously right to anyone who reads this row, and it IS right — so a reader
  // who meets the case without the reason will change it, and the test will look wrong rather
  // than the change.
  assert.equal(named(true), "user", "typed over then restored to our text still counts as naming it");
  assert.equal(named(false, "Fanout · ZULU"), "generated", "fork mode untouched, where we write the field once");
});

test("a caller that reports no touch at all is treated as untouched, not as user-named", () => {
  // The dialog always passes the flag; a caller that doesn't is describing a field nobody edited,
  // which is the generated default. The SERVER's absence default is the opposite ("user") and
  // correctly so — there, absence means the CLIENT can't make the claim, which is a different
  // population from a client saying "nobody touched it".
  const body = fanoutBody({ rows: [{ ref: "a/b", count: 1 }], name: "Fanout · x", source: { path: "/p", leafId: "l" } });
  assert.equal((body as { named?: string }).named, "generated");
});

test("a member row's controls are named by the FULL ref, because two providers ship one model name", () => {
  // The hazard this pins: `zai/glm-5.3` and `ollama-cloud/glm-5.3` are two rows, two subscriptions,
  // and one bare model id. The row's visible text is the full ref, so a sighted user can tell them
  // apart; the accessible name is the only signal a screen-reader user has, and shortModel would
  // announce both as "One more glm-5.3". §9's "Member row" requires the ref for that reason.
  assert.equal(moreLabel("zai/glm-5.3"), "One more zai/glm-5.3");
  assert.notEqual(moreLabel("zai/glm-5.3"), moreLabel("ollama-cloud/glm-5.3"));
  assert.equal(removeLabel("ollama-cloud/glm-5.3"), "Remove ollama-cloud/glm-5.3");
  // At 1 the − button removes the row, so it says so — the same string as the remove button.
  assert.equal(fewerLabel("zai/glm-5.3", 1), "Remove zai/glm-5.3");
  assert.equal(fewerLabel("zai/glm-5.3", 2), "One fewer zai/glm-5.3");
});

test("two providers failing the same way stay two lines, and read as two models", () => {
  // The collapse keys on the ref, so these correctly do NOT merge — which is exactly why the
  // short form is wrong here: it would render a non-duplicate as a visible duplicate, and the
  // duplicate-looking pair is the NORMAL rendering for a cross-provider fanout, not an edge.
  const lines = failureLines([failure("zai/glm-5.3", "the provider returned 429."), failure("ollama-cloud/glm-5.3", "the provider returned 429.")]);
  assert.equal(lines.length, 2, "different refs are different models and never collapse");
  assert.notEqual(lines[0], lines[1], "and the user can tell which is which");
  assert.deepEqual(lines, [
    "zai/glm-5.3 couldn't start: the provider returned 429.",
    "ollama-cloud/glm-5.3 couldn't start: the provider returned 429.",
  ]);
});
