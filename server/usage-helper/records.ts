import { parseUsageLine, type UsageRecord } from "../../pi-config/extensions/llm-inflight/usage-record";
import type { TokenUsage } from "../../shared/model-prices/prices";

/**
 * A ledger record (pi-config/extensions/llm-inflight/usage-record.ts, the contract) as the helper
 * folds it: the tokens split into the five priced kinds. A line that isn't a record is skipped,
 * never fatal.
 */
export interface UsageRec {
  key: string;
  ts: number;
  record: UsageRecord;
  usage: TokenUsage;
}

export function usageOf(r: UsageRecord): TokenUsage {
  const cw1h = r.cacheWrite1h ?? 0;
  return { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite5m: r.cacheWrite - cw1h, cacheWrite1h: cw1h };
}

/** A line of a producer file (without its `\n`), or null. */
export function parseLine(line: string): UsageRec | null {
  const record = parseUsageLine(line);
  if (!record) return null;
  return { key: record.key, ts: record.ts, record, usage: usageOf(record) };
}
