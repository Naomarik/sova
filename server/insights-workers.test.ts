// Run: npx tsx --test server/insights-workers.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { WorkerInfo } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-insights-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-insights-test--");
const liveDir = join(agentDir, "sessions", "live");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(liveDir, { recursive: true });

const { decodeWorkers, getSessionInsight } = await import("./insights");
const { canonicalPath } = await import("./paths");

after(() => rmSync(agentDir, { recursive: true, force: true }));

function session(id: string): string {
  const path = join(sessionsDir, `2026-09-20T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-20T00:00:00.000Z", cwd: "/tmp" })}\n`);
  return canonicalPath(path);
}

const workerFile = join(sessionsDir, "2026-09-20T00-01-00-000Z_worker.jsonl");

test("decodeWorkers carries the worker's sessionFile/sessionId, dropping non-strings and empties", () => {
  const workers = decodeWorkers({ workers: [
    { id: "ag_01", name: "pi", status: "running", backend: "pi", sessionFile: workerFile, sessionId: "0199-w" },
    { id: "ag_02", name: "claude", status: "waiting", backend: "claude-code", sessionId: "claude-123" },
    { id: "ag_03", name: "bad", status: "running", sessionFile: 42, sessionId: "" },
  ] });
  assert.equal(workers.length, 3);
  const [pi, claude, bad] = workers as [WorkerInfo, WorkerInfo, WorkerInfo];
  assert.equal(pi.sessionFile, workerFile);
  assert.equal(pi.sessionId, "0199-w");
  assert.equal(claude.sessionFile, undefined);
  assert.equal(claude.sessionId, "claude-123");
  assert.ok(!("sessionFile" in bad) && !("sessionId" in bad));
  assert.equal(bad.name, "bad");
});

test("getSessionInsight returns this session's own live workers", async () => {
  const own = session("own-workers");
  writeFileSync(join(liveDir, `p${process.pid}-aaaaaaaa.json`), JSON.stringify({
    heartbeat: Date.now(),
    session: { sessionFile: own, pid: process.pid, mode: "rpc", status: "idle" },
    presence: { status: "idle", workers: [
      { id: "ag_01", name: "reviewer", status: "running", backend: "pi", sessionFile: workerFile, sessionId: "0199-w" },
    ] },
  }));
  const insight = await getSessionInsight(own);
  assert.equal(insight.workers?.length, 1);
  const worker = insight.workers![0]!;
  assert.equal(worker.id, "ag_01");
  assert.equal(worker.working, true);
  assert.equal(worker.sessionFile, workerFile);
  assert.equal(worker.sessionId, "0199-w");
});

test("a never-live session yields workers: []", async () => {
  const insight = await getSessionInsight(session("never-live"));
  assert.deepEqual(insight.workers, []);
});
