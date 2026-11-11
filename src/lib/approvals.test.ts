import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTION_DECISION, approveNotice, decideFirstLine, decideAll, holdLine, itemsPhrase, rowActions, stateWord, waitingOf, type Approval } from "./approvals";

const ALL: Approval[] = ["approved", "disallowed", "waiting", "changed"];

test("without asking nothing waits: no notice, no hold, and an undecided row reads Allowed", () => {
  const items = ALL.map((a, i) => ({ kind: "skill" as const, key: `k${i}`, approval: a }));
  assert.deepEqual(waitingOf(items, false), []);
  assert.equal(approveNotice(waitingOf(items, false).length, "project"), null);
  assert.equal(stateWord("waiting", false), "Allowed");
  assert.equal(stateWord("approved", false), "Allowed");
  // The new chat's card asks nothing: only a changed item offers its two buttons.
  for (const a of ALL) assert.deepEqual(rowActions(a, false, "setup"), a === "changed" ? ["reapprove", "disallow"] : []);
});

test("asking: only waiting items wait, and each offers Approve and Disallow", () => {
  const items = ALL.map((a, i) => ({ kind: "context" as const, key: `k${i}`, approval: a }));
  assert.deepEqual(waitingOf(items, true).map((i) => i.approval), ["waiting"]);
  assert.deepEqual(rowActions("waiting", true, "setup"), ["approve", "disallow"]);
  assert.equal(stateWord("waiting", true), "Waiting");
  // A changed item stays loaded: it never counts as waiting.
  assert.equal(waitingOf([{ kind: "skill", key: "a", approval: "changed" }], true).length, 0);
});

test("a card re-allows a disallowed row; without asking that only lifts the Disallow", () => {
  assert.deepEqual(rowActions("disallowed", false, "card"), ["allow"]);
  assert.equal(ACTION_DECISION.allow, "waiting");
  assert.deepEqual(rowActions("disallowed", true, "card"), ["approve"]);
  assert.equal(ACTION_DECISION.approve, "approved");
  // The new chat's card never re-allows: its own switch turns it on for that chat alone.
  assert.deepEqual(rowActions("disallowed", true, "setup"), []);
});

test("the notice and the composer's line count context files and skills together, in digits", () => {
  assert.equal(approveNotice(3, "project"), "3 to approve for this project.");
  assert.equal(approveNotice(1, "adhoc"), "1 to approve for this folder.");
  assert.equal(holdLine(2, 1), "Approve or disallow 2 context files and 1 skill to send.");
  assert.equal(holdLine(0, 3), "Approve or disallow 3 skills to send.");
  assert.equal(itemsPhrase(1, 0), "1 context file");
});

test("Approve All and Disallow All set exactly the given keys, in one change", () => {
  assert.deepEqual(decideAll([{ key: "AGENTS.md" }, { key: "/home/u/.claude/skills/x/SKILL.md" }], "disallowed"), {
    "AGENTS.md": "disallowed",
    "/home/u/.claude/skills/x/SKILL.md": "disallowed",
  });
  assert.deepEqual(decideAll([], "approved"), {});
});

test("a Start that waits says where its message is and how many decide it, in digits", () => {
  assert.equal(decideFirstLine(1), "Its message waits in the composer: decide 1 context file or skill to send it.");
  assert.equal(decideFirstLine(3), "Its message waits in the composer: decide 3 context files and skills to send it.");
});
