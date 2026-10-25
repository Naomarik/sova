// Run: pnpm test -- src/lib/team-inbox.test.ts
// The words a team member's inbox says (§app.subagents-pane/member-inbox). The reader behind the
// tab is held by team-inbox.browser.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyInboxText, fromWord, inboxSummary, inboxTabLabel, kindWord, movedWord, openChip, openChipTitle, statusChip } from "./team-inbox";

test("each kind has its word; an unknown one reads Message", () => {
  assert.deepEqual(["message", "question", "report", "handover", "notice", "instruction"].map(kindWord), ["Message", "Question", "Report", "Handover", "Notice", "Instruction"]);
  assert.equal(kindWord("later-kind"), "Message");
});

test("the sender reads from its role, the main thread and Sova by name", () => {
  assert.equal(fromWord({ from: { role: "builder", workerId: "ag_03" } }), "from builder");
  assert.equal(fromWord({ from: { role: "main thread", workerId: "parent" } }), "from main thread");
  assert.equal(fromWord({ from: { role: "Sova", workerId: "parent" } }), "from Sova");
});

test("status chips carry a word each; returned wins over the status it had", () => {
  assert.deepEqual(statusChip({ status: "new" }), { word: "New", tone: "info" });
  assert.deepEqual(statusChip({ status: "read" }), { word: "Read", tone: "plain" });
  assert.deepEqual(statusChip({ status: "addressed" }), { word: "Addressed", tone: "success" });
  assert.deepEqual(statusChip({ status: "addressed", closedBy: "member" }), { word: "Addressed", tone: "success" });
  assert.deepEqual(statusChip({ status: "addressed", closedBy: "reply" }), { word: "Addressed", tone: "success" });
  assert.deepEqual(statusChip({ status: "addressed", closedBy: "auto" }), { word: "Closed automatically", tone: "plain" });
  assert.deepEqual(statusChip({ status: "read", returned: { at: 1, why: "stopped" } }), { word: "Returned to sender", tone: "plain" });
});

test("a moved item says whom it was first sent to; one sent here says nothing", () => {
  const m = (role: string, workerId: string) => ({ role, workerId, at: 1, why: "handover" as const });
  assert.equal(movedWord({ movedFrom: [m("writer", "ag_02"), m("writer-2", "ag_05")] }), "Moved from writer");
  assert.equal(movedWord({}), null);
  assert.equal(movedWord({ movedFrom: [] }), null);
});

test("the row's chip and the tab's label show open items only, none at 0", () => {
  assert.equal(openChip({ open: 3, urgent: 1, total: 9 }), "3 open");
  assert.equal(openChip({ open: 0, urgent: 0, total: 9 }), null);
  assert.equal(openChip(undefined), null);
  assert.equal(openChipTitle(1), "1 open item in its inbox");
  assert.equal(openChipTitle(3), "3 open items in its inbox");
  assert.equal(inboxTabLabel({ open: 3, urgent: 0, total: 3 }), "Inbox · 3 open");
  assert.equal(inboxTabLabel({ open: 0, urgent: 0, total: 3 }), "Inbox");
  assert.equal(inboxTabLabel(undefined), "Inbox");
  assert.equal(emptyInboxText("builder"), "0 items in builder's inbox.");
});

test("the summary line counts open, closed by the member and closed automatically, a part at 0 left out", () => {
  const c = (open: number, m?: number, a?: number) => ({ open, urgent: 0, total: 99, ...(m === undefined ? {} : { closedByMember: m }), ...(a === undefined ? {} : { closedAutomatically: a }) });
  assert.equal(inboxSummary(c(2, 5, 3), "builder"), "2 open · 5 closed by builder · 3 closed automatically");
  assert.equal(inboxSummary(c(0, 5, 3), "builder"), "5 closed by builder · 3 closed automatically");
  assert.equal(inboxSummary(c(2, 0, 3), "builder"), "2 open · 3 closed automatically");
  assert.equal(inboxSummary(c(2, 5, 0), "builder"), "2 open · 5 closed by builder");
  assert.equal(inboxSummary(c(0, 0, 0), "builder"), null, "nothing to count");
  assert.equal(inboxSummary(c(2), "builder"), null, "an older server sends no split: no line");
  assert.equal(inboxSummary(undefined, "builder"), null);
});
