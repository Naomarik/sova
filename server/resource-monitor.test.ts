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

const { ResourceMonitor, decodeWorkerEvent, monitorExtension, setRemoteHosted, CLAUDE_CODE_PROVIDER } = await import("./resource-monitor");
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
  /** Shared resident pages (statm's third field): resident less these is the process's own memory. */
  sharedPages?: number;
  swapKb?: number;
  /** A cgroup of its own (a chat's unit), relative to the cgroup root; written with its cgroup.procs. */
  cgroup?: string;
}

/** Write a fake /proc (and, for `unit`, a cgroup) holding `procs`. Rewrites stat on each call. */
function fixture(name: string, procs: P[], opts: { unit: boolean; cgroupUsec?: number; managerComm?: string; execPid?: number }) {
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
    writeFileSync(join(d, "statm"), `${(p.rssPages ?? 256) * 4} ${p.rssPages ?? 256} ${p.sharedPages ?? 0} 1 0 1 0\n`);
    writeFileSync(join(d, "status"), `Name:\tx\nVmRSS:\t${(p.rssPages ?? 256) * 4} kB\nVmSwap:\t${p.swapKb ?? 0} kB\n`);
    writeFileSync(join(d, "cmdline"), p.argv.join("\0") + "\0");
    writeFileSync(join(d, "comm"), `${p.argv[0]}\n`);
    // systemd's SYSTEMD_EXEC_PID names the unit's main process; every child inherits it.
    const env = { ...(opts.unit ? { SYSTEMD_EXEC_PID: String(opts.execPid ?? SERVER) } : {}), ...p.env };
    writeFileSync(join(d, "environ"), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\0") + "\0");
    writeFileSync(join(d, "cgroup"), `0::${p.cgroup ?? selfPath}\n`);
    if (p.cwd) try { symlinkSync(p.cwd, join(d, "cwd")); } catch { /* exists */ }
    const kids = procs.filter((c) => c.ppid === p.pid).map((c) => c.pid).join(" ");
    writeFileSync(join(d, "task", String(p.pid), "children"), kids ? kids + " " : "");
  }
  for (const path of new Set(procs.flatMap((p) => (p.cgroup ? [p.cgroup] : [])))) {
    mkdirSync(join(cg, path), { recursive: true });
    writeFileSync(join(cg, path, "cgroup.procs"), procs.filter((p) => p.cgroup === path).map((p) => p.pid).join("\n") + "\n");
  }
  // Processes no longer listed are gone.
  for (const name of readdirSync(proc)) if (/^\d+$/.test(name) && name !== "1" && !procs.some((p) => String(p.pid) === name)) rmSync(join(proc, name), { recursive: true });
  if (opts.unit) {
    const u = join(cg, UNIT);
    mkdirSync(u, { recursive: true });
    writeFileSync(join(u, "cgroup.procs"), procs.filter((p) => !p.cgroup).map((p) => p.pid).join("\n") + "\n");
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
    assert.ok(s.notes.some((n) => /each process's own memory/.test(n)));

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
    assert.equal(line.v, 2);
    assert.equal(line.cpuPctMax, 72);
    assert.equal((await m.history(0, "30s")).points.length, 1);

    // A new worker the runtime has not published: unowned, not dropped.
    hosted = [hostedA({ workers: [] })];
    now += 5000;
    fx = fixture("unit", [...base, { pid: 500, ppid: SERVER, argv: ["claude", "-p"], start: now / 1000 - BOOT, utime: 30 }], { unit: true });
    await m.tick();
    // First listed this tick: read from the next one (it would have been charged to its parent
    // had it exited meanwhile).
    assert.equal(m.snapshot()!.unownedWorkers.find((x) => x.id === "unowned:500"), undefined);
    assert.equal(m.lastPhases.deferred, 1);
    now += 5000;
    await m.tick();
    const u = m.snapshot()!.unownedWorkers.find((x) => x.id === "unowned:500")!;
    assert.ok(u, "unowned Claude CLI");
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

  test("a worker chat's process (its mirror names the worker) is its parent's worker row, never a session of its own", async () => {
    const fx = fixture("worker-chat", [
      { pid: SERVER, ppid: 1, argv: ["node"] },
      { pid: 450, ppid: SERVER, argv: ["bun", "server/chat-runtime/main.ts"] },
      { pid: 500, ppid: SERVER, argv: ["bun", "server/chat-runtime/main.ts"], utime: 10 }, // child placement
      { pid: 501, ppid: 500, argv: ["zsh", "-c", "make"] },
    ], { unit: false });
    const m = new ResourceMonitor({ procRoot: fx.proc, logDir: join(root, "worker-chat-log"), serverPid: SERVER, eventLoop: false, platform: "linux" });
    const facts = { workers: [], toolsRunning: 0, lastToolEnd: 0 };
    setRemoteHosted("/s/a.jsonl", { sessionId: "sess-a", ...facts, workers: [{ id: "ag_09", name: "tester", status: "running" }], pid: 450 });
    setRemoteHosted("/s/w.jsonl", { sessionId: "sess-w", ...facts, toolsRunning: 1, pid: 500, worker: { parentPath: "/s/a.jsonl", parentSessionId: "sess-a", workerId: "ag_09" } });
    try {
      await m.tick();
      const s = m.snapshot()!;
      assert.deepEqual(s.sessions.map((x) => x.sessionPath), ["/s/a.jsonl"]);
      const w = s.sessions[0]!.workers[0]!;
      assert.deepEqual([w.id, w.name, w.pid, w.via, w.procCount], ["ag_09", "tester", 500, "worker-pid", 2]);
    } finally {
      setRemoteHosted("/s/a.jsonl", null);
      setRemoteHosted("/s/w.jsonl", null);
    }
  });

  test("chats in units of their own are measured with their whole unit, charged to their session or parent's worker, never escaped", async () => {
    const CHATS = "/user.slice/user-1000.slice/user@1000.service/sova-chats.slice";
    const procs = (): P[] => [
      { pid: SERVER, ppid: 1, argv: ["node"] },
      { pid: 450, ppid: 1, argv: ["bun", "server/chat-runtime/main.ts"], cgroup: `${CHATS}/sova-chat-a.service` },
      { pid: 451, ppid: 450, argv: ["zsh", "-c", "make"], cgroup: `${CHATS}/sova-chat-a.service` },
      { pid: 452, ppid: 1, sid: 452, argv: ["node", "vite"], cgroup: `${CHATS}/sova-chat-a.service` }, // setsid'd, reparented
      { pid: 500, ppid: 1, argv: ["bun", "server/chat-runtime/main.ts"], cgroup: `${CHATS}/sova-chat-w.service` },
      { pid: 501, ppid: 500, argv: ["zsh", "-c", "make"], cgroup: `${CHATS}/sova-chat-w.service` },
    ];
    const facts = { workers: [], toolsRunning: 0, lastToolEnd: 0 };
    setRemoteHosted("/s/a.jsonl", { sessionId: "sess-a", ...facts, workers: [{ id: "ag_09", name: "tester", status: "running" }], pid: 450 });
    setRemoteHosted("/s/w.jsonl", { sessionId: "sess-w", ...facts, pid: 500, worker: { parentPath: "/s/a.jsonl", parentSessionId: "sess-a", workerId: "ag_09" } });
    try {
      for (const unit of [true, false]) {
        const fx = fixture(unit ? "chat-units" : "chat-units-tree", procs(), { unit });
        const m = new ResourceMonitor({ procRoot: fx.proc, cgroupRoot: fx.cg, logDir: join(root, `chat-units-${unit}-log`), serverPid: SERVER,
          eventLoop: false, platform: "linux", clkTck: HZ });
        assert.equal(m.scope, unit ? "unit" : "tree");
        await m.tick();
        const s = m.snapshot()!;
        assert.deepEqual(s.sessions.map((x) => x.sessionPath), ["/s/a.jsonl"]);
        const a = s.sessions[0]!;
        assert.deepEqual(a.own.map((p) => p.pid).sort(), [450, 451, 452]);
        assert.deepEqual([a.workers[0]!.id, a.workers[0]!.pid, a.workers[0]!.procCount], ["ag_09", 500, 2]);
        assert.equal(s.escaped.procs.length, 0, "a chat's unit is not the server's: nothing escaped it");
        assert.equal(s.totals.procCount, 6);
      }
    } finally {
      setRemoteHosted("/s/a.jsonl", null);
      setRemoteHosted("/s/w.jsonl", null);
    }
  });

  test("a .service cgroup the server merely inherited (started from a shell in the unit) is tree scope", () => {
    const fx = fixture("inherited", [{ pid: SERVER, ppid: 1, argv: ["node"] }], { unit: true, managerComm: "zsh" });
    const m = new ResourceMonitor({ procRoot: fx.proc, cgroupRoot: fx.cg, logDir: join(root, "inherited-log"), serverPid: SERVER,
      eventLoop: false, platform: "linux", hosted: () => [] });
    assert.equal(m.scope, "tree");
  });

  test("a server backgrounded from a shell in the unit and reparented to the manager is still tree scope", () => {
    // Its parent is systemd now, but SYSTEMD_EXEC_PID (inherited) names the unit's real main process.
    const fx = fixture("backgrounded", [{ pid: SERVER, ppid: 1, argv: ["node"] }], { unit: true, execPid: 3283333 });
    const m = new ResourceMonitor({ procRoot: fx.proc, cgroupRoot: fx.cg, logDir: join(root, "backgrounded-log"), serverPid: SERVER,
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

  test("no /proc and no ps: the server's own numbers only, and a note that says so", async () => {
    const m = new ResourceMonitor({ procRoot: join(root, "nothing"), logDir: join(root, "none-log"), eventLoop: false, platform: "win32", hosted: () => [] });
    await m.tick();
    const s = m.snapshot()!;
    assert.equal(s.scope, "none");
    assert.equal(s.totals.procCount, 0);
    assert.ok(s.server.heapUsedBytes > 0);
    assert.ok(s.notes.some((n) => /need Linux/.test(n)));
    assert.equal(s.memory, undefined, "no Sova memory without a process list");
  });

  test("Sova memory: each process's own memory, split four ways that add up, per session and worker too", async () => {
    const { claudeSessionId } = await import("../pi-config/extensions/claude-code/provider/session-records.ts");
    // The id the claude-code extension itself registers, as a chat reports it.
    const { CLAUDE_CODE_PROVIDER: CLAUDE_PROVIDER_ID } = await import("./models");
    assert.equal(CLAUDE_PROVIDER_ID, CLAUDE_CODE_PROVIDER, "the monitor's copy of the provider id is the server's");
    const CHATS = "/user.slice/user-1000.slice/user@1000.service/sova-chats.slice";
    let now = BOOT * 1000 + 2_000_000;
    const PG = 4096;
    const procs = (): P[] => [
      { pid: SERVER, ppid: 1, argv: ["bun", "server/index.ts"], rssPages: 600_000, sharedPages: 12_000 },
      { pid: 110, ppid: SERVER, argv: ["bun", "server/usage-helper/main.ts"], rssPages: 20_000, sharedPages: 6_000 },
      { pid: 111, ppid: SERVER, argv: ["git", "status"], rssPages: 1_000, sharedPages: 400 },
      // A Claude Code chat: its runtime, its CLI and a tool. Its argv says nothing: the reported pid names it.
      { pid: 450, ppid: 1, argv: ["bun", "main.ts"], rssPages: 60_000, sharedPages: 12_000, cgroup: `${CHATS}/sova-chat-a.service` },
      { pid: 451, ppid: 450, argv: ["claude", "-p", "--session-id", claudeSessionId("sess-a", 0)], rssPages: 70_000, sharedPages: 31_000, cgroup: `${CHATS}/sova-chat-a.service` },
      { pid: 452, ppid: 451, argv: ["zsh", "-c", "make"], rssPages: 2_000, sharedPages: 500, cgroup: `${CHATS}/sova-chat-a.service` },
      // Its worker's chat (a Claude Code worker) with its CLI.
      { pid: 500, ppid: 1, argv: ["bun", "server/chat-runtime/main.ts"], rssPages: 50_000, sharedPages: 12_000, cgroup: `${CHATS}/sova-chat-w.service` },
      { pid: 501, ppid: 500, argv: ["claude", "-p", "--session-id", claudeSessionId("sess-w", 0)], rssPages: 65_000, sharedPages: 31_000, cgroup: `${CHATS}/sova-chat-w.service` },
      // A pi-model chat: nothing wrapped.
      { pid: 600, ppid: 1, argv: ["bun", "server/chat-runtime/main.ts"], rssPages: 45_000, sharedPages: 12_000, cgroup: `${CHATS}/sova-chat-p.service` },
    ];
    const facts = { workers: [], toolsRunning: 0, lastToolEnd: 0 };
    setRemoteHosted("/s/a.jsonl", { sessionId: "sess-a", ...facts, workers: [{ id: "ag_09", name: "tester", status: "running", backend: "claude-code" }], pid: 450, provider: CLAUDE_PROVIDER_ID });
    setRemoteHosted("/s/w.jsonl", { sessionId: "sess-w", ...facts, pid: 500, provider: CLAUDE_PROVIDER_ID, worker: { parentPath: "/s/a.jsonl", parentSessionId: "sess-a", workerId: "ag_09" } });
    setRemoteHosted("/s/p.jsonl", { sessionId: "sess-p", ...facts, pid: 600, provider: "zai" });
    try {
      const fx = fixture("sova-memory", procs(), { unit: true });
      const m = new ResourceMonitor({ procRoot: fx.proc, cgroupRoot: fx.cg, logDir: join(root, "sova-memory-log"), serverPid: SERVER,
        now: () => now, eventLoop: false, platform: "linux", clkTck: HZ });
      await m.tick();
      now += 5000;
      await m.tick(); // argv is read on a process's second sighting
      const s = m.snapshot()!;
      const own = (pid: number) => { const p = procs().find((x) => x.pid === pid)!; return (p.rssPages! - p.sharedPages!) * PG; };
      const procOf = (pid: number) => [...s.sessions.flatMap((x) => [...x.own, ...x.workers.flatMap((w) => w.top)]), ...s.unattributed.procs, ...(s.server.helpers ?? [])].find((p) => p.pid === pid);
      // Each process: its own memory beside its RSS.
      assert.equal(procOf(451)!.privBytes, own(451));
      assert.equal(procOf(451)!.rssBytes, 70_000 * PG);
      assert.equal(s.server.privBytes, own(SERVER));
      // Kinds: a chat's runtime by its reported pid first, the helper by argv.
      assert.equal(procOf(450)!.kind, "sova-runtime");
      assert.equal(s.server.helpers!.map((p) => [p.pid, p.kind]).join(), "110,sova-helper");
      assert.ok(!s.unattributed.procs.some((p) => p.pid === 110), "the helper is the backend's, never Not attributed");
      // The four parts partition the total: a collision, not a literal.
      const mem = s.memory!;
      const all = procs().reduce((n, p) => n + own(p.pid), 0);
      assert.equal(mem.total, all);
      assert.equal(mem.backend.bytes + mem.runtime.bytes + mem.wrapped.bytes + mem.tools.bytes, mem.total);
      assert.deepEqual([mem.backend.bytes, mem.backend.procs], [own(SERVER) + own(110), 2]);
      assert.deepEqual([mem.runtime.bytes, mem.runtime.count], [own(450) + own(500) + own(600), 3]);
      assert.deepEqual([mem.wrapped.bytes, mem.wrapped.count], [own(451) + own(501), 2]);
      assert.equal(mem.tools.bytes, own(452) + own(111));
      // Per session: its own parts plus its workers make its memory.
      const a = s.sessions.find((x) => x.sessionPath === "/s/a.jsonl")!;
      assert.equal(a.backend, "claude-code");
      assert.deepEqual([a.runtimeBytes, a.wrappedBytes, a.toolsBytes], [own(450), own(451), own(452)]);
      const w = a.workers[0]!;
      assert.deepEqual([w.runtimeBytes, w.wrappedBytes, w.toolsBytes, w.privBytes], [own(500), own(501), 0, own(500) + own(501)]);
      assert.equal(a.runtimeBytes! + a.wrappedBytes! + a.toolsBytes! + a.workers.reduce((n, x) => n + x.privBytes!, 0), a.privBytes);
      const p = s.sessions.find((x) => x.sessionPath === "/s/p.jsonl")!;
      assert.deepEqual([p.backend, p.runtimeBytes, p.wrappedBytes, p.privBytes], ["pi", own(600), 0, own(600)]);
      // History: Sova memory and its parts in the point; groups count own memory.
      const pt = (await m.history(0, "5s")).points[1]!;
      assert.equal(pt.sovaBytes, mem.total);
      assert.deepEqual(pt.mem, [mem.backend.bytes, mem.runtime.bytes, mem.wrapped.bytes, mem.tools.bytes]);
      assert.equal(pt.groups["/s/a.jsonl"]![1], a.privBytes);
      assert.equal(pt.groups.server![1], mem.backend.bytes, "the server group is the backend: server and helper");
      // An idle process not re-read keeps the own memory it was last read with.
      for (let i = 0; i < 4; i++) { now += 5000; await m.tick(); }
      assert.ok(m.lastPhases.stale! > 0, "some processes went unread this tick");
      assert.equal(m.snapshot()!.memory!.total, all);
    } finally {
      setRemoteHosted("/s/a.jsonl", null);
      setRemoteHosted("/s/w.jsonl", null);
      setRemoteHosted("/s/p.jsonl", null);
    }
  });

  test("a chat process its server hasn't heard from yet is still a Sova runtime, by argv", async () => {
    const fx = fixture("runtime-argv", [
      { pid: SERVER, ppid: 1, argv: ["bun", "server/index.ts"] },
      { pid: 470, ppid: SERVER, argv: ["bun", "/x/code/abc/server/chat-runtime/main.ts"], rssPages: 3000, sharedPages: 1000 },
    ], { unit: false });
    const m = new ResourceMonitor({ procRoot: fx.proc, logDir: join(root, "runtime-argv-log"), serverPid: SERVER, eventLoop: false, platform: "linux", hosted: () => [] });
    await m.tick();
    const s = m.snapshot()!;
    assert.deepEqual([s.memory!.runtime.bytes, s.memory!.runtime.count], [2000 * 4096, 1]);
    assert.equal(s.unattributed.procs.find((p) => p.pid === 470)!.kind, "sova-runtime");
  });

  test("macOS: one ps per tick lists the processes; commands read once; resident memory, split the same way", async () => {
    const { claudeSessionId } = await import("../pi-config/extensions/claude-code/provider/session-records.ts");
    const calls: string[][] = [];
    let cpu = 100;
    const table = () => [
      `  1     0  10000   9:00.00`,
      `  ${SERVER}     1  400000   0:${String(cpu / 100).padStart(2, "0")}.00`,
      `  110   ${SERVER}  60000   0:01.00`,
      `  450     1  200000   0:02.00`,
      `  451   450  300000   0:03.00`,
      `  452   451   5000   0:00.10`,
      `  999     1  900000   1:00.00`,
    ].join("\n") + "\n";
    const args: Record<number, string> = {
      [SERVER]: "bun server/index.ts", 110: "bun /x/server/usage-helper/main.ts", 450: "bun /x/server/chat-runtime/main.ts",
      451: `/usr/local/bin/claude -p --session-id ${claudeSessionId("sess-a", 0)}`, 452: "zsh -c make", 999: "Safari",
    };
    const ps = async (a: string[]) => {
      calls.push(a);
      if (a.includes("-A")) return table();
      const pids = a[a.indexOf("-p") + 1]!.split(",").map(Number);
      return pids.map((p) => `${p} ${args[p] ?? ""}`).join("\n") + "\n";
    };
    let now = 1_800_000_000_000;
    const m = new ResourceMonitor({ logDir: join(root, "ps-log"), serverPid: SERVER, now: () => now, eventLoop: false, platform: "darwin", ps,
      hosted: () => [{ path: "/s/a.jsonl", sessionId: "sess-a", workers: [], providerIds: [claudeSessionId("sess-a", 0)], toolInWindow: false, pid: 450, backend: "claude-code" }] });
    assert.equal(m.scope, "ps");
    await m.tick();
    now += 5000;
    cpu = 600;
    await m.tick();
    const s = m.snapshot()!;
    assert.equal(s.scope, "ps");
    assert.equal(calls.filter((c) => c.includes("-A")).length, 2, "one table per tick");
    assert.equal(calls.filter((c) => !c.includes("-A")).length, 1, "commands read once, for the new processes together");
    const a = s.sessions.find((x) => x.sessionPath === "/s/a.jsonl")!;
    const kb = 1024;
    assert.deepEqual([a.runtimeBytes, a.wrappedBytes, a.toolsBytes], [200000 * kb, 300000 * kb, 5000 * kb]);
    assert.equal(a.own.find((p) => p.pid === 451)!.kind, "claude-provider");
    const mem = s.memory!;
    assert.equal(mem.backend.bytes, 460000 * kb);
    assert.equal(mem.total, (400000 + 60000 + 200000 + 300000 + 5000) * kb, "Safari, outside Sova, is not measured");
    assert.equal(mem.backend.bytes + mem.runtime.bytes + mem.wrapped.bytes + mem.tools.bytes, mem.total);
    assert.equal(s.server.cpuPct, 100, "5s of CPU time over 5s");
    assert.ok(s.notes.some((n) => /resident memory/.test(n) && /run high/.test(n)));
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

test("stop() writes the 30s window in progress as one line, once; a restart's history keeps it", async () => {
  let now = BOOT * 1000 + 2_000_000;
  const fx = fixture("flush", [{ pid: SERVER, ppid: 1, argv: ["node"] }], { unit: false });
  const logDir = join(root, "flush-log");
  const m = new ResourceMonitor({ procRoot: fx.proc, logDir, serverPid: SERVER, now: () => now, eventLoop: false, platform: "linux", hosted: () => [] });
  for (let i = 0; i < 3; i++) {
    await m.tick(); // half a window: nothing on disk yet
    now += 5000;
  }
  assert.equal(readdirSync(join(root)).includes("flush-log"), false);
  m.stop();
  m.stop();
  const lines = readdirSync(logDir).flatMap((f) => readFileSync(join(logDir, f), "utf8").trim().split("\n"));
  assert.equal(lines.length, 1, "one line, and a second stop adds nothing");
  // A fresh process (the restart) reads it back.
  const after = new ResourceMonitor({ procRoot: fx.proc, logDir, serverPid: SERVER, now: () => now, eventLoop: false, platform: "linux", hosted: () => [] });
  assert.equal((await after.history(0, "30s")).points.length, 1);
});

test("titleOf (Sova's title, from memory) wins over pi's session name", async () => {
  const fx = fixture("title", [{ pid: SERVER, ppid: 1, argv: ["node"] }, { pid: 200, ppid: SERVER, argv: ["claude", "-p"] }], { unit: false });
  const asked: string[] = [];
  const m = new ResourceMonitor({ procRoot: fx.proc, logDir: join(root, "title-log"), serverPid: SERVER, eventLoop: false, platform: "linux",
    hosted: () => [hostedA({ title: "pi name" })], titleOf: (p) => (asked.push(p), p === "/s/a.jsonl" ? "Renamed in Sova" : undefined) });
  await m.tick();
  assert.equal(m.snapshot()!.sessions[0]!.title, "Renamed in Sova");
  assert.equal((await m.history(0, "5s")).groups["/s/a.jsonl"]!.label, "Renamed in Sova");
  assert.deepEqual(asked, ["/s/a.jsonl"]);
});
