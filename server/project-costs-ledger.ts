import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CostKind, CostStarter } from "../shared/costs";
import { writeAtomic } from "./overseer-store";
import { orgDir, OrgError } from "./orgs";

/**
 * A project's cost ledger in the org's workspace repo (§app.project-costs/ledger), so it moves with
 * the org. Neither file holds a secret, a path or a host name; a snapshot keeps its session's title,
 * as started.json does.
 *
 * - `projects/<pid>/usage.jsonl`: append-only usage that has no transcript: one row per reconciler
 *   answer (the decide chain's own cache hits spend nothing and write nothing).
 * - `projects/<pid>/costs.json`: the last count of each session and worker, as token buckets, by
 *   the host that has its file. A host without the file shows the snapshot ("as last counted").
 *   Dollars are never stored: they are recomputed from the buckets with the current prices.
 */

const SAFE_ID = /^[a-z0-9_]{1,40}$/;

export interface LedgerPaths {
  usage: string;
  costs: string;
}

export function ledgerPaths(orgId: string, projectId: string, workspace = orgDir(orgId)): LedgerPaths {
  if (!SAFE_ID.test(orgId) || !SAFE_ID.test(projectId)) throw new OrgError("Unknown project", 404);
  const dir = join(workspace, "projects", projectId);
  return { usage: join(dir, "usage.jsonl"), costs: join(dir, "costs.json") };
}

// ---- usage.jsonl -------------------------------------------------------------------------------------

/** One reconciler answer's usage. `provider`/`model` are the price ref (`claude`/`claude-haiku-4-5-20251001`,
    `zai`/`glm-5.3`, `jev`/`jev-1.13.0`); `cacheWrite` includes `cacheWrite1h`. */
export interface UsageRow {
  at: string;
  kind: "reconcile";
  by: CostStarter;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const s = (v: unknown): string => (typeof v === "string" ? v : "");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function appendUsage(p: LedgerPaths, row: UsageRow): void {
  mkdirSync(dirname(p.usage), { recursive: true });
  appendFileSync(p.usage, `${JSON.stringify(row)}\n`);
}

/** Every well-formed row, in file order; a torn or hand-broken line is skipped. */
export function readUsageLedger(p: LedgerPaths): UsageRow[] {
  let text: string;
  try {
    text = readFileSync(p.usage, "utf8");
  } catch {
    return [];
  }
  const out: UsageRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let r: unknown;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(r) || r.kind !== "reconcile" || !s(r.at) || !s(r.provider) || !s(r.model)) continue;
    out.push({
      at: s(r.at),
      kind: "reconcile",
      by: r.by === "overseer" ? "overseer" : "operator",
      provider: s(r.provider),
      model: s(r.model),
      input: n(r.input),
      output: n(r.output),
      cacheRead: n(r.cacheRead),
      cacheWrite: n(r.cacheWrite),
      ...(n(r.cacheWrite1h) ? { cacheWrite1h: Math.min(n(r.cacheWrite1h), n(r.cacheWrite)) } : {}),
    });
  }
  return out;
}

// ---- costs.json --------------------------------------------------------------------------------------

/** Where a bucket's figures are an estimate (shared/costs.ts CostEstimate codes). */
export type EstimateFlag = "1h" | "alias";

/**
 * Messages of one model, kind, UTC day, price tier band and estimate flags, summed. Every message
 * in a bucket fell in the same band, so pricing the bucket's average message times `n` is exact.
 */
export interface CostBucket {
  kind: CostKind;
  provider: string;
  model: string;
  responseModel?: string;
  /** The first message's time (ISO): the price period and dated alias it is priced at. */
  at: string;
  /** Messages. */
  n: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** The tier threshold its messages were over when counted; absent = base rates. */
  band?: number;
  est?: EstimateFlag[];
  /** A tool result's usage with no model of its own: never priced. */
  noModel?: true;
}

/** One session's (or worker's) last count. */
export interface CostSnapshot {
  sessionId: string;
  title: string;
  kind: CostKind;
  by: CostStarter;
  countedAt: string;
  buckets: CostBucket[];
}

export interface CostLedger {
  version: 1;
  /** By source key: a session id, or `w:<backend>:<locator>` for a worker. */
  sources: Record<string, CostSnapshot>;
}

const KINDS = new Set<CostKind>(["overseer", "gathering", "settle", "wrapup", "coding-overseer", "coding-operator", "workers", "reconcile"]);
const isKind = (v: unknown): v is CostKind => typeof v === "string" && KINDS.has(v as CostKind);

function parseBucket(v: unknown): CostBucket | null {
  if (!isObj(v) || !isKind(v.kind) || !s(v.provider) || !s(v.model) || !s(v.at) || !(n(v.n) >= 1)) return null;
  const est = Array.isArray(v.est) ? v.est.filter((f): f is EstimateFlag => f === "1h" || f === "alias") : [];
  return {
    kind: v.kind,
    provider: s(v.provider),
    model: s(v.model),
    ...(s(v.responseModel) ? { responseModel: s(v.responseModel) } : {}),
    at: s(v.at),
    n: Math.round(n(v.n)),
    input: n(v.input),
    output: n(v.output),
    cacheRead: n(v.cacheRead),
    cacheWrite5m: n(v.cacheWrite5m),
    cacheWrite1h: n(v.cacheWrite1h),
    ...(n(v.band) ? { band: n(v.band) } : {}),
    ...(est.length ? { est } : {}),
    ...(v.noModel === true ? { noModel: true as const } : {}),
  };
}

export function readCostLedger(p: LedgerPaths): CostLedger {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p.costs, "utf8"));
  } catch {
    return { version: 1, sources: {} };
  }
  const out: CostLedger = { version: 1, sources: {} };
  if (!isObj(raw) || !isObj(raw.sources)) return out;
  for (const [k, v] of Object.entries(raw.sources)) {
    if (!isObj(v) || !isKind(v.kind) || !s(v.sessionId) || !s(v.countedAt) || !Array.isArray(v.buckets)) continue;
    out.sources[k] = {
      sessionId: s(v.sessionId),
      title: s(v.title),
      kind: v.kind,
      by: v.by === "overseer" ? "overseer" : "operator",
      countedAt: s(v.countedAt),
      buckets: v.buckets.map(parseBucket).filter((b): b is CostBucket => b !== null),
    };
  }
  return out;
}

export function writeCostLedger(p: LedgerPaths, ledger: CostLedger): void {
  const sorted = Object.fromEntries(Object.keys(ledger.sources).sort().map((k) => [k, ledger.sources[k]]));
  writeAtomic(p.costs, `${JSON.stringify({ version: 1, sources: sorted }, null, 1)}\n`);
}
