// Run: npx tsx --test server/insights-hidden-workers.test.ts
// The workers a live record couldn't list (§app.subagents-pane/hidden-workers): the record carries
// at most 40, the pane's "Show {n} More" reads the rest from the session's own worker records.
// Uses a throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-hidden-workers-test-")));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
const sessionsDir = join(agentDir, "sessions", "--tmp-hidden-test--");
const liveDir = join(agentDir, "sessions", "live");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(liveDir, { recursive: true });

const { getHiddenWorkers, getSessionInsight } = await import("./insights");
const { canonicalPath } = await import("./paths");

after(() => rmSync(root, { recursive: true, force: true }));

const jsonl = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
const T0 = Date.parse("2026-09-27T06:43:19.480Z");
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();
const id = (n: number) => `ag_${String(n).padStart(2, "0")}`;
const snapshot = (n: number) => ({ input: n, output: 2 * n, cacheRead: 30 * n, cacheWrite: 4 * n, cost: n / 100, byModel: [], source: "snapshot", asOf: T0 + n * 60_000 });

// ag_01's own transcript says something else than its snapshot: the endpoint must not read it.
const ag01File = canonicalPath(join(sessionsDir, "2026-09-27T06-44-00-000Z_ag01.jsonl"));
writeFileSync(ag01File, jsonl(
  { type: "session", version: 3, id: "ag01", timestamp: iso(1), cwd: "/tmp/hidden-test" },
  { type: "message", id: "w1", parentId: null, timestamp: iso(2), message: { role: "assistant", provider: "zai", model: "glm-5.3", content: [{ type: "text", text: "done" }], usage: { input: 99_999, output: 99_999, cacheRead: 0, cacheWrite: 0, cost: { total: 9 } }, stopReason: "stop" } },
));

/** The owner: e1 → x1 (rewound away: ag_99) and e1 → m01 → … → m57, one worker each; ag_57 is
    the running one. ag_02 saved no usage. Returns the canonical path. */
const owner = (() => {
  const path = canonicalPath(join(sessionsDir, "2026-09-27T06-43-19-480Z_owner.jsonl"));
  const lines: unknown[] = [
    { type: "session", version: 3, id: "owner", timestamp: iso(0), cwd: "/tmp/hidden-test" },
    { type: "message", id: "e1", parentId: null, timestamp: iso(0), message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    { type: "custom", id: "x1", parentId: "e1", timestamp: iso(1), customType: "subagents-worker-manifest",
      data: { v: 1, kind: "worker-manifest", at: T0, workerId: "ag_99", backend: "pi", name: "abandoned", status: "done", usageSnapshot: snapshot(99) } },
  ];
  let parent = "e1";
  for (let n = 1; n <= 57; n++) {
    const running = n === 57;
    lines.push({ type: "custom", id: `m${n}`, parentId: parent, timestamp: iso(n), customType: "subagents-worker-manifest",
      data: { v: 1, kind: "worker-manifest", at: T0 + n * 60_000, workerId: id(n), backend: "pi", name: `reviewer-${n}`,
        status: running ? "running" : "killed", ...(running ? {} : { endedAt: T0 + n * 60_000 }),
        spec: { cwd: "/tmp/hidden-test", model: "zai/glm-5.3", taskPreview: "review", wake: true },
        ...(n === 1 ? { ref: { v: 1, backend: "pi", kind: "pi-session-file", locator: ag01File } } : {}),
        ...(n === 2 ? {} : { usageSnapshot: snapshot(n) }) } });
    parent = `m${n}`;
  }
  writeFileSync(path, jsonl(...lines));
  return path;
})();

/** The live record as the sessions extension now writes it: the running worker, then the newest. */
const liveFile = join(liveDir, `p${process.pid}-bbbbbbbb.json`);
function publish(listed: number[], total = 57): void {
  writeFileSync(liveFile, JSON.stringify({
    heartbeat: Date.now(),
    session: { sessionFile: owner, pid: process.pid, mode: "rpc", status: "idle" },
    presence: { status: "idle", workers: listed.map((n) => ({ id: id(n), name: `reviewer-${n}`, status: n === 57 ? "running" : "killed", backend: "pi" })),
      workerCounts: { total, working: 1, waiting: 0, done: 0, error: 0, killed: total - 1 } },
  }));
}
const newest40 = [57, ...Array.from({ length: 39 }, (_, i) => 56 - i)]; // ag_57, ag_56 … ag_18

test("the insight says how many workers the record counts when it lists fewer", async () => {
  publish(newest40);
  const insight = await getSessionInsight(owner);
  assert.equal(insight.workers?.length, 40);
  assert.equal(insight.workers?.[0]?.id, "ag_57");
  assert.equal(insight.workerTotal, 57);
});

test("hidden workers: the active branch's unlisted ones, newest first, with the count", async () => {
  publish(newest40);
  const res = await getHiddenWorkers(owner);
  assert.deepEqual(res.workers.map((w) => w.id), Array.from({ length: 17 }, (_, i) => id(17 - i)), "ag_17 … ag_01, none the record lists");
  assert.equal(res.listed, 40);
  assert.equal(res.total, 57);
  assert.ok(!res.workers.some((w) => w.id === "ag_99"), "a worker rewound off the active branch is never offered");
  for (const w of res.workers) assert.equal(w.working, false);
  assert.equal(res.workers[0]!.status, "killed", "an ended worker keeps its ending");
});

test("hidden workers carry the usage their record saved, never their transcript's", async () => {
  publish(newest40);
  const byId = new Map((await getHiddenWorkers(owner)).workers.map((w) => [w.id, w]));
  const ag01 = byId.get("ag_01")!;
  assert.equal(ag01.usageSource, "snapshot");
  assert.deepEqual(ag01.usage, { input: 1, output: 2, cacheRead: 30, cacheWrite: 4, cost: 0.01 }, "the snapshot, not the transcript's 99,999");
  assert.equal(ag01.usageAsOf, T0 + 60_000);
  assert.equal(ag01.sessionFile, ag01File, "its transcript still opens from the row");
  assert.equal(byId.get("ag_02")!.usageSource, "unavailable", "no saved usage is unavailable, never 0");
  assert.equal(byId.get("ag_02")!.usage, undefined);
});

test("a record whose list gained a hidden worker stops offering it", async () => {
  publish([...newest40.slice(0, 39), 3]);
  const res = await getHiddenWorkers(owner);
  assert.ok(!res.workers.some((w) => w.id === "ag_03"));
  assert.ok(res.workers.some((w) => w.id === "ag_18"), "the one it pushed out is offered instead");
  assert.equal(res.total, 57);
});

test("nothing extra when the record lists every worker it counts, or there is no record", async () => {
  publish(newest40, 40);
  assert.equal((await getSessionInsight(owner)).workerTotal, undefined);
  unlinkSync(liveFile);
  const insight = await getSessionInsight(owner);
  assert.equal(insight.workers?.length, 57, "unhosted: every active-branch worker is listed already");
  assert.equal(insight.workerTotal, undefined);
  assert.deepEqual(await getHiddenWorkers(owner), { workers: [], listed: 0, total: 0 });
});
