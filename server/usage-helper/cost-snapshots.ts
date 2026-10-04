import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CostKind, CostStarter } from "../../shared/costs";

/**
 * A project's costs.json (§app.project-costs/ledger): the last count of each session and worker on
 * the host that counts it, as token buckets (never dollars). Builtins only: the usage helper writes
 * it from the usage ledger and reads other hosts' rows from it; server/project-costs-ledger.ts
 * re-exports it. `costs` is the file's absolute path.
 */

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const s = (v: unknown): string => (typeof v === "string" ? v : "");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

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

export function readCostLedger(p: { costs: string }): CostLedger {
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
      by: v.by === "overseer" || v.by === "sova" ? v.by : "operator",
      countedAt: s(v.countedAt),
      buckets: v.buckets.map(parseBucket).filter((b): b is CostBucket => b !== null),
    };
  }
  return out;
}

export function writeCostLedger(p: { costs: string }, ledger: CostLedger): void {
  const sorted = Object.fromEntries(Object.keys(ledger.sources).sort().map((k) => [k, ledger.sources[k]]));
  mkdirSync(dirname(p.costs), { recursive: true });
  const tmp = `${p.costs}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, sources: sorted }, null, 1)}\n`);
  renameSync(tmp, p.costs);
}
