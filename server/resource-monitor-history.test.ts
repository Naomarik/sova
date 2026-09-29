// Run: npx tsx --test server/resource-monitor-history.test.ts
// The 1h ring, 30s rollups, and the disk log with rotation (§app.resource-monitor/sampling-and-history).
// Files go to a throwaway dir in the OS temp dir.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { dayFile, MonitorLog, MonitorRing, Rollup, type TickPoint } from "./resource-monitor-history";

const dir = mkdtempSync(join(tmpdir(), "sova-monitor-history-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const point = (at: number, cpu: number, extra: Partial<TickPoint> = {}): TickPoint => ({
  at, cpuPct: cpu, rssBytes: 1000 + at, swapBytes: 0, load1: 1, loopMaxMs: 2,
  groups: new Map([["server", [1, 100]], ["/s/a.jsonl", [cpu - 1, 900]]]),
  workers: new Map([["/s/a.jsonl", new Map([["ag_01", [cpu - 1, 800]]])]]),
  top: [{ pid: 42, cmd: "java … clojure.main", kind: "java", cpuPct: cpu - 1, rssBytes: 800, group: "/s/a.jsonl", workerId: "ag_01" }],
  labels: new Map([["server", { label: "Sova server" }], ["/s/a.jsonl", { label: "Fix the build", sessionPath: "/s/a.jsonl" }]]),
  ...extra,
});

describe("MonitorRing", () => {
  test("round-trips a tick: groups, workers, top processes and labels", () => {
    const ring = new MonitorRing(10);
    ring.push(point(5000, 51, { anonBytes: 77 }));
    const h = ring.history(0);
    assert.equal(h.res, "5s");
    assert.deepEqual(h.points, [{
      at: 5000, cpuPct: 51, rssBytes: 6000, swapBytes: 0, anonBytes: 77, load1: 1, loopMaxMs: 2,
      groups: { server: [1, 100], "/s/a.jsonl": [50, 900] },
      workers: { "/s/a.jsonl": { ag_01: [50, 800] } },
      top: [{ pid: 42, cmd: "java … clojure.main", kind: "java", cpuPct: 50, rssBytes: 800, group: "/s/a.jsonl", workerId: "ag_01" }],
    }]);
    assert.deepEqual(h.groups, { server: { label: "Sova server" }, "/s/a.jsonl": { label: "Fix the build", sessionPath: "/s/a.jsonl" } });
  });

  test("keeps the last `capacity` ticks, oldest first, and filters by since", () => {
    const ring = new MonitorRing(3);
    for (let i = 1; i <= 5; i++) ring.push(point(i * 5000, 10 + i));
    assert.deepEqual(ring.history(0).points.map((p) => p.at), [15000, 20000, 25000]);
    assert.deepEqual(ring.history(20000).points.map((p) => p.at), [20000, 25000]);
    assert.equal(ring.history(99999).points.length, 0);
  });

  test("labels of processes no kept tick uses are pruned; kept ones survive the prune", () => {
    const ring = new MonitorRing(4);
    for (let i = 0; i < 12; i++) ring.push(point(i, 5, { top: [{ pid: 1000 + i, cmd: `proc ${i}`, kind: "other", cpuPct: 1, rssBytes: 1 }] }));
    const cmds = ring.history(0).points.map((p) => p.top[0]!.cmd);
    assert.deepEqual(cmds, ["proc 8", "proc 9", "proc 10", "proc 11"]);
    assert.ok((ring as unknown as { procs: { size: number } }).procs.size <= 5);
  });

  test("an hour of a busy machine stays near 2 MB", () => {
    const ring = new MonitorRing(720);
    const groups = new Map<string, [number, number]>();
    const workers = new Map<string, Map<string, [number, number]>>();
    const labels: TickPoint["labels"] = new Map();
    for (let s = 0; s < 20; s++) {
      const key = `/home/u/.pi/agent/sessions/--home-u-app--/2026-09-29T10-00-00-000Z_${s}.jsonl`;
      groups.set(key, [12.5, 300e6]);
      labels.set(key, { label: `Session ${s}`, sessionPath: key });
      workers.set(key, new Map(Array.from({ length: 3 }, (_, w) => [`ag_0${w}`, [4.2, 280e6] as [number, number]])));
    }
    const top = Array.from({ length: 5 }, (_, i) => ({ pid: 100 + i, cmd: "node tsc --noEmit", kind: "build" as const, cpuPct: 99, rssBytes: 1e9, group: "unattributed" }));
    for (let i = 0; i < 720; i++) ring.push({ ...point(i * 5000, 300), groups, workers, top, labels });
    assert.ok(ring.bytes() < 2.2 * 1024 * 1024, `${ring.bytes()} bytes`);
  });
});

describe("Rollup", () => {
  test("30s line: mean and max CPU, max memory, per-group mean CPU with max memory, top by window mean", () => {
    const r = new Rollup();
    r.add(point(5000, 11));
    r.add(point(10000, 31, { top: [{ pid: 7, cmd: "node tsc", kind: "build", cpuPct: 90, rssBytes: 5 }] }));
    const line = r.flush()!;
    assert.equal(line.v, 1);
    assert.equal(line.at, 10000);
    assert.equal(line.cpuPct, 21);
    assert.equal(line.cpuPctMax, 31);
    assert.equal(line.rssBytes, 11000);
    assert.deepEqual(line.groups["/s/a.jsonl"], [20, 900]);
    assert.deepEqual(line.workers["/s/a.jsonl"]!.ag_01, [20, 800]);
    // The transient tsc (one tick of two at 90%) averages 45 over the window and leads; the JVM,
    // in the first tick only at 10%, averages 5.
    assert.deepEqual(line.top.map((p) => [p.cmd, p.cpuPct]), [["node tsc", 45], ["java … clojure.main", 5]]);
    assert.equal(line.labels["/s/a.jsonl"]!.label, "Fix the build");
    assert.equal(r.flush(), null, "empty after a flush");
  });
});

describe("MonitorLog", () => {
  test("appends one JSON line per rollup to the day's file and reads them back by since", async () => {
    const log = new MonitorLog(join(dir, "a"));
    const r = new Rollup();
    const base = new Date(2026, 8, 29, 10, 0, 0).getTime();
    for (let i = 0; i < 3; i++) {
      r.add(point(base + i * 30_000, 10 + i));
      await log.append(r.flush()!);
    }
    const file = join(dir, "a", dayFile(base));
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 3);
    const h = await log.history(base + 30_000, base + 60_000);
    assert.equal(h.res, "30s");
    assert.deepEqual(h.points.map((p) => p.at), [base + 30_000, base + 60_000]);
    assert.equal(h.groups["/s/a.jsonl"]!.label, "Fix the build");
    assert.ok(!("labels" in h.points[0]!) && !("v" in h.points[0]!));
  });

  test("a torn last line (crash mid-append) is skipped, not fatal", async () => {
    const d = join(dir, "torn");
    mkdirSync(d);
    const base = new Date(2026, 8, 29, 11, 0, 0).getTime();
    const log = new MonitorLog(d);
    const r = new Rollup();
    r.add(point(base, 5));
    await log.append(r.flush()!);
    appendFileSync(join(d, dayFile(base)), '{"v":1,"at":');
    assert.equal((await log.history(0, base)).points.length, 1);
  });

  test("rotation deletes day files older than 3 days, by the name's date; other files are kept", async () => {
    const d = join(dir, "rot");
    mkdirSync(d);
    for (const name of ["2026-09-24.jsonl", "2026-09-25.jsonl", "2026-09-26.jsonl", "2026-09-27.jsonl", "2026-09-29.jsonl", "notes.txt"])
      writeFileSync(join(d, name), "");
    const removed = await new MonitorLog(d).rotate(new Date(2026, 8, 29, 12, 0, 0).getTime());
    assert.deepEqual(removed.sort(), ["2026-09-24.jsonl", "2026-09-25.jsonl"]);
    assert.deepEqual(readdirSync(d).sort(), ["2026-09-26.jsonl", "2026-09-27.jsonl", "2026-09-29.jsonl", "notes.txt"]);
    assert.deepEqual(await new MonitorLog(join(dir, "missing")).rotate(), []);
  });
});
