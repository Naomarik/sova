// Run: npx tsx --test src/lib/insights-teams.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TeamEvent, TeamInfo, TeamMember } from "../../shared/protocol";
import type { AgentsInsight } from "../../shared/protocol";
import { agentsHref, findTeamGroup, insightsRouteFromHash, memberBadges, memberStatus, newestEventLine, orderedMembers, splitTeamEvents, TEAM_EVENTS_SHOWN, teamAnchor, teamFresh, teamHeadingId, teamKey, teamPause, teamPulse } from "./insights";

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

test("D1: two sessions' team_02 get distinct keys, anchors and heading ids; a link finds its own", () => {
  const a = { id: "team_02", parentPath: "/s/--home--/2026-09-25T20-59_a.jsonl" };
  const b = { id: "team_02", parentPath: "/s/--home--/2026-09-24T10-00_b.jsonl" };
  const [ka, kb] = [teamKey(a), teamKey(b)];
  assert.notEqual(ka, kb);
  assert.match(ka, /^team_02\.[0-9a-z]+$/);
  assert.equal(teamKey({ ...a }), ka, "stable for the same session");
  assert.notEqual(teamAnchor(ka), teamAnchor(kb));
  assert.notEqual(teamHeadingId(ka), teamHeadingId(kb));
  // The deep link round-trips through the hash to the same key.
  const route = insightsRouteFromHash(agentsHref(kb));
  assert.deepEqual(route, { page: "agents", team: kb });
  // A fake document with both groups, newest first as rendered.
  const els = [{ id: teamAnchor(ka) }, { id: teamAnchor(kb) }, { id: teamAnchor(teamKey({ id: "team_20", parentPath: a.parentPath })) }] as HTMLElement[];
  const doc = {
    getElementById: (id: string) => els.find((e) => e.id === id) ?? null,
    querySelectorAll: (sel: string) => { assert.equal(sel, ".team-group"); return els; },
  } as unknown as Document;
  assert.equal(findTeamGroup(doc, kb), els[1]);
  assert.equal(findTeamGroup(doc, ka), els[0]);
  assert.equal(findTeamGroup(doc, "team_02"), els[0], "an older bare-id link: the newest team with that id");
  assert.equal(findTeamGroup(doc, "team_2"), null, "a prefix of another id is not a match");
  assert.equal(findTeamGroup(doc, "team_02.zzz"), null, "an unknown key never falls back");
});

test("D1: teamFresh matches the team's own session, not another session's team with the same id", () => {
  const team = (parentPath: string) => ({ id: "team_02", parentPath }) as TeamInfo;
  const insight = (fresh: boolean, path: string) => ({ fresh, teams: [team(path)] });
  const a = { sessions: [insight(true, "/new.jsonl"), insight(false, "/old.jsonl")] } as unknown as AgentsInsight;
  assert.equal(teamFresh(a, team("/new.jsonl")), true);
  assert.equal(teamFresh(a, team("/old.jsonl")), false);
});

test("D2: a session's team pulse changes with a pause event or a working count, not with a refetch or another session", () => {
  const team = (parentPath: string, working: number, events: TeamEvent[] = []) => ({ id: "team_02", parentPath, working, events }) as unknown as TeamInfo;
  const insight = (...teams: TeamInfo[]) => ({ sessions: teams.map((t) => ({ fresh: true, teams: [t] })) }) as unknown as AgentsInsight;
  const before = teamPulse(insight(team("/a.jsonl", 2, [ev("e1", "handover")]), team("/b.jsonl", 0)), "/a.jsonl");
  assert.equal(teamPulse(insight(team("/a.jsonl", 2, [ev("e1", "handover")])), "/a.jsonl"), before, "the same data refetched: unchanged");
  assert.notEqual(teamPulse(insight(team("/a.jsonl", 2, [ev("e1", "handover"), ev("e2", "pause")])), "/a.jsonl"), before, "a pause");
  assert.notEqual(teamPulse(insight(team("/a.jsonl", 1, [ev("e1", "handover")])), "/a.jsonl"), before, "a working count");
  assert.equal(teamPulse(insight(team("/a.jsonl", 2, [ev("e1", "handover")]), team("/b.jsonl", 3, [ev("x", "pause")])), "/a.jsonl"), before, "another session's team_02");
  assert.equal(teamPulse(insight(team("/b.jsonl", 0)), "/a.jsonl"), null);
  assert.equal(teamPulse(undefined, "/a.jsonl"), null);
});
