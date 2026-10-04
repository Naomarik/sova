import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { CostStarter } from "../shared/costs";
import { OrgError } from "./org-error";
import { projectDir } from "./projects/spaces";

/**
 * A project's cost ledger in its engine's directory (§app.project-costs/ledger), so it moves with
 * the project. Neither file holds a secret, a path or a host name; a snapshot keeps its session's title,
 * as the build statechart does.
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

export function ledgerPaths(projectId: string, workspace?: string): LedgerPaths {
  if (!SAFE_ID.test(projectId)) throw new OrgError("Unknown project", 404);
  if (workspace !== undefined && !isAbsolute(workspace)) throw new Error(`ledgerPaths: the engine's directory must be absolute, not ${JSON.stringify(workspace)}`);
  const dir = join(workspace ?? projectDir(projectId), "projects", projectId);
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
      by: r.by === "overseer" || r.by === "sova" ? r.by : "operator",
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

// The snapshot file's shape, parse and write live with the usage helper, which writes it.
export { readCostLedger, writeCostLedger, type CostBucket, type CostLedger, type CostSnapshot, type EstimateFlag } from "./usage-helper/cost-snapshots";
