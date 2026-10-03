import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
// @ts-expect-error a plain .mjs script, no types
import { BUSY_EXIT, busyOf, gate, parseArgs } from "../../scripts/sova-restart-gate.mjs";
import { adoptedStatus, parseEnterTimestamp, type Exec } from "./drivers";
import { RESTART_GATE, restartGateArgv, restartGateUnitOf } from "./self-host";

/**
 * An adopted unit (§app.project-services/adopt): read only through `systemctl show`, restarted only by
 * the gate script `apply` schedules, which re-reads the live records when it fires. Every systemctl
 * call is faked: nothing here reaches a user bus, and no real unit is ever named.
 */

const dir = mkdtempSync(join(tmpdir(), "sova-restart-gate-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const UNIT = "sova-gate-stand-in.service";

test("an adopted unit's status: state, main pid, start time and memory, by one read-only systemctl show", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    return { code: 0, stdout: "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=4242\nExecMainStatus=0\nResult=success\nActiveEnterTimestamp=@1700000000\n", stderr: "" };
  };
  const st = await adoptedStatus(UNIT, exec, () => [process.pid]);
  assert.equal(st.state, "active");
  assert.equal(st.pid, 4242);
  assert.equal(st.startedAt, "2023-11-14T22:13:20.000Z");
  assert.ok(st.rssBytes && st.rssBytes > 0, "the unit's processes' resident memory");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.slice(0, 4), ["systemctl", "--user", "show", UNIT], "only ever show, by the unit's whole name");
  const gone = await adoptedStatus(UNIT, async () => ({ code: 0, stdout: "LoadState=not-found\nActiveState=inactive\n", stderr: "" }), () => []);
  assert.equal(gone.state, "missing");
  assert.equal(gone.startedAt, null);
  const noBus = await adoptedStatus(UNIT, async () => ({ code: 1, stdout: "", stderr: "Failed to connect to bus" }), () => []);
  assert.equal(noBus.state, "missing");
  assert.match(noBus.detail!, /Failed to connect to bus/);
  assert.equal(parseEnterTimestamp(""), null);
  assert.equal(parseEnterTimestamp("@0"), null);
});

test("the schedule: systemd-run --on-active=30s runs the server's own gate script with its pid, live dir and the unit's main pid", () => {
  const a = restartGateArgv({ unit: UNIT, serverPid: 777, liveDir: "/live", mainPid: 4242, log: "/l/restart-gate.log", node: "/usr/bin/node", at: 1_000 });
  assert.deepEqual(a.slice(0, 6), ["--user", `--unit=${restartGateUnitOf(UNIT, 1_000)}`, "--on-active=30s", "--collect", "--quiet", "--"]);
  assert.deepEqual(a.slice(6), ["/usr/bin/node", RESTART_GATE, "--unit", UNIT, "--server-pid", "777", "--live-dir", "/live", "--main-pid", "4242", "--log", "/l/restart-gate.log"]);
  assert.match(restartGateUnitOf(UNIT, 1_000), /^sova-restart-[0-9a-f]{6}-sova-gate-stand-in-rs$/);
  assert.notEqual(restartGateUnitOf(UNIT, 1_000), restartGateUnitOf(UNIT, 2_000), "each schedule its own unit: an elapsed timer never blocks the next");
  assert.ok(!a.includes("--main-pid") || a[a.indexOf("--main-pid") + 1] === "4242");
  assert.ok(!restartGateArgv({ unit: UNIT, serverPid: 1, liveDir: "/x", mainPid: null, log: "/l" }).includes("--main-pid"));
  assert.deepEqual(parseArgs(a.slice(8)), { unit: UNIT, "server-pid": "777", "live-dir": "/live", "main-pid": "4242", log: "/l/restart-gate.log" }, "the script reads what the schedule passes");
  assert.equal(parseArgs(["--unit", "x", "--server-pid", "1", "--live-dir", "/x"]), null, "a unit is a whole .service name");
  assert.equal(parseArgs(["--unit", UNIT, "--server-pid", "1"]), null);
  assert.equal(parseArgs(["--unit", UNIT, "--server-pid", "1", "--live-dir", "/x", "--shell", "rm"]), null);
});

const rec = (pid: number, beat: number, presence: unknown) => ({ session: { pid }, heartbeat: beat, presence });

test("busy at fire time: a fresh record of the scheduling server with working subagents or a turn in flight", () => {
  const now = 1_000_000;
  assert.equal(busyOf([], 7, now), null);
  assert.equal(busyOf([rec(7, now - 1000, { activity: { state: "idle" }, workerCounts: { working: 0, total: 2 } })], 7, now), null);
  assert.equal(busyOf([rec(7, now - 1000, { activity: { state: "working" } })], 7, now), "1 with a turn in flight");
  assert.equal(busyOf([rec(7, now - 1000, { workerCounts: { working: 2, total: 2 } }), rec(7, now, { activity: { state: "working" } })], 7, now), "1 with working subagents, 1 with a turn in flight");
  assert.equal(busyOf([rec(8, now, { activity: { state: "working" } })], 7, now), null, "another server's sessions are not this one's");
  assert.equal(busyOf([rec(7, now - 31_000, { activity: { state: "working" } })], 7, now), null, "a heartbeat older than 30 s is stale");
});

test("the gate: idle → systemctl restart, busy → exit 75 and nothing restarted, restarted already → nothing", async () => {
  const log = join(dir, "restart-gate.log");
  const opts = { unit: UNIT, "server-pid": "7", "live-dir": "/unused", "main-pid": "4242", log };
  const said: string[] = [];
  const run = async (records: unknown[], mainPid = "4242", restartCode = 0) => {
    const calls: string[][] = [];
    const exec = async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      if (args[1] === "show") return { code: 0, stdout: `MainPID=${mainPid}\n`, stderr: "" };
      return { code: restartCode, stdout: "", stderr: restartCode ? "Unit failed" : "" };
    };
    const code = await gate(opts, { exec, records: () => records, now: () => 5_000_000, say: (l: string) => said.push(l) });
    return { code, calls };
  };
  const idle = await run([rec(7, 5_000_000, { activity: { state: "idle" } })]);
  assert.equal(idle.code, 0);
  assert.deepEqual(idle.calls.at(-1), ["systemctl", "--user", "restart", UNIT]);
  const busy = await run([rec(7, 4_999_000, { activity: { state: "working" } })]);
  assert.equal(busy.code, BUSY_EXIT);
  assert.ok(!busy.calls.some((c) => c.includes("restart")), "a busy server is never restarted");
  const already = await run([], "5555");
  assert.equal(already.code, 0);
  assert.ok(!already.calls.some((c) => c.includes("restart")), "restarted since the schedule: not again");
  const failed = await run([], "4242", 1);
  assert.equal(failed.code, 1);
  const lines = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(lines.length, 4, "one line per firing");
  assert.match(lines[0]!, /: restarted$/);
  assert.match(lines[1]!, /restart deferred \(exit 75\).*1 with a turn in flight/);
  assert.match(lines[2]!, /restarted already since the schedule/);
  assert.match(lines[3]!, /restart failed: Unit failed/);
  assert.equal(said.length, 4, "each also on stdout, the gate unit's journal");
});
