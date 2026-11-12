import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DetachedDriver, RESTART_BURST, RESTART_SEC, restartTickMs } from "./drivers";
import { type ProcEntry, type ProcTable, psTable, realSyncExec } from "./proctable";
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
  assert.equal(st.gaveUp, true);
  assert.match(st.detail ?? "", /^start limit hit: 5 failed starts/);
  await d.stop(loop);
});

test("detached restart watch at the production ratio: a service that runs a moment and fails gives up, stays failed through a server restart, and a start clears it", async () => {
  const root = mkdtempSync(join(tmpdir(), "sova-detached-limit-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = { procsDir: () => join(root, "procs"), logsDir: () => join(root, "logs") };
  // Production is a 2 s delay and a service that runs about a second; here the same ratio, scaled to 100 ms.
  const d = new DetachedDriver(1_000, { restart: true, restartMs: 100, ...dirs });
  const env = { PATH: process.env.PATH ?? "" };
  const unit = `sova-svc-test-${process.pid}-ratio`;
  await d.start({ unit, argv: [process.execPath, "-e", "setTimeout(()=>process.exit(3),50)"], cwd: tmpdir(), env });
  let st = await d.status(unit);
  for (let i = 0; i < 400 && !(st = await d.status(unit)).gaveUp; i++) await sleep(25);
  assert.equal(st.state, "failed", "it gave up");
  assert.equal(st.gaveUp, true);
  const rec = JSON.parse(readFileSync(join(root, "procs", `${unit}.json`), "utf8"));
  assert.ok(rec.gaveUp, "its record keeps it");

  // A server restart: a new driver reads the same records.
  const next = new DetachedDriver(1_000, { restart: true, restartMs: 100, ...dirs });
  await next.adopt();
  st = await next.status(unit);
  assert.equal(st.state, "failed", "still failed after the restart, not waiting to restart");
  assert.equal(st.gaveUp, true);
  await sleep(250);
  assert.ok(!(await next.tick()).some((x) => x.startsWith(unit)), "the watch never starts it again");
  assert.equal((await next.status(unit)).state, "failed");

  // Started by hand (up): a fresh count, and the mark is gone.
  await next.start({ unit, argv: [process.execPath, "-e", "setInterval(()=>{},1000)"], cwd: tmpdir(), env });
  st = await next.status(unit);
  assert.equal(st.state, "active");
  assert.equal(st.gaveUp, undefined);
  assert.equal(JSON.parse(readFileSync(join(root, "procs", `${unit}.json`), "utf8")).gaveUp, undefined, "the new record has no mark");
  await next.stop(unit);
  assert.equal((await next.status(unit)).state, "missing");
});

test("detached restart watch: a failed unit whose pid is now someone else's (another start) is started again without signalling that process", async () => {
  const root = mkdtempSync(join(tmpdir(), "sova-detached-reuse-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const procs = join(root, "procs");
  mkdirSync(procs, { recursive: true });
  writeFileSync(join(procs, "u-reused.json"), JSON.stringify({ pid: 4242, start: "S0", clock: "ps", argv: ["true"], cwd: root, env: {}, at: "" }));
  const entries: ProcEntry[] = [
    { pid: 4242, ppid: 1, pgid: 4242, sid: null, zombie: false },
    { pid: 4243, ppid: 4242, pgid: 4242, sid: null, zombie: false },
  ];
  const table: ProcTable = { kind: "ps", sessions: false, list: () => entries, get: (pid) => entries.find((e) => e.pid === pid) ?? null, startOf: (pid) => (pid === 4242 ? "S9" : null) };
  // Signals are recorded, never sent (the pids are made up).
  const sent: number[] = [];
  const realKill = process.kill;
  process.kill = ((pid: number) => (sent.push(pid), entries.splice(0), true)) as typeof process.kill;
  const d = new DetachedDriver(200, { table, restart: true, restartMs: 100, procsDir: () => procs, logsDir: () => join(root, "logs") });
  let did: string[];
  try {
    await d.tick();
    await sleep(150);
    did = await d.tick();
  } finally {
    process.kill = realKill;
  }
  assert.deepEqual(did, ["u-reused: started again"]);
  assert.deepEqual(sent, [], "nothing signalled at the reused pid");
  await d.stop("u-reused");
});

test("detached restart watch at production timing (2 s delay, 1 s ticks): a service that fails at once gives up after 5 starts, and its record keeps it", async () => {
  const root = mkdtempSync(join(tmpdir(), "sova-detached-prod-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  // No process ever looks alive: each start fails at once. The clock is stepped a watch tick at a time.
  const table: ProcTable = { kind: "ps", sessions: false, list: () => [], get: () => null, startOf: () => null };
  let t = 1_700_000_000_000;
  const d = new DetachedDriver(100, { table, restart: true, restartMs: RESTART_SEC * 1000, procsDir: () => join(root, "procs"), logsDir: () => join(root, "logs"), now: () => t });
  const unit = "u-prod";
  await d.start({ unit, argv: [process.execPath, "-e", "process.exit(3)"], cwd: root, env: {} });
  let starts = 1;
  let gaveUpAt: number | null = null;
  for (let tick = 1; tick <= 60 && gaveUpAt === null; tick++) {
    t += restartTickMs(RESTART_SEC * 1000);
    for (const line of await d.tick()) {
      if (line === `${unit}: started again`) starts++;
      else if (line === `${unit}: start limit hit`) gaveUpAt = tick;
      else assert.fail(line);
    }
  }
  // A fixed 10 s window (the old one) never gets here: a cycle is 3 s, so at most 4 starts fall in any 10 s.
  assert.notEqual(gaveUpAt, null, `gave up (${starts} starts)`);
  assert.equal(starts, RESTART_BURST, "5 starts, then failed");
  const st = await d.status(unit);
  assert.equal(st.state, "failed");
  assert.equal(st.gaveUp, true);
  assert.match(st.detail ?? "", /^start limit hit: 5 failed starts within 30 s/);
  // Much later, still not started again: the mark is in its record, not the window.
  t += 10 * 60_000;
  assert.deepEqual(await d.tick(), []);
  assert.equal((await d.status(unit)).gaveUp, true);
  await d.stop(unit);
});
