import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DetachedDriver, parseShow, SystemdDriver, systemdRunArgv, type Exec } from "./drivers";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-drivers-"));

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
  const gone = (pid: number) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
    } catch {
      return true;
    }
  };
  for (const pid of group) assert.ok(gone(pid), `pid ${pid} is gone`);
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
  const pgrp = (pid: number) => Number(readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[2]);
  assert.notEqual(pgrp(sleeper), pgrp(st.pid!), "the child really is in another process group");
  assert.ok(d.owns(unit, sleeper), "and still the unit's");
  await d.stop(unit);
  for (const pid of pids) {
    let gone = false;
    try {
      gone = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.startsWith("Z");
    } catch {
      gone = true;
    }
    assert.ok(gone, `pid ${pid} stopped`);
  }
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
  assert.equal(missing.code, 127);
});
