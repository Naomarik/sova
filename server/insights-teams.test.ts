// Run: npx tsx --test server/insights-teams.test.ts
// Coordinated teams on the insight (§app.insights/team-cards): member duty and successorOf from
// subagents-team-v1, team events (subagents-team-event-v1), retired members, and a member's last
// report from its own worker records when its completion went to the coordinator.
// Uses a throwaway PI_CODING_AGENT_DIR; ~/.pi is never touched.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-teams-test-")));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-teams-test--");
const liveDir = join(agentDir, "sessions", "live");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(liveDir, { recursive: true });

const { getSessionInsight } = await import("./insights");
const { canonicalPath } = await import("./paths");

after(() => rmSync(root, { recursive: true, force: true }));

const T0 = Date.parse("2026-09-25T18:50:00.000Z");
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();
const ms = (min: number) => T0 + min * 60_000;

const member = (workerId: string, role: string, extra: Record<string, unknown> = {}) =>
  ({ workerId, role, ownedPaths: [], backend: "pi", model: "zai/glm-5.3", groupId: "run_01", addedAt: T0, ...extra });
const event = (kind: string, workerId: string, role: string, min: number, detail?: string) =>
  ({ version: 1, teamId: "team_01", kind, workerId, role, at: ms(min), ...(detail ? { detail } : {}) });
const manifest = (data: Record<string, unknown>) => ({ v: 1, kind: "worker-manifest", backend: "pi", ...data });

/** A linear session: each entry parents on the one before. */
function session(name: string, entries: { type: string; customType?: string; data?: unknown; content?: unknown; min: number }[]): string {
  const path = canonicalPath(join(sessionsDir, `2026-09-25T18-50-00-000Z_${name}.jsonl`));
  let parent: string | null = null;
  const lines = [JSON.stringify({ type: "session", version: 3, id: name, timestamp: iso(0), cwd: "/tmp/teams-test" })];
  entries.forEach((e, i) => {
    const id = `${name}-${i}`;
    const { min, ...rest } = e;
    lines.push(JSON.stringify({ ...rest, ...(e.type === "custom_message" ? { display: true } : {}), id, parentId: parent, timestamp: iso(min) }));
    parent = id;
  });
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

const TEAM = "subagents-team-v1";
const EVENT = "subagents-team-event-v1";
const MANIFEST = "subagents-worker-manifest";

const coordinated = () => session("coordinated", [
  { type: "custom", customType: TEAM, min: 0, data: { version: 1, op: "create", team: { id: "team_01", name: "e2e-file-test", objective: "Write 3 files.", createdAt: T0 }, members: [
    member("ag_01", "coordinator", { orchestrator: true, duty: "coordinator" }),
    member("ag_02", "writer"),
    member("ag_03", "monitor", { duty: "monitor" }),
    member("ag_06", "tester", { duty: "janitor", successorOf: "writer" }), // unknown duty, bad successorOf: ignored, member kept
  ] } },
  { type: "custom", customType: MANIFEST, min: 1, data: manifest({ workerId: "ag_02", name: "writer", status: "running", team: { teamId: "team_01", role: "writer" } }) },
  { type: "custom", customType: EVENT, min: 10, data: event("wrap-up", "ag_02", "writer", 10, "context 78% of 200k") },
  { type: "custom", customType: TEAM, min: 11, data: { version: 1, op: "add", teamId: "team_01", members: [member("ag_04", "writer-2", { successorOf: "ag_02" })] } },
  { type: "custom", customType: EVENT, min: 11, data: event("handover", "ag_02", "writer", 11, "successor writer-2 (ag_04) on pi/zai/glm-5.3-flash; retire on team_ready or after 2 min") },
  { type: "custom", customType: MANIFEST, min: 12, data: manifest({ workerId: "ag_02", status: "done", taskOutcome: "success", endedAt: ms(12) }) },
  { type: "custom", customType: EVENT, min: 12, data: event("retire", "ag_02", "writer", 12, "retired: successor writer-2 (ag_04) confirmed the takeover") },
  // An older file: the monitor's successor has no successorOf, only the handover event says it.
  { type: "custom", customType: TEAM, min: 13, data: { version: 1, op: "add", teamId: "team_01", members: [member("ag_05", "monitor-2", { duty: "monitor" })] } },
  { type: "custom", customType: EVENT, min: 13, data: event("handover", "ag_03", "monitor", 13, "successor monitor-2 (ag_05) on pi/zai/glm-5.3-flash; retire on team_ready or after 2 min") },
  { type: "custom", customType: EVENT, min: 16, data: event("retire", "ag_03", "monitor", 16, "retired: handover to monitor-2 (ag_05) timed out") },
  { type: "custom", customType: MANIFEST, min: 16, data: manifest({ workerId: "ag_03", status: "killed", endedAt: ms(16) }) },
  { type: "custom", customType: EVENT, min: 20, data: event("pause", "ag_05", "monitor-2", 20, "pause → coordinator: zai 5h at 95%. Wrap up.") },
  { type: "custom", customType: EVENT, min: 21, data: { ...event("pause", "ag_05", "monitor-2", 21), kind: "stop" } }, // not a kind: dropped
  // ag_06 reported to this session after its manifest settled: the newer one wins.
  { type: "custom", customType: MANIFEST, min: 22, data: manifest({ workerId: "ag_06", status: "waiting", taskOutcome: "error", settledAt: ms(22) }) },
  { type: "custom_message", customType: "subagent-complete", min: 23, content: "### ag_06 (tester) — waiting · task success\nAll green." },
]);

test("members: duty, successorOf (recorded, and from the handover event), retired with its reason", async () => {
  const [team] = (await getSessionInsight(coordinated())).teams;
  assert.ok(team);
  assert.equal(team.coordinated, true);
  const by = new Map(team.members.map((m) => [m.workerId, m]));
  assert.equal(by.get("ag_01")?.duty, "coordinator");
  assert.equal(by.get("ag_01")?.orchestrator, true);
  assert.equal(by.get("ag_03")?.duty, "monitor");
  assert.equal(by.get("ag_02")?.duty, undefined);
  assert.equal(by.get("ag_06")?.duty, undefined, "an unknown duty is ignored");
  assert.equal(by.get("ag_06")?.successorOf, undefined, "a successorOf that isn't a worker id is ignored");
  assert.equal(by.get("ag_04")?.successorOf, "ag_02");
  assert.equal(by.get("ag_05")?.successorOf, "ag_03", "fallback: the handover event's detail");
  assert.deepEqual(by.get("ag_02")?.retired, { at: iso(12), reason: "confirmed" });
  assert.deepEqual(by.get("ag_03")?.retired, { at: iso(16), reason: "timeout" });
  assert.equal(by.get("ag_04")?.retired, undefined);
});

test("events: every valid one, oldest first, with its sentence; an unknown kind is dropped", async () => {
  const [team] = (await getSessionInsight(coordinated())).teams;
  assert.deepEqual(team?.events?.map((e) => [e.kind, e.workerId, e.at, e.text]), [
    ["wrap-up", "ag_02", iso(10), "writer was asked to wrap up: context 78% of 200k."],
    ["handover", "ag_02", iso(11), "writer handed over to writer-2 (ag_04)."],
    ["retire", "ag_02", iso(12), "writer retired. writer-2 confirmed the takeover."],
    ["handover", "ag_03", iso(13), "monitor handed over to monitor-2 (ag_05)."],
    ["retire", "ag_03", iso(16), "monitor retired. The handover to monitor-2 timed out."],
    ["pause", "ag_05", iso(20), "monitor-2 paused the team: zai 5h at 95%. Wrap up."],
  ]);
  assert.equal(team?.events?.[0]?.detail, "context 78% of 200k");
});

test("lastReport: a routed member's own records fill it; the newer of record and report wins", async () => {
  const path = coordinated();
  // Live parent: only the coordinator and the successors are still listed; ag_02 and ag_03 were pruned.
  writeFileSync(join(liveDir, `p${process.pid}-cccccccc.json`), JSON.stringify({
    heartbeat: Date.now(),
    session: { sessionFile: path, pid: process.pid, mode: "rpc", status: "idle" },
    presence: { status: "idle", workers: [
      { id: "ag_01", name: "coordinator", status: "running", backend: "pi" },
      { id: "ag_04", name: "writer-2", status: "running", backend: "pi" },
    ] },
  }));
  try {
    const [team] = (await getSessionInsight(path)).teams;
    const by = new Map(team!.members.map((m) => [m.workerId, m]));
    assert.equal(by.get("ag_02")?.worker, null);
    assert.deepEqual(by.get("ag_02")?.lastReport, { status: "done", outcome: "success", at: iso(12) });
    assert.deepEqual(by.get("ag_03")?.lastReport, { status: "killed", at: iso(16) });
    assert.deepEqual(by.get("ag_06")?.lastReport, { status: "waiting", outcome: "success", at: iso(23) }, "the report is newer than the record");
    assert.equal(by.get("ag_01")?.lastReport, undefined, "nothing settled: no report");
  } finally {
    rmSync(join(liveDir, `p${process.pid}-cccccccc.json`), { force: true });
  }
});

test("a team without duties or events carries neither field (older files render as before)", async () => {
  const path = session("plain", [
    { type: "custom", customType: TEAM, min: 0, data: { version: 1, op: "create", team: { id: "team_01", name: "plain", objective: "", createdAt: T0 }, members: [member("ag_01", "lead", { orchestrator: true })] } },
  ]);
  const [team] = (await getSessionInsight(path)).teams;
  assert.equal("coordinated" in team!, false);
  assert.equal("events" in team!, false);
  assert.deepEqual(Object.keys(team!.members[0]!).sort(), ["addedAt", "backend", "model", "orchestrator", "ownedPaths", "role", "worker", "workerId"]);
});
