import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CostEstimate, CostKind, CostModelRow, CostRow, CostSession, CostStarter, CostTokens, ProjectCost } from "../shared/costs";
import type { ModelRef, PricedUsage, TokenUsage } from "../shared/model-prices/prices";
import { claudeSidechainFiles, claudeUsageAccumulator } from "../pi-config/extensions/claude-code/transcript-adapter.ts";
import { piUsageAccumulator } from "../pi-config/extensions/subagents/adapters/pi.ts";
import { type CountedMessage, readWorkerManifests, type WorkerManifest, type WorkerTranscriptAdapters, type WorkerUsage } from "../pi-config/extensions/subagents/worker-transcript.ts";
import { modelName, pricesInfo, priceUsage } from "./model-prices";
import { contributedCostSessions } from "./projects/contributions";
import { engineOrThrow, projectDir } from "./projects/spaces";
import { type CostBucket, type CostLedger, type CostSnapshot, type EstimateFlag, ledgerPaths, readCostLedger, readUsageLedger, writeCostLedger, type UsageRow } from "./project-costs-ledger";
import { readBuilds } from "./build-loadout";
import { projectOf, projectOverseerPaths, readPoMarker, sessionIdOfFile } from "./project-overseer-store";
import { getSessionSummary, indexedSessionPaths } from "./sessions-index";
import { parseLines } from "./transcript";
import { defaultAdapters } from "./worker-adapters";

/**
 * A project's running cost at API prices (§app/project-costs). Every session tied to the project
 * (§app.project-costs/scope) is read through the worker-transcript protocol's usage accumulators
 * (their `onCount`: one call per counted message, after their dedup and fork rules), each message
 * folded into a bucket (kind, model, UTC day, tier band, estimate flags), and each bucket priced
 * by its average message times its count: every message in a bucket fell in one band, so that is
 * the per-message price. What a host counted is kept in the workspace repo's costs.json, so a host
 * without a file still shows it "as last counted" (§app.project-costs/ledger).
 *
 * Main listener only: never the share listener, the owner page or the project overseer's tools.
 */

type Entry = Record<string, any>;
type Pricer = (ref: ModelRef, usage: TokenUsage, at: number | string) => PricedUsage;

export interface CostDeps {
  price: Pricer;
  prices: () => { fetchedAt: string | null };
  /** models.dev's display name of a price key. */
  name: (key: string) => string | undefined;
  adapters: () => WorkerTranscriptAdapters;
  now: () => number;
}
const baseDeps = (): CostDeps => ({ price: priceUsage, prices: pricesInfo, name: modelName, adapters: defaultAdapters, now: Date.now });
let deps: CostDeps = baseDeps();
/** Tests replace the pricer, the adapters and the clock. */
export function setCostDeps(d: Partial<CostDeps> | null): void {
  deps = d === null ? baseDeps() : { ...baseDeps(), ...d };
  projectMemo.clear();
  fileMemo.clear();
}

// ---- buckets -----------------------------------------------------------------------------------------

const NO_MODEL_WHY = "A tool's own model calls, with no model recorded.";

function refOf(model: string): { provider: string; model: string } {
  const i = model.indexOf("/");
  return i > 0 ? { provider: model.slice(0, i), model: model.slice(i + 1) } : { provider: "unknown", model };
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Folds counted messages into buckets. */
class Buckets {
  private readonly map = new Map<string, CostBucket>();
  constructor(private readonly fallbackAt: number) {}

  add(kind: CostKind, m: Pick<CountedMessage, "model" | "responseModel" | "counts" | "cacheWrite1h" | "at" | "inferredModel" | "source">): void {
    const c = m.counts;
    if (c.input + c.output + c.cacheRead + c.cacheWrite <= 0) return;
    const { provider, model } = refOf(m.model);
    const at = m.at ?? this.fallbackAt;
    const est: EstimateFlag[] = [];
    let h1 = m.cacheWrite1h;
    // The bridge's messages from before it split cache writes: all at the 1-hour rate (it wrote
    // about all of its cache at 1h), marked an estimate (DECISIONS 5).
    if (provider === "claude-code-cli") {
      if (h1 === undefined && c.cacheWrite > 0) {
        h1 = c.cacheWrite;
        est.push("1h");
      }
      if (!m.responseModel) est.push("alias");
    }
    const usage: TokenUsage = { input: c.input, output: c.output, cacheRead: c.cacheRead, cacheWrite5m: c.cacheWrite - (h1 ?? 0), cacheWrite1h: h1 ?? 0 };
    const noModel = m.source === "toolResult" && m.inferredModel === true;
    let band: number | undefined;
    // The price key and period it resolves to: a bucket never spans a dated alias's switch or a
    // new price period inside its day, so pricing it at its first message stays exact.
    let priced = "";
    if (!noModel) {
      const p = deps.price({ provider, model, ...(m.responseModel ? { responseModel: m.responseModel } : {}) }, usage, at);
      if (p.status === "priced") {
        if (p.tier !== null) band = p.tier;
        priced = `${p.key}@${p.period ?? ""}`;
      }
    }
    const key = [kind, provider, model, m.responseModel ?? "", dayOf(at), band ?? "", est.join(","), noModel ? "x" : "", priced].join("\0");
    let b = this.map.get(key);
    if (!b) {
      b = { kind, provider, model, ...(m.responseModel ? { responseModel: m.responseModel } : {}), at: new Date(at).toISOString(), n: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...(band ? { band } : {}), ...(est.length ? { est } : {}), ...(noModel ? { noModel: true as const } : {}) };
      this.map.set(key, b);
    } else if (Date.parse(b.at) > at) b.at = new Date(at).toISOString();
    b.n++;
    b.input += usage.input;
    b.output += usage.output;
    b.cacheRead += usage.cacheRead;
    b.cacheWrite5m += usage.cacheWrite5m;
    b.cacheWrite1h += usage.cacheWrite1h;
  }

  list(): CostBucket[] {
    return [...this.map.values()];
  }
}

// ---- reading files -------------------------------------------------------------------------------------

interface FileCount {
  buckets: CostBucket[];
  /** Workers this file's manifests name (pi files only). */
  workers: WorkerManifest[];
}

/** One parse per (path, mtime, size, how it is read). */
const fileMemo = new Map<string, { mtimeMs: number; size: number; count: FileCount }>();
const FILE_MEMO_MAX = 2000;

async function statOf(path: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const s = await stat(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

function remember(key: string, st: { mtimeMs: number; size: number }, count: FileCount): FileCount {
  fileMemo.delete(key);
  fileMemo.set(key, { ...st, count });
  while (fileMemo.size > FILE_MEMO_MAX) {
    const oldest = fileMemo.keys().next().value;
    if (oldest === undefined) break;
    fileMemo.delete(oldest);
  }
  return count;
}

/** The wrap-up turns of a file: from each `entry` "start" to its "end" (ms). */
function wrapupSpans(entries: readonly Entry[], entry: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const e of entries) {
    if (e?.type !== "custom" || e.customType !== entry) continue;
    const at = Date.parse(e.timestamp ?? "");
    if (!Number.isFinite(at)) continue;
    if (e.data?.phase === "start") spans.push([at, Infinity]);
    else if (e.data?.phase === "end" && spans.length && spans[spans.length - 1]![1] === Infinity) spans[spans.length - 1]![1] = at;
  }
  return spans;
}

/** A pi session file: every counted message under `kind` (or "wrapup" inside a wrap-up turn). */
async function countPiFile(path: string, kind: CostKind, wrapupEntry?: string): Promise<FileCount | null> {
  const st = await statOf(path);
  if (!st) return null;
  const key = `pi\0${kind}\0${wrapupEntry ?? ""}\0${path}`;
  const hit = fileMemo.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.count;
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return null;
  const entries = parseLines(text);
  const spans = wrapupEntry ? wrapupSpans(entries, wrapupEntry) : [];
  const buckets = new Buckets(st.mtimeMs);
  const acc = piUsageAccumulator({
    forkBoundary: true,
    onCount: (m) => buckets.add(spans.some(([a, b]) => m.at !== undefined && m.at >= a && m.at <= b) ? "wrapup" : kind, m),
  });
  acc.add(entries);
  let workers: WorkerManifest[] = [];
  try {
    workers = [...readWorkerManifests(entries).manifests.values()];
  } catch {
    workers = [];
  }
  return remember(key, st, { buckets: buckets.list(), workers });
}

/** A Claude Code worker: its record and its nested agents' files, deduplicated together. */
async function countClaudeFiles(file: string): Promise<FileCount | null> {
  const files = [file, ...claudeSidechainFiles(file)];
  const stats = await Promise.all(files.map(statOf));
  if (!stats[0]) return null;
  const st = { mtimeMs: Math.max(...stats.map((s) => s?.mtimeMs ?? 0)), size: stats.reduce((n, s) => n + (s?.size ?? 0), 0) };
  const key = `cc\0${file}`;
  const hit = fileMemo.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.count;
  const buckets = new Buckets(st.mtimeMs);
  const acc = claudeUsageAccumulator({ onCount: (m) => buckets.add("workers", m) });
  for (const f of files) {
    const text = await readFile(f, "utf8").catch(() => "");
    acc.add(parseLines(text));
  }
  return remember(key, st, { buckets: buckets.list(), workers: [] });
}

/** A worker's last usage snapshot (its transcript is gone and nothing counted it before), per model at its time. */
function snapshotBuckets(u: WorkerUsage | undefined, backend: string, fallbackAt: number): CostBucket[] {
  if (!u) return [];
  const b = new Buckets(u.asOf ?? fallbackAt);
  for (const row of u.byModel) {
    const model = backend === "claude-code" && !row.model.startsWith("claude/") ? `claude/${row.model}` : row.model;
    b.add("workers", { model, counts: row, source: "assistant", ...(u.asOf ? { at: u.asOf } : {}) });
  }
  return b.list();
}

// ---- sources ---------------------------------------------------------------------------------------------

interface Source {
  key: string;
  sessionId: string;
  title: string;
  kind: CostKind;
  by: CostStarter;
  /** On this host, for #/s/<path>. */
  path: string | null;
  buckets: CostBucket[];
  /** Counted from its file now (so its snapshot may be written). */
  live: boolean;
  countedAt?: string;
}

/** A worker source's ledger key: never a host path. */
function workerKey(m: WorkerManifest): string | null {
  const ref = m.ref;
  if (!ref) return null;
  if (ref.sessionId) return `w:${m.backend}:${ref.sessionId}`;
  if (m.backend === "claude-code") return `w:claude-code:${ref.locator}`;
  return `w:${m.backend}:${createHash("sha256").update(ref.locator).digest("hex").slice(0, 16)}`;
}

async function titleOf(path: string, fallback: string): Promise<string> {
  const s = await getSessionSummary(path).catch(() => null);
  return s?.title?.trim() || fallback;
}

interface Walk {
  sources: Source[];
  /** Transcript files already counted (a team member listed by two manifests counts once). */
  seen: Set<string>;
  ledger: CostLedger;
}

async function addWorkers(w: Walk, workers: WorkerManifest[], by: CostStarter, depth: number): Promise<void> {
  if (depth > 6) return;
  const adapters = deps.adapters();
  for (const m of workers) {
    const key = workerKey(m);
    if (!key || w.sources.some((s) => s.key === key)) continue;
    let file: string | null = null;
    try {
      file = m.ref ? adapters.get(m.backend).locate(m.ref).file ?? null : null;
    } catch {
      file = null;
    }
    const title = m.name || m.team?.role || m.workerId;
    if (file && w.seen.has(file)) continue;
    const count = file ? (m.backend === "claude-code" ? await countClaudeFiles(file) : await countPiFile(file, "workers")) : null;
    if (count) {
      w.seen.add(file!);
      w.sources.push({ key, sessionId: m.ref?.sessionId ?? m.ref?.locator.split("/").pop() ?? m.workerId, title, kind: "workers", by, path: m.backend === "claude-code" ? null : file, buckets: count.buckets, live: true });
      await addWorkers(w, count.workers, by, depth + 1);
      continue;
    }
    const snap = w.ledger.sources[key];
    if (snap) continue; // the ledger's snapshot joins below
    const buckets = snapshotBuckets(m.usageSnapshot, m.backend, deps.now());
    if (buckets.length) w.sources.push({ key, sessionId: m.workerId, title, kind: "workers", by, path: null, buckets, live: false, countedAt: new Date(m.usageSnapshot?.asOf ?? deps.now()).toISOString() });
  }
}

async function addSession(w: Walk, s: Omit<Source, "buckets" | "live" | "path">, path: string | null, wrapupEntry?: string): Promise<void> {
  if (w.sources.some((x) => x.key === s.key)) return;
  const count = path && !w.seen.has(path) ? await countPiFile(path, s.kind, wrapupEntry) : null;
  if (!count || !path) return;
  w.seen.add(path);
  w.sources.push({ ...s, path, buckets: count.buckets, live: true });
  await addWorkers(w, count.workers, s.by, 0);
}

/** Every source of the project on this host, plus the ledger's for what isn't here. */
async function walkProject(projectId: string): Promise<{ sources: Source[]; reconcile: UsageRow[]; ledger: CostLedger }> {
  const dir = projectDir(projectId);
  const lp = ledgerPaths(projectId, dir);
  const w: Walk = { sources: [], seen: new Set(), ledger: readCostLedger(lp) };

  // Sessions another layer counts as the project's (gathering sessions), each with its wrap-up apart.
  const contributedFiles = new Set<string>();
  for (const c of contributedCostSessions(engineOrThrow(projectId), projectId)) {
    if (c.path) contributedFiles.add(c.path);
    await addSession(w, { key: c.key, sessionId: c.sessionId, title: c.title, kind: c.kind, by: c.by }, c.path, c.wrapupEntry);
  }

  // Its overseer's conversations: every session in its engine's sessions dir carrying this project's marker.
  let names: string[] = [];
  try {
    names = readdirSync(join(dir, "sessions")).filter((n) => n.endsWith(".jsonl"));
  } catch {
    names = [];
  }
  for (const name of names) {
    const path = join(dir, "sessions", name);
    if (contributedFiles.has(path)) continue;
    const m = readPoMarker(path);
    if (!m || m.projectId !== projectId) continue;
    const id = sessionIdOfFile(path);
    await addSession(w, { key: id, sessionId: id, title: await titleOf(path, "Overseer conversation"), kind: "overseer", by: "overseer" }, path);
  }

  // Coding sessions of both kinds, and their workers.
  for (const r of readBuilds(projectId)) {
    const kind: CostKind = r.kind === "coding" ? "coding-overseer" : "coding-operator";
    const by: CostStarter = r.kind === "coding" ? "overseer" : "operator";
    if (r.path) await addSession(w, { key: r.sessionId, sessionId: r.sessionId, title: await titleOf(r.path, r.title ?? "Coding session"), kind, by }, r.path);
  }

  // What the ledger has and this host doesn't (another host's sessions, deleted transcripts, rows
  // the statecharts no longer keep): its last count.
  for (const [key, snap] of Object.entries(w.ledger.sources)) {
    if (w.sources.some((s) => s.key === key)) continue;
    w.sources.push({ key, sessionId: snap.sessionId, title: snap.title, kind: snap.kind, by: snap.by, path: null, buckets: snap.buckets, live: false, countedAt: snap.countedAt });
  }
  return { sources: w.sources, reconcile: readUsageLedger(lp), ledger: w.ledger };
}

// ---- pricing and the answer -----------------------------------------------------------------------------

const zeroTokens = (): CostTokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
const zeroRow = (): CostRow => ({ usd: 0, tokens: zeroTokens(), usdBy: zeroTokens() });
const tokenSum = (b: Pick<CostBucket, "input" | "output" | "cacheRead" | "cacheWrite5m" | "cacheWrite1h">) => b.input + b.output + b.cacheRead + b.cacheWrite5m + b.cacheWrite1h;

interface PricedBucket {
  bucket: CostBucket;
  status: "priced" | "free" | "unpriced";
  /** The price key (priced, free: the ref) or the recorded ref (unpriced). */
  model: string;
  why?: string;
  usdBy: CostTokens;
  usd: number;
}

function priceBucket(b: CostBucket): PricedBucket {
  const ref = `${b.provider}/${b.model}`;
  const none = { usdBy: zeroTokens(), usd: 0 };
  if (b.noModel) return { bucket: b, status: "unpriced", model: ref, why: NO_MODEL_WHY, ...none };
  const n = b.n || 1;
  const avg: TokenUsage = { input: b.input / n, output: b.output / n, cacheRead: b.cacheRead / n, cacheWrite5m: b.cacheWrite5m / n, cacheWrite1h: b.cacheWrite1h / n };
  const p = deps.price({ provider: b.provider, model: b.model, ...(b.responseModel ? { responseModel: b.responseModel } : {}) }, avg, b.at);
  if (p.status === "unpriced") return { bucket: b, status: "unpriced", model: ref, why: p.why, ...none };
  if (p.status === "free") return { bucket: b, status: "free", model: ref, why: p.why, ...none };
  const usdBy: CostTokens = { input: p.usd.input * n, output: p.usd.output * n, cacheRead: p.usd.cacheRead * n, cacheWrite: (p.usd.cacheWrite5m + p.usd.cacheWrite1h) * n, cacheWrite1h: p.usd.cacheWrite1h * n };
  return { bucket: b, status: "priced", model: p.key, usdBy, usd: p.usd.total * n };
}

function addTo(row: CostRow, p: PricedBucket): void {
  const b = p.bucket;
  row.usd += p.usd;
  row.tokens.input += b.input;
  row.tokens.output += b.output;
  row.tokens.cacheRead += b.cacheRead;
  row.tokens.cacheWrite += b.cacheWrite5m + b.cacheWrite1h;
  row.tokens.cacheWrite1h += b.cacheWrite1h;
  for (const k of ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"] as const) row.usdBy[k] += p.usdBy[k];
}

/** Reconciler rows as buckets (each row one message), under the starter that asked. */
function reconcileSources(rows: UsageRow[]): Source[] {
  const by = new Map<CostStarter, Buckets>();
  for (const r of rows) {
    const at = Date.parse(r.at);
    const b = by.get(r.by) ?? new Buckets(at);
    by.set(r.by, b);
    b.add("reconcile", {
      model: `${r.provider}/${r.model}`,
      counts: { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite },
      // Recorded with its split (the envelope's `cache_creation`): none said is 5-minute writes.
      cacheWrite1h: r.cacheWrite1h ?? 0,
      // The model that answered where the provider named it (reconcile.ts usageRefOf); a bare
      // Claude Code alias is priced by the alias table's date.
      ...(r.provider === "claude-code-cli" ? {} : { responseModel: r.model }),
      source: "assistant",
      ...(Number.isFinite(at) ? { at } : {}),
    });
  }
  return [...by].map(([starter, b]) => ({ key: `reconcile:${starter}`, sessionId: `reconcile:${starter}`, title: "Reconciler", kind: "reconcile" as const, by: starter, path: null, buckets: b.list(), live: false }));
}

const TOP_MAX = 20;
const WRITE_GAP_MS = 60_000;
const lastWrite = new Map<string, number>();

/** Write what changed into costs.json, at most once a minute per project. */
function keepSnapshots(projectId: string, ledger: CostLedger, sources: Source[], now: number): void {
  const k = projectId;
  if (now - (lastWrite.get(k) ?? 0) < WRITE_GAP_MS) return;
  let changed = false;
  const next: CostLedger = { version: 1, sources: { ...ledger.sources } };
  for (const s of sources) {
    if (!s.live || !s.buckets.length) continue;
    const prev = ledger.sources[s.key];
    const sorted = [...s.buckets].sort((a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind) || a.model.localeCompare(b.model));
    if (prev && prev.kind === s.kind && prev.by === s.by && JSON.stringify(prev.buckets) === JSON.stringify(sorted)) continue;
    const snap: CostSnapshot = { sessionId: s.sessionId, title: s.title, kind: s.kind, by: s.by, countedAt: new Date(now).toISOString(), buckets: sorted };
    next.sources[s.key] = snap;
    changed = true;
  }
  lastWrite.set(k, now);
  if (!changed) return;
  try {
    writeCostLedger(ledgerPaths(projectId), next);
  } catch (err) {
    console.warn(`[project-costs] ${k}: costs.json not written: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function computeProjectCost(projectId: string): Promise<ProjectCost> {
  projectOf(projectId);
  const now = deps.now();
  const { sources: fileSources, reconcile, ledger } = await walkProject(projectId);
  keepSnapshots(projectId, ledger, fileSources, now);
  const sources = [...fileSources, ...reconcileSources(reconcile)];

  const total = zeroRow();
  const byKind = new Map<CostKind, CostRow>();
  const byStarter = new Map<CostStarter, CostRow>();
  const byModel = new Map<string, CostModelRow>();
  const unpriced = new Map<string, { model: string; tokens: number; why: string }>();
  const estimates = new Map<CostEstimate["code"], CostEstimate>();
  const top: CostSession[] = [];
  let since: number | null = null;
  let notOnHost = 0;
  let oldestCount: string | null = null;

  for (const s of sources) {
    const row = zeroRow();
    for (const b of s.buckets) {
      const p = priceBucket(b);
      addTo(row, p);
      addTo(total, p);
      const kindRow = byKind.get(b.kind) ?? zeroRow();
      byKind.set(b.kind, kindRow);
      addTo(kindRow, p);
      const starterRow = byStarter.get(s.by) ?? zeroRow();
      byStarter.set(s.by, starterRow);
      addTo(starterRow, p);
      const mk = `${p.status}\0${p.model}`;
      const name = p.status === "priced" ? deps.name(p.model) : undefined;
      const modelRow = byModel.get(mk) ?? { model: p.model, ...(name ? { name } : {}), status: p.status, ...(p.why ? { why: p.why } : {}), ...zeroRow() };
      byModel.set(mk, modelRow);
      addTo(modelRow, p);
      if (p.status === "unpriced") {
        const u = unpriced.get(p.model) ?? { model: p.model, tokens: 0, why: p.why ?? "" };
        u.tokens += tokenSum(b);
        unpriced.set(p.model, u);
      }
      for (const f of b.est ?? []) {
        const code = f === "1h" ? "cache-write-1h-assumed" : "model-from-alias";
        const e = estimates.get(code) ?? { code, messages: 0, usd: 0 };
        e.messages += b.n;
        e.usd += f === "1h" ? p.usdBy.cacheWrite1h : p.usd;
        estimates.set(code, e);
      }
      const at = Date.parse(b.at);
      if (Number.isFinite(at)) since = since === null ? at : Math.min(since, at);
    }
    if (!s.live && s.countedAt) {
      notOnHost++;
      if (!oldestCount || s.countedAt < oldestCount) oldestCount = s.countedAt;
    }
    top.push({ sessionId: s.sessionId, title: s.title, kind: s.kind, by: s.by, path: s.path, ...(s.countedAt && !s.live ? { countedAt: s.countedAt } : {}), ...row });
  }

  const spent = (r: CostRow) => r.usd > 0 || r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite > 0;
  const allTokens = (r: CostRow) => r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite;
  const kindOrder: CostKind[] = ["overseer", "gathering", "settle", "wrapup", "coding-overseer", "coding-operator", "workers", "reconcile"];
  const starterOrder: CostStarter[] = ["overseer", "operator", "sova"];
  return {
    projectId,
    totalUsd: total.usd,
    asOf: new Date(now).toISOString(),
    since: since === null ? null : new Date(since).toISOString(),
    prices: { source: "models.dev", fetchedAt: deps.prices().fetchedAt },
    sessions: new Set(sources.map((s) => (s.kind === "reconcile" ? "reconcile" : s.key))).size,
    byKind: kindOrder.filter((k) => byKind.has(k) && spent(byKind.get(k)!)).map((kind) => ({ kind, ...byKind.get(kind)! })),
    byStarter: starterOrder.filter((k) => byStarter.has(k) && spent(byStarter.get(k)!)).map((by) => ({ by, ...byStarter.get(by)! })),
    byModel: [...byModel.values()].filter(spent).sort((a, b) => b.usd - a.usd || allTokens(b) - allTokens(a) || a.model.localeCompare(b.model)),
    top: top.filter(spent).sort((a, b) => b.usd - a.usd || allTokens(b) - allTokens(a)).slice(0, TOP_MAX),
    unpriced: [...unpriced.values()].sort((a, b) => b.tokens - a.tokens),
    estimates: [...estimates.values()],
    notOnHost: notOnHost ? { sessions: notOnHost, countedAt: oldestCount } : null,
    notCounted: [],
  };
}

const MEMO_MS = 15_000;
const projectMemo = new Map<string, { at: number; value: Promise<ProjectCost> }>();

/** A project's cost now (memoized 15 s: a poll re-reads only changed files anyway). */
export function projectCost(projectId: string): Promise<ProjectCost> {
  const k = projectId;
  const hit = projectMemo.get(k);
  if (hit && deps.now() - hit.at < MEMO_MS) return hit.value;
  const value = computeProjectCost(projectId);
  projectMemo.set(k, { at: deps.now(), value });
  value.catch(() => projectMemo.delete(k));
  return value;
}
