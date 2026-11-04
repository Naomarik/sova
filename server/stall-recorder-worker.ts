// The stall recorder's watchdog (server/stall-recorder.ts starts it): a thread of its own, the one
// place that can see the main thread stalled, and the only writer of the log. It reads /proc and the
// shared board. Its reads are the ones that never take the target's mm lock (never maps or smaps,
// §app.resource-monitor/lightness-budget), so a process deep in a memory spike doesn't hold it up,
// and it never holds the process up. Where /proc is missing (macOS) it still has the board and RSS.

import { closeSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { parentPort, workerData } from "node:worker_threads";
import { parseLoadavg, parseMeminfo, pressureOf } from "./resource-monitor-proc";
import { ActivityBoard, CappedLog, StallWatch, type MainSample, type ProcDetail, type StallEnd, type WatchConfig, type WatchIO } from "./stall-recorder-core";

export interface WorkerConfig extends WatchConfig {
  sab: SharedArrayBuffer;
  dir: string;
  mainTid: number;
  /** The main thread's performance.now() and Date.now() at one moment: the board counts in its clock. */
  mainMono: number;
  mainWall: number;
}

const cfg = workerData as WorkerConfig;
const board = new ActivityBoard(cfg.sab);
const log = new CappedLog(cfg.dir);
const PAGE = 4096;
const TICK_HZ = 100;
const read = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

const statm = (() => {
  const buf = Buffer.alloc(128);
  let fd: number | null = null;
  try {
    fd = openSync("/proc/self/statm", "r");
  } catch {
    // no /proc
  }
  return (): number | null => {
    if (fd === null) return null;
    const n = readSync(fd, buf, 0, buf.length, 0);
    return Number(buf.toString("latin1", 0, n).split(" ")[1]) * PAGE;
  };
})();

/** One thread's `stat`, after its `(comm)`: the state, and user + system CPU in ms. */
function taskStat(tid: number | string): { comm: string; state: string; cpuMs: number } | null {
  const text = read(`/proc/self/task/${tid}/stat`);
  if (!text) return null;
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < 0) return null;
  const f = text.slice(close + 2).split(" ");
  return { comm: text.slice(open + 1, close), state: f[0] ?? "?", cpuMs: ((Number(f[11]) + Number(f[12])) * 1000) / TICK_HZ };
}

function mainSample(): MainSample | null {
  const st = taskStat(cfg.mainTid);
  if (!st) return null;
  const sched = read(`/proc/self/task/${cfg.mainTid}/schedstat`)?.split(" ");
  const wchan = read(`/proc/self/task/${cfg.mainTid}/wchan`)?.trim();
  const sys = read(`/proc/self/task/${cfg.mainTid}/syscall`);
  const syscall = sys ? Number(sys.split(" ")[0]) : NaN;
  return {
    state: st.state,
    cpuMs: sched ? Math.round(Number(sched[0]) / 1e6) : st.cpuMs,
    ...(sched ? { runQueueMs: Math.round(Number(sched[1]) / 1e6) } : {}),
    ...(wchan && wchan !== "0" ? { wchan } : {}),
    ...(Number.isFinite(syscall) ? { syscall } : {}),
  };
}

function statusBytes(text: string, key: string): number | undefined {
  const at = text.indexOf(`\n${key}:`);
  if (at < 0) return undefined;
  const v = parseInt(text.slice(at + key.length + 2), 10);
  return Number.isFinite(v) ? v * 1024 : undefined;
}

function detail(): ProcDetail | null {
  const out: ProcDetail = {};
  const self = read("/proc/self/stat");
  if (self) {
    const f = self.slice(self.lastIndexOf(")") + 2).split(" ");
    out.childrenCpuMs = ((Number(f[13]) + Number(f[14])) * 1000) / TICK_HZ;
  }
  const status = read("/proc/self/status");
  if (status) {
    out.memory = {
      rssBytes: statusBytes(status, "VmRSS"), anonBytes: statusBytes(status, "RssAnon"), fileBytes: statusBytes(status, "RssFile"),
      swapBytes: statusBytes(status, "VmSwap"), peakBytes: statusBytes(status, "VmHWM"),
    };
  }
  try {
    const threads: Record<string, number> = {};
    for (const tid of readdirSync("/proc/self/task")) {
      const st = taskStat(tid);
      if (!st) continue;
      const name = Number(tid) === cfg.mainTid ? "(main)" : st.comm;
      threads[name] = (threads[name] ?? 0) + st.cpuMs;
    }
    out.threads = threads;
  } catch {
    // no /proc
  }
  const load = read("/proc/loadavg");
  const meminfo = read("/proc/meminfo");
  if (load || meminfo) {
    const m = meminfo ? parseMeminfo(meminfo, ["MemAvailable", "SwapFree"]) : null;
    const pressure = pressureOf(read("/proc/pressure/cpu"), read("/proc/pressure/memory"), read("/proc/pressure/io"));
    out.host = {
      ...(load ? { load1: parseLoadavg(load)[0] } : {}), ...(m ? { memAvailableBytes: m.get("MemAvailable"), swapFreeBytes: m.get("SwapFree") } : {}),
      ...(pressure ? { pressure } : {}),
    };
  }
  return out;
}

const monoOffset = cfg.mainMono + (Date.now() - cfg.mainWall) - performance.now();
const io: WatchIO = {
  mono: () => performance.now() + monoOffset,
  wall: () => Date.now(),
  rssBytes: () => statm() ?? process.memoryUsage.rss(),
  mainSample,
  detail,
  write: (rec) => log.write(rec),
  toMain: (msg) => parentPort?.postMessage(msg),
};

let failures = 0;
const guarded = (step: () => void): void => {
  try {
    step();
  } catch {
    failures++;
    if (failures === 1) parentPort?.postMessage({ k: "failing" });
  }
};

let watch: StallWatch | null = null;
guarded(() => {
  watch = new StallWatch(board, cfg, io, log.tail());
});
setInterval(() => guarded(() => watch?.tick()), cfg.tickMs);

parentPort?.on("message", (msg: { k: string; end?: StallEnd; detail?: Record<string, unknown>; head?: string }) => {
  guarded(() => {
    if (msg.k === "stall-end" && msg.end) watch?.stallEnded(msg.end);
    else if (msg.k === "memory-detail" && msg.detail) watch?.memoryDetail(msg.detail);
    else if (msg.k === "shutdown") watch?.shutdown();
    else if (msg.k === "head" && msg.head) watch?.setHead(msg.head);
  });
});
