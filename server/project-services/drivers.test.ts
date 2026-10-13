import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DetachedDriver, parseShow, SystemdDriver, systemdRunArgv, type Exec } from "./drivers";
import type { ProcEntry, ProcTable } from "./proctable";

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


test("detached: a recorded pid now someone else's (another start) is never signalled by a stop; a gone leader's own orphans still are (the restart watch: drivers.integration.test.ts)", async () => {
  const root = mkdtempSync(join(tmpdir(), "sova-detached-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const procs = join(root, "procs");
  mkdirSync(procs, { recursive: true });
  const record = (unit: string, pid: number) =>
    writeFileSync(join(procs, `${unit}.json`), JSON.stringify({ pid, start: "S0", clock: "ps", argv: ["true"], cwd: root, env: {}, at: "" }));
  // Without session ids (macOS): a unit is its leader's tree and groups.
  let entries: ProcEntry[] = [];
  const starts = new Map<number, string>();
  const table: ProcTable = {
    kind: "ps",
    sessions: false,
    list: () => entries,
    get: (pid) => entries.find((e) => e.pid === pid) ?? null,
    startOf: (pid) => starts.get(pid) ?? null,
  };
  // Signals are recorded, never sent (the pids are made up).
  const sent: [number, string][] = [];
  const realKill = process.kill;
  process.kill = ((pid: number, sig: NodeJS.Signals) => {
    sent.push([pid, sig]);
    entries = entries.filter((e) => e.pid !== pid);
    return true;
  }) as typeof process.kill;
  after(() => void (process.kill = realKill));
  const d = new DetachedDriver(200, { table, procsDir: () => procs, logsDir: () => join(root, "logs") });
  // pid 4242 was the unit's; now an unrelated process (another start) leads its own tree there.
  entries = [
    { pid: 4242, ppid: 1, pgid: 4242, sid: null, zombie: false },
    { pid: 4243, ppid: 4242, pgid: 4242, sid: null, zombie: false },
  ];
  starts.set(4242, "S9");
  record("u-reused", 4242);
  assert.equal((await d.status("u-reused")).state === "active", false, "not taken for the unit");
  await d.stop("u-reused");
  assert.deepEqual(sent, [], "nothing signalled");
  assert.equal(existsSync(join(procs, "u-reused.json")), false, "the stale record goes");
  // The leader is gone, its group's members remain (the pid can't be reused while its group lives): they go.
  entries = [{ pid: 5001, ppid: 1, pgid: 5000, sid: null, zombie: false }];
  record("u-orphans", 5000);
  await d.stop("u-orphans");
  assert.deepEqual(sent, [[5001, "SIGTERM"]]);
  // The recorded process itself (same start): signalled.
  sent.length = 0;
  entries = [{ pid: 6000, ppid: 1, pgid: 6000, sid: null, zombie: false }];
  starts.set(6000, "S0");
  record("u-own", 6000);
  await d.stop("u-own");
  assert.deepEqual(sent, [[6000, "SIGTERM"]]);
  process.kill = realKill;
});

test("detached, with session ids: a process in the session of a recorded pid now someone else's is not the unit's", () => {
  const root = mkdtempSync(join(tmpdir(), "sova-detached-own-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const procs = join(root, "procs");
  mkdirSync(procs, { recursive: true });
  writeFileSync(join(procs, "u.json"), JSON.stringify({ pid: 7000, start: "S0", clock: "procfs", argv: ["true"], cwd: root, env: {}, at: "" }));
  const entries: ProcEntry[] = [
    { pid: 7000, ppid: 1, pgid: 7000, sid: 7000, zombie: false },
    { pid: 7001, ppid: 7000, pgid: 7000, sid: 7000, zombie: false },
  ];
  let start = "S9";
  const table: ProcTable = { kind: "procfs", sessions: true, list: () => entries, get: (pid) => entries.find((e) => e.pid === pid) ?? null, startOf: (pid) => (pid === 7000 ? start : null) };
  const d = new DetachedDriver(200, { table, procsDir: () => procs, logsDir: () => join(root, "logs") });
  assert.equal(d.owns("u", 7001), false, "a later session leader's member");
  start = "S0";
  assert.equal(d.owns("u", 7001), true, "the unit's own");
});
