// Run: npx tsx --test server/resource-monitor.test.ts
// The sampler end to end over a fixture /proc and cgroup tree (injectable roots), with hosted
// sessions injected; nothing real is read and ~/.pi is never touched.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "sova-monitor-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent"); // before paths.ts computes its dirs
after(() => rmSync(root, { recursive: true, force: true }));

const { ResourceMonitor, decodeWorkerEvent, monitorExtension } = await import("./resource-monitor");
type HostedInfo = import("./resource-monitor-attrib").HostedInfo;

const BOOT = 1_790_000_000; // btime, seconds
const HZ = 100;
const SERVER = 100;
const UNIT = "/user.slice/user-1000.slice/user@1000.service/app.slice/sova-runtime.service";

interface P {
  pid: number;
  ppid: number;
  sid?: number;
  argv: string[];
  env?: Record<string, string>;
  cwd?: string;
  utime?: number;
  cutime?: number;
  /** Seconds after boot. */
  start?: number;
  rssPages?: number;
  swapKb?: number;
}

/** Write a fake /proc (and, for `unit`, a cgroup) holding `procs`. Rewrites stat on each call. */
function fixture(name: string, procs: P[], opts: { unit: boolean; cgroupUsec?: number; managerComm?: string }) {
  const proc = join(root, name, "proc");
  const cg = join(root, name, "cgroup");
  mkdirSync(proc, { recursive: true });
  writeFileSync(join(proc, "stat"), `cpu 1 2 3\nbtime ${BOOT}\n`);
  writeFileSync(join(proc, "meminfo"), "MemTotal: 64000000 kB\nMemAvailable: 32000000 kB\nSwapTotal: 8000000 kB\nSwapFree: 7000000 kB\n");
  writeFileSync(join(proc, "loadavg"), "3.50 2.00 1.00 2/500 999\n");
  mkdirSync(join(proc, "pressure"), { recursive: true });
  writeFileSync(join(proc, "pressure", "cpu"), "some avg10=7.50 avg60=1 avg300=0 total=1\n");
  const selfPath = opts.unit ? UNIT : "/user.slice/user-1000.slice/user@1000.service/app.slice/app-tmux.scope";
  // The server's parent (pid 1 here): the service manager, unless a test says otherwise.
  mkdirSync(join(proc, "1"), { recursive: true });
  writeFileSync(join(proc, "1", "comm"), `${opts.managerComm ?? "systemd"}\n`);
  for (const p of procs) {
    const d = join(proc, String(p.pid));
    mkdirSync(join(d, "task", String(p.pid)), { recursive: true });
    const f = Array.from({ length: 50 }, () => "0");
    const set = (field: number, v: number) => { f[field - 3] = String(v); };
    f[0] = "S";
    set(4, p.ppid); set(5, p.sid ?? p.pid); set(6, p.sid ?? p.pid); set(14, p.utime ?? 0); set(16, p.cutime ?? 0);
    set(22, (p.start ?? 1000) * HZ); set(24, p.rssPages ?? 256);
    writeFileSync(join(d, "stat"), `${p.pid} (${p.argv[0]}) ${f.join(" ")}\n`);
    writeFileSync(join(d, "status"), `Name:\tx\nVmRSS:\t${(p.rssPages ?? 256) * 4} kB\nVmSwap:\t${p.swapKb ?? 0} kB\n`);
    writeFileSync(join(d, "cmdline"), p.argv.join("\0") + "\0");
    writeFileSync(join(d, "comm"), `${p.argv[0]}\n`);
    writeFileSync(join(d, "environ"), Object.entries(p.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\0") + "\0");
    writeFileSync(join(d, "cgroup"), `0::${selfPath}\n`);
    if (p.cwd) try { symlinkSync(p.cwd, join(d, "cwd")); } catch { /* exists */ }
    const kids = procs.filter((c) => c.ppid === p.pid).map((c) => c.pid).join(" ");
    writeFileSync(join(d, "task", String(p.pid), "children"), kids ? kids + " " : "");
  }
  // Processes no longer listed are gone.
  for (const name of readdirSync(proc)) if (/^\d+$/.test(name) && name !== "1" && !procs.some((p) => String(p.pid) === name)) rmSync(join(proc, name), { recursive: true });
  if (opts.unit) {
    const u = join(cg, UNIT);
    mkdirSync(u, { recursive: true });
    writeFileSync(join(u, "cgroup.procs"), procs.map((p) => p.pid).join("\n") + "\n");
    writeFileSync(join(u, "cpu.stat"), `usage_usec ${opts.cgroupUsec ?? 0}\nuser_usec 0\nsystem_usec 0\n`);
    writeFileSync(join(u, "memory.current"), "17500000000\n");
    writeFileSync(join(u, "memory.peak"), "20000000000\n");
    writeFileSync(join(u, "memory.stat"), "anon 9980000000\nfile 7300000000\nshmem 730000000\n");
    writeFileSync(join(u, "memory.swap.current"), "1000000\n");
    writeFileSync(join(u, "memory.events"), "low 0\nhigh 0\nmax 0\noom 1\noom_kill 1\n");
    writeFileSync(join(u, "memory.pressure"), "some avg10=2.00 avg60=0 avg300=0 total=0\nfull avg10=1.00 avg60=0 avg300=0 total=0\n");
  }
  return { proc, cg };
}

const hostedA = (over: Partial<HostedInfo> = {}): HostedInfo => ({
  path: "/s/a.jsonl", sessionId: "sess-a", cwd: "/work/a", title: "Fix the build",
  workers: [{ id: "ag_01", name: "tester", status: "running", backend: "claude-code", pid: 200 }], providerIds: [], toolInWindow: false, ...over,
});

describe("sampler over a fixture /proc", () => {
  test("unit scope: attribution, subtree CPU with a reaped child, escaped, unit counters, history and the disk log", async () => {
    let now = BOOT * 1000 + 2_000_000; // sampling starts long after these processes did
    let hosted = [hostedA()];
    const base: P[] = [
      { pid: SERVER, ppid: 1, argv: ["node", "--import", "tsx", "server/index.ts"], utime: 5000, rssPages: 25_600 },
      { pid: 200, ppid: SERVER, argv: ["claude", "-p", "--model", "opus"], utime: 100, rssPages: 65_536 },
      { pid: 201, ppid: 200, sid: 201, argv: ["zsh", "-c", "clojure -M:test"], utime: 1 },
      { pid: 202, ppid: 201, sid: 201, argv: ["java", "-cp", "a.jar", "clojure.main"], utime: 1000, rssPages: 262_144, swapKb: 2048 },
      { pid: 300, ppid: 1511, sid: 300, argv: ["node", "vite"], env: { PI_SESSION_FILE: "/s/a.jsonl" }, utime: 50 },
      { pid: 400, ppid: 1511, argv: ["python3", "-m", "http.server"], cwd: "/elsewhere" },
    ];
    let fx = fixture("unit", base, { unit: true, cgroupUsec: 0 });
    const logDir = join(root, "unit-log");
    const m = new ResourceMonitor({ procRoot: fx.proc, cgroupRoot: fx.cg, logDir, serverPid: SERVER, now: () => now, hosted: () => hosted,
      eventLoop: false, platform: "linux", clkTck: HZ });
    assert.equal(m.scope, "unit");
    await m.tick(); // baseline

    // 5s later: the JVM burned 2.5s of CPU; the worker's cutime shows a 1s tsc that came and went.
    now += 5000;
    fx = fixture("unit", base.map((p) => p.pid === 202 ? { ...p, utime: 1250 } : p.pid === 200 ? { ...p, utime: 110, cutime: 100 } : p),
      { unit: true, cgroupUsec: 3_700_000 });
    await m.tick();
    const s = m.snapshot()!;
    assert.equal(s.scope, "unit");
    assert.equal(s.unitName, "sova-runtime.service");
    const a = s.sessions.find((x) => x.sessionPath === "/s/a.jsonl")!;
    assert.equal(a.title, "Fix the build");
    const w = a.workers[0]!;
    assert.equal(w.id, "ag_01");
    assert.equal(w.pid, 200);
    assert.equal(w.via, "worker-pid");
    // 10 own + 100 reaped + 250 JVM ticks over 5s = 3.6s of CPU = 72% of one core.
    assert.equal(w.cpuPct, 72);
    assert.equal(w.procCount, 3);
    assert.equal(w.top[0]!.cmd, "java … clojure.main");
    assert.equal(w.top[0]!.cpuPct, 50);
    assert.equal(w.top[0]!.rssBytes, 262_144 * 4096);
    assert.equal(w.top[0]!.swapBytes, 2048 * 1024);
    assert.equal(w.status, "running");
    // The escaped vite is charged to the session by its env, and listed under escaped too.
    assert.ok(a.own.some((p) => p.pid === 300 && p.via === "env"));
    assert.deepEqual(s.escaped.procs.map((p) => p.pid).sort(), [300, 400]);
    // Totals cover only the uncharged one (vite counts in its session).
    assert.equal(s.escaped.procCount, 1);
    assert.equal(s.escaped.procs.find((p) => p.pid === 400)!.cwd, "/elsewhere");
    assert.equal(s.escaped.procs.find((p) => p.pid === 400)!.sessionPath, undefined);
    // Unit counters: anon apart from page cache.
    assert.deepEqual(s.unit!.memory, { current: 17_500_000_000, anon: 9_980_000_000, file: 7_300_000_000, shmem: 730_000_000, peak: 20_000_000_000 });
    assert.equal(s.unit!.oomKills, 1);
    assert.equal(s.unit!.cpuPct, 74);
    assert.deepEqual(s.host.loadavg, [3.5, 2, 1]);
    assert.deepEqual(s.host.pressure, { cpu: { some: 7.5 } });
    assert.equal(s.host.swapTotalBytes - s.host.swapFreeBytes, 1_000_000 * 1024);
    assert.equal(s.totals.procCount, 6);
    assert.equal(s.totals.cpuPct, 72);
    assert.equal(s.topProcs[0]!.pid, 202);
    assert.ok(s.sampler.lastTickMs >= 0 && s.sampler.ticks === 2);
    assert.ok(s.notes.some((n) => /RSS/.test(n)));

    // History: two 5s points whose groups partition the total.
    const h = await m.history(0, "5s");
    assert.equal(h.points.length, 2);
    const last = h.points[1]!;
    assert.equal(last.groups["/s/a.jsonl"]![0], 72);
    assert.equal(last.workers["/s/a.jsonl"]!.ag_01![0], 72);
    assert.equal(h.groups["/s/a.jsonl"]!.label, "Fix the build");
    assert.equal(last.anonBytes, 9_980_000_000);

    // Four more ticks make six: one 30s line on disk.
    for (let i = 0; i < 4; i++) {
      now += 5000;
      await m.tick();
    }
    await new Promise((r) => setTimeout(r, 50));
    const lines = readdirSync(logDir).flatMap((f) => readFileSync(join(logDir, f), "utf8").trim().split("\n"));
    assert.equal(lines.length, 1);
    const line = JSON.parse(lines[0]!);
    assert.equal(line.v, 1);
    assert.equal(line.cpuPctMax, 72);
    assert.equal((await m.history(0, "30s")).points.length, 1);

    // A new worker the runtime has not published: unowned, not dropped.
    hosted = [hostedA({ workers: [] })];
    now += 5000;
    fx = fixture("unit", [...base, { pid: 500, ppid: SERVER, argv: ["pi"], start: now / 1000 - BOOT, utime: 30 }], { unit: true });
    await m.tick();
    // First listed this tick: read from the next one (it would have been charged to its parent
    // had it exited meanwhile).
    assert.equal(m.snapshot()!.unownedWorkers.find((x) => x.id === "unowned:500"), undefined);
    assert.equal(m.lastPhases.deferred, 1);
    now += 5000;
    await m.tick();
    const u = m.snapshot()!.unownedWorkers.find((x) => x.id === "unowned:500")!;
    assert.ok(u, "unowned pi worker");
    assert.equal(u.cpuPct, 6, "a fresh process counts its whole life");
    assert.equal(m.snapshot()!.unownedWorkers.find((x) => x.id === "unowned:200")?.procCount, 3, "ag_01 lost its pid: its subtree stays together");
  });

  test("exited server children: charged to the one hosted session running a tool, labelled a heuristic", async () => {
    let now = BOOT * 1000 + 2_000_000;
    const base: P[] = [{ pid: SERVER, ppid: 1, argv: ["node", "server/index.ts"] }];
    let fx = fixture("exited", base, { unit: false });
    let hosted = [hostedA({ workers: [], toolInWindow: true }), { ...hostedA({ workers: [] }), path: "/s/b.jsonl", sessionId: "b" }];
    const m = new ResourceMonitor({ procRoot: fx.proc, logDir: join(root, "exited-log"), serverPid: SERVER, now: () => now,
      hosted: () => hosted, eventLoop: false, platform: "linux", clkTck: HZ });
    assert.equal(m.scope, "tree");
    await m.tick();
    now += 5000;
    fx = fixture("exited", [{ ...base[0]!, cutime: 200 }], { unit: false });
    await m.tick();
    let s = m.snapshot()!;
    const own = s.sessions.find((x) => x.sessionPath === "/s/a.jsonl")!.own[0]!;
    assert.deepEqual([own.cmd, own.cpuPct, own.via], ["(exited tool children)", 40, "exited-tools"]);
    assert.ok(s.notes.some((n) => /process tree only/.test(n)));
    // Two sessions ran tools: nobody is guessed.
    hosted = hosted.map((h) => ({ ...h, toolInWindow: true }));
    now += 5000;
    fixture("exited", [{ ...base[0]!, cutime: 300 }], { unit: false });
    await m.tick();
    s = m.snapshot()!;
    assert.equal(s.unattributed.procs[0]!.cmd, "(exited server children)");
    assert.equal(s.unattributed.cpuPct, 20);
  });

  test("a child listed once and gone before its first read is charged to its parent, once", async () => {
    let now = BOOT * 1000 + 2_000_000;
    const base: P[] = [{ pid: SERVER, ppid: 1, argv: ["node"] }, { pid: 200, ppid: SERVER, argv: ["claude", "-p"], utime: 10 }];
    let fx = fixture("deferred", base, { unit: true });
    const m = new ResourceMonitor({ procRoot: fx.proc, cgroupRoot: fx.cg, logDir: join(root, "deferred-log"), serverPid: SERVER, now: () => now,
      hosted: () => [hostedA()], eventLoop: false, platform: "linux", clkTck: HZ });
    await m.tick();
    now += 5000;
    fx = fixture("deferred", [...base, { pid: 600, ppid: 200, argv: ["node", "tsc"], start: now / 1000 - BOOT, utime: 40 }], { unit: true });
    await m.tick();
    assert.equal(m.snapshot()!.sessions[0]!.workers[0]!.procCount, 1, "not read yet");
    now += 5000;
    fx = fixture("deferred", [base[0]!, { ...base[1]!, cutime: 150 }], { unit: true });
    await m.tick();
    assert.equal(m.snapshot()!.sessions[0]!.workers[0]!.cpuPct, 30, "150 ticks of reaped tsc over 5s");
  });

  test("an idle process is re-read less often, and what it spent meanwhile still lands, once", async () => {
    let now = BOOT * 1000 + 2_000_000;
    const server: P = { pid: SERVER, ppid: 1, argv: ["node"] };
    const worker: P = { pid: 203, ppid: SERVER, argv: ["claude", "-p"], utime: 10 };
    let fx = fixture("idle", [server, worker], { unit: true });
    const m = new ResourceMonitor({ procRoot: fx.proc, cgroupRoot: fx.cg, logDir: join(root, "idle-log"), serverPid: SERVER, now: () => now,
      hosted: () => [hostedA({ workers: [{ id: "ag_01", pid: 203 }] })], eventLoop: false, platform: "linux", clkTck: HZ });
    for (let i = 0; i < 4; i++) {
      await m.tick();
      now += 5000;
    }
    // Idle long enough: it wakes (its own 100 ticks, plus a reaped child's 200) while not re-read.
    fx = fixture("idle", [server, { ...worker, utime: 110, cutime: 200 }], { unit: true });
    const stales: number[] = [];
    for (let i = 0; i < 6; i++) {
      await m.tick();
      stales.push(m.lastPhases.stale!);
      now += 5000;
    }
    assert.ok(stales.some((n) => n > 0), "it was skipped at least once");
    const spent = (await m.history(0, "5s")).points.reduce((sum, p) => sum + (p.workers["/s/a.jsonl"]?.ag_01?.[0] ?? 0), 0);
    assert.equal(spent, 60, "300 ticks over 5s, counted exactly once across the ticks");
  });

  test("a held session with no listener (a special loadout): its Claude Code provider by --session-id", async () => {
    const { claudeSessionId } = await import("../pi-config/extensions/claude-code/provider/session-records.ts");
    const fx = fixture("held", [
      { pid: SERVER, ppid: 1, argv: ["node"] },
      { pid: 210, ppid: SERVER, argv: ["claude", "-p", "--session-id", claudeSessionId("baton-1", 1), "--model", "sonnet"] },
    ], { unit: false });
    const m = new ResourceMonitor({ procRoot: fx.proc, logDir: join(root, "held-log"), serverPid: SERVER, eventLoop: false, platform: "linux",
      held: () => [{ path: "/s/baton.jsonl", sessionId: "baton-1" }] });
    await m.tick();
    const own = m.snapshot()!.sessions.find((x) => x.sessionPath === "/s/baton.jsonl")!.own[0]!;
    assert.deepEqual([own.pid, own.kind, own.via], [210, "claude-provider", "session-id"]);
  });

  test("a .service cgroup the server merely inherited (started from a shell in the unit) is tree scope", () => {
    const fx = fixture("inherited", [{ pid: SERVER, ppid: 1, argv: ["node"] }], { unit: true, managerComm: "zsh" });
    const m = new ResourceMonitor({ procRoot: fx.proc, cgroupRoot: fx.cg, logDir: join(root, "inherited-log"), serverPid: SERVER,
      eventLoop: false, platform: "linux", hosted: () => [] });
    assert.equal(m.scope, "tree");
  });

  test("Claude Code tool children by CLAUDE_PID / CLAUDE_CODE_SESSION_ID, even escaped; the server's own values say nothing", async () => {
    const uuid = "3586816f-1111-2222-3333-444444444444";
    const procs: P[] = [
      { pid: SERVER, ppid: 1, argv: ["node"] },
      { pid: 200, ppid: SERVER, argv: ["claude", "-p"] },
      { pid: 310, ppid: 1511, argv: ["node", "bg.js"], env: { CLAUDE_PID: "200" } },
      { pid: 311, ppid: 1511, argv: ["node", "bg2.js"], env: { CLAUDE_CODE_SESSION_ID: uuid } },
    ];
    const fx = fixture("claude-env", procs, { unit: true });
    const m = new ResourceMonitor({ procRoot: fx.proc, cgroupRoot: fx.cg, logDir: join(root, "claude-env-log"), serverPid: SERVER,
      eventLoop: false, platform: "linux", hosted: () => [hostedA({ workers: [{ id: "ag_01", pid: 200, sessionId: uuid }] })] });
    await m.tick();
    const w = m.snapshot()!.sessions[0]!.workers[0]!;
    assert.deepEqual(w.top.map((p) => [p.pid, p.via]).sort(), [[310, "env"], [311, "env"]]);
  });

  test("tree scope follows the server's children; a process outside it is not measured", async () => {
    const now = BOOT * 1000 + 2_000_000;
    const fx = fixture("tree", [
      { pid: SERVER, ppid: 1, argv: ["node", "server/index.ts"] },
      { pid: 200, ppid: SERVER, argv: ["claude", "-p"] },
      { pid: 201, ppid: 200, argv: ["node", "tsc"] },
      { pid: 999, ppid: 1, argv: ["firefox"] },
    ], { unit: false });
    const m = new ResourceMonitor({ procRoot: fx.proc, logDir: join(root, "tree-log"), serverPid: SERVER, now: () => now,
      hosted: () => [hostedA()], eventLoop: false, platform: "linux", clkTck: HZ });
    await m.tick();
    const s = m.snapshot()!;
    assert.equal(s.totals.procCount, 3);
    assert.equal(s.unit, undefined);
    assert.equal(s.escaped.procCount, 0);
    assert.equal(s.sessions[0]!.workers[0]!.procCount, 2);
  });

  test("no /proc: the server's own numbers only, and a note that says so", async () => {
    const m = new ResourceMonitor({ procRoot: join(root, "nothing"), logDir: join(root, "none-log"), eventLoop: false, platform: "darwin", hosted: () => [] });
    await m.tick();
    const s = m.snapshot()!;
    assert.equal(s.scope, "none");
    assert.equal(s.totals.procCount, 0);
    assert.ok(s.server.heapUsedBytes > 0);
    assert.ok(s.notes.some((n) => /need Linux/.test(n)));
  });

  test("a tick that finds the previous one running is skipped and counted", async () => {
    const fx = fixture("skip", [{ pid: SERVER, ppid: 1, argv: ["node"] }], { unit: false });
    const m = new ResourceMonitor({ procRoot: fx.proc, logDir: join(root, "skip-log"), serverPid: SERVER, eventLoop: false, platform: "linux", hosted: () => [] });
    await Promise.all([m.tick(), m.tick()]);
    assert.equal(m.snapshot()!.sampler.skipped, 1);
    assert.equal(m.snapshot()!.sampler.ticks, 1);
  });
});

test("decodeWorkerEvent keeps only well-typed fields (pid included), and rejects other versions", () => {
  assert.deepEqual(decodeWorkerEvent({ version: 1, workers: [
    { id: "ag_01", name: "a", status: "waiting", pid: 4242, sessionId: "u", lastActivity: 5, preview: "secret task text", cwd: "/x" },
    { id: "ag_02", pid: -3, name: 7 },
    { name: "no id" },
  ] }), [
    { id: "ag_01", name: "a", status: "waiting", pid: 4242, sessionId: "u", lastActivity: 5 },
    { id: "ag_02" },
  ]);
  assert.equal(decodeWorkerEvent({ version: 2, workers: [] }), null);
  assert.equal(decodeWorkerEvent(null), null);
});

test("the runtime listener: registers its session, takes worker pids off the event, tracks tools, and leaves on shutdown", async () => {
  const handlers = new Map<string, ((e: unknown, ctx: unknown) => void)[]>();
  const bus = new Map<string, ((d: unknown) => void)[]>();
  const emitted: string[] = [];
  const pi = {
    on: (name: string, fn: (e: unknown, ctx: unknown) => void) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    events: {
      on: (name: string, fn: (d: unknown) => void) => { bus.set(name, [...(bus.get(name) ?? []), fn]); return () => {}; },
      emit: (name: string) => { emitted.push(name); },
    },
  };
  const fire = (name: string, ctx: unknown = {}) => { for (const fn of handlers.get(name) ?? []) fn({}, ctx); };
  monitorExtension(pi as never);
  // The snapshot can arrive before session_start (the subagents extension answers early).
  for (const fn of bus.get("subagents:workers-snapshot")!) fn({ version: 1, workers: [{ id: "ag_01", name: "w", status: "running", pid: 200 }] });
  const ctx = { cwd: "/work/a", sessionManager: { getSessionFile: () => "/s/listener.jsonl", getSessionId: () => "sid-l", getSessionName: () => "Named" } };
  fire("session_start", ctx);
  assert.ok(emitted.includes("subagents:workers-request"), "asks for the workers at start");
  const fx = fixture("listener", [{ pid: SERVER, ppid: 1, argv: ["node"] }, { pid: 200, ppid: SERVER, argv: ["claude", "-p"] }], { unit: false });
  const m = new ResourceMonitor({ procRoot: fx.proc, logDir: join(root, "listener-log"), serverPid: SERVER, eventLoop: false, platform: "linux" });
  fire("tool_execution_start");
  await m.tick();
  const row = m.snapshot()!.sessions.find((x) => x.sessionPath === "/s/listener.jsonl")!;
  assert.equal(row.title, "Named");
  assert.equal(row.cwd, "/work/a");
  assert.deepEqual([row.workers[0]!.id, row.workers[0]!.pid, row.workers[0]!.via], ["ag_01", 200, "worker-pid"]);
  fire("session_shutdown");
  await m.tick();
  assert.equal(m.snapshot()!.sessions.find((x) => x.sessionPath === "/s/listener.jsonl"), undefined);
  assert.equal(m.snapshot()!.unownedWorkers[0]!.id, "unowned:200");
});
