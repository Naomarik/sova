import assert from "node:assert/strict";
import { test } from "node:test";
import { findUnitListener, TourTargetUnverifiable, verifyUnitListener, type AsyncProcFs } from "./tour-target-listener";
import { TourTargetRefused } from "./tour-target";
import type { InstanceRecord, Registry } from "./store";

// A fake /proc: socket tables, per-process stat (ppid, starttime) and fds. Every read is async, as the
// real one; a path set in `fail` rejects with that code.
const PORT = 8080; // 1F90
const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const row = (local: string, st: string, inode: string) => `   0: ${local} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;
function host() {
  const tcp = [
    row("0100007F:1F90", "0A", "111"), // 127.0.0.1:8080 LISTEN
    row("0100007F:1F90", "01", "222"), // 127.0.0.1:8080 ESTABLISHED: same local port, not a listener
    row("0100007F:1F90", "06", "333"), // TIME_WAIT
    row("0100007F:1F91", "0A", "777"), // another port's listener
  ];
  const tcp6 = [
    row("0000000000000000FFFF00000100007F:1F90", "0A", "444"), // ::ffff:127.0.0.1 LISTEN (dual-stack)
    row("00000000000000000000000000000000:1F90", "0A", "555"), // :: (any) LISTEN
  ];
  const procs = new Map<number, { ppid: number; start: string; fds: string[] }>([
    [10, { ppid: 1, start: "500", fds: ["pipe:[1]"] }], // a wrapper (nice → node)
    [11, { ppid: 10, start: "600", fds: ["socket:[222]", "socket:[111]", "socket:[444]", "socket:[555]"] }],
    [99, { ppid: 1, start: "900", fds: [] }], // outside the unit
  ]);
  const fail = new Map<string, string>();
  const err = (code: string) => Object.assign(new Error(code), { code });
  const fs: AsyncProcFs = {
    read: async (p) => {
      if (fail.has(p)) throw err(fail.get(p)!);
      if (p === "/proc/net/tcp") return [HEADER, ...tcp].join("\n");
      if (p === "/proc/net/tcp6") return [HEADER, ...tcp6].join("\n");
      const m = /^\/proc\/(\d+)\/stat$/.exec(p);
      const proc = m && procs.get(Number(m[1]));
      if (!proc) throw err("ENOENT");
      // pid (comm with ) space) state ppid pgrp session … field 22 starttime
      return `${m![1]} (node (x)) S ${proc.ppid} ${proc.ppid} ${proc.ppid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 ${proc.start} 0 0`;
    },
    list: async (p) => {
      if (fail.has(p)) throw err(fail.get(p)!);
      if (p === "/proc") return [...procs.keys()].map(String).concat(["self", "net"]);
      const m = /^\/proc\/(\d+)\/fd$/.exec(p);
      const proc = m && procs.get(Number(m[1]));
      if (!proc) throw err("ENOENT");
      return proc.fds.map((_, i) => String(i));
    },
    link: async (p) => {
      if (fail.has(p)) throw err(fail.get(p)!);
      const m = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(p);
      const target = m && procs.get(Number(m[1]))?.fds[Number(m[2])];
      if (!target) throw err("ENOENT");
      return target;
    },
  };
  return { tcp, tcp6, procs, fail, fs };
}
const unit = new Set([10, 11]);
const inUnit = (pid: number) => unit.has(pid);

test("only LISTEN rows of the exact port count, in tcp and tcp6, v4-mapped and unspecified binds included", async () => {
  const h = host();
  const found = await findUnitListener(PORT, 10, inUnit, h.fs);
  assert.ok("held" in found);
  assert.deepEqual(found.held, { pid: 11, start: "600", inodes: ["111", "444", "555"] }, "the wrapper's child holds it; 222/333/777 never count");
  // A unit process holding only the ESTABLISHED socket of that port isn't the listener.
  h.procs.get(11)!.fds = ["socket:[222]"];
  assert.deepEqual(await findUnitListener(PORT, 10, inUnit, h.fs), { refused: "foreign" });
  // Nothing listening: only non-LISTEN rows remain.
  h.tcp.splice(0, 1); h.tcp6.length = 0;
  assert.deepEqual(await findUnitListener(PORT, 10, inUnit, h.fs), { refused: "none" });
});

test("a holder outside the unit is never taken for it", async () => {
  const h = host();
  h.procs.get(11)!.fds = []; h.procs.get(99)!.fds = ["socket:[111]"]; h.procs.get(99)!.ppid = 10;
  assert.deepEqual(await findUnitListener(PORT, 10, inUnit, h.fs), { refused: "foreign" }, "a descendant the driver doesn't own");
});

test("re-verification: unchanged passes; takeover, pid reuse, a lost socket and leaving the unit each refuse", async () => {
  const fresh = async () => { const h = host(); const f = await findUnitListener(PORT, 10, inUnit, h.fs); assert.ok("held" in f); return { h, held: f.held }; };
  { const { h, held } = await fresh(); for (let i = 0; i < 3; i++) assert.equal(await verifyUnitListener(PORT, held, inUnit, h.fs), null, "control: the same socket and process pass every time"); }
  { const { h, held } = await fresh(); h.tcp.push(row("00000000:1F90", "0A", "999")); assert.equal(await verifyUnitListener(PORT, held, inUnit, h.fs), "listeners", "another listener joined the port"); }
  { const { h, held } = await fresh(); h.tcp.splice(0, 1); h.tcp.push(row("0100007F:1F90", "0A", "888")); h.procs.get(99)!.fds = ["socket:[888]"]; assert.equal(await verifyUnitListener(PORT, held, inUnit, h.fs), "listeners", "takeover by a process outside the unit"); }
  { const { h, held } = await fresh(); h.procs.get(11)!.start = "601"; assert.equal(await verifyUnitListener(PORT, held, inUnit, h.fs), "process", "same pid, a later process"); }
  { const { h, held } = await fresh(); h.procs.delete(11); assert.equal(await verifyUnitListener(PORT, held, inUnit, h.fs), "process", "the process vanished"); }
  { const { h, held } = await fresh(); h.procs.get(11)!.fds = ["socket:[222]"]; h.procs.get(10)!.fds = ["socket:[111]", "socket:[444]", "socket:[555]"]; assert.equal(await verifyUnitListener(PORT, held, inUnit, h.fs), "socket", "the unit lives on, but its process no longer holds the socket"); }
  { const { h, held } = await fresh(); unit.delete(11); try { assert.equal(await verifyUnitListener(PORT, held, inUnit, h.fs), "unit"); } finally { unit.add(11); } }
});

test("unreadable process state fails closed as unverifiable, never as a pass and never as a refusal", async () => {
  const cases: [string, "find" | "verify"][] = [["/proc/net/tcp+6", "find"], ["/proc/net/tcp+6", "verify"], ["/proc/11/fd", "find"], ["/proc/11/fd", "verify"], ["/proc/11/stat", "verify"], ["/proc", "find"]];
  for (const [path, phase] of cases) {
    const h = host();
    const f = await findUnitListener(PORT, 10, inUnit, h.fs); assert.ok("held" in f);
    for (const p of path === "/proc/net/tcp+6" ? ["/proc/net/tcp", "/proc/net/tcp6"] : [path]) h.fail.set(p, "EACCES");
    if (path === "/proc") h.procs.get(10)!.fds = []; // force the descendant scan
    const run = phase === "find" ? findUnitListener(PORT, path === "/proc" ? 10 : 11, inUnit, h.fs) : verifyUnitListener(PORT, f.held, inUnit, h.fs);
    await assert.rejects(run, (e: unknown) => e instanceof TourTargetUnverifiable && !(e instanceof TourTargetRefused) && e.message === "Sova couldn't verify this running copy: this host's process information can't be read.", `${path} ${phase}`);
  }
  // Control: one table missing (no IPv6) is still readable state.
  const h = host(); h.fail.set("/proc/net/tcp6", "ENOENT");
  const f = await findUnitListener(PORT, 10, inUnit, h.fs);
  assert.ok("held" in f); assert.deepEqual(f.held.inodes, ["111"]);
});

test("resolveTourTarget on Linux: every contact re-verifies the pinned socket; generation, takeover and unreadable state each stop it", async () => {
  const { mkdtempSync, mkdirSync, realpathSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { parseDefinition } = await import("../../shared/project-contract");
  const { resolveTourTarget } = await import("./tour-target");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tour-listener-")));
  try {
    const checkout = join(root, "copy-a"); mkdirSync(checkout);
    const rec: InstanceRecord = { id: "copy-a", project: root, checkout, branch: "a", slot: 1, generation: 1, createdBy: "operator", createdAt: new Date().toISOString(), cutWorktree: false, desired: { web: "running" }, prints: {}, data: {}, ports: { web: { http: PORT } } };
    const registry: Registry = { version: 1, instances: [rec], shared: [] };
    const h = host();
    const deps = { registry: () => registry, projectRoot: () => root, definition: () => parseDefinition(JSON.stringify({ version: 1, services: { web: { cmd: ["web"], ports: { http: { base: 8079 } } } } })), unitOf: (id: string, s: string) => `${id}-${s}`, driver: { status: async () => ({ state: "active" as const, pid: 10 }), owns: (_u: string, pid: number) => inUnit(pid) }, procfs: h.fs, platform: "linux" as const };
    const source = { kind: "project" as const, projectId: "project", instanceId: "copy-a", checkout, serviceId: "web", endpoint: "http" };
    const target = await resolveTourTarget(source, deps);
    assert.equal(target.origin, `http://127.0.0.1:${PORT}`);
    for (let i = 0; i < 3; i++) await target.assertCurrent(); // control
    h.procs.get(11)!.start = "601";
    await assert.rejects(target.assertCurrent(), /changed during recording/, "pid reuse");
    h.procs.get(11)!.start = "600";
    await target.assertCurrent(); // back to the same process
    rec.generation = 2;
    await assert.rejects(target.assertCurrent(), /changed during recording/, "a registry generation change");
    rec.generation = 1;
    h.tcp.push(row("00000000:1F90", "0A", "999")); h.procs.get(99)!.fds = ["socket:[999]"];
    await assert.rejects(target.assertCurrent(), (e: unknown) => e instanceof TourTargetRefused && /changed during recording/.test((e as Error).message), "takeover by a process outside the unit");
    h.tcp.pop();
    await target.assertCurrent();
    h.fail.set("/proc/net/tcp", "EACCES"); h.fail.set("/proc/net/tcp6", "EACCES");
    await assert.rejects(target.assertCurrent(), (e: unknown) => e instanceof TourTargetUnverifiable && !(e instanceof TourTargetRefused));
    await assert.rejects(resolveTourTarget(source, deps), TourTargetUnverifiable, "at resolve too");
    h.fail.clear(); h.procs.get(11)!.fds = [];
    await assert.rejects(resolveTourTarget(source, deps), /another process owns its port/, "a listener no unit process holds is refused");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
