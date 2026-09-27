// Project costs at API prices (§app/project-costs): the card's and the org roll-up's pure rules,
// so they run under tsx --test. Words: §design.copy-deck/project-costs.

import type { CostKind, CostModelRow, CostStarter, CostTokens, ProjectCost } from "../../shared/costs";
import { shortDate } from "./format";
import { tokens } from "./project-overseer-view";

// ---- figures ----

/** Dollars as the copy deck writes them: `$1,240.00`, `$0.08`, `<$0.01`, `$0.00`; `≈` before one that includes an estimate. */
export function usd(n: number, estimate = false): string {
  const s = !(n > 0) ? "$0.00" : n < 0.005 ? "<$0.01" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return estimate ? `≈${s}` : s;
}
/** The `title` on a figure written with `≈`. */
export const ESTIMATE_TITLE = "Partly an estimate: see the note below.";

/** The token kinds the model table shows; `cacheWrite` is both TTLs. */
export const TOKEN_KINDS = ["input", "output", "cacheRead", "cacheWrite"] as const satisfies readonly (keyof CostTokens)[];

/** Some part of the total is an estimate: the merged Claude Code cache writes priced at the 1-hour rate (a dated alias is a price rule, not an estimate). */
export const hasEstimate = (c: Pick<ProjectCost, "estimates">): boolean => c.estimates.some((e) => e.code === "cache-write-1h-assumed" && e.usd > 0);

// ---- grouping ----

/** A kind as the card shows it: coding sessions are one row whoever started them (the starters line says who). */
export type CardKind = "overseer" | "gathering" | "settle" | "wrapup" | "coding" | "workers" | "reconcile";
const CARD_KIND: Record<CostKind, CardKind> = {
  overseer: "overseer",
  gathering: "gathering",
  settle: "settle",
  wrapup: "wrapup",
  "coding-overseer": "coding",
  "coding-operator": "coding",
  workers: "workers",
  reconcile: "reconcile",
};
export const KIND_ORDER: readonly CardKind[] = ["overseer", "gathering", "settle", "wrapup", "coding", "workers", "reconcile"];
export const KIND_LABEL: Record<CardKind, string> = {
  overseer: "Overseer conversations",
  gathering: "Gathering and offers",
  settle: "Settling",
  wrapup: "Wrap-ups",
  coding: "Coding sessions",
  workers: "Their workers",
  reconcile: "Reconciler",
};

/** The kinds with a cost, in the scope's order (never by size), both coding kinds as one row. */
export function kindRows(rows: readonly { kind: CostKind; usd: number }[]): { kind: CardKind; usd: number }[] {
  const sums = new Map<CardKind, number>();
  for (const r of rows) sums.set(CARD_KIND[r.kind], (sums.get(CARD_KIND[r.kind]) ?? 0) + r.usd);
  return KIND_ORDER.filter((k) => (sums.get(k) ?? 0) > 0).map((kind) => ({ kind, usd: sums.get(kind)! }));
}

// "sova" is the spec's third starter (the reconciler's automatic runs), said when the wire carries it.
const STARTER_ORDER: readonly string[] = ["overseer", "operator", "sova"];
const STARTER_WORDS: Record<string, string> = { overseer: "the overseer", operator: "you", sova: "Sova on its own" };

/** "Started by the overseer $8.10 · by you $4.02 · by Sova on its own $0.36", as parts (each amount is its own figure): only starters with a cost, in a fixed order; empty when none has. */
export function starterParts(rows: readonly { by: CostStarter; usd: number }[]): { words: string; usd: string }[] {
  return rows
    .filter((r) => r.usd > 0 && STARTER_WORDS[r.by])
    .sort((a, b) => STARTER_ORDER.indexOf(a.by) - STARTER_ORDER.indexOf(b.by))
    .map((r, i) => ({ words: `${i === 0 ? "Started by" : "by"} ${STARTER_WORDS[r.by]}`, usd: usd(r.usd) }));
}

/** A top session's second line: "Coding sessions · started by you". */
export function topMeta(kind: CostKind, by: CostStarter): string {
  return `${KIND_LABEL[CARD_KIND[kind]]} · ${(by as string) === "sova" ? "run by Sova" : `started by ${STARTER_WORDS[by] ?? by}`}`;
}

const sum = (t: CostTokens) => t.input + t.output + t.cacheRead + t.cacheWrite;

/** Models most expensive first, priced before free before unpriced; ties by tokens, then name. An empty row goes. */
export function modelRows(rows: readonly CostModelRow[]): CostModelRow[] {
  const rank = { priced: 0, free: 1, unpriced: 2 } as const;
  return rows
    .filter((r) => r.usd > 0 || sum(r.tokens) > 0)
    .sort((a, b) => rank[a.status] - rank[b.status] || b.usd - a.usd || sum(b.tokens) - sum(a.tokens) || a.model.localeCompare(b.model));
}

/** The `All models` row: each column summed (an unpriced model adds tokens, never dollars: the wire's usd is 0 for it). */
export function allModels(rows: readonly CostModelRow[]): Pick<CostModelRow, "tokens" | "usdBy" | "usd"> {
  const zero = (): CostTokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
  const tokens = zero();
  const usdBy = zero();
  let total = 0;
  for (const r of rows) {
    for (const k of Object.keys(tokens) as (keyof CostTokens)[]) {
      tokens[k] += r.tokens[k];
      if (r.status !== "unpriced") usdBy[k] += r.usdBy[k];
    }
    if (r.status !== "unpriced") total += r.usd;
  }
  return { tokens, usdBy, usd: total };
}

/** What a model's money cells say: dollars, or `local`, or `unpriced`. */
export const moneyWord = (r: Pick<CostModelRow, "status" | "why">): "usd" | "local" | "unpriced" => (r.status === "unpriced" ? "unpriced" : r.status === "free" && r.why === "local" ? "local" : "usd");

// ---- notes ----

export interface CostNote {
  text: string;
  title?: string;
}

/** The card's notes, one line each and only when true, then the 2 always said (the prices' date when known). */
export function costNotes(c: Pick<ProjectCost, "unpriced" | "estimates" | "notOnHost" | "prices">, now = Date.now()): CostNote[] {
  const out: CostNote[] = [];
  for (const u of c.unpriced) {
    if (u.model === "unknown") out.push({ text: `${tokens(u.tokens)} tokens counted before costs have no model recorded, so they aren't in the total.` });
    else out.push({ text: `${tokens(u.tokens)} tokens on ${u.model} have no API price, so they aren't in the total.`, title: u.why || undefined });
  }
  if (hasEstimate(c)) {
    out.push({ text: "≈ Older Claude Code messages didn't record how long their cache was kept, so their cache writes are priced at the 1-hour rate." });
  }
  const off = c.notOnHost;
  if (off && off.sessions > 0) {
    const n = `${off.sessions} ${off.sessions === 1 ? "session isn't" : "sessions aren't"} on this host: `;
    out.push({ text: off.countedAt ? `${n}their cost is as last counted, ${shortDate(Date.parse(off.countedAt), now)}.` : `${n}their cost is as last counted.` });
  }
  out.push({ text: "Not counted: topic summaries, image descriptions, and Sova's own side calls." });
  if (c.prices.fetchedAt) out.push({ text: `Prices from models.dev, as of ${shortDate(Date.parse(c.prices.fetchedAt), now)}.` });
  return out;
}

/** The empty card's line. */
export const emptyLine = (sessions: number): string => (sessions > 0 ? `${sessions} ${sessions === 1 ? "session" : "sessions"} in this project. Nothing spent yet.` : "Nothing spent yet.");
