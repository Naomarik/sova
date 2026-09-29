// Run: npx tsx --test server/resource-monitor.integration.test.ts
// The sampler over the REAL /proc with real child processes (Linux only; skipped elsewhere): this
// test process plays the server. What the fixture tests can't show: the kernel really rolls a
// reaped grandchild's CPU into its parent's cutime and the fold charges it to the worker, and a
// child carrying pi's bash-tool env (PI_SESSION_FILE) lands on its hosted session. The cgroup
// root is pointed at nothing, so the scope is always the process tree (never a real unit).
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "sova-monitor-it-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent"); // before paths.ts computes its dirs
const kids: ChildProcess[] = [];
after(() => {
  for (const k of kids) k.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

const { ResourceMonitor } = await import("./resource-monitor");
type HostedInfo = import("./resource-monitor-attrib").HostedInfo;

const linux = process.platform === "linux" && existsSync("/proc/self/stat");
const SESSION = join(root, "hosted.jsonl");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Burn `ms` of CPU time (not wall time: the machine may be loaded). */
const burn = (ms: number) => `let x=0;for(;;){for(let i=0;i<1e6;i++)x+=i;if(process.cpuUsage().user>=${ms * 1000})break;}`;
const node = (code: string, env: NodeJS.ProcessEnv = {}) => {
  const c = spawn(process.execPath, ["-e", code], { stdio: "ignore", env: { PATH: process.env.PATH, ...env } });
  kids.push(c);
  return c;
};
/** utime+stime and cutime+cstime of a live process, in clock ticks, straight from /proc. */
const ticksOf = (pid: number) => {
  const t = readFileSync(`/proc/${pid}/stat`, "utf8");
  const f = t.slice(t.lastIndexOf(")") + 2).split(" ");
  return { own: Number(f[11]) + Number(f[12]), kids: Number(f[13]) + Number(f[14]) };
};
/** Poll until `ok()` holds (the kernel counters say a burst is done), or fail after `ms`. */
async function until(ok: () => boolean, what: string, ms = 20_000) {
  for (const end = Date.now() + ms; !ok(); ) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}
/** Resolves when `c` has exited (already or later). */
const exited = (c: ChildProcess) => (c.exitCode !== null || c.signalCode !== null ? Promise.resolve() : new Promise<void>((r) => c.once("exit", () => r())));

describe("sampler over the real /proc", { skip: !linux && "needs Linux /proc" }, () => {
  test("a worker's reaped tool child (tsc-like burst) and a hosted bash child are charged by the real kernel counters", async () => {
    let hosted: HostedInfo[] = [];
    const m = new ResourceMonitor({ logDir: join(root, "log"), cgroupRoot: join(root, "no-cgroup"), eventLoop: false, hosted: () => hosted });
    assert.equal(m.scope, "tree");
    const tBase = Date.now(); // ≈ the baseline tick's `at`
    await m.tick(); // baseline, before any child exists
    // btime has one-second resolution: start the children clearly after the first tick.
    await sleep(1100);

    // A "worker" that runs one short CPU burst as its own child (~500ms), waits for it (so the
    // kernel reaps it into the worker's cutime), then idles until killed.
    const worker = node(
      `require("child_process").execFileSync(process.execPath, ["-e", ${JSON.stringify(burn(500))}]); setInterval(() => {}, 1e6);`,
    );
    // A hosted session's bash-tool child: pi's bash tool puts PI_SESSION_FILE in its env.
    const tool = node(`${burn(400)}; setInterval(() => {}, 1e6);`, { PI_SESSION_FILE: SESSION, PI_SESSION_ID: "sess-it" });
    hosted = [{
      path: SESSION, sessionId: "sess-it", cwd: root, title: "integration",
      workers: [{ id: "ag_01", name: "burst", backend: "pi", status: "running", pid: worker.pid! }],
      providerIds: [], toolInWindow: true,
    }];
    // Wait for both bursts to finish by the kernel's own counters, not a fixed sleep (the full
    // suite runs files in parallel on a loaded machine): the worker's grandchild has been reaped
    // into its cutime, and the tool has burned its own CPU. A pid first listed waits one tick
    // before it is read, so tick twice.
    await until(() => ticksOf(worker.pid!).kids >= 40, "the worker's burst to be reaped");
    await until(() => ticksOf(tool.pid!).own >= 30, "the tool's burst");
    await m.tick();
    await sleep(200);
    await m.tick();
    const s = m.snapshot()!;
    const row = s.sessions.find((x) => x.sessionPath === SESSION);
    assert.ok(row, `session row missing: ${JSON.stringify({ n: s.totals.procCount, un: s.unattributed.procs, top: s.topProcs })}`);
    assert.equal(row.hosted, true);

    const w = row.workers.find((x) => x.id === "ag_01");
    assert.ok(w, "worker row missing");
    assert.equal(w.pid, worker.pid);
    assert.equal(w.via, "worker-pid");
    // The 500ms burst lived and died between ticks: it reaches the worker only through cutime.
    const h = await m.history(0, "5s");
    const cpuSec = (pick: (p: (typeof h.points)[number]) => number) =>
      h.points.reduce((sum, p, i) => sum + (i ? (pick(p) / 100) * ((p.at - h.points[i - 1]!.at) / 1000) : 0), 0);
    const workerCpuSec = cpuSec((p) => p.workers[SESSION]?.ag_01?.[0] ?? 0);
    // …and matches what the kernel itself says the worker and its reaped child used.
    const k = ticksOf(worker.pid!);
    const kernelSec = (k.own + k.kids) / 100;
    assert.ok(k.kids >= 40, `the burst never reached the worker's cutime: ${JSON.stringify(k)}`);
    assert.ok(Math.abs(workerCpuSec - kernelSec) <= 0.05 + kernelSec * 0.05,
      `worker charged ${workerCpuSec.toFixed(2)} cpu-s, the kernel says ${kernelSec.toFixed(2)}`);
    const sessionCpuSec = cpuSec((p) => p.groups[SESSION]?.[0] ?? 0);
    assert.ok(sessionCpuSec - workerCpuSec >= 0.3, `hosted tool charged ${(sessionCpuSec - workerCpuSec).toFixed(2)} cpu-s, expected ≈ 0.4`);

    const own = row.own.find((p) => p.pid === tool.pid);
    assert.ok(own, `hosted tool child not charged to the session: ${JSON.stringify(row.own)}`);
    assert.equal(own.via, "env");
    // Nothing of ours is left unattributed.
    for (const pid of [worker.pid, tool.pid]) assert.ok(!s.unattributed.procs.some((p) => p.pid === pid), `pid ${pid} unattributed`);

    // After both exit, the next tick drops them and charges nothing new to the worker.
    worker.kill("SIGKILL");
    tool.kill("SIGKILL");
    await Promise.all([exited(worker), exited(tool)]);
    await m.tick();
    const s2 = m.snapshot()!;
    const row2 = s2.sessions.find((x) => x.sessionPath === SESSION);
    assert.ok(!row2?.workers.some((x) => x.id === "ag_01" && x.cpuPct > 5), "a dead worker still burns CPU");
    // …but the ring still has the ticks that charged it.
    const h2 = await m.history(0, "5s");
    assert.ok(h2.points.some((p) => (p.workers[SESSION]?.ag_01?.[0] ?? 0) > 0), "history lost the worker's CPU");
    m.stop();
  });
});
