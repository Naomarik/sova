// Run: npx tsx --test src/lib/workers.test.ts (or npm test)
import assert from "node:assert/strict";
import { test } from "node:test";
import { isHostSession, sessionWorking, subagentsWorkingLabel } from "./workers";

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
