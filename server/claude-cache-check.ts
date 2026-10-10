import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { parseUsageLine, RESEND_HOWS, type UsageRecord } from "../pi-config/extensions/llm-inflight/usage-record.ts";
import { priceUsage, type Aliases, type PriceTable } from "../shared/model-prices/prices";

/**
 * The developer check of Claude re-sends (§app.insights/usage-resend): from the usage ledger's files
 * only (never a model call), per kind of conversation, the share of its Claude Code spend that went
 * to re-sending its history to a new process, and the top reasons. A call with `launch` says so
 * itself (`how` folded or joined); a call without one (records from before the field) is estimated
 * from its tokens: a cache write over RESEND_MIN tokens where the cache read falls short of the
 * conversation's previous call (read + write) by at least RESEND_MIN. An estimate's reason is what
 * the timing shows: over an hour idle (the cache had expired anyway), another process than the
 * previous call's (a server restart), a previous reply that stopped for a tool (mid-turn), else
 * between turns. Pure but for `readLedger`.
 */

export const RESEND_MIN = 5_000;
const IDLE_MS = 60 * 60_000;

export interface CheckOptions {
  table: PriceTable;
  aliases: Aliases;
  /** UTC days, inclusive (`yyyy-mm-dd`); absent: every day. */
  from?: string;
  to?: string;
}

export interface ReasonRow {
  reason: string;
  /** From `launch`, or estimated from the tokens. */
  source: "recorded" | "estimated";
  calls: number;
  usd: number;
  tokens: number;
}

export interface KindRow {
  kind: string;
  conversations: number;
  calls: number;
  /** Every Claude Code call of the kind, at API prices. */
  usd: number;
  /** The re-sending calls' input and cache-write dollars. */
  resendUsd: number;
  resendCalls: number;
  share: number;
  /** Launches with `launch` recorded, and how many of them resumed. */
  launches: number;
  resumed: number;
  reasons: ReasonRow[];
}

export interface CheckReport {
  from: string | null;
  to: string | null;
  records: number;
  usd: number;
  resendUsd: number;
  kinds: KindRow[];
}

/** Every record under `<usage>/v1` (plain and sealed `.gz` files), deduplicated by key. Reads only. */
export function readLedger(usageRoot: string, from?: string, to?: string): UsageRecord[] {
  const out = new Map<string, UsageRecord>();
  let days: string[] = [];
  try {
    days = fs.readdirSync(usageRoot).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  } catch {
    return [];
  }
  for (const day of days) {
    if ((from && day < from) || (to && day > to)) continue;
    const dir = path.join(usageRoot, day);
    for (const f of fs.readdirSync(dir).sort()) {
      let text: string;
      try {
        if (f.endsWith(".jsonl")) text = fs.readFileSync(path.join(dir, f), "utf8");
        else if (f.endsWith(".jsonl.gz")) text = zlib.gunzipSync(fs.readFileSync(path.join(dir, f))).toString("utf8");
        else continue;
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        const r = line ? parseUsageLine(line) : null;
        if (r && !out.has(r.key)) out.set(r.key, r);
      }
    }
  }
  return [...out.values()];
}

const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);

/** The report over `records` (any order). Only Claude Code's per-message records (`src` claude) count. */
export function cacheCheck(records: readonly UsageRecord[], opts: CheckOptions): CheckReport {
  const calls = records
    .filter((r) => r.provider === "claude-code-cli" && r.src === "claude")
    .filter((r) => (!opts.from || dayOf(r.ts) >= opts.from) && (!opts.to || dayOf(r.ts) <= opts.to))
    .sort((a, b) => a.ts - b.ts || (a.key < b.key ? -1 : 1));
  const price = (r: UsageRecord) => {
    const cw1h = r.cacheWrite1h ?? 0;
    const p = priceUsage(opts.table, opts.aliases, { provider: r.provider, model: r.model, ...(r.responseModel ? { responseModel: r.responseModel } : {}) }, { input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite5m: r.cacheWrite - cw1h, cacheWrite1h: cw1h }, r.ts);
    return p.status === "priced" ? { total: p.usd.total, resend: p.usd.input + p.usd.cacheWrite5m + p.usd.cacheWrite1h } : { total: 0, resend: 0 };
  };
  const kinds = new Map<string, KindRow & { owners: Set<string>; byReason: Map<string, ReasonRow> }>();
  const prev = new Map<string, UsageRecord>();
  let usd = 0;
  let resendUsd = 0;
  for (const r of calls) {
    const owner = r.owner ?? `(none):${r.producer}`;
    const k = kinds.get(r.kind) ?? { kind: r.kind, conversations: 0, calls: 0, usd: 0, resendUsd: 0, resendCalls: 0, share: 0, launches: 0, resumed: 0, reasons: [], owners: new Set<string>(), byReason: new Map<string, ReasonRow>() };
    kinds.set(r.kind, k);
    k.owners.add(owner);
    k.calls++;
    const p = price(r);
    k.usd += p.total;
    usd += p.total;
    let reason: { reason: string; source: ReasonRow["source"] } | undefined;
    if (r.launch) {
      k.launches++;
      if (r.launch.how === "resumed") k.resumed++;
      if (RESEND_HOWS.includes(r.launch.how)) reason = { reason: r.launch.fallback ? `${r.launch.why} (${r.launch.fallback})` : r.launch.why, source: "recorded" };
    } else {
      const before = prev.get(owner);
      if (before && r.cacheWrite > RESEND_MIN && r.cacheRead < before.cacheRead + before.cacheWrite - RESEND_MIN) {
        const why = r.ts - before.ts > IDLE_MS ? "idle over 1h (cache expired)"
          : r.producer !== before.producer ? "server restart"
          : before.stop === "tool_use" || before.stop === "toolUse" ? "mid-turn"
          : "between turns";
        reason = { reason: why, source: "estimated" };
      }
    }
    prev.set(owner, r);
    if (!reason) continue;
    const tokens = r.input + r.cacheWrite;
    k.resendUsd += p.resend;
    k.resendCalls++;
    resendUsd += p.resend;
    const key = `${reason.source}\u0000${reason.reason}`;
    const row = k.byReason.get(key) ?? { ...reason, calls: 0, usd: 0, tokens: 0 };
    k.byReason.set(key, row);
    row.calls++;
    row.usd += p.resend;
    row.tokens += tokens;
  }
  const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
  const out: KindRow[] = [...kinds.values()]
    .map(({ owners, byReason, ...k }) => ({
      ...k,
      conversations: owners.size,
      usd: r6(k.usd),
      resendUsd: r6(k.resendUsd),
      share: k.usd ? r6(k.resendUsd / k.usd) : 0,
      reasons: [...byReason.values()].map((x) => ({ ...x, usd: r6(x.usd) })).sort((a, b) => b.usd - a.usd || b.calls - a.calls),
    }))
    .sort((a, b) => b.usd - a.usd);
  return {
    from: opts.from ?? (calls[0] ? dayOf(calls[0].ts) : null),
    to: opts.to ?? (calls.at(-1) ? dayOf(calls.at(-1)!.ts) : null),
    records: calls.length,
    usd: r6(usd),
    resendUsd: r6(resendUsd),
    kinds: out,
  };
}

/** The report as text, `top` reasons per kind. */
export function formatCheck(report: CheckReport, top = 5): string {
  const $ = (n: number) => `$${n.toFixed(2)}`;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `Claude Code re-sends, ${report.from ?? "-"} to ${report.to ?? "-"} (UTC): ${report.records} calls, ${$(report.usd)}, of which ${$(report.resendUsd)} re-sending history (${pct(report.usd ? report.resendUsd / report.usd : 0)})`,
  ];
  for (const k of report.kinds) {
    lines.push("", `${k.kind}: ${k.conversations} conversations, ${k.calls} calls, ${$(k.usd)}; re-sending ${$(k.resendUsd)} = ${pct(k.share)} in ${k.resendCalls} calls; launches recorded ${k.launches}, resumed ${k.resumed}`);
    for (const r of k.reasons.slice(0, top)) lines.push(`  ${$(r.usd).padStart(9)}  ${String(r.calls).padStart(4)}×  ${r.reason}${r.source === "estimated" ? " (estimated)" : ""}`);
  }
  return lines.join("\n");
}
