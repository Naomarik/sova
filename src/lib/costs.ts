// Project costs at API prices (§app/project-costs): the card's and the org roll-up's pure rules,
// so they run under tsx --test. Words: §design.copy-deck/project-costs.

import { cardKindOf, COST_CARD_KINDS, type CostCardKind, type CostKind, type CostModelRow, type CostStarter, type CostTokens, type ProjectCost } from "../../shared/costs";
import { shortDate } from "./format";
import { tokens } from "./project-overseer-view";

// ---- figures ----

/** Dollars as the copy deck writes them: `$1,240.00`, `$0.08`, `<$0.01`, `$0.00`. */
export function usd(n: number): string {
  const s = !(n > 0) ? "$0.00" : n < 0.005 ? "<$0.01" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return s;
}

/** The token kinds the model table shows; `cacheWrite` is both TTLs. */
export const TOKEN_KINDS = ["input", "output", "cacheRead", "cacheWrite"] as const satisfies readonly (keyof CostTokens)[];


// ---- grouping ----

/** The card's kinds in the scope's order (the wire's, both coding kinds one row). */
export const KIND_ORDER = COST_CARD_KINDS;
export const KIND_LABEL: Record<CostCardKind, string> = {
  overseer: "Overseer conversations",
  gathering: "Gathering and offers",
  settle: "Settling",
  wrapup: "Wrap-ups",
  coding: "Coding sessions",
  workers: "Their workers",
  reconcile: "Reconciler",
};

// "sova" is the reconciler's automatic runs.
const STARTER_ORDER: readonly CostStarter[] = ["overseer", "operator", "sova"];
const STARTER_WORDS: Record<CostStarter, string> = { overseer: "the overseer", operator: "you", sova: "Sova on its own" };

/** "Started by the overseer $8.10 · by you $4.02 · by Sova on its own $0.36", as parts (each amount is its own figure): only starters with a cost, in a fixed order; empty when none has. */
export function starterParts(rows: readonly { by: CostStarter; usd: number }[]): { words: string; usd: string }[] {
  return rows
    .filter((r) => r.usd > 0)
    .sort((a, b) => STARTER_ORDER.indexOf(a.by) - STARTER_ORDER.indexOf(b.by))
    .map((r, i) => ({ words: `${i === 0 ? "Started by" : "by"} ${STARTER_WORDS[r.by]}`, usd: usd(r.usd) }));
}

/** A top session's second line: "Coding sessions · started by you". */
export function topMeta(kind: CostKind, by: CostStarter): string {
  return `${KIND_LABEL[cardKindOf(kind)]} · ${by === "sova" ? "run by Sova" : `started by ${STARTER_WORDS[by]}`}`;
}

const sum = (t: CostTokens) => t.input + t.output + t.cacheRead + t.cacheWrite;

/** Models most expensive first, priced before free before unpriced; ties by tokens, then name. An empty row goes. */
export function modelRows(rows: readonly CostModelRow[]): CostModelRow[] {
  const rank = { priced: 0, free: 1, unpriced: 2 } as const;
  return rows
    .filter((r) => r.usd > 0 || sum(r.tokens) > 0)
    .sort((a, b) => rank[a.status] - rank[b.status] || b.usd - a.usd || sum(b.tokens) - sum(a.tokens) || a.model.localeCompare(b.model));
}


/** What a model's money cells say: dollars, or `local`, or `unpriced`. */
export const moneyWord = (r: Pick<CostModelRow, "status" | "why">): "usd" | "local" | "unpriced" => (r.status === "unpriced" ? "unpriced" : r.status === "free" && r.why === "local" ? "local" : "usd");

// ---- notes ----

export interface CostNote {
  text: string;
  title?: string;
}

/** The card's notes, one line each and only when true, then the 2 always said (the prices' date when known). */
export function costNotes(c: Pick<ProjectCost, "unpriced" | "notOnHost" | "prices">, now = Date.now()): CostNote[] {
  const out: CostNote[] = [];
  for (const u of c.unpriced) {
    if (u.model === "unknown") out.push({ text: `${tokens(u.tokens)} tokens counted before costs have no model recorded, so they aren't in the total.` });
    else out.push({ text: `${tokens(u.tokens)} tokens on ${u.model} have no API price, so they aren't in the total.`, title: u.why || undefined });
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
