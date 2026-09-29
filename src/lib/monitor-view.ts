// The Resource Monitor's words and numbers (components/ResourceMonitor.tsx): the meters, the rows of
// the sessions → workers table (live, or at a scrubbed moment of the history), the strip chart's
// geometry, the transient and idle summaries, and the degraded-state lines. Pure, so node tests run
// it without a DOM.

import type {
  MonitorHistory,
  MonitorPoint,
  MonitorProc,
  MonitorProcKind,
  MonitorSampler,
  MonitorSession,
  MonitorSnapshot,
  MonitorVia,
  MonitorWorker,
} from "../../shared/protocol";
import { duration } from "./format";
import { bytes } from "./mesh-details";

export { bytes };

/** The modal polls this often while open, and never while closed. */
export const MONITOR_POLL_MS = 5_000;
/** The strip chart's window. */
export const CHART_SPAN_MS = 60 * 60_000;

/** History group keys that are not a session. */
export const SERVER_GROUP = "server";
export const ESCAPED_GROUP = "escaped";
export const UNATTRIBUTED_GROUP = "unattributed";
export const UNOWNED_GROUP = "unowned";

/** CPU% of one core: "0%", "0.4%", "12%", "140%". */
export function cpuText(pct: number): string {
  if (!Number.isFinite(pct) || pct <= 0) return "0%";
  if (pct < 1) return `${Math.max(0.1, Math.round(pct * 10) / 10)}%`;
  return `${Math.round(pct)}%`;
}

/** Milliseconds with a precision that suits the size: "0.4 ms", "12 ms". */
export function msText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0 ms";
  return ms < 10 ? `${Math.round(ms * 10) / 10} ms` : `${Math.round(ms)} ms`;
}

// ---- where a number came from ------------------------------------------------------------------

/** A match by folder, or exited tool time given to the one session running a tool, is a guess and
    is labelled one; every other join names its process exactly. */
export const isHeuristic = (via: MonitorVia | undefined): boolean => via === "cwd" || via === "exited-tools";

const VIA_WORDS: Record<MonitorVia, string> = {
  "worker-pid": "Worker process",
  "session-id": "Claude session id",
  "live-record": "Worker's live record",
  "team-env": "Team member helper",
  env: "Started by the session's tool",
  descendant: "Started by a charged process",
  sid: "Same process group as an earlier worker process",
  "exited-tools": "Guessed: tool time from the only session running a tool",
  cwd: "Guessed from its folder",
};
/** How a row was charged, for its tooltip. */
export const viaWords = (via: MonitorVia | undefined): string => (via ? VIA_WORDS[via] ?? via : "Not attributed");

// ---- degraded states ---------------------------------------------------------------------------

/** The head's second line: what the numbers cover. */
export function scopeLine(s: Pick<MonitorSnapshot, "scope" | "unitName">): string {
  if (s.scope === "unit") return `Everything in ${s.unitName ?? "this service"}`;
  if (s.scope === "tree") return "This server's process tree only";
  return "This server's own numbers only";
}

/** The one sentence a degraded snapshot shows above the meters, or null when nothing is missing. */
export function degradedLine(s: Pick<MonitorSnapshot, "scope" | "platform">): string | null {
  if (s.scope === "none") return "Process details need Linux. This shows the server's own memory and event loop.";
  if (s.scope === "tree")
    return "Sova isn't running as its own systemd service here, so this covers the server's process tree only. Processes that left it aren't counted.";
  return null;
}

// ---- meters ------------------------------------------------------------------------------------

export interface MeterView {
  key: string;
  label: string;
  /** The number, first. */
  value: string;
  /** " of 16 cores". */
  of?: string;
  /** Track fill, 0–100; null = no track (no denominator). */
  pct: number | null;
  context?: string;
  /** The reading doesn't exist here (no swap): a dashed, empty track. */
  ghost?: boolean;
}

const clampPct = (n: number): number => (Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0);

/** Load, memory, swap, CPU pressure and the event loop, number first. Readings that need /proc are left out without it. */
export function meters(s: MonitorSnapshot): MeterView[] {
  const out: MeterView[] = [];
  const h = s.host;
  if (s.scope !== "none") {
    const [l1, l5, l15] = h.loadavg;
    out.push({
      key: "load",
      label: "Load",
      value: l1.toFixed(2),
      of: ` of ${s.cores} ${s.cores === 1 ? "core" : "cores"}`,
      pct: clampPct((l1 / Math.max(1, s.cores)) * 100),
      context: `5 min ${l5.toFixed(2)} · 15 min ${l15.toFixed(2)}`,
    });
  }
  const ram = h.memTotalBytes;
  if (s.unit) {
    const m = s.unit.memory;
    out.push({
      key: "memory",
      label: "Memory",
      value: bytes(m.anon),
      of: ` of ${bytes(ram)}`,
      pct: clampPct((m.anon / Math.max(1, ram)) * 100),
      context: `The unit holds ${bytes(m.current)}, including ${bytes(m.file)} of page cache${m.peak ? `, peak ${bytes(m.peak)}` : ""}.`,
    });
  } else if (s.scope === "tree") {
    out.push({
      key: "memory",
      label: "Memory",
      value: bytes(s.totals.rssBytes),
      of: ` of ${bytes(ram)}`,
      pct: clampPct((s.totals.rssBytes / Math.max(1, ram)) * 100),
      context: `Resident, over ${s.totals.procCount} ${s.totals.procCount === 1 ? "process" : "processes"}. The machine has ${bytes(h.memAvailableBytes)} available.`,
    });
  } else {
    out.push({ key: "memory", label: "Server memory", value: bytes(s.server.rssBytes), pct: null, context: `Heap ${bytes(s.server.heapUsedBytes)} of ${bytes(s.server.heapTotalBytes)}.` });
  }
  if (s.scope !== "none") {
    const used = Math.max(0, h.swapTotalBytes - h.swapFreeBytes);
    if (h.swapTotalBytes <= 0) out.push({ key: "swap", label: "Swap", value: "None", pct: null, ghost: true, context: "This machine has no swap." });
    else
      out.push({
        key: "swap",
        label: "Swap",
        value: bytes(used),
        of: ` of ${bytes(h.swapTotalBytes)}`,
        pct: clampPct((used / h.swapTotalBytes) * 100),
        context: s.unit ? `The unit's share is ${bytes(s.unit.swap.current)}.` : undefined,
      });
  }
  const cpuSome = (s.unit?.pressure ?? h.pressure)?.cpu?.some;
  if (typeof cpuSome === "number")
    out.push({
      key: "psi",
      label: "CPU pressure",
      value: `${cpuSome.toFixed(1)}%`,
      pct: clampPct(cpuSome),
      context: s.unit?.pressure?.cpu ? "Share of the last 10s the unit's processes waited for a CPU." : "Share of the last 10s something waited for a CPU.",
    });
  const loop = s.server.eventLoop;
  out.push({
    key: "loop",
    label: "Server event loop",
    value: msText(loop.p99),
    of: " p99",
    // 100 ms of delay fills the track: past that, the web app feels it.
    pct: clampPct(loop.p99),
    context: `Longest delay ${msText(loop.max)} in the last ${Math.round(s.sampler.intervalMs / 1000)}s.`,
  });
  return out;
}

// ---- the table ---------------------------------------------------------------------------------

export interface ProcRow {
  key: string;
  pid: number;
  cmd: string;
  kind?: MonitorProcKind;
  cpuPct: number;
  rssBytes: number;
  via?: MonitorVia;
  cwd?: string;
  /** An escaped process's session, when sid memory or its folder says. */
  chargedTo?: string;
}

export interface WorkerRow {
  key: string;
  label: string;
  backend?: string;
  status?: string;
  idleSince?: number;
  via?: MonitorVia;
  cpuPct: number;
  rssBytes: number;
  swapBytes?: number;
  procCount?: number;
  /** Heaviest descendants, by short command. */
  top: ProcRow[];
}

export interface GroupRow {
  key: string;
  label: string;
  /** The session to open, when there is one. */
  sessionPath?: string;
  /** "hosted" / a folder, as a caption. */
  caption?: string;
  kind: "session" | "server" | "unowned" | "escaped" | "unattributed";
  cpuPct: number;
  rssBytes: number;
  swapBytes?: number;
  procCount?: number;
  workers: WorkerRow[];
  /** The group's own processes (a session's hosted tools, an escaped bucket's processes). */
  procs: ProcRow[];
}

const procRow = (p: MonitorProc): ProcRow => ({
  key: `${p.pid}:${p.startedAt}`,
  pid: p.pid,
  cmd: p.cmd,
  kind: p.kind,
  cpuPct: p.cpuPct,
  rssBytes: p.rssBytes,
  via: p.via,
  cwd: p.cwd,
});

const workerRow = (w: MonitorWorker, scope: string): WorkerRow => ({
  key: `${scope}/${w.id}`,
  label: w.name || w.id,
  backend: w.backend,
  status: w.status,
  idleSince: w.idleSince,
  via: w.via,
  cpuPct: w.cpuPct,
  rssBytes: w.rssBytes,
  swapBytes: w.swapBytes,
  procCount: w.procCount,
  top: w.top.map(procRow),
});

const heaviest = <T extends { cpuPct: number; rssBytes: number }>(a: T, b: T): number => b.cpuPct - a.cpuPct || b.rssBytes - a.rssBytes;

/** A folder's last segment: "/home/me/webapps/sova" → "sova". */
const folderName = (p: string): string => p.replace(/\/+$/, "").slice(p.replace(/\/+$/, "").lastIndexOf("/") + 1) || p;

/** What a person calls a session: its title, else "Untitled session" and its folder. Never the file name. */
export const sessionLabel = (s: Pick<MonitorSession, "title" | "sessionPath" | "cwd">): string =>
  s.title?.trim() || (s.cwd ? `Untitled session in ${folderName(s.cwd)}` : "Untitled session");

/** A label that is only a session file's name (what a history without the title falls back to). */
const isFileLabel = (label: string): boolean => /\.jsonl$/.test(label) || label.includes("/");

/** Resolves a session's title from the session list the app already holds, keyed by path. */
export type TitleOf = (sessionPath: string) => string | undefined;

/** A title worth showing: the list's "Untitled" placeholder isn't one. */
const known = (titleOf: TitleOf, path: string): string | undefined => {
  const t = titleOf(path)?.trim();
  return t && t !== "Untitled" ? t : undefined;
};

/** The snapshot with every session's title as the app's list says it, where the list has one. */
export function withTitles(s: MonitorSnapshot, titleOf: TitleOf): MonitorSnapshot {
  return { ...s, sessions: s.sessions.map((x) => {
      const title = x.sessionPath ? known(titleOf, x.sessionPath) : undefined;
      return title ? { ...x, title } : x;
    }) };
}

/** The history's labels with each session's title from the app's list, and no file name left as a label. */
export function labelsWithTitles(labels: MonitorHistory["groups"], titleOf: TitleOf): MonitorHistory["groups"] {
  const out: MonitorHistory["groups"] = {};
  for (const [key, g] of Object.entries(labels)) {
    const path = g.sessionPath ?? (key.startsWith("/") ? key : undefined);
    const title = path ? known(titleOf, path) : undefined;
    out[key] = title ? { ...g, label: title } : g;
  }
  return out;
}

/** The words for the groups that aren't a session, the same in the table, the chart and transient work. */
const RESERVED: Record<string, string> = {
  [SERVER_GROUP]: "Sova server",
  [ESCAPED_GROUP]: "Escaped processes",
  [UNATTRIBUTED_GROUP]: "Not attributed",
  [UNOWNED_GROUP]: "Workers of no known session",
};

/** A history group's name: ours for the reserved keys, else the history's label, else the file name. */
export function groupLabel(key: string, labels: MonitorHistory["groups"]): string {
  const reserved = RESERVED[key];
  if (reserved) return reserved;
  const label = labels[key]?.label?.trim();
  return label && !isFileLabel(label) ? label : "Untitled session";
}

/** The table now: every session, then the server itself, workers of no known session, escaped and unattributed processes. Heaviest first within sessions. */
export function liveRows(s: MonitorSnapshot): GroupRow[] {
  const rows: GroupRow[] = [...s.sessions]
    .sort(heaviest)
    .map((x) => ({
      key: x.sessionPath ?? `cwd:${x.cwd ?? ""}`,
      label: sessionLabel(x),
      sessionPath: x.sessionPath,
      caption: x.hosted ? "Hosted here" : undefined,
      kind: "session" as const,
      cpuPct: x.cpuPct,
      rssBytes: x.rssBytes,
      swapBytes: x.swapBytes,
      procCount: x.procCount,
      workers: [...x.workers].sort(heaviest).map((w) => workerRow(w, x.sessionPath ?? "")),
      procs: x.own.map(procRow),
    }));
  rows.push({
    key: SERVER_GROUP,
    label: RESERVED[SERVER_GROUP]!,
    caption: `pid ${s.server.pid}`,
    kind: "server",
    cpuPct: s.server.cpuPct,
    rssBytes: s.server.rssBytes,
    procCount: 1,
    workers: [],
    procs: [],
  });
  if (s.unownedWorkers.length) {
    const ws = [...s.unownedWorkers].sort(heaviest);
    rows.push({
      key: UNOWNED_GROUP,
      label: "Workers of no known session",
      kind: "unowned",
      cpuPct: sum(ws, (w) => w.cpuPct),
      rssBytes: sum(ws, (w) => w.rssBytes),
      swapBytes: sum(ws, (w) => w.swapBytes),
      procCount: sum(ws, (w) => w.procCount),
      workers: ws.map((w) => workerRow(w, UNOWNED_GROUP)),
      procs: [],
    });
  }
  if (s.scope === "unit" && s.escaped.procCount) {
    const titles = new Map(s.sessions.filter((x) => x.sessionPath).map((x) => [x.sessionPath!, sessionLabel(x)]));
    const row = bucketRow(s.escaped);
    row.procs = s.escaped.procs.map((p) => ({
      ...procRow(p),
      chargedTo: p.sessionPath ? `${titles.get(p.sessionPath) ?? "Untitled session"}${p.workerId ? ` · ${p.workerId}` : ""}` : undefined,
    }));
    rows.push({ ...row, key: ESCAPED_GROUP, label: "Escaped processes", caption: "In the unit, no longer under the server", kind: "escaped" });
  }
  if (s.unattributed.procCount) rows.push({ ...bucketRow(s.unattributed), key: UNATTRIBUTED_GROUP, label: "Not attributed", kind: "unattributed" });
  return rows;
}

function bucketRow(b: MonitorSnapshot["escaped"]): Omit<GroupRow, "key" | "label" | "kind"> {
  return { cpuPct: b.cpuPct, rssBytes: b.rssBytes, swapBytes: b.swapBytes, procCount: b.procCount, workers: [], procs: b.procs.map(procRow) };
}

function sum<T>(xs: readonly T[], f: (x: T) => number): number {
  let n = 0;
  for (const x of xs) n += f(x) || 0;
  return n;
}

/**
 * The table at a scrubbed moment: each group's and worker's CPU and memory at that point, named
 * from the history's labels and, for a worker, the live snapshot's name. Processes come from the
 * point's top 5, so a worker row expands to what was busy then.
 */
export function rowsAt(point: MonitorPoint, labels: MonitorHistory["groups"], live: MonitorSnapshot | undefined, fromHistory?: WorkerLabels): GroupRow[] {
  const liveWorkers = new Map<string, MonitorWorker>();
  for (const x of live?.sessions ?? []) for (const w of x.workers) liveWorkers.set(`${x.sessionPath ?? ""}/${w.id}`, w);
  for (const w of live?.unownedWorkers ?? []) liveWorkers.set(`${UNOWNED_GROUP}/${w.id}`, w);
  const nameOf = workerNamer(live, fromHistory);
  const kindOf = (key: string): GroupRow["kind"] =>
    key === SERVER_GROUP ? "server" : key === ESCAPED_GROUP ? "escaped" : key === UNATTRIBUTED_GROUP ? "unattributed" : key === UNOWNED_GROUP ? "unowned" : "session";
  const rows: GroupRow[] = Object.entries(point.groups).map(([key, [cpuPct, rssBytes]]) => {
    const kind = kindOf(key);
    const label = groupLabel(key, labels);
    const sessionPath = kind === "session" ? (labels[key]?.sessionPath ?? (key.startsWith("/") ? key : undefined)) : undefined;
    const workers: WorkerRow[] = Object.entries(point.workers[key] ?? {})
      .map(([id, [wc, wr]]) => {
        const scope = kind === "unowned" ? UNOWNED_GROUP : (sessionPath ?? key);
        const w = liveWorkers.get(`${scope}/${id}`);
        const top = point.top.filter((p) => p.group === key && p.workerId === id).map((p) => ({ key: `${p.pid}`, pid: p.pid, cmd: p.cmd, kind: p.kind, cpuPct: p.cpuPct, rssBytes: p.rssBytes }));
        return { key: `${key}/${id}`, label: nameOf(key, id) || w?.name || id, backend: w?.backend, via: w?.via, cpuPct: wc, rssBytes: wr, top };
      })
      .sort(heaviest);
    const procs = point.top
      .filter((p) => p.group === key && !p.workerId)
      .map((p) => ({ key: `${p.pid}`, pid: p.pid, cmd: p.cmd, kind: p.kind, cpuPct: p.cpuPct, rssBytes: p.rssBytes }));
    return { key, label, sessionPath, kind, cpuPct, rssBytes, workers, procs };
  });
  const order: Record<GroupRow["kind"], number> = { session: 0, server: 1, unowned: 2, escaped: 3, unattributed: 4 };
  return rows.sort((a, b) => order[a.kind] - order[b.kind] || (a.kind === "session" ? heaviest(a, b) : 0));
}

/** "Idle 3h 12m" / "Working"; the status word as the record says it otherwise. */
export function statusText(w: Pick<WorkerRow, "status" | "idleSince">, now: number): string | undefined {
  if (!w.status) return undefined;
  const word = w.status.charAt(0).toUpperCase() + w.status.slice(1);
  if (w.idleSince && w.status !== "working") return `${word} ${duration(now - w.idleSince)}`;
  return word;
}

/** "12 idle workers hold 3.4 GB", over every worker not working now; null when none is. */
export function idleSummary(s: MonitorSnapshot): string | null {
  const all = [...s.sessions.flatMap((x) => x.workers), ...s.unownedWorkers];
  const idle = all.filter((w) => w.status && w.status !== "working");
  if (!idle.length) return null;
  const held = sum(idle, (w) => w.rssBytes);
  return `${idle.length} idle ${idle.length === 1 ? "worker holds" : "workers hold"} ${bytes(held)}${all.length > idle.length ? `; ${all.length - idle.length} working` : ""}.`;
}

// ---- transient work ----------------------------------------------------------------------------

export interface TransientRow {
  /** Command, group and worker: one row for every run of the same thing by the same worker. */
  key: string;
  cmd: string;
  /** Distinct processes (runs) seen. */
  runs: number;
  /** The heaviest tick any run was seen in. */
  peakCpuPct: number;
  peakRssBytes: number;
  firstAt: number;
  lastAt: number;
  group?: string;
  workerId?: string;
}

/** Every pid the snapshot names, so a process still running isn't listed as come-and-gone. */
export function livePids(s: MonitorSnapshot): Set<number> {
  const out = new Set<number>([s.server.pid]);
  const add = (p: MonitorProc) => out.add(p.pid);
  for (const x of s.sessions) {
    x.own.forEach(add);
    for (const w of x.workers) {
      if (w.pid) out.add(w.pid);
      w.top.forEach(add);
    }
  }
  for (const w of s.unownedWorkers) {
    if (w.pid) out.add(w.pid);
    w.top.forEach(add);
  }
  s.escaped.procs.forEach(add);
  s.unattributed.procs.forEach(add);
  s.topProcs.forEach(add);
  const extra = (s as { livePids?: unknown }).livePids;
  if (Array.isArray(extra)) for (const p of extra) if (typeof p === "number") out.add(p);
  return out;
}

/**
 * Processes that were among a tick's top CPU users in the window and aren't running now: the
 * builds, test runs and probes that came and went. Runs of the same command by the same worker
 * fold into one row, heaviest first. Short-lived work that never made a tick's top 5 still counts
 * in its worker's CPU (through its parent's reaped-children time), just not by name here.
 */
export function transient(points: readonly MonitorPoint[], alive: ReadonlySet<number>, limit = 8): TransientRow[] {
  const seen = new Map<string, TransientRow & { pids: Set<number> }>();
  for (const pt of points)
    for (const p of pt.top) {
      if (alive.has(p.pid)) continue;
      const key = `${p.cmd}\n${p.group ?? ""}\n${p.workerId ?? ""}`;
      const r = seen.get(key);
      if (!r) {
        seen.set(key, { key, cmd: p.cmd, runs: 1, pids: new Set([p.pid]), peakCpuPct: p.cpuPct, peakRssBytes: p.rssBytes, firstAt: pt.at, lastAt: pt.at, group: p.group, workerId: p.workerId });
        continue;
      }
      r.pids.add(p.pid);
      r.runs = r.pids.size;
      r.peakCpuPct = Math.max(r.peakCpuPct, p.cpuPct);
      r.peakRssBytes = Math.max(r.peakRssBytes, p.rssBytes);
      r.lastAt = pt.at;
    }
  return [...seen.values()]
    .filter((r) => r.peakCpuPct >= 1)
    .sort((a, b) => b.peakCpuPct - a.peakCpuPct || b.lastAt - a.lastAt)
    .slice(0, limit)
    .map(({ pids: _pids, ...r }) => r);
}

/** "vite build" / "vite build ×8". */
export const transientName = (r: Pick<TransientRow, "cmd" | "runs">): string => (r.runs > 1 ? `${r.cmd} ×${r.runs}` : r.cmd);

/** Who a transient process was charged to: "Refactor auth · w3" / "Not attributed". */
export function chargedTo(r: Pick<TransientRow, "group" | "workerId">, labels: MonitorHistory["groups"], nameOf: WorkerNameOf = () => undefined): string {
  if (!r.group || r.group === UNATTRIBUTED_GROUP) return "Not attributed";
  const g = groupLabel(r.group, labels);
  return r.workerId ? `${g} · ${nameOf(r.group, r.workerId) ?? r.workerId}` : g;
}

/** A worker's name by history group key and worker id, when anything knows it. */
export type WorkerNameOf = (group: string, workerId: string) => string | undefined;

/** Worker names per history group, then per worker id, as a history may carry them. */
export type WorkerLabels = Record<string, Record<string, string>>;

/**
 * Names a worker from the history's own labels (which outlive the worker and a restart), else
 * from the live snapshot while it still runs; undefined leaves the caller its id. A snapshot
 * session's workers are keyed by its path, the history's group key for that session.
 */
export function workerNamer(live: MonitorSnapshot | undefined, fromHistory: WorkerLabels | undefined): WorkerNameOf {
  const liveNames = new Map<string, string>();
  for (const x of live?.sessions ?? []) for (const w of x.workers) if (w.name) liveNames.set(`${x.sessionPath ?? ""}\n${w.id}`, w.name);
  for (const w of live?.unownedWorkers ?? []) if (w.name) liveNames.set(`${UNATTRIBUTED_GROUP}\n${w.id}`, w.name);
  return (group, id) => fromHistory?.[group]?.[id] || liveNames.get(`${group}\n${id}`);
}

// ---- history -----------------------------------------------------------------------------------

/**
 * One timeline from the 5s ring and, before its first point (after a restart the ring starts
 * empty), the 30s rollups from disk; points older than the chart's span are dropped.
 */
export function mergeHistory(fine: readonly MonitorPoint[], coarse: readonly MonitorPoint[], now: number, span = CHART_SPAN_MS): MonitorPoint[] {
  const start = now - span;
  const firstFine = fine.length ? fine[0]!.at : Infinity;
  return [...coarse.filter((p) => p.at >= start && p.at < firstFine), ...fine.filter((p) => p.at >= start)];
}

/** Append a delta (points after the last one held) and trim to the span. */
export function appendHistory(held: readonly MonitorPoint[], delta: readonly MonitorPoint[], now: number, span = CHART_SPAN_MS): MonitorPoint[] {
  const last = held.length ? held[held.length - 1]!.at : -Infinity;
  const fresh = delta.filter((p) => p.at > last);
  const start = now - span;
  const kept = held[0] && held[0].at < start ? held.filter((p) => p.at >= start) : held;
  return fresh.length ? [...kept, ...fresh] : (kept as MonitorPoint[]);
}

/** The point nearest `at`, by index; -1 for no points. */
export function nearestIndex(points: readonly MonitorPoint[], at: number): number {
  if (!points.length) return -1;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.at < at) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(points[lo - 1]!.at - at) <= Math.abs(points[lo]!.at - at)) return lo - 1;
  return lo;
}

// ---- the strip chart ---------------------------------------------------------------------------

export interface ChartSeries {
  key: string;
  label: string;
  /** One closed polygon per run without a gap. */
  paths: string[];
}

export interface ChartModel {
  width: number;
  height: number;
  t0: number;
  t1: number;
  /** CPU% the top edge stands for (a round number ≥ the highest stack). */
  cpuMax: number;
  memMax: number;
  /** Memory the top edge stands for on the dashed line (a little above the window's highest). */
  memTop: number;
  /** Stacked CPU areas, bottom first; the last is "Everything else" when groups were folded. */
  series: ChartSeries[];
  /** The memory line (RSS, or the unit's anon when present), one path per run. */
  memory: string[];
  /** x of each point, for the crosshair. */
  xs: number[];
}

/** 1, 2 or 5 × a power of ten, at or above n. */
export function niceCeil(n: number): number {
  if (!(n > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 5, 10]) if (m * p >= n) return m * p;
  return 10 * p;
}

const r1 = (n: number): string => (Math.round(n * 10) / 10).toString();

/**
 * The chart's geometry: stacked CPU by group (the `maxSeries` heaviest over the window, the rest
 * folded into one) and a memory line, over [now − span, now]. A gap longer than three ticks (a
 * restart, a stalled server) breaks every path rather than drawing a line across it.
 */
export function chartModel(
  points: readonly MonitorPoint[],
  labels: MonitorHistory["groups"],
  opts: { width: number; height: number; now: number; span?: number; maxSeries?: number },
): ChartModel {
  const { width, height, now } = opts;
  const span = opts.span ?? CHART_SPAN_MS;
  const t0 = now - span;
  const t1 = now;
  const x = (at: number) => ((at - t0) / span) * width;
  const totals = new Map<string, number>();
  for (const p of points) for (const [k, [c]] of Object.entries(p.groups)) totals.set(k, (totals.get(k) ?? 0) + c);
  const ranked = [...totals.entries()].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]);
  const maxSeries = opts.maxSeries ?? 4;
  const shown = ranked.length > maxSeries ? ranked.slice(0, maxSeries - 1).map(([k]) => k) : ranked.map(([k]) => k);
  const folded = ranked.length > shown.length;
  const keys = folded ? [...shown, "*"] : shown;
  const valueOf = (p: MonitorPoint, k: string): number => {
    if (k !== "*") return p.groups[k]?.[0] ?? 0;
    let n = 0;
    for (const [g, [c]] of Object.entries(p.groups)) if (!shown.includes(g)) n += c;
    return n;
  };
  let stackMax = 0;
  let memMax = 0;
  const memOf = (p: MonitorPoint) => p.anonBytes ?? p.rssBytes;
  for (const p of points) {
    let s = 0;
    for (const k of keys) s += valueOf(p, k);
    stackMax = Math.max(stackMax, s);
    memMax = Math.max(memMax, memOf(p));
  }
  const cpuMax = niceCeil(Math.max(stackMax, 10));
  const y = (v: number, max: number) => height - (Math.min(v, max) / max) * height;

  // Runs: split wherever the spacing jumps past three times the usual step.
  const runs: MonitorPoint[][] = [];
  let cur: MonitorPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const prev = points[i - 1];
    const step = prev ? p.at - prev.at : 0;
    const usual = i >= 2 ? points[i - 1]!.at - points[i - 2]!.at : step;
    if (prev && step > Math.max(15_000, 3 * Math.max(usual, 5_000))) {
      runs.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) runs.push(cur);

  const series: ChartSeries[] = keys.map((k) => ({ key: k, label: k === "*" ? "Everything else" : groupLabel(k, labels), paths: [] }));
  const memory: string[] = [];
  for (const run of runs) {
    const base = run.map(() => 0);
    keys.forEach((k, si) => {
      const lower = run.map((p, i) => [x(p.at), y(base[i]!, cpuMax)] as const);
      const upper = run.map((p, i) => {
        base[i] = base[i]! + valueOf(p, k);
        return [x(p.at), y(base[i]!, cpuMax)] as const;
      });
      // A single point still shows: widen it to a sliver.
      if (run.length === 1) {
        const [ux, uy] = upper[0]!;
        const [, ly] = lower[0]!;
        series[si]!.paths.push(`M${r1(ux - 1)},${r1(ly)}L${r1(ux - 1)},${r1(uy)}L${r1(ux + 1)},${r1(uy)}L${r1(ux + 1)},${r1(ly)}Z`);
        return;
      }
      const pts = [...upper, ...lower.reverse()];
      series[si]!.paths.push(`M${pts.map(([a, b]) => `${r1(a)},${r1(b)}`).join("L")}Z`);
    });
    if (memMax > 0) memory.push(`M${run.map((p) => `${r1(x(p.at))},${r1(y(memOf(p), memMax * 1.1))}`).join("L")}`);
  }
  return { width, height, t0, t1, cpuMax, memMax, memTop: memMax * 1.1, series, memory, xs: points.map((p) => x(p.at)) };
}

// ---- footer and this tab -----------------------------------------------------------------------

/** "Sampling every 5s · last tick 2.1 ms · average 1.8 ms · 142 processes". */
export function samplerLine(s: MonitorSampler, procCount: number): string {
  const parts = [`Sampling every ${Math.round(s.intervalMs / 1000)}s`, `last tick ${msText(s.lastTickMs)}`, `average ${msText(s.avgTickMs)}`, `${procCount} ${procCount === 1 ? "process" : "processes"}`];
  if (s.skipped) parts.push(`${s.skipped} ${s.skipped === 1 ? "tick" : "ticks"} skipped`);
  return parts.join(" · ");
}

/** Chrome's non-standard `performance.memory`, when present. */
export interface TabMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

/** "This tab: 84 MB of JavaScript heap (limit 4 GB)"; null when the browser doesn't say (the line is hidden). */
export function tabLine(m: TabMemory | undefined | null): string | null {
  if (!m || !(m.usedJSHeapSize > 0) || !(m.jsHeapSizeLimit > 0)) return null;
  return `This tab: ${bytes(m.usedJSHeapSize)} of JavaScript heap (limit ${bytes(m.jsHeapSizeLimit)})`;
}

/** A tick's moment to the second, 24-hour and meant for mono: "14:06:05". */
export function momentText(at: number): string {
  if (!Number.isFinite(at)) return "";
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}
