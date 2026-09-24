// Run: npx tsx --test server/insights-restored.test.ts
// Restored workers (§chat/subagents): a session nothing publishes live is rebuilt from its own
// durable worker records plus each worker's transcript, through the worker-transcript protocol.
// Uses a throwaway PI_CODING_AGENT_DIR and CLAUDE_CONFIG_DIR; ~/.pi and ~/.claude are never touched.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { WorkerInfo } from "../shared/protocol";

const root = mkdtempSync(join(tmpdir(), "sova-restored-test-"));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
const sessionsDir = join(agentDir, "sessions", "--tmp-restored-test--");
const liveDir = join(agentDir, "sessions", "live");
const claudeProject = join(root, "claude", "projects", "-tmp-restored-test");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(liveDir, { recursive: true });
mkdirSync(claudeProject, { recursive: true });

const { decodeWorkers, getSessionInsight } = await import("./insights");
const { canonicalPath } = await import("./paths");
const { resumeWorker, resumeCommandOf } = await import("./worker-resume");

after(() => rmSync(root, { recursive: true, force: true }));

const jsonl = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
const T0 = Date.parse("2026-09-24T10:00:00.000Z");
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();

/** One manifest record as the subagents extension appends it. */
const manifest = (id: string, parentId: string, data: Record<string, unknown>) => ({
  type: "custom", id, parentId, timestamp: iso(1), customType: "subagents-worker-manifest",
  data: { v: 1, kind: "worker-manifest", at: T0 + 60_000, ...data },
});

// A pi worker's own session: two replies with cost, one cache-warm usage entry.
const piWorkerFile = canonicalPath(join(sessionsDir, "2026-09-24T10-01-00-000Z_pi-worker.jsonl"));
const piUsage = (input: number, output: number, cost: number) =>
  ({ input, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost } });
writeFileSync(piWorkerFile, jsonl(
  { type: "session", version: 3, id: "pi-worker", timestamp: iso(1), cwd: "/tmp/restored-test" },
  { type: "custom", id: "w0", parentId: null, timestamp: iso(1), customType: "subagents-worker-session", data: { workerId: "ag_01" } },
  { type: "message", id: "w1", parentId: "w0", timestamp: iso(2), message: { role: "user", content: [{ type: "text", text: "go" }] } },
  { type: "message", id: "w2", parentId: "w1", timestamp: iso(3), message: { role: "assistant", provider: "zai", model: "glm-5.3", content: [{ type: "text", text: "done" }], usage: piUsage(100, 20, 0.5), stopReason: "stop" } },
  { type: "usage", id: "w3", parentId: "w2", timestamp: iso(4), kind: "cache_warm", provider: "zai", model: "glm-5.3", usage: piUsage(10, 0, 0.1) },
));

// A claude-code worker's record: tokens only, the same message repeated on two lines.
const claudeId = "0199aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ccLine = { type: "assistant", uuid: "c1", timestamp: iso(3), message: { id: "msg_1", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "hi" }], usage: { input_tokens: 7, output_tokens: 70, cache_read_input_tokens: 700, cache_creation_input_tokens: 0 } } };
writeFileSync(join(claudeProject, `${claudeId}.jsonl`), jsonl(
  { type: "user", uuid: "c0", timestamp: iso(2), message: { role: "user", content: "go" } },
  ccLine,
  { ...ccLine, uuid: "c1b" },
));

/** The owner session: e1 → (x1 off-branch) and e1 → m1 → m2 → m3 → m4 (the active branch). */
function owner(): string {
  const path = canonicalPath(join(sessionsDir, "2026-09-24T10-00-00-000Z_owner.jsonl"));
  writeFileSync(path, jsonl(
    { type: "session", version: 3, id: "owner", timestamp: iso(0), cwd: "/tmp/restored-test" },
    { type: "message", id: "e1", parentId: null, timestamp: iso(0), message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    // Rewound away: counted in the lifetime Σ (it was spent), never listed.
    manifest("x1", "e1", {
      workerId: "ag_05", backend: "pi", name: "abandoned",
      usageSnapshot: { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0, byModel: [], source: "snapshot", asOf: T0 + 5 * 60_000 },
    }),
    manifest("m1", "e1", {
      workerId: "ag_01", backend: "pi", name: "pi-worker", status: "running",
      spec: { cwd: "/tmp/restored-test", model: "zai/glm-5.3", taskPreview: "go", wake: true },
      ref: { v: 1, backend: "pi", kind: "pi-session-file", locator: piWorkerFile },
    }),
    manifest("m2", "m1", {
      workerId: "ag_02", backend: "claude-code", name: "cc-worker", status: "waiting",
      ref: { v: 1, backend: "claude-code", kind: "claude-session-id", locator: claudeId },
      // The live runner's last report: Claude's cost exists only here.
      usageSnapshot: { input: 7, output: 70, cacheRead: 700, cacheWrite: 0, cost: 0.42, byModel: [], source: "snapshot", asOf: T0 + 9 * 60_000 },
    }),
    // A backend Sova has no reader for, and nothing reported: unknown, which is not 0.
    manifest("m3", "m2", { workerId: "ag_03", backend: "future-backend", name: "future", status: "running" }),
    manifest("m4", "m3", {
      workerId: "ag_04", backend: "pi", name: "ended", status: "done", taskOutcome: "success", endedAt: T0 + 8 * 60_000,
      usageSnapshot: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, byModel: [], source: "snapshot", asOf: T0 + 8 * 60_000 },
    }),
  ));
  return path;
}

const byId = (workers: WorkerInfo[] | undefined) => new Map((workers ?? []).map((w) => [w.id, w]));

test("an unhosted session lists its active-branch workers, restored or ended, none working", async () => {
  const insight = await getSessionInsight(owner());
  const workers = byId(insight.workers);
  assert.deepEqual([...workers.keys()].sort(), ["ag_01", "ag_02", "ag_03", "ag_04"], "the rewound-away ag_05 is not listed");
  for (const w of workers.values()) assert.equal(w.working, false, `${w.id} has no process`);
  assert.equal(workers.get("ag_01")!.status, "restored");
  assert.ok(workers.get("ag_01")!.interruptedAt, "running at the restart: that turn never finished");
  assert.equal(workers.get("ag_02")!.status, "restored");
  assert.equal(workers.get("ag_02")!.interruptedAt, undefined, "idle at the restart: nothing was cut off");
  assert.equal(workers.get("ag_04")!.status, "done", "an ended worker keeps its ending");
  for (const w of workers.values()) assert.equal(w.resumable, undefined, "nothing can be resumed without a runtime");
});

test("usage comes from each transcript through the protocol; a snapshot says as of when; unreadable is not 0", async () => {
  const insight = await getSessionInsight(owner());
  const workers = byId(insight.workers);
  const pi = workers.get("ag_01")!;
  assert.equal(pi.usageSource, "transcript");
  assert.deepEqual(pi.usage, { input: 110, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.6 }, "cache-warm usage counts");
  assert.equal(pi.usageAsOf, undefined);
  assert.equal(pi.sessionFile, piWorkerFile);

  const cc = workers.get("ag_02")!;
  assert.equal(cc.usageSource, "transcript", "tokens are the transcript's");
  assert.deepEqual(cc.usage, { input: 7, output: 70, cacheRead: 700, cacheWrite: 0, cost: 0.42 }, "one message, counted once; cost from the snapshot");
  assert.equal(cc.usageAsOf, T0 + 9 * 60_000, "the cost is only as true as its last report");
  assert.equal(cc.sessionId, claudeId);
  assert.equal(cc.provider, "claude code");

  const future = workers.get("ag_03")!;
  assert.equal(future.usageSource, "unavailable");
  assert.ok(!("usage" in future), "no number at all, never a 0");

  assert.equal(workers.get("ag_04")!.usageSource, "snapshot");

  const usage = insight.usage!;
  assert.deepEqual(usage.unavailable, ["ag_03"]);
  const subagentRows = usage.models.filter((m) => m.origin === "subagents");
  const ccRow = subagentRows.find((m) => m.model === cc.model)!;
  assert.equal(ccRow.asOf, T0 + 9 * 60_000, "a row holding a snapshot cost says as of when");
  assert.equal(subagentRows.find((m) => m.model === pi.model)!.asOf, undefined);
});

test("the lifetime Σ covers every branch and every readable worker, and names the snapshot time", async () => {
  const insight = await getSessionInsight(owner());
  const total = insight.usageTotal!;
  assert.equal(total.workers, 4, "ag_01, ag_02, ag_04 and the off-branch ag_05; not the unreadable ag_03");
  assert.equal(total.input, 110 + 7 + 5 + 1000);
  assert.equal(total.output, 20 + 70 + 5 + 1000);
  assert.equal(total.asOf, T0 + 5 * 60_000, "the oldest snapshot in the Σ bounds it");
  assert.deepEqual(insight.usage!.workersTotal, total);
});

test("a live record wins: nothing is rebuilt from disk while a process publishes the workers", async () => {
  const path = owner();
  const file = join(liveDir, `p${process.pid}-restored.json`);
  writeFileSync(file, JSON.stringify({
    heartbeat: Date.now(),
    session: { sessionFile: path, pid: process.pid, mode: "rpc", status: "idle" },
    presence: { status: "idle", workers: [
      { id: "ag_09", name: "live", status: "restored", backend: "claude-code", resumable: true, usageSource: "snapshot", usageAsOf: T0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01 } },
    ], workerUsage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, workers: 1, asOf: T0 } },
  }));
  try {
    const insight = await getSessionInsight(path);
    assert.deepEqual((insight.workers ?? []).map((w) => w.id), ["ag_09"]);
    assert.equal(insight.workers![0]!.resumable, true, "this server's own runtime: it can resume");
    assert.equal(insight.usageTotal?.asOf, T0);
    assert.equal(insight.usage?.models.find((m) => m.origin === "subagents")?.asOf, T0);
  } finally {
    rmSync(file, { force: true });
  }
});

test("decodeWorkers: `resumable` only from this server's own runtime; a record's none is unavailable, with no usage", () => {
  const presence = { workers: [
    { id: "ag_01", name: "a", status: "restored", resumable: true, usageSource: "none", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { id: "ag_02", name: "b", status: "done", resumable: true, usageSource: "snapshot", usageAsOf: 5, interruptedAt: 4 },
  ] };
  const [a, b] = decodeWorkers(presence) as [WorkerInfo, WorkerInfo];
  assert.equal(a.resumable, undefined, "a TUI's ghost is not ours to start");
  assert.equal(a.working, false, "restored is idle");
  assert.equal(a.usageSource, "unavailable");
  assert.ok(!("usage" in a));
  assert.equal(b.usageAsOf, 5);
  assert.equal(b.interruptedAt, 4);
  const hosted = decodeWorkers(presence, true);
  assert.equal(hosted[0]!.resumable, true);
  assert.equal(hosted[1]!.resumable, true, "an ended worker can be resumable too");
});

test("resumeWorker runs only the subagents extension's own agent-resume, and passes its refusal through", async () => {
  const calls: string[] = [];
  const own = { sourceInfo: { path: "/x/pi-config/extensions/subagents/index.ts" }, handler: async (args: string) => void calls.push(args) };
  const foreign = { sourceInfo: { path: "/x/extensions/other/index.ts" }, handler: async () => void calls.push("foreign") };
  assert.equal(resumeCommandOf({ getCommand: () => foreign }), undefined, "a same-named command elsewhere never runs");
  assert.equal(resumeCommandOf({ getCommand: () => own }), own);

  let after = 0;
  const host = (cmd: typeof own | undefined, isForeign = false) => ({
    command: () => cmd, foreign: () => isForeign, commandContext: () => ({}), beforeCommand: () => {}, afterCommand: () => void after++,
  });
  assert.deepEqual(await resumeWorker(host(own), "ag_03"), { ok: true });
  assert.deepEqual(calls, ["ag_03"]);
  const none = await resumeWorker(host(undefined), "ag_03");
  assert.equal(none.ok, false);
  const busy = await resumeWorker(host(own, true), "ag_03");
  assert.ok(!busy.ok && busy.status === 409);
  assert.deepEqual(calls, ["ag_03"], "a foreign writer: nothing started");
  const refusing = { ...own, handler: async () => { throw new Error("ag_03 is already running."); } };
  const refused = await resumeWorker(host(refusing), "ag_03");
  assert.deepEqual(refused, { ok: false, status: 409, error: "ag_03 is already running." });
  assert.equal(after, 2, "afterCommand runs whether the handler took it or threw");
});
