// Run: npx tsx --test src/lib/workers.test.ts (or npm test)
import assert from "node:assert/strict";
import { test } from "node:test";
import { isHostSession, sessionWorking, showSubagentsLabel, sortWorkers, subagentsWorkingLabel, workerLabel } from "./workers";

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
