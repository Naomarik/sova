import assert from "node:assert/strict";
import { test } from "node:test";
import type { MonitorPoint, MonitorProc, MonitorSnapshot, MonitorWorker } from "../../shared/protocol";
import {
  appendHistory,
  chargedTo,
  chartModel,
  cpuText,
  degradedLine,
  groupLabel,
  labelsWithTitles,
  sessionLabel,
  withTitles,
  workerNamer,
  idleSummary,
  isHeuristic,
  liveRows,
  livePids,
  mergeHistory,
  memoryParts,
  meters,
  momentText,
  readoutText,
  msText,
  nearestIndex,
  niceCeil,
  rowsAt,
  samplerLine,
  scopeLine,
  statusText,
  tabLine,
  transient,
  transientName,
} from "./monitor-view";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

const proc = (pid: number, cmd: string, cpuPct: number, rssBytes: number, extra: Partial<MonitorProc> = {}): MonitorProc => ({
  pid,
  ppid: 1,
  kind: "other",
  cmd,
  cpuPct,
  rssBytes,
  startedAt: 1000 + pid,
  ...extra,
});

const worker = (id: string, cpuPct: number, rssBytes: number, extra: Partial<MonitorWorker> = {}): MonitorWorker => ({
  id,
  via: "worker-pid",
  cpuPct,
  rssBytes,
  swapBytes: 0,
  procCount: 1,
  top: [],
  ...extra,
});

function snapshot(extra: Partial<MonitorSnapshot> = {}): MonitorSnapshot {
  return {
    at: 1_000_000,
    platform: "linux",
    scope: "unit",
    unitName: "sova-runtime.service",
    cores: 16,
    host: { loadavg: [4, 3, 2], memTotalBytes: 32 * GB, memAvailableBytes: 10 * GB, swapTotalBytes: 8 * GB, swapFreeBytes: 6 * GB, pressure: { cpu: { some: 2.5 } } },
    unit: { cpuPct: 300, memory: { current: 17.5 * GB, anon: 10 * GB, file: 7.3 * GB, shmem: 0.7 * GB, peak: 20 * GB }, swap: { current: 1 * GB }, oomKills: 0 },
    server: { pid: 100, cpuPct: 5, rssBytes: 400 * MB, heapUsedBytes: 200 * MB, heapTotalBytes: 300 * MB, eventLoop: { p50: 1, p99: 12.4, max: 40 }, uptimeSec: 3600 },
    totals: { cpuPct: 300, rssBytes: 12 * GB, swapBytes: GB, procCount: 142 },
    sessions: [
      {
        sessionPath: "/s/light.jsonl",
        title: "Light",
        hosted: true,
        cpuPct: 1,
        rssBytes: 300 * MB,
        swapBytes: 0,
        procCount: 2,
        own: [],
        ownCpuPct: 0,
        ownRssBytes: 0,
        workers: [worker("w1", 1, 300 * MB, { status: "idle", idleSince: 1_000_000 - 3 * 3600_000 })],
      },
      {
        sessionPath: "/s/heavy.jsonl",
        title: "Heavy",
        hosted: true,
        cpuPct: 250,
        rssBytes: 3 * GB,
        swapBytes: 0,
        procCount: 6,
        own: [proc(300, "bash -c pnpm test", 20, 50 * MB, { via: "cwd" })],
        ownCpuPct: 20,
        ownRssBytes: 50 * MB,
        workers: [
          worker("w2", 30, GB, { name: "reviewer", status: "working" }),
          worker("w3", 200, 2 * GB, { name: "builder", status: "working", pid: 301, top: [proc(302, "java … clojure.main", 190, 1.5 * GB)] }),
        ],
      },
    ],
    unownedWorkers: [],
    escaped: { cpuPct: 10, rssBytes: GB, swapBytes: 0, procCount: 1, procs: [proc(400, "chromium", 10, GB, { sessionPath: "/s/heavy.jsonl", workerId: "w3", via: "sid", cwd: "/w/x" })] },
    unattributed: { cpuPct: 0, rssBytes: 0, swapBytes: 0, procCount: 0, procs: [] },
    topProcs: [],
    sampler: { intervalMs: 5000, lastTickMs: 2.1, avgTickMs: 1.84, skipped: 0, ticks: 700, startedAt: 0 },
    notes: [],
    ...extra,
  };
}

const point = (at: number, groups: MonitorPoint["groups"], extra: Partial<MonitorPoint> = {}): MonitorPoint => ({
  at,
  cpuPct: Object.values(groups).reduce((n, [c]) => n + c, 0),
  rssBytes: GB,
  swapBytes: 0,
  load1: 1,
  loopMaxMs: 2,
  groups,
  workers: {},
  top: [],
  ...extra,
});

test("numbers read at a glance", () => {
  assert.equal(cpuText(0), "0%");
  assert.equal(cpuText(0.04), "0.1%");
  assert.equal(cpuText(0.46), "0.5%");
  assert.equal(cpuText(12.4), "12%");
  assert.equal(cpuText(140), "140%");
  assert.equal(msText(0.44), "0.4 ms");
  assert.equal(msText(12.6), "13 ms");
  assert.equal(niceCeil(0), 1);
  assert.equal(niceCeil(130), 200);
  assert.equal(niceCeil(400), 500);
  assert.equal(niceCeil(1000), 1000);
  assert.equal(momentText(new Date(2026, 8, 29, 13, 4, 5).getTime()), "13:04:05");
  assert.equal(momentText(new Date(2026, 8, 29, 9, 0, 7).getTime()), "09:00:07");
});

test("scope and degraded lines say what the numbers cover", () => {
  assert.equal(scopeLine({ scope: "unit", unitName: "sova-runtime.service" }), "Sova's server and its chats");
  assert.equal(scopeLine({ scope: "tree" }), "Sova's server and its chats, process trees only");
  assert.equal(scopeLine({ scope: "ps" }), "Sova's server and its chats");
  assert.equal(scopeLine({ scope: "none" }), "This server's own numbers only");
  assert.match(degradedLine({ scope: "ps", platform: "darwin" })!, /resident memory/);
  assert.equal(degradedLine({ scope: "unit", platform: "linux" }), null);
  assert.match(degradedLine({ scope: "tree", platform: "linux" })!, /process tree only/);
  assert.match(degradedLine({ scope: "none", platform: "win32" })!, /need Linux/);
});

const MEMORY = { total: 6 * GB, backend: { bytes: 2.5 * GB, procs: 2 }, runtime: { bytes: 2 * GB, count: 3 }, wrapped: { bytes: GB, count: 2 }, tools: { bytes: 0.5 * GB } };
/** A snapshot from a server that splits Sova's memory: a Claude Code chat with a worker, and a pi-model chat. */
function split(extra: Partial<MonitorSnapshot> = {}): MonitorSnapshot {
  const base = snapshot();
  return snapshot({
    memory: MEMORY,
    server: { ...base.server, privBytes: 2.4 * GB, helpers: [proc(110, "bun usage-helper/main.ts", 0.5, 70 * MB, { kind: "sova-helper", privBytes: 56 * MB })] },
    sessions: [
      {
        sessionPath: "/s/cc.jsonl", title: "Claude chat", hosted: true, backend: "claude-code",
        cpuPct: 12, rssBytes: 900 * MB, privBytes: 600 * MB, swapBytes: 0, procCount: 5,
        runtimeBytes: 150 * MB, wrappedBytes: 160 * MB, toolsBytes: 40 * MB,
        own: [
          proc(450, "bun main.ts", 2, 200 * MB, { kind: "sova-runtime", privBytes: 150 * MB }),
          proc(451, "claude -p", 8, 300 * MB, { kind: "claude-provider", privBytes: 160 * MB }),
          proc(452, "zsh -c make", 2, 50 * MB, { kind: "shell", privBytes: 40 * MB }),
        ],
        ownCpuPct: 12, ownRssBytes: 550 * MB,
        workers: [worker("ag_09", 0, 350 * MB, { name: "tester", backend: "claude-code", status: "idle", privBytes: 250 * MB, runtimeBytes: 120 * MB, wrappedBytes: 130 * MB, toolsBytes: 0, procCount: 2 })],
      },
      {
        sessionPath: "/s/pi.jsonl", title: "Pi chat", hosted: true, backend: "pi",
        cpuPct: 1, rssBytes: 180 * MB, privBytes: 130 * MB, swapBytes: 0, procCount: 1,
        runtimeBytes: 130 * MB, wrappedBytes: 0, toolsBytes: 0,
        own: [proc(600, "bun main.ts", 1, 180 * MB, { kind: "sova-runtime", privBytes: 130 * MB })],
        ownCpuPct: 1, ownRssBytes: 180 * MB, workers: [],
      },
    ],
    escaped: { cpuPct: 0, rssBytes: 0, swapBytes: 0, procCount: 0, procs: [] },
    ...extra,
  });
}

test("Sova memory: one meter against RAM, and four figures that add up to it", () => {
  const m = meters(split()).find((x) => x.key === "memory")!;
  assert.deepEqual([m.label, m.value, m.of], ["Sova memory", "6 GB", " of 32 GB"]);
  assert.equal(m.pct, (6 / 32) * 100);
  assert.match(m.context!, /10 GB available/);
  const parts = memoryParts(split())!;
  assert.deepEqual(parts.map((p) => [p.label, p.value, p.context ?? ""]), [
    ["Backend", "2.5 GB", "server and helper"],
    ["Sova runtime", "2 GB", "3 chats"],
    ["Claude Code", "1 GB", "2 CLIs"],
    ["Tools and work", "512 MB", ""],
  ]);
  assert.equal(parts.reduce((n, p) => n + p.bytes, 0), MEMORY.total);
  assert.equal(memoryParts(snapshot()), null, "an older server's snapshot has no split");
  // macOS: no per-process swap, so no swap meter.
  assert.ok(!meters(split({ scope: "ps", unit: undefined })).some((x) => x.key === "swap"));
});

test("table: Backend first, each chat split into runtime, what it wraps and tools; no 'Hosted here', no 'own tools'", () => {
  const rows = liveRows(split());
  assert.deepEqual(rows.map((r) => r.label), ["Backend", "Claude chat", "Pi chat"]);
  const backend = rows[0]!;
  assert.deepEqual([backend.kind, backend.caption, backend.rssBytes], ["server", "the Sova server and its helper", 2.5 * GB]);
  assert.deepEqual(backend.parts!.map((p) => [p.label, p.caption, p.rssBytes]), [
    ["Sova server", "web app, sessions, monitor", 2.4 * GB],
    ["Usage helper", "prices and usage", 56 * MB],
  ]);
  const cc = rows[1]!;
  assert.deepEqual([cc.caption, cc.rssBytes], ["Claude Code", 600 * MB]);
  assert.deepEqual(cc.parts!.map((p) => [p.label, p.caption, p.rssBytes]), [
    ["Sova runtime", "this chat's own process", 150 * MB],
    ["Claude Code", "the wrapped CLI", 160 * MB],
    ["Tools", "1 process", 40 * MB],
  ]);
  assert.deepEqual(cc.parts![2]!.procs.map((p) => p.cmd), ["zsh -c make"]);
  assert.equal(cc.procs.length, 0, "a split session's processes hang off its parts");
  // Its parts and its workers add up to its row.
  assert.equal(cc.parts!.reduce((n, p) => n + p.rssBytes, 0) + cc.workers.reduce((n, w) => n + w.rssBytes, 0), cc.rssBytes);
  assert.deepEqual([cc.workers[0]!.rssBytes, cc.workers[0]!.split], [250 * MB, "runtime 120 MB · Claude Code 130 MB"]);
  const pi = rows[2]!;
  assert.equal(pi.caption, "pi model · nothing wrapped");
  assert.deepEqual(pi.parts!.map((p) => p.label), ["Sova runtime"], "nothing wrapped, no tools: only its runtime");
  for (const r of rows) assert.ok(!/Hosted here/.test(r.caption ?? ""));
  // A row per group still adds up to Sova's memory.
  assert.equal(rows.reduce((n, r) => n + r.rssBytes, 0), 2.5 * GB + 600 * MB + 130 * MB);
});

test("chart and reading: Sova memory only from readings that carry it, never the old count", () => {
  const now = 3_600_000;
  // Two 30s rollups from before the change (RSS-era numbers, far higher), then three new ticks.
  const pts = [
    point(now - 60_000, { a: [10, GB] }, { rssBytes: 20 * GB, anonBytes: 15 * GB }),
    point(now - 30_000, { a: [10, GB] }, { rssBytes: 20 * GB, anonBytes: 15 * GB }),
    point(now - 10_000, { a: [10, GB] }, { sovaBytes: 6 * GB, mem: [2.5 * GB, 2 * GB, GB, 0.5 * GB] }),
    point(now - 5000, { a: [10, GB] }, { sovaBytes: 6 * GB, mem: [2.5 * GB, 2 * GB, GB, 0.5 * GB] }),
    point(now, { a: [10, GB] }, { sovaBytes: 6.5 * GB, mem: [3 * GB, 2 * GB, GB, 0.5 * GB] }),
  ];
  const m = chartModel(pts, {}, { width: 720, height: 120, now });
  assert.equal(m.memMax, 6.5 * GB, "the old numbers set no scale");
  assert.equal(m.memory.length, 1);
  assert.ok(m.memory[0]!.startsWith(`M${Math.round(m.xs[2]! * 10) / 10},`), `memory line starts at the first new tick: ${m.memory[0]}`);
  assert.equal(chartModel(pts.slice(0, 2), {}, { width: 720, height: 120, now }).memory.length, 0, "no new tick: no memory line at all");
  assert.equal(readoutText(pts[4]!), "CPU 10% · Sova memory 6.5 GB: backend 3 GB, runtime 2 GB, Claude Code 1 GB, tools 512 MB · load 1.00");
  assert.equal(readoutText(pts[0]!), "CPU 10% · load 1.00");
  // A moment from before the change shows no memory per row rather than the old count.
  const old = rowsAt(pts[0]!, {}, undefined);
  assert.ok(old.every((r) => Number.isNaN(r.rssBytes)));
  assert.equal(rowsAt(pts[4]!, {}, undefined)[0]!.rssBytes, GB);
});

test("meters: unit memory is anon, not memory.current; number first with context", () => {
  const m = meters(snapshot());
  assert.deepEqual(
    m.map((x) => x.key),
    ["load", "memory", "swap", "psi", "loop"],
  );
  const mem = m.find((x) => x.key === "memory")!;
  assert.equal(mem.value, "10 GB");
  assert.equal(mem.of, " of 32 GB");
  assert.match(mem.context!, /holds 18 GB, including 7.3 GB of page cache, peak 20 GB/);
  const load = m.find((x) => x.key === "load")!;
  assert.equal(load.value, "4.00");
  assert.equal(load.pct, 25);
  const swap = m.find((x) => x.key === "swap")!;
  assert.equal(swap.value, "2 GB");
  assert.equal(swap.pct, 25);
});

test("meters degrade: tree uses the tree's RSS, none keeps only the server", () => {
  const tree = meters(snapshot({ scope: "tree", unit: undefined }));
  assert.equal(tree.find((x) => x.key === "memory")!.value, "12 GB");
  const none = meters(snapshot({ scope: "none", unit: undefined, host: { loadavg: [0, 0, 0], memTotalBytes: 8 * GB, memAvailableBytes: GB, swapTotalBytes: 0, swapFreeBytes: 0 } }));
  assert.deepEqual(
    none.map((x) => x.key),
    ["memory", "loop"],
  );
  assert.equal(none[0]!.label, "Server memory");
  const noSwap = meters(snapshot({ host: { ...snapshot().host, swapTotalBytes: 0, swapFreeBytes: 0 } })).find((x) => x.key === "swap")!;
  assert.equal(noSwap.ghost, true);
});

test("live rows: sessions heaviest first, workers heaviest first, then server and buckets", () => {
  const rows = liveRows(snapshot());
  assert.deepEqual(
    rows.map((r) => r.label),
    ["Backend", "Heavy", "Light", "Escaped processes"],
  );
  const heavy = rows[1]!;
  assert.equal(heavy.sessionPath, "/s/heavy.jsonl");
  assert.deepEqual(
    heavy.workers.map((w) => w.label),
    ["builder", "reviewer"],
  );
  assert.equal(heavy.workers[0]!.top[0]!.cmd, "java … clojure.main");
  assert.equal(heavy.procs[0]!.via, "cwd");
  const escaped = rows.at(-1)!;
  assert.equal(escaped.procs[0]!.chargedTo, "Heavy · w3");
  assert.equal(escaped.caption, "In the unit, no longer under the server; 1 also counted in its session above");
  // Tree scope has no escaped bucket to show.
  assert.ok(!liveRows(snapshot({ scope: "tree", unit: undefined })).some((r) => r.kind === "escaped"));
});

test("a worker with no name shows its id; folder matches are labelled guesses", () => {
  assert.equal(liveRows(snapshot())[2]!.workers[0]!.label, "w1");
  assert.equal(isHeuristic("cwd"), true);
  assert.equal(isHeuristic("exited-tools"), true);
  assert.equal(isHeuristic("env"), false);
  assert.equal(isHeuristic("worker-pid"), false);
  assert.equal(isHeuristic("sid"), false);
});

test("status and idle summary", () => {
  const s = snapshot();
  assert.equal(statusText({ status: "idle", idleSince: s.at - 3 * 3600_000 - 12 * 60_000 }, s.at), "Idle 3h 12m");
  assert.equal(statusText({ status: "working" }, s.at), "Working");
  assert.equal(statusText({}, s.at), undefined);
  assert.equal(idleSummary(s), "1 idle worker holds 300 MB; 2 working.");
  assert.equal(idleSummary(snapshot({ sessions: [] })), null);
});

test("rows at a scrubbed moment come from the point, named by the history and the live snapshot", () => {
  const p = point(
    500,
    { "/s/heavy.jsonl": [80, 2 * GB], server: [3, 400 * MB], unattributed: [1, 10 * MB] },
    {
      workers: { "/s/heavy.jsonl": { w3: [70, GB], w2: [10, GB] } },
      top: [
        { pid: 302, cmd: "tsc", kind: "build", cpuPct: 60, rssBytes: 300 * MB, group: "/s/heavy.jsonl", workerId: "w3" },
        { pid: 9, cmd: "git status", kind: "other", cpuPct: 1, rssBytes: MB, group: "unattributed" },
      ],
    },
  );
  const rows = rowsAt(p, { "/s/heavy.jsonl": { label: "Heavy", sessionPath: "/s/heavy.jsonl" } }, snapshot());
  assert.deepEqual(
    rows.map((r) => [r.label, r.kind]),
    [
      ["Backend", "server"],
      ["Heavy", "session"],
      ["Not attributed", "unattributed"],
    ],
  );
  assert.equal(rows[1]!.sessionPath, "/s/heavy.jsonl");
  assert.deepEqual(
    rows[1]!.workers.map((w) => [w.label, w.cpuPct]),
    [
      ["builder", 70],
      ["reviewer", 10],
    ],
  );
  assert.equal(rows[1]!.workers[0]!.top[0]!.cmd, "tsc");
  assert.equal(rows[2]!.procs[0]!.cmd, "git status");
});

test("transient work: busy earlier, not running now, runs of one command folded, heaviest first", () => {
  const pts = [
    point(1, {}, { top: [{ pid: 7, cmd: "tsc", kind: "build", cpuPct: 90, rssBytes: 200 * MB, group: "/s/heavy.jsonl", workerId: "w3" }] }),
    point(2, {}, {
      top: [
        { pid: 7, cmd: "tsc", kind: "build", cpuPct: 120, rssBytes: 250 * MB, group: "/s/heavy.jsonl", workerId: "w3" },
        { pid: 302, cmd: "java … clojure.main", kind: "java", cpuPct: 190, rssBytes: GB },
      ],
    }),
    point(3, {}, {
      top: [
        { pid: 8, cmd: "vite build", kind: "build", cpuPct: 50, rssBytes: 100 * MB },
        { pid: 9, cmd: "sleep", kind: "other", cpuPct: 0.2, rssBytes: MB },
        { pid: 17, cmd: "tsc", kind: "build", cpuPct: 60, rssBytes: 150 * MB, group: "/s/heavy.jsonl", workerId: "w3" },
      ],
    }),
  ];
  const alive = livePids(snapshot());
  assert.ok(alive.has(302) && alive.has(100) && alive.has(400) && alive.has(301));
  const t = transient(pts, alive);
  assert.deepEqual(
    t.map((r) => [transientName(r), r.peakCpuPct, r.firstAt, r.lastAt]),
    [
      ["tsc ×2", 120, 1, 3],
      ["vite build", 50, 3, 3],
    ],
  );
  assert.equal(chargedTo(t[0]!, { "/s/heavy.jsonl": { label: "Heavy" } }), "Heavy · w3");
  assert.equal(chargedTo(t[1]!, {}), "Not attributed");
});

test("history: the 30s rollups fill in before the ring, deltas append and trim", () => {
  const now = 10_000_000;
  const span = 60 * 60_000;
  const coarse = [point(now - span - 30_000, {}), point(now - 2000_000, {}), point(now - 100_000, {})];
  const fine = [point(now - 600_000, {}), point(now - 5000, {})];
  const merged = mergeHistory(fine, coarse, now);
  assert.deepEqual(
    merged.map((p) => p.at),
    [now - 2000_000, now - 600_000, now - 5000],
  );
  const later = now + 5000;
  const next = appendHistory(merged, [point(now - 5000, {}), point(now, {})], later);
  assert.deepEqual(
    next.map((p) => p.at),
    [now - 2000_000, now - 600_000, now - 5000, now],
  );
  assert.equal(appendHistory(next, [], later), next);
  const trimmed = appendHistory(next, [], now + span - 1_000_000);
  assert.deepEqual(
    trimmed.map((p) => p.at),
    [now - 600_000, now - 5000, now],
  );
});

test("nearestIndex picks the closest tick", () => {
  const pts = [point(0, {}), point(5000, {}), point(10_000, {})];
  assert.equal(nearestIndex([], 3), -1);
  assert.equal(nearestIndex(pts, -100), 0);
  assert.equal(nearestIndex(pts, 2400), 0);
  assert.equal(nearestIndex(pts, 2600), 1);
  assert.equal(nearestIndex(pts, 99_999), 2);
});

test("chart: stacks the heaviest groups, folds the rest, breaks paths across gaps", () => {
  const now = 3_600_000;
  const pts = [
    point(now - 20_000, { a: [100, GB], b: [50, GB], c: [10, GB], d: [5, GB], e: [1, GB] }),
    point(now - 15_000, { a: [120, GB], b: [40, GB], c: [10, GB], d: [5, GB], e: [1, GB] }),
    point(now - 5000, { a: [90, 2 * GB], b: [20, GB] }),
    point(now, { a: [80, 2 * GB], b: [20, GB] }),
  ];
  const m = chartModel(pts, { a: { label: "Session A" }, b: { label: "b" }, c: { label: "c" } }, { width: 720, height: 120, now, maxSeries: 4 });
  assert.deepEqual(
    m.series.map((s) => s.label),
    ["Session A", "b", "c", "Everything else"],
  );
  assert.equal(m.cpuMax, 200);
  assert.equal(m.xs.length, 4);
  assert.equal(m.xs[3], 720);
  // 10s after a 5s step is not a gap: one run per series.
  assert.equal(m.series[0]!.paths.length, 1);
  // A 10-minute gap (a restart) starts a new path.
  const sova = (p: MonitorPoint) => ({ ...p, sovaBytes: 4 * GB });
  const gapped = chartModel([sova(pts[0]!), sova(pts[1]!), sova(point(now + 600_000, { a: [10, GB] }))], {}, { width: 720, height: 120, now: now + 600_000 });
  assert.equal(gapped.series[0]!.paths.length, 2);
  assert.equal(gapped.memory.length, 2);
  // A lone point still draws a sliver.
  assert.match(gapped.series[0]!.paths[1]!, /Z$/);
});

test("footer and this tab", () => {
  assert.equal(samplerLine(snapshot().sampler, 142), "Sampling every 5s · last tick 2.1 ms · average 1.8 ms · 142 processes");
  assert.match(samplerLine({ ...snapshot().sampler, skipped: 2 }, 1), /1 process · 2 ticks skipped$/);
  assert.equal(tabLine(undefined), null);
  assert.equal(tabLine({ usedJSHeapSize: 84 * MB, totalJSHeapSize: 100 * MB, jsHeapSizeLimit: 4 * GB }), "This tab: 84 MB of JavaScript heap (limit 4 GB)");
});

test("reserved groups read the same everywhere, whatever the history calls them", () => {
  const labels = { unattributed: { label: "Unattributed" }, "/s/a.jsonl": { label: "A chat" } };
  assert.equal(groupLabel("unattributed", labels), "Not attributed");
  assert.equal(groupLabel("server", {}), "Backend");
  assert.equal(groupLabel("/s/a.jsonl", labels), "A chat");
  assert.equal(groupLabel("/s/b.jsonl", labels), "Untitled session");
  assert.equal(groupLabel("/s/c.jsonl", { "/s/c.jsonl": { label: "2026-09-29T06-28-59-167Z_01a0.jsonl", sessionPath: "/s/c.jsonl" } }), "Untitled session");
  const m = chartModel([point(0, { unattributed: [5, MB] })], labels, { width: 10, height: 10, now: 0 });
  assert.equal(m.series[0]!.label, "Not attributed");
});

test("session names come from the app's list, never from the file name", () => {
  const titleOf = (p: string) => ({ "/s/heavy.jsonl": "Renamed heavy", "/s/new.jsonl": "Untitled" })[p];
  const s = withTitles(snapshot(), titleOf);
  assert.deepEqual(
    liveRows(s).map((r) => r.label).slice(1, 3),
    ["Renamed heavy", "Light"],
  );
  assert.equal(liveRows(s).find((r) => r.kind === "escaped")!.procs[0]!.chargedTo, "Renamed heavy · w3");
  const labels = labelsWithTitles(
    { "/s/heavy.jsonl": { label: "heavy.jsonl", sessionPath: "/s/heavy.jsonl" }, "/s/new.jsonl": { label: "new.jsonl" }, server: { label: "Server" } },
    titleOf,
  );
  assert.equal(groupLabel("/s/heavy.jsonl", labels), "Renamed heavy");
  assert.equal(groupLabel("/s/new.jsonl", labels), "Untitled session");
  assert.equal(sessionLabel({ cwd: "/home/me/webapps/sova/" }), "Untitled session in sova");
  assert.equal(sessionLabel({ sessionPath: "/s/x.jsonl" }), "Untitled session");
});

test("a gone worker keeps its name from the history; a live one from the snapshot; else its id", () => {
  const nameOf = workerNamer(snapshot(), { "/s/old.jsonl": { ag_01: "jvm-runner" } });
  assert.equal(chargedTo({ group: "/s/old.jsonl", workerId: "ag_01" }, { "/s/old.jsonl": { label: "Old" } }, nameOf), "Old · jvm-runner");
  assert.equal(chargedTo({ group: "/s/heavy.jsonl", workerId: "w3" }, { "/s/heavy.jsonl": { label: "Heavy" } }, nameOf), "Heavy · builder");
  assert.equal(chargedTo({ group: "/s/heavy.jsonl", workerId: "w9" }, { "/s/heavy.jsonl": { label: "Heavy" } }, nameOf), "Heavy · w9");
  const rows = rowsAt(point(1, { "/s/old.jsonl": [5, MB] }, { workers: { "/s/old.jsonl": { ag_01: [5, MB] } } }), {}, undefined, { "/s/old.jsonl": { ag_01: "jvm-runner" } });
  assert.equal(rows[0]!.workers[0]!.label, "jvm-runner");
});

test("the synthetic pid 0 (exited tool children) is never taken for a live process", () => {
  const s = snapshot();
  s.sessions[0]!.own = [proc(0, "(exited tool children)", 4, 0, { via: "exited-tools" })];
  assert.ok(!livePids(s).has(0));
  const t = transient([point(1, {}, { top: [{ pid: 0, cmd: "(exited tool children)", kind: "other", cpuPct: 30, rssBytes: 0, group: "/s/light.jsonl" }] })], livePids(s));
  assert.equal(t[0]!.cmd, "(exited tool children)");
  assert.equal(isHeuristic(liveRows(s).find((r) => r.label === "Light")!.procs[0]!.via), true);
});
