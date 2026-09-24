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
  midTurnReason,
  moreLabel,
  oldFormatReason,
  partialClosing,
  partialTitle,
  removeModel,
  removeLabel,
  rowFill,
  seedRef,
  sharedTurnLine,
  sourceBlocked,
  sourceRefusal,
  stepCount,
  totalMembers,
} from "./fanout";
import type { ModelInfo } from "../../shared/protocol";

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
  // The same 48k against two windows: 4% of one, 24% of the other — the fanout spec's own worked example,
  // and the percent is the context window spec's formatter, which floors rather than rounds.
  assert.equal(rowFill(48_000, 1_000_000).text, "48k of 1M · 4%");
  assert.equal(rowFill(48_000, 200_000).text, "48k of 200k · 24%");
});

test("a fill that can't be named is said in words, never as 0 — which would be a false claim", () => {
  // The context window spec refuses "0%" for a just-compacted session in the head, for the same reason: an
  // empty-looking gauge is a claim we can't make. The preview must not make it either.
  const compacted = rowFill("compacted", 1_000_000);
  assert.equal(compacted.text, "compacted");
  assert.equal(compacted.step, "");
  assert.equal(compacted.overflows, false, "we don't know that it doesn't fit");
  assert.notEqual(compacted.text, "0 of 1M · 0%");
  // The Add-Members entry's source is not on screen: its fill was never reported, and the
  // summary's tail is not the fork point's fill once the source ran on. Also unknown, also words.
  const unknown = rowFill("unknown", 200_000);
  assert.equal(unknown.text, "unknown");
  assert.equal(unknown.overflows, false);
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

test("a fork bigger than the window overflows, and carries the context window spec's error step", () => {
  const over = rowFill(250_000, 200_000);
  assert.equal(over.overflows, true);
  assert.equal(over.step, "context-error");
  assert.equal(over.text, "250k of 200k");
  // Right at the window is still over: a session that starts full fails on its first turn.
  assert.equal(rowFill(200_000, 200_000).overflows, true);
  // Under it is not, and the warn step is the context window spec's, not a second opinion.
  assert.equal(rowFill(170_000, 200_000).overflows, false);
  assert.equal(rowFill(170_000, 200_000).step, "context-warn");
});

test("the shared-turn line says what every future turn costs, in every mode and unknowable", () => {
  assert.equal(sharedTurnLine(5, 48_000), "5 members × ~48k tokens re-sent every shared turn.");
  assert.equal(
    sharedTurnLine(3, null),
    "3 members, each starting empty. Every shared turn is re-sent 3 times as they grow.",
  );
  // A number we can't name is not ~0 — "~0 tokens re-sent" was the false claim.
  assert.equal(
    sharedTurnLine(5, "compacted"),
    "5 members × unknown tokens re-sent every shared turn — the fork point was compacted.",
  );
  assert.equal(sharedTurnLine(2, "unknown"), "2 members × unknown tokens re-sent every shared turn.");
  assert.equal(
    sharedTurnLine(1, "compacted"),
    "1 member × unknown tokens re-sent every shared turn — the fork point was compacted.",
  );
});

test("a fanout of one agrees in number, in both modes", () => {
  // A row at count 1 is a legal plan, and the copy deck's plural-only copy reads "1 members … 1 times" there.
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

test("the two shapes of `failed` entry say different things, because they are different facts", () => {
  // An empty id is a member that never came into being: "couldn't start". A SET id is a member
  // that exists — created, grouped, in `created` — but was refused its FIRST MESSAGE by the batch
  // path (the fold): "couldn't start" would be false of a session the user can see in the pane,
  // so the line names the message, not the member. The two never collapse together, even at the
  // same ref and reason — merging them would count one broken plan and one fine-but-silent
  // member as two of the same thing.
  const reason = "the provider returned 429.";
  const never = failure("zai/glm-5.3", reason);
  const refused = { id: "s1", path: "/tmp/s1.jsonl", code: "busy" as const, message: reason, ref: "zai/glm-5.3" };
  assert.deepEqual(failureLines([never, refused]), [
    "zai/glm-5.3 couldn't start: the provider returned 429.",
    "zai/glm-5.3 couldn't take the first message: the provider returned 429.",
  ]);
  // Repeats of the exists-shape collapse among themselves, with the count.
  assert.deepEqual(failureLines([refused, { ...refused, id: "s2", path: "/tmp/s2.jsonl" }]), [
    "2 × zai/glm-5.3 couldn't take the first message: the provider returned 429.",
  ]);
  // A pre-existing member of a groupId target reports with id only (its model is not this
  // fanout's to claim): named as "A member", never a guessed ref.
  assert.deepEqual(failureLines([{ id: "old1", path: "/tmp/old1.jsonl", code: "mid-turn", message: "still replying." }]), [
    "A member couldn't take the first message: still replying.",
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
  // assertion. This row is NOT one that deserves to survive: the group ends up carrying Sova's
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
  // announce both as "One more glm-5.3". The copy deck's "Member row" requires the ref for that reason.
  assert.equal(moreLabel("zai/glm-5.3"), "One more zai/glm-5.3");
  assert.notEqual(moreLabel("zai/glm-5.3"), moreLabel("ollama-cloud/glm-5.3"));
  assert.equal(removeLabel("ollama-cloud/glm-5.3"), "Remove ollama-cloud/glm-5.3");
  // At 1 the − button removes the row, so it says so — but NOT in the remove button's words: two
  // controls in one row answering to one name is a duplicate-accessible-name defect, so − names
  // the situation and × keeps the plain "Remove {ref}".
  assert.equal(fewerLabel("zai/glm-5.3", 1), "Remove the only zai/glm-5.3");
  assert.notEqual(fewerLabel("zai/glm-5.3", 1), removeLabel("zai/glm-5.3"));
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

/** A summary with only the facts `sourceBlocked` reads — structural, so the real SessionSummary
 *  (and the `legacyFormat` field the server computes) can stand in for it unchanged. */
const facts = (over: {
  title?: string;
  busy?: boolean;
  live?: { pid: number; status: string } | null;
  legacyFormat?: true;
}) => ({
  title: over.title ?? "Retry with jitter",
  busy: over.busy ?? false,
  live: over.live ?? null,
  ...over,
});

test("the source's blocked reason reads the LIST, so it is reactive and never a snapshot", () => {
  // The states the list can see, in the order they outrank each other: a format that reading
  // would rewrite (waiting clears nothing), then the terminal's claim on the file, then the turn's.
  assert.equal(sourceBlocked(facts({ legacyFormat: true, busy: true })), oldFormatReason("Retry with jitter"));
  assert.equal(sourceBlocked(facts({ legacyFormat: true })), oldFormatReason("Retry with jitter"));
  const tui = { pid: 1, status: "running" };
  assert.equal(sourceBlocked(facts({ live: tui })), sourceBlocked(facts({ live: tui })), "a stable string, re-derived per read");
  assert.ok(sourceBlocked(facts({ live: tui }))!.includes("open in a terminal now"));
  assert.equal(sourceBlocked(facts({ busy: true })), midTurnReason("Retry with jitter"));
  // The MID-TURN sentence is the one the fanout spec promises enables itself; the function's whole job is
  // that re-reading it after the turn ends yields null, which a snapshot could never do.
  assert.equal(sourceBlocked(facts({})), null, "a quiet source blocks nothing");
  // Absence is "can't tell", never "current": legacyFormat absent = no block, even though an
  // older server can't send it — the refusal still names it after the press.
  assert.equal(sourceBlocked(facts({})), null);
});

test("a source refusal keeps the recovery advice the group composer's clause drops", () => {
  const refusal = (code: string, message = "reason") => ({ id: "", path: "", code, message }) as BatchRefusal;
  const stale = sourceRefusal(refusal("stale-leaf"), "Retry with jitter");
  assert.ok(stale.includes("Reopen Fan out to fork from where it is now."), "the advice survives");
  const old = sourceRefusal(refusal("old-format"), "Retry with jitter");
  assert.ok(old.includes("Open it for chat here once to update it, then fan out."));
  // A code this build has no sentence for (a newer server's) shows the server's own reason
  // rather than dropping it — the older client stays honest.
  assert.equal(sourceRefusal(refusal("some-new-code", "the server knows."), "Retry with jitter"),
    "“Retry with jitter” couldn't be forked. the server knows.");
  assert.equal(sourceRefusal(refusal("some-new-code", "  "), "Retry with jitter"), "“Retry with jitter” couldn't be forked.");
});

test("the pre-seeded row is the source's model in fork mode, else the top favorite", () => {
  const m = (ref: string, favorite: boolean): ModelInfo => ({
    ref,
    provider: ref.split("/")[0]!,
    id: ref.split("/")[1]!,
    favorite,
    thinkingLevels: ["off"],
  });
  const list = [m("zai/glm-5.3", true), m("anthropic/claude-opus-5", true), m("ollama-cloud/deepseek-v4.1-flash", false)];
  assert.equal(seedRef(list, true, "zai/glm-5.3"), "zai/glm-5.3", "fork mode: where you are");
  assert.equal(seedRef(list, false, null), "anthropic/claude-opus-5", "fresh: the first favorite, picker's order");
  assert.equal(seedRef(undefined, false, null), null, "nothing loaded yet: no seed, not a guess");
  // No favorites at all (the palette file missing or empty): no seed either — a guessed
  // non-favorite would be a first row the user never chose.
  assert.equal(seedRef([m("zai/glm-5.3", false)], false, null), null);
});
