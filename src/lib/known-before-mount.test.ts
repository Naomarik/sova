import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentsInsight, ExplanationInfo, SessionSummary, TeamInfo, TranscriptItem } from "../../shared/protocol";
import { busiestLiveTeam, headTeam, inputsPending, knownAgents, knownExplanations, knownInputs, knownOutline, knownWorkers, workersShown } from "./known-before-mount";

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
  assert.equal(knownWorkers(summary({ restoredWorkers: 15 })), 15, "no runtime hosts it: what its records restore");
  assert.equal(knownWorkers(summary({ restoredWorkers: 15, workers: { working: 0, total: 3 } })), 3, "a live record's count wins");
  assert.equal(knownWorkers(summary({ restoredWorkers: 15, workers: { working: 0, total: 0 } })), 15, "a runtime just started, still restoring");
});

test("the inputs trigger's box is held only while its count is unknown and an input is known", () => {
  assert.equal(inputsPending(null, null, true), true, "the list says there are inputs");
  assert.equal(inputsPending(null, [row("u", "user")], false), true, "an input among the rows on screen");
  assert.equal(inputsPending(null, [row("a")], false), false, "nothing says so: nothing held");
  assert.equal(inputsPending(null, null, false), false);
  assert.equal(inputsPending(3, null, true), false, "known: the trigger itself shows");
  assert.equal(inputsPending(0, [], true), false, "the hello said none (a rewind): the row goes");
});

const teamInfo = (id: string, t: Partial<TeamInfo> = {}): TeamInfo =>
  ({ id, name: id, objective: "", createdAt: 1, parentPath: "/p", live: false, members: [], working: 0, ...t }) as TeamInfo;
const member = (workerId: string) => ({ workerId }) as TeamInfo["members"][number];

test("the head's team chip: the list's until the insight loads, then the insight's; none when known to have none", () => {
  const known = { name: "Explain UX", members: 3, paused: "lead paused the team." };
  assert.deepEqual(headTeam(undefined, known), { name: "Explain UX", members: 3, paused: "lead paused the team." });
  assert.deepEqual(headTeam(undefined, { name: "Solo", members: 1 }), { name: "Solo", members: 1, paused: null });
  assert.equal(headTeam(undefined, undefined), null, "a session the list knows has no team: no chip, no space");
  // The insight's first team, and its pause rule (the newest pause/resume decides).
  const pause = { id: "e1", teamId: "a", kind: "pause", workerId: "ag_01", role: "lead", at: "", text: "lead paused the team." } as const;
  const resume = { ...pause, id: "e2", kind: "resume", text: "lead resumed the team." } as const;
  const teams = [teamInfo("a", { name: "Explain UX", members: [member("ag_01"), member("ag_02"), member("ag_03")], events: [pause] }), teamInfo("b")];
  assert.deepEqual(headTeam(teams, undefined), known, "the same chip from either source");
  assert.equal(headTeam([teamInfo("a", { events: [pause, resume] })], known)?.paused, null);
  assert.equal(headTeam([], known), null, "the insight's word wins: no team now");
});

test("the #/agents poll's teams are the session's own, and the busiest live one leads", () => {
  const feed = { sessions: [{ path: "/a", teams: [teamInfo("x")] }, { path: "/b", teams: [] }] } as unknown as AgentsInsight;
  assert.equal(knownAgents(feed, "/a")?.teams[0]?.id, "x");
  assert.equal(knownAgents(feed, "/c"), undefined, "not running: the poll says nothing");
  assert.equal(knownAgents(undefined, "/a"), undefined);
  const teams = [teamInfo("a", { live: true, working: 1 }), teamInfo("b", { live: true, working: 3 }), teamInfo("c", { working: 9 })];
  assert.equal(busiestLiveTeam(teams)?.id, "b");
  assert.equal(busiestLiveTeam([teamInfo("c", { working: 9 })]), null);
  assert.equal(busiestLiveTeam(undefined), null);
});

test("the settled-workers count: the list's until the socket names workers", () => {
  assert.equal(workersShown(false, 0, 4), 4, "before any workers message");
  assert.equal(workersShown(true, 0, 4), 4, "a runtime still restoring says none: the file's count holds");
  assert.equal(workersShown(true, 3, 4), 3, "once it lists any, the socket's");
  assert.equal(workersShown(true, 0, 0), 0);
  assert.equal(workersShown(true, 2, 0), 2);
});
