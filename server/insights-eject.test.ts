// Run: npx tsx --test server/insights-eject.test.ts
// Team seats: the subagents extension's `eject` op (subagents-team-v1) reaches the web as
// TeamMember.ejectedAt. Uses a throwaway PI_CODING_AGENT_DIR; ~/.pi is never touched.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-eject-test-")));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-eject-test--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });

const { getSessionInsight } = await import("./insights");
const { canonicalPath } = await import("./paths");

after(() => rmSync(root, { recursive: true, force: true }));

const jsonl = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
const T0 = Date.parse("2026-09-26T10:00:00.000Z");
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();
const seat = (n: number, role: string) =>
  ({ workerId: `ag_0${n}`, role, backend: "pi", ownedPaths: [], groupId: "run_01", addedAt: T0 });
/** A team entry on the chain: each line's parent is the one before it. */
const teamLine = (id: string, parentId: string, data: Record<string, unknown>) =>
  ({ type: "custom", id, parentId, timestamp: iso(1), customType: "subagents-team-v1", data: { version: 1, ...data } });

test("an eject op marks that member ejectedAt; malformed, unknown and off-branch ejects change nothing", async () => {
  const path = canonicalPath(join(sessionsDir, "2026-09-26T10-00-00-000Z_eject.jsonl"));
  writeFileSync(path, jsonl(
    { type: "session", version: 3, id: "eject", timestamp: iso(0), cwd: "/tmp/eject-test" },
    { type: "message", id: "e1", parentId: null, timestamp: iso(0), message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    teamLine("t1", "e1", { op: "create", team: { id: "team_01", name: "crew", objective: "ship", createdAt: T0 }, members: [seat(1, "lead"), seat(2, "dev")] }),
    // Off the active branch (a sibling of t2): never applied.
    teamLine("x1", "t1", { op: "eject", teamId: "team_01", workerId: "ag_01", at: T0 + 1 }),
    teamLine("t2", "t1", { op: "eject", teamId: "team_01", workerId: "ag_02", at: T0 + 5_000 }),
    teamLine("t3", "t2", { op: "eject", teamId: "team_01", workerId: "ag_02", at: T0 + 9_000 }), // repeat: the first stands
    teamLine("t4", "t3", { op: "eject", teamId: "team_01", workerId: "ag_01" }), // no time: malformed
    teamLine("t5", "t4", { op: "eject", teamId: "team_07", workerId: "ag_01", at: T0 }), // unknown team
    teamLine("t6", "t5", { op: "add", teamId: "team_01", members: [seat(3, "late")] }),
    { type: "message", id: "e2", parentId: "t6", timestamp: iso(2), message: { role: "user", content: [{ type: "text", text: "leaf" }] } },
  ));
  const insight = await getSessionInsight(path);
  const [team] = insight.teams;
  assert.ok(team);
  assert.deepEqual(team.members.map((m) => [m.workerId, m.role, m.ejectedAt]), [
    ["ag_01", "lead", undefined],
    ["ag_02", "dev", T0 + 5_000],
    ["ag_03", "late", undefined],
  ]);
  assert.ok(!("ejectedAt" in team.members[0]!), "a member never ejected carries no key at all");
});
