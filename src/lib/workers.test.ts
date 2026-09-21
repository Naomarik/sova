// Run: npx tsx --test src/lib/workers.test.ts (or npm test)
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activeAgentCounts,
  activeTeamCount,
  capTitle,
  formatCost,
  isHostSession,
  sessionWorking,
  showSubagentsLabel,
  sortWorkers,
  sourceKey,
  sourceName,
  sourceOf,
  showWorkersLabel,
  subagentsWorkingLabel,
  teamNote,
  transcriptUsage,
  usageHeadline,
  usageTitle,
  usageTotal,
  workerLabel,
  workersNoun,
  workersWorkingLabel,
  workerTeam,
  workerUsage,
  workingChipTitle,
  workingSplit,
} from "./workers";

const live = (working: number) => ({ pid: 1, status: "idle", workers: { working, total: working + 1 } });

test("sessionWorking: top-level workers first, then live.workers (older servers), else 0", () => {
  assert.equal(sessionWorking({ live: null, workers: { working: 2, total: 3 } }), 2); // web session
  assert.equal(sessionWorking({ live: live(1), workers: { working: 1, total: 2 } }), 1); // TUI, new server
  assert.equal(sessionWorking({ live: live(4) }), 4); // TUI, older server
  assert.equal(sessionWorking({ live: null, workers: { working: 0, total: 5 } }), 0);
  assert.equal(sessionWorking({ live: { pid: 1, status: "idle" } }), 0);
  assert.equal(sessionWorking({ live: null }), 0);
});

test("subagentsWorkingLabel pluralizes", () => {
  assert.equal(subagentsWorkingLabel(1), "1 subagent working…");
  assert.equal(subagentsWorkingLabel(2), "2 subagents working…");
});

test("isHostSession hides only headless worker pis", () => {
  assert.equal(isHostSession({ mode: "tui" }), true);
  assert.equal(isHostSession({ mode: null }), true);
  assert.equal(isHostSession({ mode: "rpc" }), false);
  assert.equal(isHostSession({ mode: "rpc", embedded: false }), false);
  assert.equal(isHostSession({ mode: "rpc", embedded: true }), true);
});

/** A live record, counted only for `fresh` host sessions. Unlisted statuses are 0. */
const session = (
  fresh: boolean,
  counts: Partial<{ working: number; waiting: number; done: number; error: number; killed: number }>,
  mode: string | null = "tui",
  embedded?: boolean,
  teams: unknown[] = [],
) => ({
  mode,
  embedded,
  fresh,
  workerCounts: { total: 0, working: 0, waiting: 0, done: 0, error: 0, killed: 0, ...counts },
  workers: [], // shorter than the counts: activeAgentCounts must never read it
  teams,
});
const insight = (...sessions: ReturnType<typeof session>[]) =>
  ({ at: 0, totals: { sessions: 0, working: 0, total: 0, teams: 0, teamWorking: 0, soloWorking: 0 }, sessions }) as never;

test("activeAgentCounts: nothing live without an insight", () => {
  assert.deepEqual(activeAgentCounts(undefined), { agents: 0, sessions: 0 });
  assert.deepEqual(activeAgentCounts(insight()), { agents: 0, sessions: 0 });
});

test("activeAgentCounts counts only workers actually working", () => {
  assert.deepEqual(activeAgentCounts(insight(session(true, { working: 1, waiting: 2 }))), { agents: 1, sessions: 1 });
});

test("activeAgentCounts leaves out idle waiting workers and the sessions holding only them", () => {
  assert.deepEqual(activeAgentCounts(insight(session(true, { waiting: 3 }))), { agents: 0, sessions: 0 });
  assert.deepEqual(activeAgentCounts(insight(session(true, { working: 2, waiting: 9 }))), { agents: 2, sessions: 1 });
});

test("activeAgentCounts ignores a session whose heartbeat went stale", () => {
  assert.deepEqual(activeAgentCounts(insight(session(false, { working: 2, waiting: 1 }))), { agents: 0, sessions: 0 });
});

test("activeAgentCounts ignores headless worker pis, counts embedded rpc sessions", () => {
  assert.deepEqual(activeAgentCounts(insight(session(true, { working: 2 }, "rpc"))), { agents: 0, sessions: 0 });
  assert.deepEqual(activeAgentCounts(insight(session(true, { working: 2 }, "rpc", false))), { agents: 0, sessions: 0 });
  assert.deepEqual(activeAgentCounts(insight(session(true, { working: 2 }, "rpc", true))), { agents: 2, sessions: 1 });
});

test("activeAgentCounts never counts settled workers", () => {
  assert.deepEqual(activeAgentCounts(insight(session(true, { done: 4, error: 2, killed: 1 }))), { agents: 0, sessions: 0 });
  assert.deepEqual(activeAgentCounts(insight(session(true, { working: 1, done: 4, error: 2, killed: 1 }))), { agents: 1, sessions: 1 });
});

test("activeAgentCounts: only sessions holding an active agent count as sessions", () => {
  const live = insight(session(true, { working: 2, waiting: 1 }), session(true, { done: 3 }));
  assert.deepEqual(activeAgentCounts(live), { agents: 2, sessions: 1 });
  const both = insight(session(true, { working: 2, waiting: 1 }), session(true, { working: 2, waiting: 1, done: 3 }));
  assert.deepEqual(activeAgentCounts(both), { agents: 4, sessions: 2 });
});

/** A live record whose session claims one team. */
const teamSession = (fresh: boolean, working: number, mode: string | null = "tui", embedded?: boolean) =>
  session(fresh, { working }, mode, embedded, [
    { id: "team_01", name: "t", objective: "", createdAt: 0, parentPath: null, live: true, members: [], working },
  ]);

test("activeTeamCount counts only teams with a member still working", () => {
  assert.equal(activeTeamCount(insight(teamSession(true, 2))), 1);
  assert.equal(activeTeamCount(insight(teamSession(true, 0))), 0);
  assert.equal(activeTeamCount(insight(teamSession(true, 0), teamSession(true, 1))), 1);
});

test("activeTeamCount ignores stale sessions and headless worker pis", () => {
  assert.equal(activeTeamCount(insight(teamSession(false, 1))), 0);
  assert.equal(activeTeamCount(insight(teamSession(true, 1, "rpc"))), 0);
  assert.equal(activeTeamCount(insight(teamSession(true, 1, "rpc", true))), 1);
  assert.equal(activeTeamCount(undefined), 0);
});

test("sortWorkers: working first, then newest activity (else start) first", () => {
  const ws = [
    { id: "a", working: false, lastActivity: 50 },
    { id: "b", working: true, startedAt: 10 },
    { id: "c", working: false, startedAt: 90 },
    { id: "d", working: true, lastActivity: 40, startedAt: 5 },
    { id: "e", working: false },
  ];
  assert.deepEqual(sortWorkers(ws).map((w) => w.id), ["d", "b", "c", "a", "e"]);
  assert.equal(ws[0]!.id, "a"); // input untouched
});

test("workerLabel: team role by workerId, else the worker's name", () => {
  const teams = [{ members: [{ workerId: "ag_02", role: "ui" }] }, { members: [{ workerId: "ag_05", role: "" }] }];
  assert.equal(workerLabel({ id: "ag_02", name: "worker-2" }, teams as never), "ui");
  assert.equal(workerLabel({ id: "ag_05", name: "worker-5" }, teams as never), "worker-5");
  assert.equal(workerLabel({ id: "ag_09", name: "scout" }, teams as never), "scout");
  assert.equal(workerLabel({ id: "ag_09", name: "scout" }, undefined), "scout");
});

test("showSubagentsLabel names the count", () => {
  assert.equal(showSubagentsLabel(1), "1 subagent working — show subagents");
  assert.equal(showSubagentsLabel(3), "3 subagents working — show subagents");
});

test("sourceKey: the pi session file wins, then a claude-code session id, else nothing to read", () => {
  const cc = "d1f6627b-15a8-4c51-8712-a7b1a869469b";
  assert.equal(sourceKey({ sessionFile: "/home/x/.pi/agent/sessions/a/b.jsonl" }), "/home/x/.pi/agent/sessions/a/b.jsonl");
  assert.equal(sourceKey({ backend: "claude-code", sessionId: cc }), `claude:${cc}`);
  assert.equal(sourceKey({ sessionFile: "/p/a.jsonl", backend: "claude-code", sessionId: cc }), "/p/a.jsonl");
  assert.equal(sourceKey({ backend: "claude-code" }), undefined); // still starting: no session yet
  assert.equal(sourceKey({ backend: "pi", sessionId: cc }), undefined); // a pi id isn't a CC session
  assert.equal(sourceKey({}), undefined);
});

test("sourceOf reads a key back, sourceName describes it", () => {
  assert.deepEqual(sourceOf("/p/a.jsonl"), { kind: "pi", path: "/p/a.jsonl" });
  assert.deepEqual(sourceOf("claude:abc"), { kind: "claude", sessionId: "abc" });
  assert.equal(sourceName(sourceOf("/p/a.jsonl")), "/p/a.jsonl");
  assert.equal(sourceName(sourceOf("claude:abc")), "Claude session abc");
});

test("usage accessors read counts off whatever the server sent, or nothing", () => {
  const usage = { input: 1200, output: 340, cacheRead: 98_000, cacheWrite: 4500, cost: 0.41 };
  assert.deepEqual(workerUsage({ id: "ag_01", usage }), usage);
  assert.equal(workerUsage({ id: "ag_01" }), null, "an older pi-config publishes none");
  assert.equal(workerUsage({ id: "ag_01", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }), null,
    "a worker that spent nothing shows nothing");
  assert.equal(workerUsage(null), null);
  // Garbage counts as 0, and a cost of 0 is dropped rather than shown as free.
  assert.deepEqual(workerUsage({ usage: { input: "12", output: -4, cacheRead: 5, cacheWrite: Number.NaN, cost: 0 } }),
    { input: 0, output: 0, cacheRead: 5, cacheWrite: 0 });
  assert.deepEqual(transcriptUsage({ type: "append", items: [], usage }), usage);
  assert.equal(transcriptUsage({ type: "append", items: [] }), null);
  // The Σ keeps its head count, which is a lifetime number and may exceed the list.
  assert.deepEqual(usageTotal({ workers: [], usageTotal: { ...usage, workers: 57 } }), { ...usage, workers: 57 });
  assert.equal(usageTotal({ workers: [], usageTotal: { ...usage, workers: -1 } })!.workers, 0);
  assert.equal(usageTotal({ workers: [] }), null);
  assert.equal(usageTotal(undefined), null);
});

test("usage headline is input + output; the title carries the split, the cost and the head count", () => {
  const usage = { input: 1200, output: 340, cacheRead: 98_000, cacheWrite: 4500, cost: 0.41 };
  assert.equal(usageHeadline(usage), 1540);
  assert.equal(usageTitle(usage), "1.2k in · 340 out · 98k cache read · 4.5k cache write · $0.41");
  assert.equal(usageTitle({ ...usage, cost: undefined }), "1.2k in · 340 out · 98k cache read · 4.5k cache write",
    "no cost line when the backend reports none");
  assert.equal(usageTitle(usage, 57).startsWith("57 subagents so far · "), true);
  assert.equal(usageTitle(usage, 1).startsWith("1 subagent so far · "), true);
  assert.equal(formatCost(0.004), "<$0.01");
  assert.equal(formatCost(0), null);
  assert.equal(formatCost(undefined), null);
});

const team = (name: string, ...ids: string[]) => ({ id: `t_${name}`, name, members: ids.map((workerId) => ({ workerId, role: workerId })) });
const w = (id: string, working: boolean, teamId?: string) => ({ id, working, teamId });

test("workingSplit: team members and plain subagents counted apart, one team named", () => {
  const teams = [team("Explain UX", "ag_01", "ag_02")] as never;
  assert.deepEqual(workingSplit(2, [w("ag_01", true), w("ag_02", true), w("ag_09", false)], teams), { members: 2, subagents: 0, team: "Explain UX" });
  assert.deepEqual(workingSplit(2, [w("ag_01", true), w("ag_09", true)], teams), { members: 1, subagents: 1, team: "Explain UX" });
  assert.deepEqual(workingSplit(1, [w("ag_09", true), w("ag_01", false)], teams), { members: 0, subagents: 1 });
  // A worker naming a team the list doesn't carry is still a member, just an unnamed one.
  assert.deepEqual(workingSplit(1, [w("ag_77", true, "t_other")], teams), { members: 1, subagents: 0 });
  // Two teams working: no single name to show.
  const two = [team("Explain UX", "ag_01"), team("Runtime", "ag_02")] as never;
  assert.deepEqual(workingSplit(2, [w("ag_01", true), w("ag_02", true)], two), { members: 2, subagents: 0 });
});

test("workingSplit returns null when the lists can't answer it", () => {
  const teams = [team("Explain UX", "ag_01")] as never;
  assert.equal(workingSplit(2, [w("ag_01", true)], teams), null, "list shorter than the count: don't guess");
  assert.equal(workingSplit(1, [], teams), null);
  assert.equal(workingSplit(1, undefined, teams), null);
  assert.equal(workingSplit(1, [w("ag_01", true)], []), null);
  assert.equal(workingSplit(1, [w("ag_01", true)], undefined), null);
});

test("workersWorkingLabel names what's actually working", () => {
  assert.equal(workersWorkingLabel(2, { members: 2, subagents: 0, team: "Explain UX" }), "2 team members working…");
  assert.equal(workersWorkingLabel(1, { members: 1, subagents: 0 }), "1 team member working…");
  assert.equal(workersWorkingLabel(3, { members: 2, subagents: 1 }), "1 subagent · 2 team members working…");
  assert.equal(workersWorkingLabel(3, { members: 0, subagents: 3 }), "3 subagents working…");
  assert.equal(workersWorkingLabel(3, null), "3 subagents working…", "unsplittable: the plain wording");
});

test("showWorkersLabel, teamNote and workingChipTitle follow the split", () => {
  assert.equal(showWorkersLabel(2, { members: 2, subagents: 0, team: "Explain UX" }), "2 team members working — show workers");
  assert.equal(showWorkersLabel(3, { members: 2, subagents: 1 }), "1 subagent · 2 team members working — show workers");
  assert.equal(showWorkersLabel(3, { members: 0, subagents: 3 }), "3 subagents working — show subagents");
  assert.equal(showWorkersLabel(3, null), "3 subagents working — show subagents");
  assert.equal(teamNote({ members: 2, subagents: 0, team: "Explain UX" }), "Team · Explain UX");
  assert.equal(teamNote({ members: 0, subagents: 2, team: "Explain UX" }), undefined);
  assert.equal(teamNote(null), undefined);
  assert.equal(workingChipTitle(null), "Subagents working now");
  assert.equal(workingChipTitle({ members: 2, subagents: 0 }), "Team members working now");
  assert.equal(workingChipTitle({ members: 2, subagents: 1 }), "Workers working now");
});

test("workerTeam finds the owning team; workersNoun names the pane", () => {
  const teams = [team("Explain UX", "ag_01"), team("Runtime", "ag_02")];
  assert.equal(workerTeam({ id: "ag_02" }, teams)!.name, "Runtime");
  assert.equal(workerTeam({ id: "ag_09" }, teams), null);
  assert.equal(workerTeam({ id: "ag_09" }, undefined), null);
  assert.equal(workersNoun(true), "Workers");
  assert.equal(workersNoun(false), "Subagents");
});

test("capTitle keeps tooltips short, cutting at a word boundary", () => {
  assert.equal(capTitle("Ship the explain strip"), "Ship the explain strip");
  assert.equal(capTitle("  padded  "), "padded", "titles are trimmed");
  assert.equal(capTitle(undefined), undefined);
  assert.equal(capTitle(""), undefined, "no empty title attribute");
  assert.equal(capTitle("   "), undefined);

  const long = "word ".repeat(1000);
  const capped = capTitle(long)!;
  assert.ok(capped.length <= 301, `capped at ~300, got ${capped.length}`);
  assert.ok(capped.endsWith("…"));
  assert.equal(capped, `${"word ".repeat(60).trimEnd()}…`, "cut on the last space before 300");

  assert.equal(capTitle("abcdefghij", 5), "abcde…", "no boundary to find: a hard cut");
  assert.equal(capTitle("ab cdefghij", 5), "ab cd…", "boundary too early would gut it — hard cut instead");
  assert.equal(capTitle("abcd efghij", 6), "abcd…");
  assert.equal(capTitle("exactly ten", 11), "exactly ten", "max is inclusive");
});
