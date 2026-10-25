import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExplanationInfo, SessionSummary, TranscriptItem, WorkerStatus } from "../../shared/protocol";
import { inputsPending, knownExplanations, knownInputs, knownOutline, knownWorkers, workersShown } from "./known-before-mount";

const row = (id: string, kind: TranscriptItem["kind"] = "assistant-text"): TranscriptItem => ({ id, kind, text: id }) as TranscriptItem;
const summary = (s: Partial<SessionSummary>): SessionSummary => ({ title: "Untitled", live: null, ...s }) as SessionSummary;
const explanation = (id: string, parentSessionId: string): ExplanationInfo => ({ id, topic: id, summary: "", createdAt: "2026-09-28T00:00:00Z", parentSessionId });

test("the strip shows the list's outline snapshot; a session without one has none", () => {
  assert.deepEqual(knownOutline(summary({ outlineNow: "Fixing the strip", outlineTopics: 3, outlineGist: "Layout shift" })), {
    now: "Fixing the strip",
    topics: 3,
    gist: "Layout shift",
  });
  assert.deepEqual(knownOutline(summary({ outlineNow: "" })), { now: "", topics: 0, gist: "" }, "a snapshot with an empty line is still one");
  assert.equal(knownOutline(summary({})), null, "no snapshot: no strip, no band");
  assert.equal(knownOutline(summary({ outlineTopics: 2 })), null);
});

test("only the session's own explanations", () => {
  const all = [explanation("a", "s1"), explanation("b", "s2"), explanation("c", "s1")];
  assert.deepEqual(knownExplanations(all, "s1").map((x) => x.id), ["a", "c"]);
  assert.deepEqual(knownExplanations(all, "s3"), []);
  assert.deepEqual(knownExplanations(undefined, "s1"), [], "the poll hasn't landed");
});

test("a derived title says the file holds an input, whatever the session is called", () => {
  assert.equal(knownInputs(summary({ title: "Fix the layout" })), true);
  assert.equal(knownInputs(summary({ title: "Untitled" })), false, "a new session: no inputs row held");
  assert.equal(knownInputs(summary({ title: "My name", originalTitle: "Untitled" })), false, "renamed before its first message");
  assert.equal(knownInputs(summary({ title: "Untitled", originalTitle: "Fix the layout" })), true, "renamed to Untitled");
});

test("the settled-workers count is the live record's total, from either field", () => {
  assert.equal(knownWorkers(summary({ workers: { working: 1, total: 4 } })), 4);
  assert.equal(knownWorkers(summary({ live: { pid: 1, status: "x", workers: { working: 0, total: 2 } } })), 2);
  assert.equal(knownWorkers(summary({})), 0);
});

test("the inputs trigger's box is held only while its count is unknown and an input is known", () => {
  assert.equal(inputsPending(null, null, true), true, "the list says there are inputs");
  assert.equal(inputsPending(null, [row("u", "user")], false), true, "an input among the rows on screen");
  assert.equal(inputsPending(null, [row("a")], false), false, "nothing says so: nothing held");
  assert.equal(inputsPending(null, null, false), false);
  assert.equal(inputsPending(3, null, true), false, "known: the trigger itself shows");
  assert.equal(inputsPending(0, [], true), false, "the hello said none (a rewind): the row goes");
});

const listed = (...statuses: WorkerStatus[]) => statuses.map((status) => ({ status }));

test("the trigger's count: the list's until the socket names workers, then the live ones", () => {
  assert.deepEqual(workersShown(false, [], 0, 4), { total: 4, tally: null }, "before any workers message: the list's, no ended note");
  assert.deepEqual(workersShown(true, [], 0, 4), { total: 4, tally: null }, "a runtime still restoring says none: the record's count holds");
  assert.equal(workersShown(true, listed("running", "waiting", "waiting"), 3, 4).total, 3, "once it lists any, the socket's");
  assert.deepEqual(workersShown(true, [], 0, 0), { total: 0, tally: { live: 0, ended: 0, kinds: { stopped: 0, failed: 0, done: 0 } } });
  assert.equal(workersShown(true, listed("running", "starting"), 2, 0).total, 2);
});

test("the socket's count leaves the ended workers out and tallies them", () => {
  const list = listed("running", ...Array<WorkerStatus>(6).fill("waiting"), ...Array<WorkerStatus>(16).fill("killed"), "error", "error");
  const { total, tally } = workersShown(true, list, 25, 25);
  assert.equal(total, 7, "1 running and 6 waiting are live; the list count (25) gives way");
  assert.deepEqual(tally, { live: 7, ended: 18, kinds: { stopped: 16, failed: 2, done: 0 } });
  const allEnded = workersShown(true, listed("killed", "done"), 2, 2);
  assert.deepEqual(allEnded, { total: 0, tally: { live: 0, ended: 2, kinds: { stopped: 1, failed: 0, done: 1 } } }, "a list of only ended workers counts 0 live, not the list's 2");
});
