// Run: npx tsx --test server/insights-workers.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { WorkerInfo } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-insights-test-"));
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

test("decodeWorkers names each worker's provider: the ref's, the catalog's, or claude code", () => {
  // A bare id resolves through pi's cached catalogs — models-store.json in this throwaway dir.
  writeFileSync(join(agentDir, "models-store.json"), JSON.stringify({ zai: { models: [{ id: "glm-5.3" }] } }));
  const byId = new Map(
    decodeWorkers({ workers: [
      { id: "ag_11", name: "ref", status: "running", backend: "pi", model: "zai/glm-5.4" },
      { id: "ag_12", name: "bare", status: "running", backend: "pi", model: "glm-5.3" },
      { id: "ag_13", name: "cc", status: "waiting", backend: "claude-code", model: "opus[1m]" },
      { id: "ag_14", name: "unknown", status: "waiting", backend: "pi", model: "made-up-model" },
      { id: "ag_15", name: "none", status: "waiting", backend: "pi" },
    ] }).map((w) => [w.id, w]),
  );
  assert.equal(byId.get("ag_11")!.provider, "zai", "a ref keeps its own prefix");
  assert.equal(byId.get("ag_12")!.provider, "zai", "a bare id comes from the cached catalog");
  assert.equal(byId.get("ag_13")!.provider, "claude code", "the claude-code backend names its own route");
  assert.equal(byId.get("ag_14")!.provider, undefined, "an unknown model gets no provider, never a guess");
  assert.equal(byId.get("ag_15")!.provider, undefined, "no model, no provider");
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

test("usage: per-model main rows from the branch, workers joined by origin", async () => {
  const path = session("usage-main");
  writeFileSync(path, [
    JSON.stringify({ type: "session", version: 3, id: "usage-main", timestamp: "2026-09-20T00:00:00.000Z", cwd: "/tmp" }),
    JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
    JSON.stringify({ type: "model_change", id: "c1", parentId: "m1", model: { provider: "zai", id: "glm-5.3" } }),
    JSON.stringify({ type: "message", id: "m2", parentId: "c1", message: { role: "assistant", provider: "zai", model: "glm-5.3", usage: { input: 100, output: 10, cacheRead: 5, cacheWrite: 0, cost: { total: 0.25 } }, content: [] } }),
    JSON.stringify({ type: "model_change", id: "c2", parentId: "m2", model: { provider: "anthropic", id: "claude-opus-5" } }),
    JSON.stringify({ type: "message", id: "m3", parentId: "c2", message: { role: "assistant", provider: "anthropic", model: "claude-opus-5", usage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 7, cost: { total: 0.5 } }, content: [] } }),
    JSON.stringify({ type: "message", id: "m4", parentId: "m3", message: { role: "assistant", provider: "anthropic", model: "claude-opus-5", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, content: [] } }), // same model: one row
    JSON.stringify({ type: "message", id: "m5", parentId: "m4", message: { role: "assistant", provider: "anthropic", model: "claude-opus-5", usage: null, content: [] } }), // no usage: skipped
  ].join("\n") + "\n");
  const own = session("usage-own");
  writeFileSync(own, [
    JSON.stringify({ type: "session", version: 3, id: "usage-own", timestamp: "2026-09-20T00:00:00.000Z", cwd: "/tmp" }),
    JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
    JSON.stringify({ type: "model_change", id: "c1", parentId: "m1", model: { provider: "zai", id: "glm-5.3" } }),
    JSON.stringify({ type: "message", id: "m2", parentId: "c1", message: { role: "assistant", provider: "zai", model: "glm-5.3", usage: { input: 100, output: 10, cacheRead: 5, cacheWrite: 0, cost: { total: 0.25 } }, content: [] } }),
    JSON.stringify({ type: "model_change", id: "c2", parentId: "m2", model: { provider: "anthropic", id: "claude-opus-5" } }),
    JSON.stringify({ type: "message", id: "m3", parentId: "c2", message: { role: "assistant", provider: "anthropic", model: "claude-opus-5", usage: { input: 200, output: 20, cacheRead: 0, cacheWrite: 7, cost: { total: 0.5 } }, content: [] } }),
    JSON.stringify({ type: "message", id: "m4", parentId: "m3", message: { role: "assistant", provider: "anthropic", model: "claude-opus-5", usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, content: [] } }), // same model: one row
    JSON.stringify({ type: "message", id: "m5", parentId: "m4", message: { role: "assistant", provider: "anthropic", model: "claude-opus-5", usage: null, content: [] } }), // no usage: skipped
  ].join("\n") + "\n");
  writeFileSync(join(liveDir, `p${process.pid}-bbbbbbbb.json`), JSON.stringify({
    heartbeat: Date.now(),
    session: { sessionFile: own, pid: process.pid, mode: "rpc", status: "idle" },
    presence: {
      status: "idle",
      workers: [
        { id: "ag_1", name: "coder", status: "done", backend: "pi", model: "zai/glm-5.3", usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.1 } },
        { id: "ag_2", name: "planner", status: "done", backend: "claude-code", model: "opus[1m]", usage: { input: 70, output: 8, cacheRead: 2, cacheWrite: 0 } },
        { id: "ag_3", name: "fresh", status: "running", backend: "pi", model: "zai/glm-5.3" }, // no usage yet
      ],
      workerUsage: { input: 120, output: 13, cacheRead: 2, cacheWrite: 0, workers: 3 },
    },
  }));
  const insight = await getSessionInsight(own);
  assert.ok(insight.usage);
  // main rows first, then subagents; cost only when reported; same-model merged.
  assert.deepEqual(insight.usage.models, [
    { model: "anthropic/claude-opus-5", origin: "main", input: 201, output: 22, cacheRead: 0, cacheWrite: 7, cost: 0.5 },
    { model: "zai/glm-5.3", origin: "main", input: 100, output: 10, cacheRead: 5, cacheWrite: 0, cost: 0.25 },
    { model: "opus[1m]", origin: "subagents", input: 70, output: 8, cacheRead: 2, cacheWrite: 0 },
    { model: "zai/glm-5.3", origin: "subagents", input: 50, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.1 },
  ]);
  assert.deepEqual(insight.usage.main, { input: 301, output: 32, cacheRead: 5, cacheWrite: 7, cost: 0.75 });
  assert.deepEqual(insight.usage.workersTotal, { input: 120, output: 13, cacheRead: 2, cacheWrite: 0, workers: 3 });
  // Branch-only session (no live record): main rows alone, no workersTotal.
  const solo = await getSessionInsight(path);
  assert.equal(solo.usage?.models.length, 2);
  assert.equal(solo.usage?.models.every((m) => m.origin === "main"), true);
  assert.equal(solo.usage?.workersTotal, undefined);
});

test("usage: absent when nothing was spent", async () => {
  const insight = await getSessionInsight(session("usage-empty"));
  assert.equal(insight.usage, undefined);
});
