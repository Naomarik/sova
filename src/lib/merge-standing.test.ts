// A standing approval and a decision as every screen draws them (al_3): one vocabulary for the chat's card, the
// Worktrees rows, the Merge Queue tab and the landing bar.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MergeDecision, MergeEntry } from "../../shared/merge-queue";
import { sendFrame } from "./send-frame";
import { needsYouOf, queueRow, rowButtons, withItsChat, type QueueRowInput } from "./merge-queue";
import { answeredInChat, answerWords, decisionActions, decisionWords, heldComposerLine, HELD_NOTE_LINE, openDecision, STANDING_LINE, standingLine, standingWords } from "./merge-standing";

const SHA = "c".repeat(40);
const decision = (x: Partial<MergeDecision> = {}): MergeDecision => ({
  id: "dc_1",
  kind: "needs-you",
  question: "Should the Save button stay at the top?",
  choices: ["Keep it at the top", "Move it to the bottom"],
  heldNote: { request: "rq_000000000001", text: "Place the Save button as the user says, then answer Fixed." },
  raisedBy: "chat",
  actions: [],
  at: "2026-11-07T12:00:00Z",
  ...x,
});

test("in place: the card's words for each phase of a standing approval", () => {
  assert.equal(standingLine({ state: "with-chat", standing: { phase: "with-chat", try: 2, of: 3, why: "Unit tests failed" } }), "Back with the chat · try 2 of 3 · Unit tests failed");
  assert.equal(standingLine({ state: "with-chat", standing: { phase: "with-chat", try: 2, of: 3, why: "Unit tests failed", checked: true } }), "Back with the chat · Fix checked · back in line");
  assert.equal(standingLine({ state: "with-chat", standing: { phase: "waiting-thread" } }), "Waiting for the merge thread");
  assert.equal(standingLine({ state: "with-chat", standing: { phase: "paused" } }), "Paused: you stopped the chat");
  assert.equal(standingLine({ state: "with-chat", standing: { phase: "waiting-fix", why: "Conflicts with master" } }), "Approved · waiting for a fix · Conflicts with master");
  assert.equal(standingLine({ state: "queued" }), null, "in line: its plain state");
  assert.equal(standingWords({ state: "with-chat" })?.label, "Back with the chat", "no phase yet: never blank");
});

test("the chat's answer in one line", () => {
  assert.equal(answerWords({ kind: "fixed", changed: "commit", commit: SHA, summary: "x", at: "" }), "Fixed: commit ccccccc");
  assert.equal(answerWords({ kind: "fixed", changed: "drafts", summary: "x", at: "" }), "Fixed: drafts");
  assert.equal(answerWords({ kind: "fixed", changed: "both", commit: SHA, summary: "x", at: "" }), "Fixed: commit ccccccc and drafts");
  assert.equal(answerWords({ kind: "cant", why: "the test needs a network", at: "" }), "Can't: the test needs a network");
  assert.equal(answerWords({ kind: "needs-you", question: "Which label?", options: [], at: "" }), "Needs you: Which label?");
  assert.equal(standingWords({ state: "with-chat", standing: { phase: "waiting-thread", answer: { kind: "fixed", changed: "commit", commit: SHA, summary: "", at: "" } } })?.answer, "Fixed: commit ccccccc");
});

test("a decision: its words, its answers on the queue (Remove from Queue last, once), and the held note's marks", () => {
  const d = decision();
  assert.deepEqual(decisionWords({ decision: d }), { label: "Needs you", tone: "warn", question: d.question, cantSettle: false });
  assert.deepEqual(decisionActions(d), ["remove"]);
  assert.deepEqual(decisionActions(decision({ kind: "unattributed", actions: ["remove", "land-anyway", "try-again", "land-anyway"] })), ["land-anyway", "try-again", "remove"]);
  assert.equal(answeredInChat(d), true);
  assert.equal(answeredInChat(decision({ kind: "out-of-tries", choices: [], heldNote: undefined, actions: ["land"] })), false, "out of tries: answered by Land or Remove, not in words");
  assert.equal(HELD_NOTE_LINE, "Not sent yet: your answer goes with it");
  assert.equal(heldComposerLine("feat/x"), "Merge queue · feat/x · not sent yet: your answer goes with it");
  assert.equal(openDecision({ decision: decision({ answered: { at: "", how: "message" } }) }), null, "answered: no longer waits");
  assert.equal(decisionWords({ decision: decision({ cantSettle: true }) })?.cantSettle, true);
});

const wt = (queue: Record<string, unknown>): QueueRowInput => ({ status: "active", exists: true, branch: "feat/x", readiness: undefined, mergeServed: true, queue: { id: "me_1", commit: SHA, notes: [], project: "prj_1", ...queue } as never });

test("a Worktrees row with its chat: the card's words, the standing line, and only Remove from Queue", () => {
  const r = queueRow(wt({ state: "with-chat", standing: { phase: "with-chat", try: 2, of: 3, why: "Unit tests failed", answer: { kind: "cant", why: "needs a network", at: "" } } }));
  assert.equal(r.key, "with-chat");
  assert.equal(r.label, "Back with the chat");
  assert.equal(r.detail, "try 2 of 3 · Unit tests failed");
  assert.equal(r.answer, "Can't: needs a network");
  assert.equal(r.reason, STANDING_LINE);
  assert.deepEqual(rowButtons(r, "prj_1"), ["Remove from Queue"]);
});

test("a Worktrees row a decision holds: its kind, its question, its answers, Answer in Chat, Remove from Queue; no text box anywhere", () => {
  const r = queueRow(wt({ state: "needs-user", decision: decision() }));
  assert.equal(r.key, "needs-you");
  assert.equal(r.label, "Needs you");
  assert.equal(r.reason, "Should the Save button stay at the top?");
  assert.deepEqual(rowButtons(r, "prj_1"), ["Answer in Chat", "Remove from Queue"]);
  const out = queueRow(wt({ state: "needs-fix", decision: decision({ kind: "out-of-tries", question: "Tried 3 times: Unit tests failed each time", choices: [], heldNote: undefined, actions: ["land"] }) }));
  assert.equal(out.label, "Out of tries");
  assert.deepEqual(rowButtons(out, "prj_1"), ["Land", "Remove from Queue"]);
  const master = queueRow(wt({ state: "needs-user", decision: decision({ kind: "unattributed", choices: [], heldNote: undefined, actions: ["land-anyway", "try-again"] }) }));
  assert.equal(master.key, "unattributed");
  assert.deepEqual(rowButtons(master, "prj_1"), ["Land Anyway", "Try Again", "Remove from Queue"]);
  const cant = queueRow(wt({ state: "needs-user", decision: decision({ cantSettle: true }) }));
  assert.equal(cant.reason, "Should the Save button stay at the top? · can't be settled without you");
});

test("the tab's sections: a decision is in Needs you once, wherever the view lists it; With its chat holds the rest", () => {
  const e = (id: string, x: Partial<MergeEntry>) => ({ id, branch: id, commit: SHA, state: "with-chat", notes: [], ...x }) as MergeEntry;
  const fixing = e("a", { standing: { phase: "with-chat", try: 1, of: 3, why: "x" } });
  const deciding = e("b", { state: "needs-fix", decision: decision() });
  const old = e("c", { state: "needs-fix" });
  const v = { needsYou: [e("d", { state: "behaviour-differs" })], needsFix: [deciding, old], waiting: [], ready: [], withChat: [fixing, deciding] };
  assert.deepEqual(needsYouOf(v).map((x) => x.id), ["d", "b"]);
  assert.deepEqual(withItsChat(v).map((x) => x.id), ["a", "c"]);
});

test("a typed message names the decision whose held note goes with it; nothing else ever does", () => {
  assert.deepEqual(sendFrame("Move it", "c1", { typed: true, decision: "dc_1" }), { type: "steer", text: "Move it", clientId: "c1", decision: "dc_1" });
  assert.deepEqual(sendFrame("Move it", "c1", { typed: true }), { type: "steer", text: "Move it", clientId: "c1" });
  assert.deepEqual(sendFrame("Run the playbook", "c2", { typed: false, decision: "dc_1" }), { type: "prompt", text: "Run the playbook", clientId: "c2" }, "a playbook or a click is never the answer");
});
