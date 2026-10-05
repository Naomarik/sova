// Run: pnpm exec tsx --test src/lib/work-now.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentsInsight, LiveAgentSession, MeshSessions, SessionSummary } from "../../shared/protocol";
import { answeredPeers, sentences, workMissing, workNow, workNowView, type WorkPeer, workPeers } from "./work-now";

const counts = (working = 0, waiting = 0) => ({ total: working + waiting, working, waiting, done: 0, error: 0, killed: 0 });
function rec(path: string, o: Partial<LiveAgentSession> = {}): LiveAgentSession {
  return { path, sessionId: path, name: null, cwd: "/w", pid: 1, mode: "tui", fresh: true, state: "idle", workerCounts: counts(), workers: [], teams: [], ...o };
}
const insight = (...sessions: LiveAgentSession[]): AgentsInsight => ({
  at: 0,
  totals: { sessions: 0, working: 0, total: 0, teams: 0, teamWorking: 0, soloWorking: 0 },
  sessions,
});
type Row = NonNullable<WorkPeer["rows"]>[number];
const row = (path: string, o: Partial<Row> = {}): Row => ({ path, live: null, busy: false, ...o });
const view = (...a: Parameters<typeof workNow>) => workNowView(workNow(...a));
const line = (v: ReturnType<typeof workNowView>) => (v.parts.length ? `${v.parts.map((p) => `${p.n} ${p.word}`).join(" · ")} working` : null);

test("unknown until the Agents poll answers: no figure, never a 0, no line", () => {
  const v = view(undefined, [{ label: "desk", rows: [row("/p/a", { busy: true })] }], { running: { "/x": true }, working: {} });
  assert.equal(v.state, "unknown");
  assert.equal(v.total, null);
  assert.equal(v.figure, "–");
  assert.equal(v.rowWord, null);
  assert.equal(line(v), null);
  assert.equal(v.sentence, "Agents working now: not known yet");
  assert.equal(v.showTally, true);
});

test("a known 0: the figure 0, no line, the tally hidden", () => {
  const v = view(insight(rec("/a")));
  assert.equal(v.state, "complete");
  assert.equal(v.figure, "0");
  assert.equal(v.rowWord, "agents");
  assert.equal(line(v), null);
  assert.equal(v.sentence, "No agents working now");
  assert.equal(v.showTally, false);
});

test("sessions are turns running; subagents are workers working; the sum is the figure", () => {
  const v = view(insight(rec("/a", { state: "working" }), rec("/b", { workerCounts: counts(3, 2) }), rec("/c", { state: "working", workerCounts: counts(2) })));
  assert.equal(v.total, 7);
  assert.equal(line(v), "2 sessions · 5 subagents working");
  assert.equal(v.sentence, "7 agents working now: 2 sessions and 5 subagents");
  assert.equal(`${v.figure} ${v.rowWord}`, "7 agents");
});

test("parts at 0 are left out, words singular at 1", () => {
  assert.equal(line(view(insight(rec("/a", { state: "working" })))), "1 session working");
  assert.equal(view(insight(rec("/a", { state: "working" }))).sentence, "1 agent working now: 1 session");
  assert.equal(line(view(insight(rec("/a", { workerCounts: counts(5) })))), "5 subagents working");
  assert.equal(line(view(insight(rec("/a", { workerCounts: counts(1) })))), "1 subagent working");
  assert.equal(view(insight(rec("/a", { workerCounts: counts(3) }))).sentence, "3 agents working now: 3 subagents");
});

test("only fresh host sessions count; waiting, done and stale workers never do", () => {
  const v = view(
    insight(
      rec("/stale", { fresh: false, state: "working", workerCounts: counts(4) }),
      rec("/worker-pi", { mode: "rpc", state: "working", workerCounts: counts(2) }), // a headless worker pi
      rec("/embedded", { mode: "rpc", embedded: true, state: "working" }), // Sova's own runtime: a session
      rec("/waiting", { workerCounts: { total: 9, working: 0, waiting: 3, done: 4, error: 1, killed: 1 } }),
    ),
  );
  assert.equal(line(v), "1 session working");
});

test("team members are never double-counted: a team adds nothing beyond its workers", () => {
  const team = { id: "t", name: "t", objective: "", createdAt: 0, parentPath: "/a", live: true, members: [], working: 3 };
  const v = view(insight(rec("/a", { workerCounts: counts(3), teams: [team, { ...team, id: "u", working: 2 }] })));
  assert.equal(v.total, 3);
  assert.equal(line(v), "3 subagents working");
});

test("peers: turns from activity, or busy when no TUI has it; their workers; worker sessions skipped", () => {
  const rows = [
    row("/p/a", { activity: { state: "working" } }),
    row("/p/b", { busy: true }),
    row("/p/c", { busy: true, live: { pid: 1, status: "x" } }), // a TUI's: its activity speaks, not `busy`
    row("/p/d", { workers: { working: 2, total: 3 } }),
    row("/p/e", { live: { pid: 2, status: "x", workers: { working: 1, total: 1 } } }), // older servers: under `live`
    row("/p/w", { workerSession: true, busy: true, workers: { working: 4, total: 4 } }), // counted by its parent already
  ];
  const v = view(insight(rec("/a", { state: "working" })), [{ label: "desk", rows }]);
  assert.equal(v.state, "complete");
  assert.equal(line(v), "3 sessions · 3 subagents working");
});

test("a down or stale peer adds nothing and makes it a floor, said in words only", () => {
  const v = view(insight(rec("/a", { state: "working", workerCounts: counts(5) }), rec("/b", { state: "working" })), [
    { label: "desk", rows: null },
    { label: "studio", rows: [row("/s/a", { busy: true })] },
  ]);
  assert.equal(v.state, "partial");
  assert.equal(v.figure, "8", "the bare number, no + or ~");
  assert.equal(line(v), "3 sessions · 5 subagents working");
  assert.equal(v.sentence, "At least 8 agents working now: 3 sessions and 5 subagents. Work on desk isn't counted: it isn't answering.");
  assert.equal(v.showTally, true);
  const two = view(insight(), [
    { label: "desk", rows: null },
    { label: "laptop", rows: null },
  ]);
  assert.equal(two.sentence, "No agents seen working now. Work on desk and laptop isn't counted: they aren't answering.");
  assert.equal(line(two), null, "a floor of 0 shows no line");
  assert.equal(two.showTally, true, "the tally hides only a complete 0");
  assert.equal(workMissing(["a", "b", "c"]), "Work on a, b and c isn't counted: they aren't answering.");
});

test("the open chat's socket overrides the poll and the peer list, and counts a session neither lists", () => {
  const agents = insight(rec("/a", { state: "idle", workerCounts: counts(1) }), rec("/b", { state: "working" }));
  // The poll says /a idle with 1 worker; its socket says it is replying with 4.
  let v = view(agents, [], { running: { "/a": true }, working: { "/a": 4 } });
  assert.equal(line(v), "2 sessions · 4 subagents working");
  // The socket says the turn ended before the poll noticed.
  v = view(agents, [], { running: { "/b": false }, working: {} });
  assert.equal(line(v), "1 subagent working");
  // A peer's open chat.
  v = view(insight(), [{ label: "desk", rows: [row("/p/a", { busy: false })] }], { running: { "/p/a": true }, working: { "/p/a": 2 } });
  assert.equal(line(v), "1 session · 2 subagents working");
  // A new chat no list has yet.
  v = view(insight(), [], { running: { "/new": true }, working: { "/new": 0 } });
  assert.equal(line(v), "1 session working");
  // Closed chats leave nothing behind: no key, no count.
  v = view(insight(), [], { running: {}, working: {} });
  assert.equal(v.total, 0);
});

test("a session on this host and in a peer's list is counted once", () => {
  const v = view(insight(rec("/a", { state: "working", workerCounts: counts(2) })), [{ label: "desk", rows: [row("/a", { busy: true, workers: { working: 2, total: 2 } })] }]);
  assert.equal(v.total, 3);
});

test("answeredPeers: a current list from a reachable peer, never a stale one", () => {
  const s: SessionSummary[] = [];
  const answer: MeshSessions = {
    peers: [
      { id: "up", label: "Up", state: "up", sessions: s },
      { id: "skew", label: "Skew", state: "skewed", sessions: s },
      { id: "stale", label: "Stale", state: "up", sessions: s, stale: true },
      { id: "down", label: "Down", state: "down", sessions: s, stale: true },
      { id: "none", label: "None", state: "up" },
      { id: "refused", label: "Refused", state: "refused" },
    ],
  };
  assert.deepEqual([...answeredPeers(answer)].sort(), ["skew", "up"]);
});

test("workPeers: every mesh peer in order, its kept list only while answered, labelled", () => {
  const lists = new Map<string, SessionSummary[]>([
    ["a", []],
    ["b", []],
  ]);
  const peers = workPeers(
    [
      { id: "a", label: "Desk" },
      { id: "b", label: "" },
      { id: "c", label: "Laptop" },
    ],
    lists,
    new Set(["a", "c"]),
  );
  assert.deepEqual(
    peers.map((p) => [p.label, p.rows === null ? null : p.rows.length]),
    [
      ["Desk", 0],
      ["b", null], // kept list, but not current: a floor
      ["Laptop", null], // answered, but no list kept yet
    ],
  );
});

test("workPeers: a host that keeps its sessions from this one is left out, never a floor", () => {
  const peers = workPeers(
    [
      { id: "a", label: "Desk" },
      { id: "h", label: "Hidden" },
    ],
    new Map<string, SessionSummary[]>([["a", []]]),
    new Set(["a"]),
    (id) => id === "h",
  );
  assert.deepEqual(peers.map((p) => p.label), ["Desk"]);
  assert.equal(workNow(insight(), peers).state, "complete");
});

test("sentences: each ends in exactly one full stop", () => {
  assert.equal(sentences("No agents working now", "Output tokens a minute: not known yet."), "No agents working now. Output tokens a minute: not known yet.");
  assert.equal(sentences("At least 1 agent working now: 1 session. Work on desk isn't counted: it isn't answering.", "x."), "At least 1 agent working now: 1 session. Work on desk isn't counted: it isn't answering. x.");
  assert.equal(sentences("a", ""), "a.");
});

test("the toolbar line: an icon kind per part, 0s left out; its name carries the words, a floor's too", () => {
  const both = view(insight(rec("/a", { state: "working", workerCounts: counts(3) }), rec("/b", { state: "working", workerCounts: counts(2) })));
  assert.deepEqual(both.parts.map((p) => [p.kind, p.n]), [["sessions", 2], ["subagents", 5]]);
  assert.equal(both.lineLabel, "2 sessions · 5 subagents working");
  const subs = view(insight(rec("/a", { workerCounts: counts(5) })));
  assert.deepEqual(subs.parts.map((p) => p.kind), ["subagents"]);
  assert.equal(subs.lineLabel, "5 subagents working");
  assert.equal(view(insight(rec("/a", { state: "working" }))).lineLabel, "1 session working");
  const floor = view(insight(rec("/a", { state: "working", workerCounts: counts(1) })), [{ label: "desk", rows: null }]);
  assert.equal(floor.lineLabel, "At least 1 session · 1 subagent working. Work on desk isn't counted: it isn't answering.");
  assert.equal(view(insight()).lineLabel, "", "no line at 0");
  assert.equal(view(undefined).lineLabel, "", "no line while unknown");
});
