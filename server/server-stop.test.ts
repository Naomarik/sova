// Run: npx tsx --test server/server-stop.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-server-stop-")));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-server-stop--");
const liveDir = join(agentDir, "sessions", "live");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(liveDir, { recursive: true });
mkdirSync(join(agentDir, "sova"), { recursive: true });

const { endedByRestart, initRestartWindow, markServerStop, NO_MARK_MS, restartWindow, serverStopFile, STOP_SLACK_MS, takeRestartWindow } = await import("./server-stop");
const { PROCESS_START_MS } = await import("./merge-readiness");
const { failedWorkersOf, workerErrorTimesOf } = await import("./live");
const { canonicalPath } = await import("./paths");
const overseer = await import("./overseer");

after(() => rmSync(agentDir, { recursive: true, force: true }));

/** A worker row as the subagents extension publishes it (SCHEMA.md WorkerEntry). */
const worker = (id: string, backend: "claude-code" | "pi", over: Record<string, unknown>) => ({
  id,
  name: id,
  backend,
  status: "error",
  startedAt: PROCESS_START_MS - 3_600_000,
  ...over,
});
const KILLED = {
  "claude-code": "Claude exited before expected closure (SIGTERM)",
  pi: "pi exited with code 143",
};

describe("the stop mark: written at shutdown, read and deleted at the next start", () => {
  test("a mark gives the window [its time − slack, this start]; the file is gone after", () => {
    const file = join(agentDir, "mark-a.json");
    markServerStop(1_000_000, file);
    assert.ok(existsSync(file));
    // The same pid wrote it here; a real next start is another process.
    writeFileSync(file, JSON.stringify({ v: 1, pid: process.pid + 1, at: 1_000_000 }));
    assert.deepEqual(takeRestartWindow(1_020_000, file), { from: 1_000_000 - STOP_SLACK_MS, to: 1_020_000 });
    assert.equal(existsSync(file), false, "read once: the start after that one has no mark");
    assert.deepEqual(takeRestartWindow(1_020_000, file), { from: 1_020_000 - NO_MARK_MS, to: 1_020_000 }, "no mark: the fallback");
  });

  test("a mark this process wrote, one from after this start, or garbage is no mark", () => {
    const file = join(agentDir, "mark-b.json");
    const fallback = { from: 5_000_000 - NO_MARK_MS, to: 5_000_000 };
    writeFileSync(file, JSON.stringify({ v: 1, pid: process.pid, at: 4_990_000 }));
    assert.deepEqual(takeRestartWindow(5_000_000, file), fallback);
    writeFileSync(file, JSON.stringify({ v: 1, pid: process.pid + 1, at: 5_000_001 }));
    assert.deepEqual(takeRestartWindow(5_000_000, file), fallback);
    writeFileSync(file, "{not json");
    assert.deepEqual(takeRestartWindow(5_000_000, file), fallback);
    assert.equal(existsSync(file), false);
  });
});

describe("which worker rows the restart ended", () => {
  const w = { from: 1_000, to: 2_000 };
  test("a restored row ended in an error inside the window, on either backend", () => {
    for (const backend of ["claude-code", "pi"] as const)
      assert.equal(endedByRestart(worker("ag_1", backend, { restored: true, endedAt: 1_500, preview: KILLED[backend] }), w), true, backend);
  });
  test("never a live error, an error before the stop, or another ending", () => {
    assert.equal(endedByRestart(worker("ag_1", "pi", { endedAt: 1_500 }), w), false, "not restored: this server's own worker");
    assert.equal(endedByRestart(worker("ag_1", "pi", { restored: true, endedAt: 999 }), w), false, "ended before the stop");
    assert.equal(endedByRestart(worker("ag_1", "pi", { restored: true, endedAt: 2_001 }), w), false, "after this start");
    assert.equal(endedByRestart(worker("ag_1", "pi", { restored: true, status: "killed", endedAt: 1_500 }), w), false);
    assert.equal(endedByRestart(worker("ag_1", "pi", { restored: true }), w), false, "no end time");
    assert.equal(endedByRestart(null, w), false);
  });
  test("the count and the error times leave those rows out", () => {
    const rec = {
      presence: {
        workerCounts: { total: 3, working: 0, waiting: 0, done: 0, error: 3, killed: 0 },
        workers: [worker("a", "claude-code", { restored: true, endedAt: 1_100 }), worker("b", "pi", { restored: true, endedAt: 1_200 }), worker("c", "pi", { endedAt: 3_000 })],
      },
    };
    const skip = (row: unknown) => endedByRestart(row, w);
    assert.equal(failedWorkersOf(rec), 3);
    assert.equal(failedWorkersOf(rec, skip), 1);
    assert.deepEqual(workerErrorTimesOf(rec, skip), [3_000]);
  });
});

describe("the digest: a worker the restart ended never reaches Needs you; a real error does", () => {
  const session = (id: string) => {
    const path = canonicalPath(join(sessionsDir, `2026-09-30T00-00-00-000Z_${id}.jsonl`));
    const at = "2026-09-30T00:00:00.000Z";
    const lines = [
      { type: "session", version: 3, id, timestamp: at, cwd: agentDir },
      { type: "message", id: "u1", parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: `task ${id}` }], timestamp: 0 } },
    ];
    writeFileSync(path, lines.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return path;
  };
  const live = (name: string, pid: number, path: string, workers: Record<string, unknown>[]) =>
    writeFileSync(
      join(liveDir, name),
      JSON.stringify({
        heartbeat: Date.now(),
        session: { sessionFile: path, pid, mode: "rpc", status: "idle" },
        presence: {
          status: "idle",
          workerCounts: { total: workers.length, working: 0, waiting: 0, done: 0, error: workers.filter((w) => w.status === "error").length, killed: 0 },
          workers,
        },
      }),
    );

  test("restart-ended claude-code and pi workers leave; a worker error while the server runs, or one before the stop, stays", async () => {
    // The previous server began stopping 20 s before this start; its workers died on that signal.
    const stopAt = PROCESS_START_MS - 20_000;
    writeFileSync(serverStopFile(), JSON.stringify({ v: 1, pid: process.pid + 1, at: stopAt }));
    initRestartWindow();
    assert.deepEqual(restartWindow(), { from: stopAt - STOP_SLACK_MS, to: PROCESS_START_MS });
    assert.equal(existsSync(serverStopFile()), false);

    const restart = { restored: true, endedAt: stopAt + 150 };
    const cut = session("cut");
    live("p-cut.json", process.pid, cut, [
      worker("ag_11", "claude-code", { ...restart, preview: KILLED["claude-code"] }),
      worker("ag_14", "pi", { ...restart, preview: KILLED.pi }),
    ]);
    // A crash mid-run while this server keeps running: a live error, after the start.
    const crash = session("crash");
    live("p-crash.json", process.pid, crash, [worker("ag_03", "claude-code", { endedAt: Date.now(), preview: "API Error: 500" })]);
    // An error the previous server saw well before it stopped, restored with the rest: still an error.
    const before = session("before");
    live("p-before.json", process.pid, before, [
      worker("ag_07", "pi", { restored: true, endedAt: stopAt - 600_000, preview: "pi exited with code 1" }),
      worker("ag_08", "pi", { ...restart, preview: KILLED.pi }),
    ]);
    // A terminal's own record (another pid) is not this server's restart.
    const tui = session("tui");
    live("p-tui.json", process.ppid, tui, [worker("ag_01", "pi", { ...restart, preview: KILLED.pi })]);

    const digest = await overseer.attentionDigest();
    const errors = new Map(digest.items.filter((i) => i.kind === "worker-error").map((i) => [i.path, i.detail]));
    assert.equal(errors.has(cut), false, "both restart-ended workers are left out");
    assert.equal(errors.get(crash), "1 subagent ended in an error.");
    assert.equal(errors.get(before), "1 subagent ended in an error.", "the older error stays, the restart's doesn't");
    assert.equal(errors.get(tui), "1 subagent ended in an error.");
  });
});
