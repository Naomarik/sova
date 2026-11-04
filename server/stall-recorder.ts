// Stall recorder: the main thread's side (server/stall-recorder-core.ts has the board and the
// decisions, server/stall-recorder-worker.ts the watchdog thread). It keeps the record of a long
// stall or a memory spike for afterwards, since nothing on a stalled main thread can run:
//
// - A beat, once a second: one timer, a few atomic stores. Its silence is how the watchdog sees a
//   stall, and its first late firing how the main thread learns one has ended.
// - The shared board: in-flight and recent named operations, the last heap figures, gauges.
// - The JS sampler (JSC's, at 10 Hz, on the runtime's own thread): it can't be read from outside
//   the main thread, so the stacks of a stall reach the log when that stall ends, and a process
//   that dies inside one leaves the board and the watchdog's readings instead.
//
// Everything here is best effort. No export throws, and a recorder that fails turns itself off.

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import type { MonitorStalls } from "../shared/protocol";
import { ActivityBoard, foldTraces, type FoldedStack, type SampledTrace, type StallEnd, type StallSummary } from "./stall-recorder-core";

const BEAT_MS = 1000;
const STALL_MS = 2000;
const TICK_MS = 1000;
const GIB = 1024 ** 3;
const MEMORY_FIRST_BYTES = 3 * GIB;
/** The sampler's period, in µs (the inspector's unit): 26 µs a sample, measured, so 0.03% of a busy core. */
const SAMPLE_US = 100_000;
/** How often the sampler's buffer is emptied when nothing is wrong; it grows only while JS runs. */
const DRAIN_MS = 30_000;
/** A heap walk costs about 40 ms per 100 MB, all of it on the main thread: above this it is skipped. */
const HEAP_WALK_MAX_BYTES = 4 * GIB;
const TYPES_KEPT = 16;
const LARGE_BYTES = 1024 * 1024;

export interface StallRecorderOptions {
  /** The log's folder, `<stateRoot>/stalls`. */
  dir: string;
  startedAt?: number;
  beatMs?: number;
  stallMs?: number;
  tickMs?: number;
  memoryFirstBytes?: number;
  /** The watchdog's module; a test names a broken one. */
  workerUrl?: URL;
  /** How often to empty the sampler. */
  drainMs?: number;
}

interface Sampler {
  drain(): SampledTrace[];
  stop(): void;
}

interface Jsc {
  heapStats(): { heapSize: number; heapCapacity: number; extraMemorySize: number; objectCount: number; objectTypeCounts: Record<string, number>; mimalloc?: { process?: { commit_current?: number } } };
  heapSize(): number;
}

interface Recorder {
  board: ActivityBoard;
  worker: Worker;
  beatTimer: ReturnType<typeof setInterval>;
  drainTimer?: ReturnType<typeof setInterval>;
  sampler: Sampler | null;
  jsc: Jsc | null;
  lastBeat: number;
  beatMs: number;
  stallMs: number;
  memoryFirstBytes: number;
  /** The stacks of the last drain, kept for a memory rung that crosses just after it. */
  lastStacks: { samples: number; stacks: FoldedStack[] };
  gauges: { name: string; read: () => number }[];
}

let rec: Recorder | null = null;
let state: MonitorStalls["state"] = "off";
let summaries: StallSummary[] = [];
const gauges: { name: string; read: () => number }[] = [];

const ds = () => Math.round(performance.now() / 100);
const quietly = (step: () => void): void => {
  try {
    step();
  } catch {
    // the recorder never reaches the server
  }
};

/** A profiler someone attached or asked for owns the JS sampler: there is one per process. */
export function profilerClaimed(flags: readonly string[]): boolean {
  return flags.some((f) => /^(--inspect|--cpu-prof|--heap-prof|BUN_INSPECT)/.test(f));
}

/** How this process was started, in names: a `--cpu-prof` run explains a memory climb by itself.
    Flag values and variables' values stay out, since they can be paths. */
export function processFlags(execArgv: readonly string[], argv: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const flags = [...execArgv, ...argv.slice(2).filter((a) => a.startsWith("-"))].map((a) => a.split("=")[0]!);
  const vars = Object.keys(env).filter((k) => /^(BUN_INSPECT|BUN_JSC_|BUN_OPTIONS$|NODE_OPTIONS$)/.test(k));
  return [...new Set([...flags, ...vars])].sort().slice(0, 32);
}

/** JSC's sampler at a coarse interval, where the runtime has one. Null anywhere else. */
async function startSampler(): Promise<{ sampler: Sampler; jsc: Jsc } | null> {
  const name = "bun:jsc"; // a variable, so Node's loader never resolves it
  const jsc = (await import(name)) as Jsc & { samplingProfilerStackTraces(): { traces: SampledTrace[] } };
  const { Session } = await import("node:inspector");
  const session = new Session();
  session.connect();
  const post = (method: string, params?: object) =>
    new Promise<void>((resolve, reject) => {
      (session.post as (m: string, p: object, cb: (e: Error | null) => void) => void)(method, params ?? {}, (e) => (e ? reject(e) : resolve()));
    });
  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval: SAMPLE_US });
  await post("Profiler.start");
  return {
    jsc,
    sampler: {
      drain: () => jsc.samplingProfilerStackTraces().traces,
      stop: () => quietly(() => session.disconnect()),
    },
  };
}

function shut(next: MonitorStalls["state"]): void {
  const r = rec;
  rec = null;
  state = next;
  if (!r) return;
  clearInterval(r.beatTimer);
  if (r.drainTimer) clearInterval(r.drainTimer);
  r.sampler?.stop();
  void r.worker.terminate().catch(() => {});
}

function onBeat(r: Recorder): void {
  const now = performance.now();
  const gap = now - r.lastBeat;
  r.lastBeat = now;
  r.board.beat(gap - r.beatMs);
  if (gap - r.beatMs >= r.stallMs) stallEnded(r, gap);
}

function stallEnded(r: Recorder, gapMs: number): void {
  const end: StallEnd = { gapMs: Math.round(gapMs), atLeastMs: Math.round(gapMs - r.beatMs) };
  quietly(() => {
    end.mem = process.memoryUsage();
  });
  quietly(() => {
    const traces = r.sampler?.drain();
    if (!traces) return;
    const { samples, stacks } = foldTraces(traces, gapMs);
    end.samples = samples;
    end.stacks = stacks;
  });
  r.worker.postMessage({ k: "stall-end", end });
}

function drain(r: Recorder): void {
  const traces = r.sampler?.drain();
  if (traces?.length) r.lastStacks = foldTraces(traces);
}

function memoryDetail(r: Recorder, rungBytes: number): void {
  const detail: Record<string, unknown> = { rungBytes };
  quietly(() => {
    detail.mem = process.memoryUsage();
  });
  quietly(() => {
    const size = r.jsc?.heapSize();
    if (size === undefined) return;
    detail.heapSizeBytes = size;
    if (size > HEAP_WALK_MAX_BYTES) return;
    const h = r.jsc!.heapStats();
    Object.assign(detail, {
      heapCapacityBytes: h.heapCapacity, extraMemoryBytes: h.extraMemorySize, objectCount: h.objectCount, mimallocCommitBytes: h.mimalloc?.process?.commit_current,
      objectTypes: Object.entries(h.objectTypeCounts).sort((a, b) => b[1] - a[1]).slice(0, TYPES_KEPT),
    });
  });
  quietly(() => {
    drain(r);
    detail.samples = r.lastStacks.samples;
    detail.stacks = r.lastStacks.stacks;
  });
  // Past the second rung the sampler goes: whatever is climbing, nothing of ours may be part of it.
  // Each sample is small and the buffer is emptied, measured flat, but this is the sampler that took
  // an undrained `--cpu-prof` run to 60 GB. The board and the watchdog go on.
  if (rungBytes >= r.memoryFirstBytes * 2 && r.sampler) {
    r.sampler.stop();
    r.sampler = null;
    if (r.drainTimer) clearInterval(r.drainTimer);
    detail.samplerStopped = true;
  }
  r.worker.postMessage({ k: "memory-detail", detail });
}

/** The process's last line. The watchdog can't be asked (nothing waits for it now), so this one line
    is the main thread's own; a stall's end is worth one write at exit. */
function noteExit(dir: string, code: number): void {
  if (rec) quietly(() => appendFileSync(join(dir, "stalls.jsonl"), JSON.stringify({ v: 1, at: Date.now(), pid: process.pid, t: "exit", code }) + "\n"));
}

/** Start the recorder. Off with SOVA_STALL_RECORDER=off; without stacks with SOVA_STALL_STACKS=off. */
export function startStallRecorder(opts: StallRecorderOptions): void {
  if (rec || process.env.SOVA_STALL_RECORDER === "off") return;
  try {
    const board = ActivityBoard.create();
    const beatMs = opts.beatMs ?? BEAT_MS;
    const stallMs = opts.stallMs ?? STALL_MS;
    const memoryFirstBytes = opts.memoryFirstBytes ?? MEMORY_FIRST_BYTES;
    const flags = processFlags(process.execArgv, process.argv, process.env);
    const worker = new Worker(opts.workerUrl ?? new URL("./stall-recorder-worker.ts", import.meta.url), {
      smol: true,
      workerData: {
        sab: board.sab, dir: opts.dir, mainTid: process.pid, beatMs, stallMs, tickMs: opts.tickMs ?? TICK_MS,
        memoryFirstBytes, pid: process.pid, startedAt: opts.startedAt ?? Date.now(), flags,
        mainMono: performance.now(), mainWall: Date.now(),
      },
    } as ConstructorParameters<typeof Worker>[1]);
    worker.unref();
    const r: Recorder = {
      board, worker, beatMs, stallMs, memoryFirstBytes, sampler: null, jsc: null, lastBeat: performance.now(), lastStacks: { samples: 0, stacks: [] }, gauges,
      beatTimer: setInterval(() => quietly(() => rec === r && onBeat(r)), beatMs),
    };
    r.beatTimer.unref?.();
    rec = r;
    state = "on";
    worker.on("error", () => rec === r && shut("failed"));
    worker.on("exit", () => rec === r && shut("failed"));
    worker.on("message", (msg: { k: string; list?: StallSummary[]; rungBytes?: number }) => {
      quietly(() => {
        if (msg.k === "summaries" && msg.list) summaries = msg.list;
        else if (msg.k === "failing") state = "failed";
        else if (msg.k === "memory" && rec === r) memoryDetail(r, msg.rungBytes ?? 0);
      });
    });
    process.on("exit", (code) => noteExit(opts.dir, code));
    if (process.env.SOVA_STALL_STACKS !== "off" && !profilerClaimed(flags)) {
      void startSampler().then(
        (got) => {
          if (!got) return;
          if (rec !== r) return got.sampler.stop();
          r.sampler = got.sampler;
          r.jsc = got.jsc;
          r.drainTimer = setInterval(() => quietly(() => rec === r && drain(r)), opts.drainMs ?? DRAIN_MS);
          r.drainTimer.unref?.();
        },
        () => {}, // no sampler here: the record goes without stacks
      );
    }
  } catch {
    shut("failed");
  }
}

export function stopStallRecorder(): void {
  shut("off");
}

/** Is the recorder on? A caller that must build a name first asks. */
export const stallRecording = (): boolean => rec !== null;

/** Begin a named operation. `name` is fixed text or a route pattern, never a value from a request. */
export function opStart(name: string, detail = 0): number {
  if (!rec) return -1;
  try {
    return rec.board.enter(name, ds(), detail);
  } catch {
    return -1;
  }
}

/** End an operation, with its final count if it has one. */
export function opEnd(token: number, detail?: number): void {
  if (rec) quietly(() => rec?.board.exit(token, ds(), detail));
}

/** Run `fn` as a named operation, sync or async; `count` reads a row count off its result. */
export function opTrack<T>(name: string, fn: () => T, count?: (result: Awaited<T>) => number): T {
  const token = opStart(name);
  let result: T;
  try {
    result = fn();
  } catch (err) {
    opEnd(token);
    throw err;
  }
  if (result instanceof Promise) {
    return result.then(
      (value) => {
        opEnd(token, count?.(value as Awaited<T>));
        return value;
      },
      (err) => {
        opEnd(token);
        throw err;
      },
    ) as T;
  }
  opEnd(token, count?.(result as Awaited<T>));
  return result;
}

/** Note a thing by name and size in bytes: a read, a frame. Only a large one lands in the recent ring, in KB. */
export function opNote(name: string, bytes: number): void {
  if (rec && bytes >= LARGE_BYTES) quietly(() => rec?.board.event(name, ds(), bytes / 1024));
}

/** A count the board shows, read on the monitor's tick. `read` must be cheap, and may throw. */
export function stallGauge(name: string, read: () => number): void {
  gauges.push({ name, read });
}

/** Put the heap figures and gauges on the board: called from the monitor's tick, which has them already. */
export function publishStallFigures(mem: NodeJS.MemoryUsage): void {
  const r = rec;
  if (!r) return;
  quietly(() => r.board.publishMemory(ds(), mem));
  r.gauges.forEach((g, i) => quietly(() => r.board.gauge(i, g.name, g.read())));
}

/** The commit this server runs: it goes on every record from here on. */
export function noteStallHead(head: string | null): void {
  if (head) quietly(() => rec?.worker.postMessage({ k: "head", head }));
}

/** The server's shutdown began. */
export function noteStallShutdown(): void {
  quietly(() => rec?.worker.postMessage({ k: "shutdown" }));
}

/** What /api/monitor shows of the recorder. */
export function stallRecorderStatus(): MonitorStalls {
  return { state, recent: summaries };
}
