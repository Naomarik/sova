// Stall recorder, the parts with no thread or process of their own: the shared board the main
// thread writes and the watchdog reads, the size-capped log, the watchdog's decisions, and folding
// the sampler's stacks. server/stall-recorder.ts is the main thread's side, and
// server/stall-recorder-worker.ts the watchdog's. Why it is split this way: when the main thread is
// stalled nothing on it runs, so everything the watchdog must see during a stall is already in
// shared memory, written as plain Int32 stores by code that costs tens of nanoseconds.
//
// Only names, sizes, counts and durations enter here. A name on the board is a route pattern or a
// fixed operation name, never a URL, path, title or message.

import { closeSync, mkdirSync, openSync, readSync, renameSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `<stateRoot>/stalls`, worked out without server/state-root.ts, which loads the whole pi SDK:
    the recorder starts before anything heavy (server/stall-recorder-boot.ts). */
export function stallLogDir(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.PI_CODING_AGENT_DIR;
  const agent = !set ? join(homedir(), ".pi", "agent") : set === "~" ? homedir() : set.startsWith("~/") ? join(homedir(), set.slice(2)) : set;
  return join(agent, "sova", "stalls");
}

// ── The board ────────────────────────────────────────────────────────────────────────────────

const HEADER = 32;
const BEAT = 0;
const NAMES = 1;
const OPS_DROPPED = 2;
const RECENT_NEXT = 3;
const MEM_AT_DS = 4;
const HEAP_USED_MB = 5;
const HEAP_TOTAL_MB = 6;
const EXTERNAL_MB = 7;
const ARRAY_BUFFERS_MB = 8;
const LATE_MAX_MS = 9;
const LATE_BUCKETS_AT = 10;
/** Upper edges of the beat-lateness buckets, in ms; the last bucket is everything above them. */
export const LATE_EDGES_MS = [10, 50, 100, 250, 500, 1000, 2000, 5000, 15000] as const;
const LATE_BUCKETS = LATE_EDGES_MS.length + 1;

const OP_SLOTS = 64;
const OP_STRIDE = 3; // name id + 1 (0: free), start, detail
const RECENT_SLOTS = 128;
const RECENT_STRIDE = 4; // name id + 1, start, duration ms, detail
const GAUGE_SLOTS = 32;
const GAUGE_STRIDE = 2; // name id + 1, value
const OPS_AT = HEADER;
const RECENT_AT = OPS_AT + OP_SLOTS * OP_STRIDE;
const GAUGES_AT = RECENT_AT + RECENT_SLOTS * RECENT_STRIDE;
const INTS = GAUGES_AT + GAUGE_SLOTS * GAUGE_STRIDE;

/** At most this many distinct names; any further name is OTHER_NAME. Routes and code names are few. */
export const NAME_SLOTS = 1024;
const NAME_BYTES = 48;
const NAME_MAX = NAME_BYTES - 1;
const NAMES_AT_BYTES = INTS * 4;
export const BOARD_BYTES = NAMES_AT_BYTES + NAME_SLOTS * NAME_BYTES;
export const OTHER_NAME = "(other)";

const MB = 1024 * 1024;
const toMb = (bytes: number) => Math.min(0x7fffffff, Math.round(Math.max(0, bytes) / MB));
const clampInt = (n: number) => (Number.isFinite(n) ? Math.min(0x7fffffff, Math.max(0, Math.round(n))) : 0);

export interface BoardOp { name: string; ageMs: number; detail?: number }
export interface BoardRecent { name: string; agoMs: number; durationMs: number; detail?: number }
export interface BoardMemory { ageMs: number; heapUsedMb: number; heapTotalMb: number; externalMb: number; arrayBuffersMb: number }

/**
 * The shared board. One writer, the main thread: it alone calls the writing methods, which allocate
 * nothing once a name is known. One reader, the watchdog. A reader can see a slot mid-write; every
 * value here is a diagnostic, so the worst outcome is one odd figure, and a name id is stored last so
 * a slot's name is always a real name.
 */
export class ActivityBoard {
  readonly i32: Int32Array;
  private readonly u8: Uint8Array;
  private readonly ids = new Map<string, number>();
  private readonly free: number[] = [];
  /** Each slot's current token: a slot's number plus a count of its uses, so a spent token never ends the slot's next op. */
  private readonly tokens = new Int32Array(OP_SLOTS).fill(-1);
  private readonly uses = new Int32Array(OP_SLOTS);
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  constructor(readonly sab: SharedArrayBuffer) {
    this.i32 = new Int32Array(sab);
    this.u8 = new Uint8Array(sab);
    for (let i = OP_SLOTS - 1; i >= 0; i--) this.free.push(i);
  }

  static create(): ActivityBoard {
    return new ActivityBoard(new SharedArrayBuffer(BOARD_BYTES));
  }

  // The writer.

  /** The id of `name`, written to the board the first time it is met. */
  nameId(name: string): number {
    const known = this.ids.get(name);
    if (known !== undefined) return known;
    const id = this.ids.size;
    if (id >= NAME_SLOTS - 1 && name !== OTHER_NAME) return this.nameId(OTHER_NAME);
    const at = NAMES_AT_BYTES + id * NAME_BYTES;
    const room = this.u8.subarray(at + 1, at + 1 + NAME_MAX);
    const { written } = this.encoder.encodeInto(name, room);
    this.u8[at] = written;
    this.ids.set(name, id);
    Atomics.store(this.i32, NAMES, this.ids.size);
    return id;
  }

  /** A token for `op`, or -1 when every slot is taken (counted, never an error). */
  enter(name: string, nowDs: number, detail = 0): number {
    const slot = this.free.pop();
    if (slot === undefined) {
      Atomics.add(this.i32, OPS_DROPPED, 1);
      return -1;
    }
    const at = OPS_AT + slot * OP_STRIDE;
    this.i32[at + 1] = nowDs;
    this.i32[at + 2] = clampInt(detail);
    Atomics.store(this.i32, at, this.nameId(name) + 1);
    const token = slot + OP_SLOTS * (this.uses[slot] = (this.uses[slot]! + 1) & 0xfffff);
    this.tokens[slot] = token;
    return token;
  }

  /** End the op of `token`, moving it to the recent ring. An unknown or spent token does nothing. */
  exit(token: number, nowDs: number, detail?: number): void {
    const slot = token % OP_SLOTS;
    if (token < 0 || this.tokens[slot] !== token) return;
    const at = OPS_AT + slot * OP_STRIDE;
    const id = this.i32[at]!;
    const start = this.i32[at + 1]!;
    const d = detail === undefined ? this.i32[at + 2]! : clampInt(detail);
    Atomics.store(this.i32, at, 0);
    this.tokens[slot] = -1;
    this.free.push(slot);
    this.pushRecent(id, start, (nowDs - start) * 100, d);
  }

  /** A finished event with no duration of its own: a large read, a big frame. */
  event(name: string, nowDs: number, detail: number): void {
    this.pushRecent(this.nameId(name) + 1, nowDs, 0, clampInt(detail));
  }

  private pushRecent(id: number, start: number, durationMs: number, detail: number): void {
    const next = this.i32[RECENT_NEXT]!;
    const at = RECENT_AT + (next % RECENT_SLOTS) * RECENT_STRIDE;
    Atomics.store(this.i32, at, 0);
    this.i32[at + 1] = start;
    this.i32[at + 2] = clampInt(durationMs);
    this.i32[at + 3] = detail;
    Atomics.store(this.i32, at, id);
    Atomics.store(this.i32, RECENT_NEXT, (next + 1) & 0x7fffffff);
  }

  /** The beat: the loop is alive, and how late it came (ms past its interval). */
  beat(lateMs: number): void {
    const late = clampInt(lateMs);
    let bucket = 0;
    while (bucket < LATE_EDGES_MS.length && late > LATE_EDGES_MS[bucket]!) bucket++;
    Atomics.add(this.i32, LATE_BUCKETS_AT + bucket, 1);
    if (late > Atomics.load(this.i32, LATE_MAX_MS)) Atomics.store(this.i32, LATE_MAX_MS, late);
    Atomics.add(this.i32, BEAT, 1);
  }

  publishMemory(nowDs: number, mem: { heapUsed: number; heapTotal: number; external: number; arrayBuffers?: number }): void {
    this.i32[HEAP_USED_MB] = toMb(mem.heapUsed);
    this.i32[HEAP_TOTAL_MB] = toMb(mem.heapTotal);
    this.i32[EXTERNAL_MB] = toMb(mem.external);
    this.i32[ARRAY_BUFFERS_MB] = toMb(mem.arrayBuffers ?? 0);
    Atomics.store(this.i32, MEM_AT_DS, nowDs + 1);
  }

  /** Set gauge `index`. Beyond GAUGE_SLOTS a gauge is left out. */
  gauge(index: number, name: string, value: number): void {
    if (index < 0 || index >= GAUGE_SLOTS) return;
    const at = GAUGES_AT + index * GAUGE_STRIDE;
    this.i32[at + 1] = clampInt(value);
    Atomics.store(this.i32, at, this.nameId(name) + 1);
  }

  // The reader.

  beatSeq(): number {
    return Atomics.load(this.i32, BEAT);
  }

  private name(idPlusOne: number): string {
    const id = idPlusOne - 1;
    if (id < 0 || id >= NAME_SLOTS) return OTHER_NAME;
    const at = NAMES_AT_BYTES + id * NAME_BYTES;
    const len = Math.min(this.u8[at]!, NAME_MAX);
    return this.decoder.decode(this.u8.slice(at + 1, at + 1 + len));
  }

  /** In-flight ops, oldest first, at most `max`. */
  ops(nowDs: number, max = 16): { list: BoardOp[]; total: number; dropped: number } {
    const all: BoardOp[] = [];
    for (let slot = 0; slot < OP_SLOTS; slot++) {
      const at = OPS_AT + slot * OP_STRIDE;
      const id = Atomics.load(this.i32, at);
      if (!id) continue;
      const detail = this.i32[at + 2]!;
      all.push({ name: this.name(id), ageMs: Math.max(0, nowDs - this.i32[at + 1]!) * 100, ...(detail ? { detail } : {}) });
    }
    all.sort((a, b) => b.ageMs - a.ageMs);
    return { list: all.slice(0, max), total: all.length, dropped: Atomics.load(this.i32, OPS_DROPPED) };
  }

  /** The latest finished ops, newest first, at most `max`. */
  recent(nowDs: number, max = 24): BoardRecent[] {
    const next = Atomics.load(this.i32, RECENT_NEXT);
    const out: BoardRecent[] = [];
    for (let n = 1; n <= Math.min(max, RECENT_SLOTS, next); n++) {
      const at = RECENT_AT + ((next - n) % RECENT_SLOTS) * RECENT_STRIDE;
      const id = Atomics.load(this.i32, at);
      if (!id) continue;
      const detail = this.i32[at + 3]!;
      out.push({ name: this.name(id), agoMs: Math.max(0, nowDs - this.i32[at + 1]!) * 100, durationMs: this.i32[at + 2]!, ...(detail ? { detail } : {}) });
    }
    return out;
  }

  memory(nowDs: number): BoardMemory | null {
    const at = Atomics.load(this.i32, MEM_AT_DS);
    if (!at) return null;
    return {
      ageMs: Math.max(0, nowDs - (at - 1)) * 100, heapUsedMb: this.i32[HEAP_USED_MB]!, heapTotalMb: this.i32[HEAP_TOTAL_MB]!,
      externalMb: this.i32[EXTERNAL_MB]!, arrayBuffersMb: this.i32[ARRAY_BUFFERS_MB]!,
    };
  }

  gauges(): Record<string, number> {
    const out: Record<string, number> = {};
    for (let i = 0; i < GAUGE_SLOTS; i++) {
      const at = GAUGES_AT + i * GAUGE_STRIDE;
      const id = Atomics.load(this.i32, at);
      if (id) out[this.name(id)] = this.i32[at + 1]!;
    }
    return out;
  }

  /** The lateness counts, per bucket, since the start. */
  lateCounts(): number[] {
    return Array.from({ length: LATE_BUCKETS }, (_, i) => Atomics.load(this.i32, LATE_BUCKETS_AT + i));
  }

  /** The largest lateness since the last call, and start over. */
  takeLateMax(): number {
    return Atomics.exchange(this.i32, LATE_MAX_MS, 0);
  }
}

/** The bucket edge the `q`th (0..1) of these counts falls under: a figure "at most this late". */
export function lateQuantile(counts: readonly number[], q: number): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  let seen = 0;
  for (let i = 0; i < counts.length; i++) {
    seen += counts[i]!;
    if (seen >= total * q) return LATE_EDGES_MS[i] ?? LATE_EDGES_MS[LATE_EDGES_MS.length - 1]!;
  }
  return LATE_EDGES_MS[LATE_EDGES_MS.length - 1]!;
}

// ── The log ──────────────────────────────────────────────────────────────────────────────────

/** Each of the two files stops at this size, so the log never holds more than twice it. */
export const LOG_FILE_MAX = 1024 * 1024;
/** One record's most: past it the record drops its long lists. */
export const LOG_LINE_MAX = 32 * 1024;
const LOG_NAME = "stalls.jsonl";
const LOG_OLD_NAME = "stalls.1.jsonl";
/** The fields a record gives up, in this order, when it is too long. */
const SHEDDABLE = ["recent", "stacks", "threads", "ops", "rssTrailMb", "trail", "objectTypes"] as const;

/** Lines appended to `<dir>/stalls.jsonl`; a line that would pass `fileMax` first moves it to `stalls.1.jsonl`. */
export class CappedLog {
  readonly file: string;
  private readonly old: string;
  private size: number | null = null;

  constructor(readonly dir: string, private readonly fileMax = LOG_FILE_MAX, private readonly lineMax = LOG_LINE_MAX) {
    this.file = join(dir, LOG_NAME);
    this.old = join(dir, LOG_OLD_NAME);
  }

  /** Append one record. Throws what the disk throws: the caller decides what a failure means. */
  write(rec: Record<string, unknown>): void {
    let line = JSON.stringify(rec) + "\n";
    if (line.length > this.lineMax) {
      const short = { ...rec, truncated: true };
      for (const field of SHEDDABLE) {
        delete (short as Record<string, unknown>)[field];
        line = JSON.stringify(short) + "\n";
        if (line.length <= this.lineMax) break;
      }
      if (line.length > this.lineMax) return;
    }
    const bytes = Buffer.from(line);
    if (this.size === null) {
      mkdirSync(this.dir, { recursive: true });
      try {
        this.size = statSync(this.file).size;
      } catch {
        this.size = 0;
      }
    }
    if (this.size + bytes.length > this.fileMax) {
      renameSync(this.file, this.old);
      this.size = 0;
    }
    const fd = openSync(this.file, "a");
    try {
      writeSync(fd, bytes);
    } finally {
      closeSync(fd);
    }
    this.size += bytes.length;
  }

  /** The records in the last `bytes` of the newest file; an unreadable log is no records. */
  tail(bytes = 64 * 1024): Record<string, unknown>[] {
    let fd: number | undefined;
    try {
      const size = statSync(this.file).size;
      const take = Math.min(size, bytes);
      const buf = Buffer.alloc(take);
      fd = openSync(this.file, "r");
      readSync(fd, buf, 0, take, size - take);
      const lines = buf.toString("utf8").split("\n");
      if (take < size) lines.shift();
      const out: Record<string, unknown>[] = [];
      for (const line of lines) {
        if (!line) continue;
        try {
          out.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // a torn last line
        }
      }
      return out;
    } catch {
      return [];
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}

// ── Stacks ───────────────────────────────────────────────────────────────────────────────────

export interface SampledFrame { name?: string; sourceURL?: string; line?: number }
export interface SampledTrace { timestamp: number; frames: SampledFrame[] }
export interface FoldedStack { samples: number; frames: string[] }

const STACK_DEPTH = 14;
const STACKS_KEPT = 10;
/** Where a source path starts counting as ours; anything else keeps only its file name, so no record names a home. */
const SOURCE_ROOTS = /\/(server|shared|src|pi-config|node_modules)\//;

/** `name file:line`, with the path cut to the repository's own part. */
export function frameLabel(f: SampledFrame): string {
  const name = (f.name || "(anonymous)").slice(0, 60);
  const url = f.sourceURL ?? "";
  if (!url || url.startsWith("[")) return name;
  const root = SOURCE_ROOTS.exec(url);
  const file = root ? url.slice(root.index + 1) : url.slice(url.lastIndexOf("/") + 1);
  const short = file.length > 80 ? file.slice(file.length - 80) : file;
  const line = typeof f.line === "number" && f.line > 0 && f.line < 0xffffffff ? `:${f.line}` : "";
  return `${name} ${short}${line}`;
}

/** The traces of the last `windowMs` before the newest one, folded to the commonest stacks, leaf first. */
export function foldTraces(traces: readonly SampledTrace[], windowMs = Infinity): { samples: number; stacks: FoldedStack[] } {
  const newest = traces.length ? traces[traces.length - 1]!.timestamp : 0;
  const from = newest - windowMs / 1000;
  const fold = new Map<string, FoldedStack>();
  let samples = 0;
  for (const t of traces) {
    if (t.timestamp < from) continue;
    samples++;
    const frames = t.frames.slice(0, STACK_DEPTH).map(frameLabel);
    const key = frames.join("\n");
    const seen = fold.get(key);
    if (seen) seen.samples++;
    else fold.set(key, { samples: 1, frames });
  }
  return { samples, stacks: [...fold.values()].sort((a, b) => b.samples - a.samples).slice(0, STACKS_KEPT) };
}

// ── What the watchdog reads of the process ───────────────────────────────────────────────────

/** The main thread at one instant, from its /proc task files. */
export interface MainSample { state: string; cpuMs: number; runQueueMs?: number; wchan?: string; syscall?: number }
/** The process and host at one instant: the slower read, taken at the moments that matter. */
export interface ProcDetail {
  /** CPU of the children this process has reaped, in ms: the monitor's server figure leaves it out. */
  childrenCpuMs?: number;
  memory?: { rssBytes?: number; anonBytes?: number; fileBytes?: number; swapBytes?: number; peakBytes?: number };
  threads?: Record<string, number>;
  host?: { load1?: number; memAvailableBytes?: number; swapFreeBytes?: number; pressure?: unknown };
}

export type StallClass = "spinning" | "starved" | "blocked";

/** What held the thread, from how it spent the time: on a core, waiting for one, or neither (a
    blocking call, the disk, a lock). The two kinds of stall want different cures. */
export function stallClass(heldMs: number, cpuMs: number, runQueueMs: number): StallClass {
  if (runQueueMs >= heldMs * 0.25 && runQueueMs >= cpuMs * 0.5) return "starved";
  return cpuMs >= heldMs * 0.5 ? "spinning" : "blocked";
}

/** Per-thread-name CPU ms between two detail reads, largest first. */
export function threadDeltas(from: Record<string, number> | undefined, to: Record<string, number> | undefined, max = 8): { name: string; cpuMs: number }[] {
  if (!to) return [];
  return Object.entries(to)
    .map(([name, ms]) => ({ name, cpuMs: Math.max(0, ms - (from?.[name] ?? 0)) }))
    .filter((t) => t.cpuMs > 0)
    .sort((a, b) => b.cpuMs - a.cpuMs)
    .slice(0, max);
}

// ── The watchdog ─────────────────────────────────────────────────────────────────────────────

export interface WatchConfig {
  /** How often the main thread beats. */
  beatMs: number;
  /** How long the loop must be held, past a beat, to count as a stall. */
  stallMs: number;
  /** How often the watchdog looks. */
  tickMs: number;
  /** The memory ladder's first rung; each next one is twice the last. */
  memoryFirstBytes: number;
  pid: number;
  head?: string;
  startedAt: number;
  /** The process's flags: on every record, since the log outlives its boot line. Empty on a plain start. */
  flags?: string[];
}

export interface WatchIO {
  /** A monotonic clock, in ms, the board's `Ds` count being this over 100. */
  mono(): number;
  wall(): number;
  rssBytes(): number;
  mainSample(): MainSample | null;
  detail(): ProcDetail | null;
  write(rec: Record<string, unknown>): void;
  toMain(msg: { k: "memory"; rungBytes: number } | { k: "summaries"; list: StallSummary[] }): void;
}

/** What the main thread sends when a stall ends. */
export interface StallEnd {
  gapMs: number;
  atLeastMs: number;
  mem?: { rss: number; heapUsed: number; heapTotal: number; external: number; arrayBuffers?: number };
  samples?: number;
  stacks?: FoldedStack[];
}

/** A log record, in a line, for /api/monitor. */
export interface StallSummary {
  kind: "stall" | "stall-open" | "memory";
  at: number;
  pid: number;
  ms?: number;
  rssBytes?: number;
  top?: string;
  ops?: string[];
  /** A stall its process never reported the end of: it died, or was killed, inside it. */
  unfinished?: boolean;
}

const VERSION = 1;
const SUMMARIES = 8;
const RSS_TRAIL_POINTS = 64;
const TRAIL_POINTS = 60;
const TRAIL_EVERY_MS = 5000;
const WAIT_FOR_MAIN_TICKS = 3;
const MEM_POINT_STEP = 0.05;
const MEM_POINT_EVERY_MS = 5000;
const REARM_BELOW = 0.75;
const REARM_AFTER_MS = 10 * 60_000;
const HOUR_MS = 3_600_000;

const mb = (bytes: number) => Math.round(bytes / MB);

/** A record that names a stall or a memory rung, in the line /api/monitor shows. */
export function summaryOf(rec: Record<string, unknown>): StallSummary | null {
  const t = rec.t;
  if (t !== "stall" && t !== "stall-open" && t !== "memory") return null;
  const stacks = rec.stacks as FoldedStack[] | undefined;
  const ops = rec.ops as BoardOp[] | undefined;
  // The innermost frame in a source file: a runtime leaf (existsSync, node:fs) says little alone.
  const frames = stacks?.[0]?.frames;
  const top = frames?.find((f) => /\.[cm]?[jt]sx?(:\d+)?$/.test(f)) ?? frames?.[0];
  return {
    kind: t, at: Number(rec.at) || 0, pid: Number(rec.pid) || 0,
    ...(typeof rec.atMostMs === "number" ? { ms: rec.atMostMs } : {}),
    ...(typeof rec.rssBytes === "number" ? { rssBytes: rec.rssBytes } : {}),
    ...(top ? { top } : {}),
    ...(ops?.length ? { ops: ops.slice(0, 3).map((o) => o.name) } : {}),
  };
}

/** The newest summaries of a log's records. A stall-open with no close after it, from another process, is unfinished. */
export function summariesOf(records: readonly Record<string, unknown>[], pid: number, max = SUMMARIES): StallSummary[] {
  const out: StallSummary[] = [];
  for (const rec of records) {
    const s = summaryOf(rec);
    if (!s) continue;
    if (s.kind === "stall") {
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i]!.kind === "stall-open" && out[i]!.pid === s.pid) {
          out.splice(i, 1);
          break;
        }
      }
    }
    out.push(s);
  }
  for (const s of out) if (s.kind === "stall-open" && s.pid !== pid) s.unfinished = true;
  return out.slice(-max);
}

interface OpenStall {
  openedMono: number;
  heldAtOpenMs: number;
  sinceWall: number;
  detail: ProcDetail | null;
  first: MainSample | null;
  last: MainSample | null;
  states: Record<string, number>;
  wchans: Record<string, number>;
  rssAtOpen: number;
  rssPeak: number;
  rssTrailMb: number[];
  rssStride: number;
  ticks: number;
  /** A progress line at each doubling of the hold: a stall the process dies in leaves a trail, a long one few lines. */
  nextProgressMs: number;
  workerLagMaxMs: number;
  closingAt: number | null;
  rec: Record<string, unknown>;
}

/**
 * The watchdog's decisions: fed a tick at a time, with every read and write behind `io`, so a test
 * drives it on a fake clock. All of it runs off the main thread, and any step may throw; the caller
 * catches per tick.
 */
export class StallWatch {
  private lastSeq: number;
  private lastChangeMono: number;
  private lastTickMono: number;
  private open: OpenStall | null = null;
  private trail: number[] = [];
  private lastTrailMono = -Infinity;
  private nextRung: number;
  private lastCrossMono = -Infinity;
  private lastPointBytes = 0;
  private lastPointMono = -Infinity;
  private hourStartMono: number;
  private hourLate: number[];
  private hourRssMax = 0;
  private hourStalls = 0;
  private summaries: StallSummary[] = [];

  constructor(private readonly board: ActivityBoard, private readonly cfg: WatchConfig, private readonly io: WatchIO, earlier: readonly Record<string, unknown>[] = []) {
    const now = io.mono();
    this.lastSeq = board.beatSeq();
    this.lastChangeMono = now;
    this.lastTickMono = now;
    this.nextRung = cfg.memoryFirstBytes;
    this.hourStartMono = now;
    this.hourLate = board.lateCounts();
    this.summaries = summariesOf(earlier, cfg.pid);
    this.emit({ t: "boot" });
    if (this.summaries.length) this.io.toMain({ k: "summaries", list: this.summaries });
  }

  private ds(): number {
    return Math.round(this.io.mono() / 100);
  }

  private emit(rec: Record<string, unknown>): void {
    const stamped = {
      v: VERSION, at: this.io.wall(), pid: this.cfg.pid, uptimeS: Math.round((this.io.wall() - this.cfg.startedAt) / 1000),
      ...(this.cfg.head ? { head: this.cfg.head } : {}), ...(this.cfg.flags?.length ? { flags: this.cfg.flags } : {}), ...rec,
    };
    this.io.write(stamped);
    const s = summaryOf(stamped);
    if (!s) return;
    this.summaries = summariesOf([...this.summaries.map(toRecord), stamped], this.cfg.pid);
    this.io.toMain({ k: "summaries", list: this.summaries });
  }

  /** The board as it stands: what the main thread had in hand. */
  private boardNow(): Record<string, unknown> {
    const ds = this.ds();
    const ops = this.board.ops(ds);
    const heap = this.board.memory(ds);
    const gauges = this.board.gauges();
    return {
      ops: ops.list, opsInFlight: ops.total, ...(ops.dropped ? { opsDropped: ops.dropped } : {}),
      recent: this.board.recent(ds), ...(heap ? { heap } : {}), ...(Object.keys(gauges).length ? { gauges } : {}),
    };
  }

  tick(): void {
    const now = this.io.mono();
    const lag = Math.max(0, now - this.lastTickMono - this.cfg.tickMs);
    this.lastTickMono = now;
    const rss = this.io.rssBytes();
    if (rss > this.hourRssMax) this.hourRssMax = rss;
    if (now - this.lastTrailMono >= TRAIL_EVERY_MS) {
      this.lastTrailMono = now;
      this.trail.push(mb(rss));
      if (this.trail.length > TRAIL_POINTS) this.trail.shift();
    }

    const seq = this.board.beatSeq();
    if (seq !== this.lastSeq) {
      this.lastSeq = seq;
      this.lastChangeMono = now;
      if (this.open && this.open.closingAt === null) this.open.closingAt = now;
    }
    if (!this.open && now - this.lastChangeMono >= this.cfg.beatMs + this.cfg.stallMs) this.openStall(now, rss);
    if (this.open) {
      this.observe(now, rss, lag);
      const closing = this.open.closingAt;
      if (closing !== null && now - closing >= WAIT_FOR_MAIN_TICKS * this.cfg.tickMs) this.finish(null);
    }
    this.memory(now, rss);
    if (now - this.hourStartMono >= HOUR_MS) this.hour(now);
  }

  private openStall(now: number, rss: number): void {
    const heldAtOpenMs = now - this.lastChangeMono;
    const sinceWall = Math.round(this.io.wall() - heldAtOpenMs);
    const first = this.io.mainSample();
    const detail = this.io.detail();
    const rec = {
      sinceAt: sinceWall, rssBytes: rss, ...(first ? { main: first } : {}), ...(detail?.memory ? { memory: detail.memory } : {}),
      ...(detail?.host ? { host: detail.host } : {}), ...this.boardNow(),
    };
    this.open = {
      openedMono: now, heldAtOpenMs, sinceWall, detail, first, last: first, states: {}, wchans: {}, rssAtOpen: rss, rssPeak: rss,
      rssTrailMb: [], rssStride: 1, ticks: 0, nextProgressMs: heldAtOpenMs * 2, workerLagMaxMs: 0, closingAt: null, rec,
    };
    this.emit({ t: "stall-open", ...rec });
  }

  private observe(now: number, rss: number, lag: number): void {
    const o = this.open!;
    if (o.closingAt !== null) return;
    o.ticks++;
    if (lag > o.workerLagMaxMs) o.workerLagMaxMs = lag;
    if (rss > o.rssPeak) o.rssPeak = rss;
    if (o.ticks % o.rssStride === 0) {
      o.rssTrailMb.push(mb(rss));
      if (o.rssTrailMb.length >= RSS_TRAIL_POINTS) {
        o.rssTrailMb = o.rssTrailMb.filter((_, i) => i % 2 === 0);
        o.rssStride *= 2;
      }
    }
    const sample = this.io.mainSample();
    if (sample) {
      o.last = sample;
      o.first ??= sample;
      o.states[sample.state] = (o.states[sample.state] ?? 0) + 1;
      if (sample.wchan) o.wchans[sample.wchan] = (o.wchans[sample.wchan] ?? 0) + 1;
    }
    const heldMs = now - this.lastChangeMono;
    if (heldMs >= o.nextProgressMs) {
      o.nextProgressMs = heldMs * 2;
      const detail = this.io.detail();
      this.emit({
        t: "stall-progress", heldMs: Math.round(heldMs), rssBytes: rss, ...(sample ? { main: sample } : {}), ...(detail?.memory ? { memory: detail.memory } : {}),
        ...(detail?.host ? { host: detail.host } : {}), threads: threadDeltas(o.detail?.threads, detail?.threads),
      });
    }
  }

  /** The end of a stall: `end` from the main thread, or null when it never said. */
  private finish(end: StallEnd | null): void {
    const o = this.open;
    const seenMs = o ? o.heldAtOpenMs + Math.max(0, (o.closingAt ?? this.io.mono()) - o.openedMono) : 0;
    this.open = null;
    this.hourStalls++;
    const detail = o ? this.io.detail() : null;
    const cpuMs = o?.first && o.last ? o.last.cpuMs - o.first.cpuMs : undefined;
    const runQueueMs = o?.first?.runQueueMs !== undefined && o.last?.runQueueMs !== undefined ? o.last.runQueueMs - o.first.runQueueMs : undefined;
    const watchedMs = o ? (o.closingAt ?? this.io.mono()) - o.openedMono : 0;
    const childrenCpuMs = o?.detail?.childrenCpuMs !== undefined && detail?.childrenCpuMs !== undefined ? detail.childrenCpuMs - o.detail.childrenCpuMs : undefined;
    this.emit({
      t: "stall",
      atLeastMs: end?.atLeastMs ?? Math.round(seenMs), atMostMs: end?.gapMs ?? Math.round(seenMs), source: end ? "main" : "watchdog", seenLive: !!o,
      ...(o ? {
        sinceAt: o.sinceWall, ops: o.rec.ops, opsInFlight: o.rec.opsInFlight, recent: o.rec.recent, gauges: o.rec.gauges, heapBefore: o.rec.heap,
        rssBytes: o.rssAtOpen, rssPeakBytes: o.rssPeak, rssTrailMb: o.rssTrailMb, states: o.states, wchans: o.wchans, workerLagMaxMs: Math.round(o.workerLagMaxMs),
        ...(cpuMs !== undefined ? { mainCpuMs: cpuMs } : {}), ...(runQueueMs !== undefined ? { mainRunQueueMs: runQueueMs } : {}),
        ...(cpuMs !== undefined && runQueueMs !== undefined && watchedMs > 0 ? { watchedMs: Math.round(watchedMs), class: stallClass(watchedMs, cpuMs, runQueueMs) } : {}),
        ...(childrenCpuMs !== undefined ? { childrenCpuMs } : {}),
        opsDuring: this.opsDuring(end?.gapMs ?? seenMs),
        threads: threadDeltas(o.detail?.threads, detail?.threads), ...(o.detail?.host ? { host: o.detail.host } : {}),
      } : {}),
      ...(end?.mem ? { memAfter: { rssBytes: end.mem.rss, heapUsedBytes: end.mem.heapUsed, heapTotalBytes: end.mem.heapTotal, externalBytes: end.mem.external, arrayBuffersBytes: end.mem.arrayBuffers ?? 0 } } : {}),
      ...(end?.stacks ? { samples: end.samples ?? 0, stacks: end.stacks } : {}),
    });
  }

  /** How many of each operation finished within the last `ms`: a chain of builds reads as one stall. */
  private opsDuring(ms: number): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const r of this.board.recent(this.ds(), 128)) if (r.agoMs <= ms) counts[r.name] = (counts[r.name] ?? 0) + 1;
    return counts;
  }

  /** The main thread's word on a stall that just ended. */
  stallEnded(end: StallEnd): void {
    if (this.open && this.open.closingAt === null) this.open.closingAt = this.io.mono();
    this.finish(end);
  }

  /** The main thread's answer to a rung: its own heap, and what it was running. */
  memoryDetail(detail: Record<string, unknown>): void {
    this.emit({ t: "memory-detail", ...detail });
  }

  /** The commit this server runs, known once its modules have loaded. */
  setHead(head: string): void {
    this.cfg.head = head;
    this.emit({ t: "head" });
  }

  /** The server began its shutdown, as seen by its own handler. */
  shutdown(): void {
    this.emit({ t: "shutdown", ...(this.open ? { heldMs: Math.round(this.io.mono() - this.lastChangeMono) } : {}) });
  }

  private memory(now: number, rss: number): void {
    const first = this.cfg.memoryFirstBytes;
    if (rss >= this.nextRung) {
      // The highest rung crossed: a jump past several is one record, and the main thread acts on the rung it names.
      let rungBytes = this.nextRung;
      while (this.nextRung <= rss) {
        rungBytes = this.nextRung;
        this.nextRung *= 2;
      }
      this.lastCrossMono = now;
      const detail = this.io.detail();
      this.emit({
        t: "memory", rungBytes, rssBytes: rss, trail: this.trail.slice(), ...(detail?.memory ? { memory: detail.memory } : {}),
        ...(detail?.host ? { host: detail.host } : {}), ...(detail?.threads ? { threads: threadDeltas(undefined, detail.threads) } : {}), ...this.boardNow(),
      });
      this.io.toMain({ k: "memory", rungBytes });
    } else if (this.nextRung > first && rss < first * REARM_BELOW && now - this.lastCrossMono >= REARM_AFTER_MS) {
      this.nextRung = first;
    }
    // Over the first rung, the ramp itself, at the steps it actually moves.
    if (rss >= first && now - this.lastPointMono >= MEM_POINT_EVERY_MS && Math.abs(rss - this.lastPointBytes) >= this.lastPointBytes * MEM_POINT_STEP) {
      this.lastPointMono = now;
      this.lastPointBytes = rss;
      const detail = this.io.detail();
      const heap = this.board.memory(this.ds());
      this.emit({ t: "mem", rssBytes: rss, ...(detail?.memory ? { memory: detail.memory } : {}), ...(heap ? { heap } : {}) });
    }
  }

  private hour(now: number): void {
    const counts = this.board.lateCounts();
    const late = counts.map((c, i) => c - (this.hourLate[i] ?? 0));
    this.emit({
      t: "hour", beats: late.reduce((a, b) => a + b, 0), lateP50Ms: lateQuantile(late, 0.5), lateP99Ms: lateQuantile(late, 0.99),
      lateMaxMs: this.board.takeLateMax(), stalls: this.hourStalls, rssMaxBytes: this.hourRssMax,
    });
    this.hourLate = counts;
    this.hourStartMono = now;
    this.hourRssMax = 0;
    this.hourStalls = 0;
  }
}

const toRecord = (s: StallSummary): Record<string, unknown> => ({
  t: s.kind, at: s.at, pid: s.pid, ...(s.ms !== undefined ? { atMostMs: s.ms } : {}), ...(s.rssBytes !== undefined ? { rssBytes: s.rssBytes } : {}),
  ...(s.top ? { stacks: [{ samples: 1, frames: [s.top] }] } : {}), ...(s.ops ? { ops: s.ops.map((name) => ({ name, ageMs: 0 })) } : {}),
});
