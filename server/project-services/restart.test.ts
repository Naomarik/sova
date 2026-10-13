import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { adoptedLogs, adoptedStatus, launchdAdoptedStatus, launchdStatusOf, parseEnterTimestamp, parseEtime, parseLaunchctlPrint, type Exec } from "./drivers";
import { kickstartArgv, launchdTargetOf, RESTART_DELAY_SEC, restartArgv, restartUnitOf, scheduleRestart } from "./self-host";

/**
 * An adopted unit (§app.project-services/adopt): read only through `systemctl show` (macOS: `launchctl
 * print`), and restarted only by the delayed restart a confirmed `apply` schedules, with no busy check.
 * Every systemctl and launchctl call is faked: nothing here reaches a user bus, and no real unit is ever named.
 */

const dir = mkdtempSync(join(tmpdir(), "sova-restart-"));
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


test("the schedule: systemd-run --on-active=3s runs `systemctl --user restart <unit>` once, a transient unit of its own per schedule", async () => {
  assert.equal(RESTART_DELAY_SEC, 3);
  const a = restartArgv(UNIT, 1_000);
  assert.deepEqual(a, ["--user", `--unit=${restartUnitOf(UNIT, 1_000)}`, "--on-active=3s", "--collect", "--quiet", "--", "systemctl", "--user", "restart", UNIT]);
  assert.match(restartUnitOf(UNIT, 1_000), /^sova-restart-[0-9a-f]{6}-sova-gate-stand-in-rs$/);
  assert.notEqual(restartUnitOf(UNIT, 1_000), restartUnitOf(UNIT, 2_000), "each schedule its own unit: an elapsed timer never blocks the next");
  const calls: string[][] = [];
  const ok: Exec = async (file, args) => (calls.push([file, ...args]), { code: 0, stdout: "", stderr: "" });
  assert.equal(await scheduleRestart(UNIT, ok, "linux"), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], "systemd-run");
  assert.deepEqual(calls[0]!.slice(-4), ["systemctl", "--user", "restart", UNIT], "the unit itself, never a gate script");
  assert.equal(await scheduleRestart(UNIT, async () => ({ code: 1, stdout: "", stderr: "Failed to connect to bus\n" }), "linux"), "Failed to connect to bus");
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

test("macOS: apply starts a detached /bin/sh that waits 3 s and kickstarts the agent (the target is an argument, never script text); one that can't start is unsupported", async () => {
  assert.equal(launchdTargetOf(UNIT, 501), "gui/501/sova-gate-stand-in");
  assert.deepEqual(kickstartArgv(UNIT, 501), ["-c", 'sleep 3; exec launchctl kickstart -k "$0"', "gui/501/sova-gate-stand-in"]);
  const started: string[][] = [];
  const never: Exec = async () => {
    throw new Error("no systemd-run on macOS");
  };
  assert.equal(await scheduleRestart(UNIT, never, "darwin", async (file, args) => (started.push([file, ...args]), null), 501), null);
  assert.deepEqual(started, [["/bin/sh", "-c", 'sleep 3; exec launchctl kickstart -k "$0"', "gui/501/sova-gate-stand-in"]]);
  assert.equal(await scheduleRestart(UNIT, never, "darwin", async () => "cannot start /bin/sh: EACCES", 501), "cannot start /bin/sh: EACCES");
});
