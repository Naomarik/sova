import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DetachedDriver, parseShow, SystemdDriver, systemdRunArgv, type Exec } from "./drivers";
import { psTable, realSyncExec } from "./proctable";
import { procsDir } from "./store";

/** A process's group, and whether it is gone (no such process, or a zombie not reaped yet): /proc on Linux, else `ps`. */
function proc(pid: number): { pgrp: number; gone: boolean } {
  try {
    if (process.platform === "linux") {
      const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ");
      return { pgrp: Number(f[2]), gone: f[0]!.startsWith("Z") };
    }
    const [pgrp, stat] = execFileSync("ps", ["-o", "pgid=,stat=", "-p", String(pid)], { encoding: "utf8" }).trim().split(/\s+/);
    return { pgrp: Number(pgrp), gone: stat!.startsWith("Z") };
  } catch {
    return { pgrp: Number.NaN, gone: true };
  }
}

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-drivers-"));
after(() => rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true }));

test("systemd-run argv: a transient user unit in the services slice, env sorted, argv after --", () => {
  const a = systemdRunArgv({ unit: "sova-svc-abc123-p-1-web", argv: ["node", "server.js", "--port", "4010"], cwd: "/w", env: { B: "2", A: "x y" } });
  assert.deepEqual(a.slice(0, 7), ["--user", "--unit=sova-svc-abc123-p-1-web", "--slice=sova-services.slice", "--collect", "--quiet", "--working-directory=/w", "--property=StandardInput=null"]);
  assert.ok(a.includes("--property=KillMode=mixed") && a.includes("--property=Restart=on-failure"));
  assert.ok(a.indexOf("--setenv=A=x y") < a.indexOf("--setenv=B=2"), "env in a fixed order");
  assert.deepEqual(a.slice(a.indexOf("--") + 1), ["node", "server.js", "--port", "4010"], "the argv is passed as is, never through a shell");
  const once = systemdRunArgv({ unit: "sova-hook-x", argv: ["true"], cwd: "/w", env: {} }, { timeoutSec: 30 });
  assert.ok(once.includes("--wait") && once.includes("--property=RuntimeMaxSec=30") && once.includes("--property=KillMode=control-group"));
  assert.ok(!once.includes("--property=Restart=on-failure"), "a hook is never restarted");
});

test("systemctl show parses into the unit's state", () => {
  assert.deepEqual(parseShow("LoadState=not-found\nActiveState=inactive\n"), { state: "missing", pid: null });
  const up = parseShow("LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=4242\nExecMainStatus=0\nResult=success\n");
  assert.equal(up.state, "active");
  assert.equal(up.pid, 4242);
  const failed = parseShow("LoadState=loaded\nActiveState=failed\nSubState=failed\nMainPID=0\nExecMainStatus=3\nResult=exit-code\n");
  assert.equal(failed.state, "failed");
  assert.equal(failed.exit, 3);
  assert.match(failed.detail!, /exit-code/);
  assert.equal(parseShow("LoadState=loaded\nActiveState=activating\nSubState=auto-restart\n").state, "activating");
});

test("the systemd driver only ever names its own unit, by argv", async () => {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    if (file === "systemctl" && args[1] === "show") return { code: 0, stdout: "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=7\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const d = new SystemdDriver(exec);
  await d.start({ unit: "sova-svc-h-i-web", argv: ["x"], cwd: "/w", env: {} });
  await d.stop("sova-svc-h-i-web");
  await d.signal("sova-svc-h-i-web", "HUP");
  assert.deepEqual((await d.status("sova-svc-h-i-web")).pid, 7);
  for (const c of calls) {
    assert.ok(c[0] === "systemctl" || c[0] === "systemd-run", c.join(" "));
    assert.ok(c.includes("--user"), `user manager only: ${c.join(" ")}`);
    assert.ok(c.some((a) => a.includes("sova-svc-h-i-web")), `names its unit: ${c.join(" ")}`);
  }
  assert.ok(calls.some((c) => c.join(" ") === "systemctl --user kill --signal=SIGHUP --kill-whom=main sova-svc-h-i-web.service"));
  const unreachable = new SystemdDriver(async () => ({ code: 1, stdout: "", stderr: "Failed to connect to bus" }));
  assert.deepEqual(await unreachable.available(), { ok: false, detail: "no systemd user manager reachable: Failed to connect to bus" });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the detached driver runs a process group, logs it, and stops the whole group", async () => {
  const d = new DetachedDriver(2_000);
  const unit = `sova-svc-test-${process.pid}-a`;
  // A parent that also starts a child in its group: stop must end both.
  const script = "const {spawn}=require('child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log('child', c.pid); setInterval(()=>{},1000);";
  await d.start({ unit, argv: [process.execPath, "-e", script], cwd: tmpdir(), env: { PATH: process.env.PATH ?? "" } });
  let st = await d.status(unit);
  assert.equal(st.state, "active");
  assert.ok(d.owns(unit, st.pid!), "its own pid is inside the unit");
  assert.ok(!d.owns(unit, process.pid), "the server is not");
  for (let i = 0; i < 50 && d.pids(unit).length < 2; i++) await sleep(50);
  const group = d.pids(unit);
  assert.equal(group.length, 2, `parent and child: ${group}`);
  for (let i = 0; i < 50 && !(await d.logs(unit, 10)).length; i++) await sleep(50);
  assert.match((await d.logs(unit, 10))[0]!.text, /^child \d+$/);
  assert.deepEqual(await d.units(`sova-svc-test-${process.pid}-`), [unit]);
  await d.start({ unit, argv: [process.execPath, "-e", "0"], cwd: tmpdir(), env: {} });
  assert.equal((await d.status(unit)).pid, st.pid, "start of a live unit leaves it alone");
  await d.stop(unit);
  st = await d.status(unit);
  assert.equal(st.state, "missing");
  // Gone, or a zombie its parent (this test process, for the group leader) has not reaped yet.
  for (const pid of group) assert.ok(proc(pid).gone, `pid ${pid} is gone`);
  assert.deepEqual(await d.units(`sova-svc-test-${process.pid}-`), []);
});

test("the detached driver's unit is its whole session: a child in a process group of its own is still the unit's", async () => {
  // `pnpm exec` does this to its child; sh's job control (`set -m`) does it to `sleep`.
  const d = new DetachedDriver(2_000);
  const unit = `sova-svc-test-${process.pid}-grp`;
  await d.start({ unit, argv: ["sh", "-c", "set -m; sleep 60 & wait"], cwd: tmpdir(), env: { PATH: process.env.PATH ?? "" } });
  const st = await d.status(unit);
  let pids: number[] = [];
  for (let i = 0; i < 50 && (pids = d.pids(unit)).length < 2; i++) await sleep(50);
  assert.equal(pids.length, 2, `sh and sleep: ${pids}`);
  const sleeper = pids.find((p) => p !== st.pid)!;
  assert.notEqual(proc(sleeper).pgrp, proc(st.pid!).pgrp, "the child really is in another process group");
  assert.ok(d.owns(unit, sleeper), "and still the unit's");
  await d.stop(unit);
  for (const pid of pids) assert.ok(proc(pid).gone, `pid ${pid} stopped`);
});

test("the detached driver's runOnce: exit codes, a timeout kills it, leftovers are killed and counted", async () => {
  const d = new DetachedDriver(1_000);
  const base = { cwd: tmpdir(), env: { PATH: process.env.PATH ?? "" } };
  assert.equal((await d.runOnce({ ...base, unit: "sova-hook-t-ok", argv: [process.execPath, "-e", "process.exit(0)"], timeoutSec: 10 })).code, 0);
  assert.equal((await d.runOnce({ ...base, unit: "sova-hook-t-3", argv: [process.execPath, "-e", "process.exit(3)"], timeoutSec: 10 })).code, 3);
  const slow = await d.runOnce({ ...base, unit: "sova-hook-t-slow", argv: [process.execPath, "-e", "setInterval(()=>{},1000)"], timeoutSec: 1 });
  assert.equal(slow.timedOut, true);
  const leaky = await d.runOnce({
    ...base,
    unit: "sova-hook-t-leak",
    argv: [process.execPath, "-e", "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}).unref()"],
    timeoutSec: 10,
  });
  assert.equal(leaky.code, 0);
  assert.equal(leaky.leftover, 1, "the process it left behind is counted (and killed)");
  const missing = await d.runOnce({ ...base, unit: "sova-hook-t-missing", argv: ["/nonexistent/program"], timeoutSec: 5 });
  assert.equal(missing.code, null, "a program that never started has no exit");
  assert.match(missing.launchError ?? "", /cannot start \/nonexistent\/program/);
  assert.deepEqual((await d.logs("sova-hook-t-missing", 10)).map((l) => l.text), [missing.launchError], "its log says why");
});

test("systemd-run argv: a relative command is resolved against the unit's directory, not systemd-run's", () => {
  const rel = systemdRunArgv({ unit: "sova-hook-x", argv: [".sova/bin/setup", "a"], cwd: "/w/co", env: {} }, { timeoutSec: 30 });
  assert.deepEqual(rel.slice(rel.indexOf("--") + 1), ["/w/co/.sova/bin/setup", "a"]);
  for (const cmd of ["npm", "/usr/bin/env"]) {
    const a = systemdRunArgv({ unit: "sova-hook-x", argv: [cmd], cwd: "/w/co", env: {} }, { timeoutSec: 30 });
    assert.deepEqual(a.slice(a.indexOf("--") + 1), [cmd], "a bare name or an absolute path is passed as is");
  }
});

/** A systemd whose `systemd-run` answers `run` and whose journal holds `journal` (MESSAGE strings) for every unit. */
const fakeSystemd = (run: { code: number; stdout?: string; stderr: string }, journal: string[] = []) => {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    if (file === "systemd-run") return { stdout: "", ...run };
    if (file === "journalctl") return { code: 0, stdout: journal.map((m, i) => JSON.stringify({ __REALTIME_TIMESTAMP: String(Date.now() * 1000 + i), MESSAGE: m })).join("\n"), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, driver: new SystemdDriver(exec) };
};

test("systemd: a run systemd-run could not start reports systemd-run's message, never an exit, and logs it", async () => {
  const { calls, driver } = fakeSystemd({ code: 1, stderr: "Failed to start transient service unit: Unit sova-hook-h-i-setup-deps.service was already loaded or has a fragment file.\n" });
  const r = await driver.runOnce({ unit: "sova-hook-h-i-setup-deps", argv: [".sova/bin/setup"], cwd: "/w", env: {}, timeoutSec: 30 });
  assert.equal(r.code, null);
  assert.equal(r.timedOut, false);
  assert.match(r.launchError ?? "", /systemd-run could not start sova-hook-h-i-setup-deps: Failed to start transient service unit: Unit .* already loaded/);
  const lines = (await driver.logs("sova-hook-h-i-setup-deps", 80)).map((l) => l.text);
  assert.deepEqual(lines, ["systemd-run: Failed to start transient service unit: Unit sova-hook-h-i-setup-deps.service was already loaded or has a fragment file."]);
  assert.deepEqual((await driver.logs("sova-hook-h-i-other", 80)).map((l) => l.text), [], "another unit's log is not it");
  const run = calls.findIndex((c) => c[0] === "systemd-run");
  const stop = calls.findIndex((c) => c.join(" ") === "systemctl --user stop sova-hook-h-i-setup-deps.service");
  const reset = calls.findIndex((c) => c.join(" ") === "systemctl --user reset-failed sova-hook-h-i-setup-deps.service");
  assert.ok(stop >= 0 && reset > stop && run > reset, "a leftover unit of the name is stopped and cleared before the run");
});

test("systemd: a hook that ran and failed keeps its exit and its journal, and peak", async () => {
  const said = "Running as unit: sova-hook-h-i-setup-deps.service; invocation ID: 0123\nFinished with result: exit-code\nMain processes terminated with: code=exited/status=1\nMemory peak: 2.0M\n";
  const { driver } = fakeSystemd({ code: 1, stderr: said }, ["npm ERR! missing package-lock.json"]);
  const r = await driver.runOnce({ unit: "sova-hook-h-i-setup-deps", argv: [".sova/bin/setup"], cwd: "/w", env: {}, timeoutSec: 30 });
  assert.equal(r.code, 1);
  assert.equal(r.launchError, undefined);
  assert.equal(r.peakBytes, 2 * 1024 * 1024);
  assert.deepEqual((await driver.logs("sova-hook-h-i-setup-deps", 80)).map((l) => l.text), ["npm ERR! missing package-lock.json"]);
});

/** The real `ps` of this host, its session column hidden as macOS's ps has none: no /proc read anywhere. */
const macLikePs = () => {
  const reads: string[] = [];
  const t = psTable((file, args) => {
    reads.push([file, ...args].join(" "));
    return args.includes("sid=") ? { code: 1, stdout: "" } : realSyncExec(file, args);
  });
  return { t, reads };
};

test("the detached driver on ps alone (no /proc, no session ids): tree and groups, status, stop", async () => {
  const { t, reads } = macLikePs();
  assert.equal(t.sessions, false);
  const d = new DetachedDriver(2_000, { table: t });
  assert.match((await d.available()).detail, /ps \(no session ids: process trees and groups\)/);
  const unit = `sova-svc-test-${process.pid}-ps`;
  // sh's job control puts sleep in a process group of its own, as `pnpm exec` does.
  await d.start({ unit, argv: ["sh", "-c", "set -m; sleep 60 & wait"], cwd: tmpdir(), env: { PATH: process.env.PATH ?? "" } });
  const st = await d.status(unit);
  assert.equal(st.state, "active");
  let pids: number[] = [];
  for (let i = 0; i < 50 && (pids = d.pids(unit)).length < 2; i++) await sleep(50);
  assert.equal(pids.length, 2, `sh and sleep: ${pids}`);
  const sleeper = pids.find((p) => p !== st.pid)!;
  assert.notEqual(t.get(sleeper)!.pgid, st.pid, "the child really is in another process group");
  assert.ok(d.owns(unit, sleeper) && d.owns(unit, st.pid!), "both are the unit's");
  assert.ok(!d.owns(unit, process.pid), "the server is not");
  const rec = JSON.parse(readFileSync(join(procsDir(), `${unit}.json`), "utf8"));
  assert.equal(rec.clock, "ps");
  assert.equal(rec.start, t.startOf(st.pid!), "the start time is ps's lstart");
  await d.stop(unit);
  assert.equal((await d.status(unit)).state, "missing");
  for (const pid of pids) {
    const e = t.get(pid);
    assert.ok(!e || e.zombie, `pid ${pid} stopped`);
  }
  assert.ok(reads.every((r) => r.startsWith("ps ")), "only ps was read");
});

test("the detached driver's restart watch: a crash is started again; a clean exit and a stop are not; a crash loop gives up", async () => {
  const d = new DetachedDriver(1_000, { restart: true, restartMs: 150 });
  const env = { PATH: process.env.PATH ?? "" };
  const crash = `sova-svc-test-${process.pid}-crash`;
  await d.start({ unit: crash, argv: [process.execPath, "-e", "setInterval(()=>{},1000)"], cwd: tmpdir(), env });
  const first = (await d.status(crash)).pid!;
  process.kill(first, "SIGKILL");
  let st = await d.status(crash);
  for (let i = 0; i < 20 && st.state === "active"; i++) st = (await sleep(25), await d.status(crash));
  assert.equal(st.state, "activating", "waiting to be started again, as systemd's auto-restart");
  assert.equal(st.detail, "auto-restart");
  for (let i = 0; i < 60 && !((st = await d.status(crash)).state === "active" && st.pid !== first); i++) await sleep(50);
  assert.equal(st.state, "active");
  assert.notEqual(st.pid, first, "a new process");
  await d.stop(crash);
  await sleep(400);
  assert.equal((await d.status(crash)).state, "missing", "a stop is never undone");

  const clean = `sova-svc-test-${process.pid}-clean`;
  await d.start({ unit: clean, argv: [process.execPath, "-e", "0"], cwd: tmpdir(), env });
  await sleep(600);
  st = await d.status(clean);
  assert.equal(st.state, "inactive", "exit 0 is not a failure");
  assert.equal(st.exit, 0);
  await d.stop(clean);

  const loop = `sova-svc-test-${process.pid}-loop`;
  await d.start({ unit: loop, argv: [process.execPath, "-e", "process.exit(3)"], cwd: tmpdir(), env });
  for (let i = 0; i < 100 && (st = await d.status(loop)).state !== "failed"; i++) await sleep(50);
  assert.equal(st.state, "failed");
  assert.equal(st.detail, "start limit hit");
  await d.stop(loop);
});
