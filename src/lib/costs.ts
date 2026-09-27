// Project costs at API prices (§app/project-costs): the card's and the org roll-up's pure rules,
// so they run under tsx --test.

import { formatTokens } from "./context";
import { relativeTime } from "./format";

/** Dollars as the copy deck writes them: `$1,240.00`, `$0.08`, `<$0.01`, `$0.00`. */
export function usd(n: number): string {
  if (!(n > 0)) return "$0.00";
  if (n < 0.005) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---- STUB wire shape (PLAN.md §4) until shared/costs.ts lands; replaced by an import ----

export type CostKind = "overseer" | "gathering" | "settle" | "wrapup" | "coding-overseer" | "coding-operator" | "workers" | "reconcile";
export type TokenKind = "input" | "output" | "cacheRead" | "cacheWrite";
export interface CostTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export interface CostRow {
  usd: number;
  tokens: CostTokens;
}
export interface ProjectCost {
  totalUsd: number;
  asOf: string;
  prices: { refreshedAt: string | null };
  sessions: number;
  byKind: ({ kind: CostKind } & CostRow)[];
  byStarter: ({ by: "overseer" | "operator" } & CostRow)[];
  byModel: ({ model: string; name?: string } & CostRow)[];
  unpriced: { model: string; tokens: number; why: string }[];
  estimates: string[];
  notOnHost: { sessions: number; countedAt: string | null } | null;
  notCounted: string[];
}
export interface OrgCosts {
  totalUsd: number;
  projects: { projectId: string; totalUsd: number }[];
}

// ---- grouping ----

export const TOKEN_KINDS: readonly TokenKind[] = ["input", "output", "cacheRead", "cacheWrite"];

/** All four token kinds of a row, summed. */
export const tokenSum = (t: CostTokens): number => t.input + t.output + t.cacheRead + t.cacheWrite;

/** Rows that spent anything, most expensive first; ties by tokens, then by the key the caller names. */
export function byCost<T extends CostRow>(rows: readonly T[], key: (r: T) => string): T[] {
  return rows.filter((r) => r.usd > 0 || tokenSum(r.tokens) > 0).sort((a, b) => b.usd - a.usd || tokenSum(b.tokens) - tokenSum(a.tokens) || key(a).localeCompare(key(b)));
}

/** The four token kinds summed over rows, and their dollars: the table's total line. */
export function totalRow(rows: readonly CostRow[]): CostRow {
  const tokens: CostTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let usd = 0;
  for (const r of rows) {
    usd += r.usd;
    for (const k of TOKEN_KINDS) tokens[k] += r.tokens[k];
  }
  return { usd, tokens };
}

// ---- words (§design.copy-deck/project-costs) ----

export const KIND_LABEL: Record<CostKind, string> = {
  overseer: "Overseer",
  gathering: "Gathering and offers",
  settle: "Settling",
  wrapup: "Wrap-ups",
  "coding-overseer": "Coding · started by the overseer",
  "coding-operator": "Coding · started by you",
  workers: "Workers",
  reconcile: "Reconciler",
};
export const STARTER_LABEL: Record<ProjectCost["byStarter"][number]["by"], string> = { overseer: "The overseer", operator: "You" };

/** What each estimate code means, as a sentence. */
const ESTIMATE_LINE: Record<string, string> = {
  "cc-ttl-assumed-1h": "Older Claude Code messages didn't record how long their cache lasts, so their cache writes are priced at the 1-hour rate. That's an estimate.",
};

/** The card's notes, one line each: what isn't in the total, what's estimated, what's from another host, and when prices were refreshed. */
export function costNotes(c: Pick<ProjectCost, "unpriced" | "estimates" | "notOnHost" | "notCounted" | "prices">, now = Date.now()): string[] {
  const out: string[] = [];
  for (const u of c.unpriced) out.push(`${formatTokens(u.tokens)} tokens on ${u.model} have no API price, so they aren't in the total.${u.why ? ` ${u.why}` : ""}`);
  for (const code of new Set(c.estimates)) out.push(ESTIMATE_LINE[code] ?? "Some figures are estimates.");
  const off = c.notOnHost;
  if (off && off.sessions > 0) {
    const n = `${off.sessions} ${off.sessions === 1 ? "session isn't" : "sessions aren't"} on this host`;
    out.push(off.countedAt ? `${n}: as last counted ${relativeTime(off.countedAt, now)}.` : `${n}.`);
  }
  if (c.notCounted.length) out.push(`Not counted: ${c.notCounted.join(", ")}.`);
  out.push(c.prices.refreshedAt ? `Prices refreshed ${relativeTime(c.prices.refreshedAt, now)}.` : "Prices from the built-in table; not refreshed yet.");
  return out;
}
