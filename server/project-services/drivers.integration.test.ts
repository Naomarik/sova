import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DetachedDriver } from "./drivers";
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The detached driver on real processes; the systemd driver (a faked exec) and the pure parts are in drivers.test.ts.
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
  // The watch restarts only recorded units: a stopped one has no record, so no tick can start it again.
  assert.ok(!(await d.units("")).includes(crash), "its record is gone");
  assert.ok(!(await d.tick()).some((x) => x.startsWith(crash)), "a tick passes it by");
  assert.equal((await d.status(crash)).state, "missing", "a stop is never undone");

  const clean = `sova-svc-test-${process.pid}-clean`;
  await d.start({ unit: clean, argv: [process.execPath, "-e", "0"], cwd: tmpdir(), env });
  // Until it has exited (a poll with a generous hang guard); a failure would read activating (auto-restart) here.
  for (let i = 0; i < 600 && (st = await d.status(clean)).state === "active"; i++) await sleep(50);
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
