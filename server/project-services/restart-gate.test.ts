import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
// @ts-expect-error a plain .mjs script, no types
import { BUSY_EXIT, busyOf, gate, launchdPidOf, parseArgs } from "../../scripts/sova-restart-gate.mjs";
import { adoptedLogs, adoptedStatus, launchdAdoptedStatus, launchdStatusOf, parseEnterTimestamp, parseEtime, parseLaunchctlPrint, type Exec } from "./drivers";
import { RESTART_DELAY_SEC, RESTART_GATE, restartGateArgv, restartGateDetachedArgv, restartGateUnitOf, scheduleRestart } from "./self-host";

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
  const st = await adoptedStatus(UNIT, exec, () => [process.pid], "linux");
  assert.equal(st.state, "active");
  assert.equal(st.pid, 4242);
  assert.equal(st.startedAt, "2023-11-14T22:13:20.000Z");
  assert.ok(st.rssBytes && st.rssBytes > 0, "the unit's processes' resident memory");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.slice(0, 4), ["systemctl", "--user", "show", UNIT], "only ever show, by the unit's whole name");
  const gone = await adoptedStatus(UNIT, async () => ({ code: 0, stdout: "LoadState=not-found\nActiveState=inactive\n", stderr: "" }), () => [], "linux");
  assert.equal(gone.state, "missing");
  assert.equal(gone.startedAt, null);
  const noBus = await adoptedStatus(UNIT, async () => ({ code: 1, stdout: "", stderr: "Failed to connect to bus" }), () => [], "linux");
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
    const code = await gate(opts, { exec, records: () => records, now: () => 5_000_000, say: (l: string) => said.push(l), platform: "linux" });
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

// ---- macOS: the adopted unit is the launchd agent labelled with its name without `.service` ----

/** `launchctl print gui/501/<label>` as macOS writes it (abridged): the job's own lines are one tab in. */
const PRINT = (state: string, pid: number | null, exit: string, out = "/logs/agent.log") =>
  [
    "gui/501/sova-gate-stand-in = {",
    "\tactive count = 1",
    "\tpath = /agents/sova-gate-stand-in.plist",
    "\ttype = LaunchAgent",
    `\tstate = ${state}`,
    `\tstdout path = ${out}`,
    "\truns = 3",
    ...(pid ? [`\tpid = ${pid}`] : []),
    `\tlast exit code = ${exit}`,
    "\tresource coalition = {",
    "\t\tstate = active",
    "\t\tpid = 1",
    "\t}",
    "}",
  ].join("\n");

test("macOS: an adopted agent's status from launchctl print (state, pid, last exit) and ps (its age), read only", async () => {
  assert.deepEqual(parseLaunchctlPrint(PRINT("running", 4242, "0")).pid, "4242", "the job's own pid, not a nested block's");
  assert.equal(launchdStatusOf(parseLaunchctlPrint(PRINT("running", 4242, "(never exited)"))).state, "active");
  assert.equal(launchdStatusOf(parseLaunchctlPrint(PRINT("spawn scheduled", null, "1"))).state, "activating");
  assert.equal(launchdStatusOf(parseLaunchctlPrint(PRINT("not running", null, "0"))).state, "inactive");
  assert.deepEqual(launchdStatusOf(parseLaunchctlPrint(PRINT("not running", null, "78"))), { state: "failed", pid: null, exit: 78, detail: "not running (last exit 78)" });
  assert.equal(parseEtime("01:02:03"), 3723);
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    return file === "launchctl" ? { code: 0, stdout: PRINT("running", 4242, "0"), stderr: "" } : { code: 0, stdout: "   05:00\n", stderr: "" };
  };
  const st = await launchdAdoptedStatus(UNIT, exec, () => [process.pid], 1_700_000_000_000);
  assert.deepEqual([st.state, st.pid, st.startedAt], ["active", 4242, "2023-11-14T22:08:20.000Z"]);
  assert.ok(st.rssBytes && st.rssBytes > 0, "the agent's process tree's resident memory");
  assert.deepEqual(calls[0], ["launchctl", "print", `gui/${process.getuid?.() ?? 0}/sova-gate-stand-in`], "print only, by the label");
  assert.deepEqual(calls[1], ["ps", "-o", "etime=", "-p", "4242"]);
  assert.equal(calls.length, 2, "nothing but reads");
  const notLoaded = await launchdAdoptedStatus(UNIT, async () => ({ code: 113, stdout: "", stderr: 'Bad request.\nCould not find service "sova-gate-stand-in" in domain for user gui: 501' }));
  assert.deepEqual([notLoaded.state, notLoaded.detail], ["missing", undefined], "not loaded: not-found");
  const broken = await launchdAdoptedStatus(UNIT, async () => ({ code: 127, stdout: "", stderr: "launchctl: not found" }));
  assert.equal(broken.state, "missing");
  assert.match(broken.detail!, /launchctl could not read gui\/\d+\/sova-gate-stand-in: launchctl: not found/, "unreadable: unsupported");
  assert.equal((await adoptedStatus(UNIT, exec, () => [], "darwin")).pid, 4242, "darwin reads launchd, never systemctl");
});

test("macOS: an adopted agent's logs are the tail of the file launchd writes its stdout to", async () => {
  const file = join(dir, "agent.log");
  writeFileSync(file, "one\ntwo\nthree\n");
  const exec: Exec = async () => ({ code: 0, stdout: PRINT("running", 4242, "0", file), stderr: "" });
  assert.deepEqual(await adoptedLogs(UNIT, 2, "darwin", exec), [{ t: "", text: "two" }, { t: "", text: "three" }]);
  assert.deepEqual(await adoptedLogs(UNIT, 2, "darwin", async () => ({ code: 113, stdout: "", stderr: "Could not find service" })), []);
});

test("macOS: apply schedules the server's own gate detached, with --delay 30; a gate that can't start is unsupported", async () => {
  const a = restartGateDetachedArgv({ unit: UNIT, serverPid: 777, liveDir: "/live", mainPid: 4242, log: "/l/restart-gate.log" });
  assert.deepEqual(a, [RESTART_GATE, "--delay", String(RESTART_DELAY_SEC), "--unit", UNIT, "--server-pid", "777", "--live-dir", "/live", "--main-pid", "4242", "--log", "/l/restart-gate.log"]);
  assert.deepEqual(parseArgs(a.slice(1)), { delay: "30", unit: UNIT, "server-pid": "777", "live-dir": "/live", "main-pid": "4242", log: "/l/restart-gate.log" }, "the script reads what the schedule passes");
  assert.equal(parseArgs(["--delay", "soon", "--unit", UNIT, "--server-pid", "1", "--live-dir", "/x"]), null);
  const started: string[][] = [];
  const never: Exec = async () => {
    throw new Error("no systemd-run on macOS");
  };
  assert.equal(await scheduleRestart(UNIT, 4242, never, "darwin", async (file, args) => (started.push([file, ...args]), null)), null);
  assert.equal(started.length, 1);
  assert.equal(started[0]![0], process.execPath, "the server's own runtime");
  assert.deepEqual(started[0]!.slice(1, 4), [RESTART_GATE, "--delay", "30"]);
  assert.equal(await scheduleRestart(UNIT, 4242, never, "darwin", async () => "cannot start bun: EACCES"), "cannot start bun: EACCES");
});

test("macOS: the gate waits its delay, then idle → launchctl kickstart -k, busy → 75, restarted already → nothing", async () => {
  const log = join(dir, "restart-gate-launchd.log");
  const opts = { delay: "30", unit: UNIT, "server-pid": "7", "live-dir": "/unused", "main-pid": "4242", log };
  const run = async (records: unknown[], pid: number | null = 4242, code = 0) => {
    const calls: string[][] = [];
    const slept: number[] = [];
    const exec = async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      if (args[0] === "print") return { code: 0, stdout: PRINT(pid ? "running" : "not running", pid, "0"), stderr: "" };
      return { code, stdout: "", stderr: code ? "Could not kickstart service" : "" };
    };
    const exit = await gate(opts, { exec, records: () => records, now: () => 5_000_000, say: () => undefined, sleep: async (ms: number) => void slept.push(ms), platform: "darwin", uid: 501 });
    return { exit, calls, slept };
  };
  const idle = await run([rec(7, 5_000_000, { activity: { state: "idle" } })]);
  assert.equal(idle.exit, 0);
  assert.deepEqual(idle.slept, [30_000], "it waits the schedule's delay itself");
  assert.deepEqual(idle.calls, [["launchctl", "print", "gui/501/sova-gate-stand-in"], ["launchctl", "kickstart", "-k", "gui/501/sova-gate-stand-in"]]);
  assert.ok(!idle.calls.some((c) => c[0] === "systemctl"), "never systemctl on macOS");
  const busy = await run([rec(7, 4_999_000, { workerCounts: { working: 1 } })]);
  assert.equal(busy.exit, BUSY_EXIT);
  assert.ok(!busy.calls.some((c) => c.includes("kickstart")), "a busy server is never restarted");
  const already = await run([], 5555);
  assert.equal(already.exit, 0);
  assert.ok(!already.calls.some((c) => c.includes("kickstart")), "restarted since the schedule: not again");
  const failed = await run([], 4242, 1);
  assert.equal(failed.exit, 1);
  assert.match(readFileSync(log, "utf8").trim().split("\n").at(-1)!, /restart failed: Could not kickstart service/);
  assert.equal(launchdPidOf(PRINT("not running", null, "0")), undefined);
});
