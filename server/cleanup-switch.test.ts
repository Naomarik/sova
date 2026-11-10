// The kill switch for automatic worktree cleanup: off unless SOVA_RETIRE=on, and off the screens never use the saved list.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-cleanup-switch-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
after(() => rmSync(agentDir, { recursive: true, force: true }));

const { CLEANUP_SWITCHED_OFF, cleanupSwitchedOn, pendingWhileOff, summaryWhileOff, viewWhileOff } = await import("./cleanup-switch");
const { retirementCounts, retirementGlance, retirementViewOf } = await import("./worktree-retire-view");

const main = "/p/main";
const commonDir = "/p/main/.git";
const state = join(agentDir, "sova");
mkdirSync(state, { recursive: true });
// A saved list that holds one and has one waiting, and a ledger with one retired: what an earlier service left.
writeFileSync(join(state, "retire-pending.json"), JSON.stringify({ v: 1, repos: { [commonDir]: { main, commonDir, held: [{ path: "/p/.worktrees/h", branch: "h", reason: "Held: a file only there", kind: "files" }], waiting: [{ path: "/p/.worktrees/w", why: "Its chat is working." }], at: 1, lockTaken: "pid 1" } } }));
const now = Date.now();
writeFileSync(join(state, "removed-worktrees.json"), JSON.stringify({ v: 1, entries: [{ v: 1, path: "/p/.worktrees/gone", branch: "gone", commonDir, tip: "a".repeat(40), merged: "ancestor", branchDeleted: true, at: now - 1000, retired: true, pinned: true }] }));

describe("the switch", () => {
  test("off unless SOVA_RETIRE=on, whatever else it says", () => {
    assert.equal(cleanupSwitchedOn({}), false);
    for (const v of ["off", "1", "true", "yes", ""]) assert.equal(cleanupSwitchedOn({ SOVA_RETIRE: v }), false, JSON.stringify(v));
    for (const v of ["on", " ON "]) assert.equal(cleanupSwitchedOn({ SOVA_RETIRE: v }), true, v);
  });

  test("the control: the planted saved list is readable, and on, the screens show what it holds", () => {
    const view = retirementViewOf(main, pendingWhileOff(true));
    assert.equal(view.held.length, 1);
    assert.equal(view.waiting, 1);
    assert.equal(retirementGlance(main, { ...pendingWhileOff(true), now }).held, 1);
    assert.deepEqual(retirementCounts(commonDir, now, pendingWhileOff(true)), { held: 1, retired: 1 });
  });
});

describe("off, the screens use only the ledger", () => {
  test("the view hands an empty saved list in: nothing held or waiting, no lock line, what retired still listed and restorable", () => {
    const off = pendingWhileOff(false);
    assert.deepEqual(off.pending, { v: 1, repos: {} });
    const view = viewWhileOff(retirementViewOf(main, off), false);
    assert.deepEqual(view.held, []);
    assert.equal(view.waiting, 0);
    assert.equal("waitingWhy" in view, false);
    assert.equal("lockTaken" in view, false);
    assert.deepEqual(view.retired.map((r) => [r.branch, r.restorable]), [["gone", true]]);
    assert.equal(view.retiredTotal, 1);
    assert.ok(view.off, "it says it's off");
    assert.equal(retirementGlance(main, { ...off, now }).held, 0);
    assert.equal(retirementGlance(main, { ...off, now }).retired, 1);
  });

  test("its line: the switch's own where nothing else said why, a more specific reason kept", () => {
    const bare = { retired: [], retiredTotal: 0, held: [{ path: "/x", reason: "r", kind: "files" }] as never, waiting: 2, waitingWhy: "w", lockTaken: "l" };
    assert.deepEqual(viewWhileOff(bare, false), { retired: [], retiredTotal: 0, held: [], waiting: 0, off: CLEANUP_SWITCHED_OFF, offFor: "setting" });
    const copy = viewWhileOff({ ...bare, off: "This is a test copy of Sova, so it retires nothing.", offFor: "test" }, false);
    assert.equal(copy.offFor, "test");
    assert.deepEqual(viewWhileOff(bare, true), bare, "on: untouched");
  });

  test("a new session's line drops its held count, keeps the rest", () => {
    const s = { state: "ok" as const, repo: main, total: 3, merged: 1, empty: 0, unmerged: 2, held: 2, retired: 1 };
    const { held: _h, ...rest } = s;
    assert.deepEqual(summaryWhileOff(s, false), rest);
    assert.deepEqual(summaryWhileOff(s, true), s);
    assert.deepEqual(summaryWhileOff({ state: "none" }, false), { state: "none" });
  });
});
