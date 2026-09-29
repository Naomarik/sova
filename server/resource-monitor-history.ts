// Resource monitor history (§app.resource-monitor/sampling-and-history): a 1-hour in-memory ring
// of 5s ticks stored as flat numbers with labels interned once, 30s rollups appended to
// <stateRoot>/monitor/YYYY-MM-DD.jsonl, and rotation after 3 days.

import { appendFile, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { MonitorHistory, MonitorPoint, MonitorPointProc, MonitorProcKind } from "../shared/protocol";

/** One tick, as the sampler hands it over (labels as strings; the ring interns them). */
export interface TickPoint {
  at: number;
  cpuPct: number;
  rssBytes: number;
  swapBytes: number;
  anonBytes?: number;
  load1: number;
  loopMaxMs: number;
  /** group key → [cpuPct, rssBytes] */
  groups: Map<string, [number, number]>;
  /** group key → worker id → [cpuPct, rssBytes] */
  workers: Map<string, Map<string, [number, number]>>;
  top: MonitorPointProc[];
  /** Labels for the group keys used (session title, …). */
  labels: Map<string, { label: string; sessionPath?: string }>;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

// A packed tick: [at, cpu, rss, swap, anon(-1 = none), load1, loop,
//   nGroups, (g, cpu, rss)…, nWorkers, (g, w, cpu, rss)…, nTop, (proc, cpu, rss, g(-1), w(-1))…]
// where g, w and proc index the intern tables.
type Packed = Float64Array;

/** Interned strings, each remembering the last tick that used it, so the table can be pruned. */
class Interner<T> {
  private ids = new Map<string, number>();
  private vals: (T | undefined)[] = [];
  private used: number[] = [];
  private free: number[] = [];
  id(key: string, value: T, tick: number): number {
    let i = this.ids.get(key);
    if (i === undefined) {
      i = this.free.pop() ?? this.vals.length;
      this.ids.set(key, i);
    }
    this.vals[i] = value;
    this.used[i] = tick;
    return i;
  }
  get(i: number): T | undefined {
    return this.vals[i];
  }
  /** Forget everything last used before `tick`. */
  prune(tick: number): void {
    for (const [key, i] of this.ids) {
      if (this.used[i]! >= tick) continue;
      this.ids.delete(key);
      this.vals[i] = undefined;
      this.free.push(i);
    }
  }
  get size() {
    return this.ids.size;
  }
}

interface ProcLabel {
  pid: number;
  cmd: string;
  kind: MonitorProcKind;
}

export class MonitorRing {
  private buf: (Packed | undefined)[];
  private head = 0;
  private count = 0;
  private tick = 0;
  private groups = new Interner<{ key: string; label: string; sessionPath?: string }>();
  private workerIds = new Interner<string>();
  private procs = new Interner<ProcLabel>();
  /** Tick number of each slot, for pruning the intern tables. */
  private tickOf: number[];

  constructor(readonly capacity = 720) {
    this.buf = new Array(capacity);
    this.tickOf = new Array(capacity).fill(0);
  }

  get length() {
    return this.count;
  }

  push(p: TickPoint): void {
    const t = ++this.tick;
    const nums: number[] = [p.at, r1(p.cpuPct), p.rssBytes, p.swapBytes, p.anonBytes ?? -1, p.load1, r1(p.loopMaxMs)];
    const gid = (key: string) => {
      const l = p.labels.get(key);
      return this.groups.id(key, { key, label: l?.label ?? key, ...(l?.sessionPath ? { sessionPath: l.sessionPath } : {}) }, t);
    };
    nums.push(p.groups.size);
    for (const [g, [cpu, rss]] of p.groups) nums.push(gid(g), r1(cpu), rss);
    let nw = 0;
    const wAt = nums.push(0) - 1;
    for (const [g, ws] of p.workers) for (const [w, [cpu, rss]] of ws) {
      nums.push(gid(g), this.workerIds.id(w, w, t), r1(cpu), rss);
      nw++;
    }
    nums[wAt] = nw;
    nums.push(p.top.length);
    for (const q of p.top)
      nums.push(this.procs.id(`${q.pid}\0${q.cmd}`, { pid: q.pid, cmd: q.cmd, kind: q.kind }, t), r1(q.cpuPct), q.rssBytes,
        q.group === undefined ? -1 : gid(q.group), q.workerId === undefined ? -1 : this.workerIds.id(q.workerId, q.workerId, t));
    this.buf[this.head] = Float64Array.from(nums);
    this.tickOf[this.head] = t;
    this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
    // Once per full turn, forget labels no kept tick uses.
    if (t % this.capacity === 0) {
      const oldest = this.tickOf[this.head]!;
      this.groups.prune(oldest);
      this.workerIds.prune(oldest);
      this.procs.prune(oldest);
    }
  }

  /** Bytes held by the packed ticks (the labels are extra and small). */
  bytes(): number {
    let n = 0;
    for (const b of this.buf) if (b) n += b.byteLength + 64;
    return n;
  }

  private decode(b: Packed, groups: MonitorHistory["groups"]): MonitorPoint {
    let i = 0;
    const at = b[i++]!, cpuPct = b[i++]!, rssBytes = b[i++]!, swapBytes = b[i++]!, anon = b[i++]!, load1 = b[i++]!, loopMaxMs = b[i++]!;
    const gkey = (id: number) => {
      const g = this.groups.get(id);
      if (!g) return `?${id}`;
      groups[g.key] ??= { label: g.label, ...(g.sessionPath ? { sessionPath: g.sessionPath } : {}) };
      return g.key;
    };
    const point: MonitorPoint = { at, cpuPct, rssBytes, swapBytes, ...(anon >= 0 ? { anonBytes: anon } : {}), load1, loopMaxMs,
      groups: {}, workers: {}, top: [] };
    for (let n = b[i++]!; n > 0; n--) point.groups[gkey(b[i++]!)] = [b[i++]!, b[i++]!];
    for (let n = b[i++]!; n > 0; n--) {
      const g = gkey(b[i++]!), w = this.workerIds.get(b[i++]!) ?? "?";
      (point.workers[g] ??= {})[w] = [b[i++]!, b[i++]!];
    }
    for (let n = b[i++]!; n > 0; n--) {
      const p = this.procs.get(b[i++]!);
      const cpu = b[i++]!, rss = b[i++]!, g = b[i++]!, w = b[i++]!;
      point.top.push({ pid: p?.pid ?? 0, cmd: p?.cmd ?? "?", kind: p?.kind ?? "other", cpuPct: cpu, rssBytes: rss,
        ...(g >= 0 ? { group: gkey(g) } : {}), ...(w >= 0 ? { workerId: this.workerIds.get(w) ?? "?" } : {}) });
    }
    return point;
  }

  /** Every kept tick at or after `since`, oldest first. */
  history(since: number): MonitorHistory {
    const groups: MonitorHistory["groups"] = {};
    const points: MonitorPoint[] = [];
    for (let k = 0; k < this.count; k++) {
      const b = this.buf[(this.head - this.count + k + this.capacity) % this.capacity]!;
      if (b[0]! >= since) points.push(this.decode(b, groups));
    }
    return { res: "5s", since: Math.max(since, points[0]?.at ?? since), points, groups };
  }
}

// ── 30s rollups ──────────────────────────────────────────────────────────────────────────────

/** One disk line: a MonitorPoint plus its own labels (so a line stands alone). */
export interface RollupLine extends MonitorPoint {
  v: 1;
  labels: MonitorHistory["groups"];
}

/** Folds 5s ticks into one 30s line: mean and max CPU, max memory, mean per group/worker CPU with
    max memory, and the window's top 5 processes by mean CPU (transient ones included). */
export class Rollup {
  private ticks: TickPoint[] = [];
  add(p: TickPoint): void {
    this.ticks.push(p);
  }
  get size() {
    return this.ticks.length;
  }
  flush(): RollupLine | null {
    const ts = this.ticks;
    this.ticks = [];
    if (!ts.length) return null;
    const n = ts.length;
    const max = (f: (t: TickPoint) => number) => Math.max(...ts.map(f));
    const labels: MonitorHistory["groups"] = {};
    const groups: Record<string, [number, number]> = {};
    const workers: Record<string, Record<string, [number, number]>> = {};
    const procs = new Map<string, MonitorPointProc & { sum: number }>();
    for (const t of ts) {
      for (const [k, l] of t.labels) labels[k] = { label: l.label, ...(l.sessionPath ? { sessionPath: l.sessionPath } : {}) };
      for (const [g, [cpu, rss]] of t.groups) {
        const cur = (groups[g] ??= [0, 0]);
        cur[0] += cpu / n;
        cur[1] = Math.max(cur[1], rss);
      }
      for (const [g, ws] of t.workers) for (const [w, [cpu, rss]] of ws) {
        const cur = ((workers[g] ??= {})[w] ??= [0, 0]);
        cur[0] += cpu / n;
        cur[1] = Math.max(cur[1], rss);
      }
      for (const q of t.top) {
        const key = `${q.pid}\0${q.cmd}`;
        const cur = procs.get(key);
        if (cur) {
          cur.sum += q.cpuPct;
          cur.rssBytes = Math.max(cur.rssBytes, q.rssBytes);
        } else procs.set(key, { ...q, sum: q.cpuPct });
      }
    }
    for (const g of Object.values(groups)) g[0] = r1(g[0]);
    for (const ws of Object.values(workers)) for (const w of Object.values(ws)) w[0] = r1(w[0]);
    const top = [...procs.values()].sort((a, b) => b.sum - a.sum).slice(0, 5)
      .map(({ sum, ...q }) => ({ ...q, cpuPct: r1(sum / n) }));
    const anon = ts.some((t) => t.anonBytes !== undefined) ? max((t) => t.anonBytes ?? 0) : undefined;
    return {
      v: 1, at: ts[n - 1]!.at,
      cpuPct: r1(ts.reduce((s, t) => s + t.cpuPct, 0) / n), cpuPctMax: r1(max((t) => t.cpuPct)),
      rssBytes: max((t) => t.rssBytes), swapBytes: max((t) => t.swapBytes), ...(anon === undefined ? {} : { anonBytes: anon }),
      load1: max((t) => t.load1), loopMaxMs: r1(max((t) => t.loopMaxMs)),
      groups, workers, top, labels,
    };
  }
}

// ── Disk log ─────────────────────────────────────────────────────────────────────────────────

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
/** Local-date file name, so a day's file is the user's day. */
export const dayFile = (at: number) => {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`;
};

export class MonitorLog {
  private ready: Promise<void> | null = null;
  constructor(readonly dir: string, readonly keepDays = 3) {}

  async append(line: RollupLine): Promise<void> {
    this.ready ??= mkdir(this.dir, { recursive: true }).then(() => undefined);
    await this.ready;
    await appendFile(join(this.dir, dayFile(line.at)), JSON.stringify(line) + "\n");
  }

  /** Delete day files older than `keepDays` (by their date, not mtime). Returns what it removed. */
  async rotate(now = Date.now()): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const cutoff = dayFile(now - this.keepDays * 86_400_000);
    const removed: string[] = [];
    for (const name of names) {
      if (!DAY_FILE.test(name) || name >= cutoff) continue;
      await unlink(join(this.dir, name)).then(() => removed.push(name), () => {});
    }
    return removed;
  }

  /** Every line at or after `since`, oldest first, from the day files that can hold them. */
  async history(since: number, now = Date.now()): Promise<MonitorHistory> {
    const groups: MonitorHistory["groups"] = {};
    const points: MonitorPoint[] = [];
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((n) => DAY_FILE.test(n)).sort();
    } catch {
      names = [];
    }
    const first = dayFile(Math.max(since, now - (this.keepDays + 1) * 86_400_000));
    for (const name of names) {
      if (name < first) continue;
      const text = await readFile(join(this.dir, name), "utf8").catch(() => "");
      for (const raw of text.split("\n")) {
        if (!raw) continue;
        let line: RollupLine;
        try {
          line = JSON.parse(raw) as RollupLine;
        } catch {
          continue; // a torn last line from a crash
        }
        if (line?.v !== 1 || typeof line.at !== "number" || line.at < since) continue;
        const { v: _v, labels, ...point } = line;
        for (const [k, l] of Object.entries(labels ?? {})) groups[k] = l;
        points.push(point);
      }
    }
    points.sort((a, b) => a.at - b.at);
    return { res: "30s", since, points, groups };
  }
}
