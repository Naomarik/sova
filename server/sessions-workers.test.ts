// Run: npx tsx --test server/sessions-workers.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-workers-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-workers-test--");
const liveDir = join(agentDir, "sessions", "live");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(liveDir, { recursive: true });

const { getSessionSummary, listSessions } = await import("./sessions-index");
const { canonicalPath } = await import("./paths");

const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
after(() => {
  sleeper.kill();
  rmSync(agentDir, { recursive: true, force: true });
});

function session(id: string): string {
  const path = join(sessionsDir, `2026-09-19T00-00-00-000Z_${id}.jsonl`);
  // The user message matters: zero-input husks are hidden from the session list (sessions-index).
  writeFileSync(
    path,
    [
      JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-19T00:00:00.000Z", cwd: "/tmp" }),
      JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-09-19T00:00:01.000Z", message: { role: "user", content: "hello" } }),
    ].join("\n") + "\n",
  );
  return canonicalPath(path);
}

/** A sessions-extension live record for `sessionFile`, owned by `pid`. */
function liveRecord(name: string, sessionFile: string, pid: number, mode: string, working: number, total: number, heartbeat = Date.now()) {
  writeFileSync(
    join(liveDir, `${name}.json`),
    JSON.stringify({
      heartbeat,
      session: { sessionFile, pid, mode, status: "idle" },
      presence: { status: "idle", workerCounts: { total, working, waiting: 0, done: total - working, error: 0, killed: 0 } },
    }),
  );
}

test("web session: workers come from this server's own live record while live stays null", async () => {
  const web = session("web-workers");
  liveRecord(`p${process.pid}-aaaaaaaa`, web, process.pid, "rpc", 2, 3);
  const s = await getSessionSummary(web);
  assert.equal(s?.live, null);
  assert.deepEqual(s?.workers, { working: 2, total: 3 });
  const listed = (await listSessions()).find((x) => x.path === web);
  assert.equal(listed?.live, null);
  assert.deepEqual(listed?.workers, { working: 2, total: 3 });
});

test("TUI session: workers mirror live.workers", async () => {
  const tui = session("tui-workers");
  liveRecord(`p${sleeper.pid}-bbbbbbbb`, tui, sleeper.pid!, "tui", 1, 4);
  const s = await getSessionSummary(tui);
  assert.equal(s?.live?.pid, sleeper.pid);
  assert.deepEqual(s?.live?.workers, { working: 1, total: 4 });
  assert.deepEqual(s?.workers, { working: 1, total: 4 });
});

test("a stale own record reports no workers", async () => {
  const stale = session("stale-workers");
  liveRecord(`p${process.pid}-cccccccc`, stale, process.pid, "rpc", 5, 5, Date.now() - 60_000);
  const s = await getSessionSummary(stale);
  assert.equal(s?.live, null);
  assert.equal(s?.workers, undefined);
});
