// Run: npx tsx --test src/lib/insights-teams.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TeamEvent, TeamInfo, TeamMember } from "../../shared/protocol";
import { memberBadges, memberStatus, newestEventLine, orderedMembers, splitTeamEvents, TEAM_EVENTS_SHOWN, teamPause } from "./insights";

const m = (workerId: string, role: string, extra: Partial<TeamMember> = {}): TeamMember =>
  ({ workerId, role, orchestrator: false, backend: "pi", ownedPaths: [], addedAt: 0, worker: null, ...extra });
const ev = (id: string, kind: TeamEvent["kind"], at = "2026-09-25T19:04:23.971Z"): TeamEvent =>
  ({ id, teamId: "team_01", kind, workerId: "ag_05", role: "monitor-2", at, text: `${kind} ${id}` });

const members = [
  m("ag_02", "writer", { retired: { at: "2026-09-25T19:04:00.000Z", reason: "confirmed" } }),
  m("ag_03", "monitor", { duty: "monitor" }),
  m("ag_04", "writer-2", { successorOf: "ag_02" }),
  m("ag_01", "coordinator", { orchestrator: true, duty: "coordinator" }),
  m("ag_06", "tester"),
];

test("order: coordinator, working members in roster order, monitor, retired last", () => {
  assert.deepEqual(orderedMembers({ members }).map((x) => x.workerId), ["ag_01", "ag_04", "ag_06", "ag_03", "ag_02"]);
  // An uncoordinated team keeps today's rule: the orchestrator first.
  assert.deepEqual(orderedMembers({ members: [m("ag_01", "a"), m("ag_02", "lead", { orchestrator: true })] }).map((x) => x.workerId), ["ag_02", "ag_01"]);
});

test("badges: Coordinator replaces Orchestrator; Monitor; Succeeds names the predecessor's role", () => {
  const team = { members };
  assert.deepEqual(memberBadges(members[3]!, team).map((b) => b.label), ["Coordinator"]);
  assert.deepEqual(memberBadges(members[1]!, team).map((b) => b.label), ["Monitor"]);
  assert.deepEqual(memberBadges(members[2]!, team).map((b) => b.label), ["Succeeds writer"]);
  assert.deepEqual(memberBadges(m("ag_09", "x", { successorOf: "ag_77" }), team).map((b) => b.label), ["Succeeds ag_77"], "unknown predecessor: its id");
  assert.deepEqual(memberBadges(m("ag_09", "x", { orchestrator: true }), team).map((b) => b.label), ["Orchestrator"]);
  assert.deepEqual(memberBadges(members[4]!, team), []);
});

test("status: Retired as of the retirement, over any worker state; lost reads Interrupted", () => {
  const retired = memberStatus({ ...members[0]!, worker: { id: "ag_02", name: "writer", status: "running", working: true } }, true);
  assert.equal(retired.text, "Retired");
  assert.equal(retired.live, false);
  assert.equal(retired.asOf, Date.parse("2026-09-25T19:04:00.000Z"));
  const done = memberStatus(m("ag_02", "writer", { lastReport: { status: "done", outcome: "success", at: "2026-09-25T19:04:00.000Z" } }), true);
  assert.equal(done.text, "Done");
  assert.equal(done.tone, "success");
  assert.equal(memberStatus(m("ag_02", "w", { lastReport: { status: "interrupted", at: "2026-09-25T19:04:00.000Z" } }), true).text, "Interrupted");
});

test("paused: the newest pause/resume decides; other kinds don't", () => {
  const team = (...events: TeamEvent[]): Pick<TeamInfo, "events"> => ({ events });
  assert.equal(teamPause({}), null);
  assert.equal(teamPause(team(ev("1", "pause"), ev("2", "handover")))?.id, "1");
  assert.equal(teamPause(team(ev("1", "pause"), ev("2", "resume"), ev("3", "wrap-up"))), null);
  assert.equal(teamPause(team(ev("1", "resume"), ev("2", "pause")))?.id, "2");
});

test("events: the newest 20 listed oldest first, the rest folded as earlier; the newest as a caption", () => {
  const events = Array.from({ length: 23 }, (_, i) => ev(String(i), "wrap-up"));
  const { earlier, recent } = splitTeamEvents({ events });
  assert.equal(recent.length, TEAM_EVENTS_SHOWN);
  assert.deepEqual(earlier.map((e) => e.id), ["0", "1", "2"]);
  assert.equal(recent[0]!.id, "3");
  assert.equal(recent[19]!.id, "22");
  assert.deepEqual(splitTeamEvents({ events: events.slice(0, 2) }).earlier, []);
  assert.equal(newestEventLine({ events })?.text, "wrap-up 22");
  assert.equal(newestEventLine({}), null);
});
