// Project costs at API prices (§app/project-costs): the card's and the org roll-up's pure rules,
// so they run under tsx --test. Words: §design.copy-deck/project-costs.

import { tokens } from "./project-overseer-view";
import { shortDate } from "./format";

// ---- STUB wire shape until shared/costs.ts lands; replaced by an import ----

export type CostKind = "overseer" | "gathering" | "settle" | "wrapup" | "coding" | "workers" | "reconcile";
export type CostBy = "overseer" | "operator" | "sova";
export interface CostTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export interface ModelCost {
  model: string;
  name?: string;
  local?: true;
  unpriced?: string;
  tokens: CostTokens;
  usd: CostTokens;
  totalUsd: number;
  estimate: boolean;
}
export interface ProjectCost {
  totalUsd: number;
  estimate: boolean;
  asOf: string;
  pricesAsOf: string | null;
  sessions: number;
  byStarter: { by: CostBy; usd: number; estimate: boolean }[];
  byKind: { kind: CostKind; usd: number; estimate: boolean }[];
  byModel: ModelCost[];
  top: { title: string; path: string | null; kind: CostKind; by: CostBy; usd: number; estimate: boolean }[];
  unpriced: { model: string; tokens: number; why: string }[];
  legacyTokens: number;
  notOnHost: { sessions: number; countedAt: string | null } | null;
}
export interface OrgCosts {
  totalUsd: number;
  estimate: boolean;
  projects: { projectId: string; totalUsd: number; estimate: boolean }[];
}

// ---- figures ----

/** Dollars as the copy deck writes them: `$1,240.00`, `$0.08`, `<$0.01`, `$0.00`; `≈` before one that includes an estimate. */
export function usd(n: number, estimate = false): string {
  const s = !(n > 0) ? "$0.00" : n < 0.005 ? "<$0.01" : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return estimate ? `≈${s}` : s;
}
/** The `title` on a figure written with `≈`. */
export const ESTIMATE_TITLE = "Partly an estimate: see the note below.";

export const TOKEN_KINDS: readonly (keyof CostTokens)[] = ["input", "output", "cacheRead", "cacheWrite"];

// ---- grouping ----

export const KIND_ORDER: readonly CostKind[] = ["overseer", "gathering", "settle", "wrapup", "coding", "workers", "reconcile"];
export const KIND_LABEL: Record<CostKind, string> = {
  overseer: "Overseer conversations",
  gathering: "Gathering and offers",
  settle: "Settling",
  wrapup: "Wrap-ups",
  coding: "Coding sessions",
  workers: "Their workers",
  reconcile: "Reconciler",
};

/** The kinds with a cost, in the scope's order (never by size: the order is how the card reads). */
export const kindRows = <T extends { kind: CostKind; usd: number }>(rows: readonly T[]): T[] =>
  KIND_ORDER.flatMap((k) => rows.filter((r) => r.kind === k && r.usd > 0));

const STARTER_ORDER: readonly CostBy[] = ["overseer", "operator", "sova"];
const STARTER_WORDS: Record<CostBy, string> = { overseer: "the overseer", operator: "you", sova: "Sova on its own" };

/** "Started by the overseer $8.10 · by you $4.02 · by Sova on its own $0.36": only starters with a cost; null when none has. */
export function starterLine(rows: readonly { by: CostBy; usd: number; estimate: boolean }[]): string | null {
  const parts = STARTER_ORDER.flatMap((by) => rows.filter((r) => r.by === by && r.usd > 0)).map((r) => `by ${STARTER_WORDS[r.by]} ${usd(r.usd, r.estimate)}`);
  return parts.length ? `Started ${parts.join(" · ")}` : null;
}

/** A top session's second line: "Coding sessions · started by you". */
export function topMeta(kind: CostKind, by: CostBy): string {
  return `${KIND_LABEL[kind]} · ${by === "sova" ? "run by Sova" : `started by ${STARTER_WORDS[by]}`}`;
}

/** Models most expensive first, priced before local before unpriced; ties by tokens, then name. */
export function modelRows(rows: readonly ModelCost[]): ModelCost[] {
  const rank = (r: ModelCost) => (r.unpriced !== undefined ? 2 : r.local ? 1 : 0);
  const sum = (t: CostTokens) => t.input + t.output + t.cacheRead + t.cacheWrite;
  return rows
    .filter((r) => r.totalUsd > 0 || sum(r.tokens) > 0)
    .sort((a, b) => rank(a) - rank(b) || b.totalUsd - a.totalUsd || sum(b.tokens) - sum(a.tokens) || a.model.localeCompare(b.model));
}

/** The `All models` row: each column summed (an unpriced model adds tokens, never dollars). */
export function allModels(rows: readonly ModelCost[]): { tokens: CostTokens; usd: CostTokens; totalUsd: number; estimate: boolean } {
  const tokens: CostTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const dollars: CostTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let totalUsd = 0;
  for (const r of rows) {
    for (const k of TOKEN_KINDS) {
      tokens[k] += r.tokens[k];
      if (r.unpriced === undefined) dollars[k] += r.usd[k];
    }
    if (r.unpriced === undefined) totalUsd += r.totalUsd;
  }
  return { tokens, usd: dollars, totalUsd, estimate: rows.some((r) => r.estimate) };
}

// ---- notes ----

export interface CostNote {
  text: string;
  title?: string;
}

/** The card's notes, one line each and only when true, then the 2 always said. */
export function costNotes(c: Pick<ProjectCost, "unpriced" | "legacyTokens" | "estimate" | "notOnHost" | "pricesAsOf">, now = Date.now()): CostNote[] {
  const out: CostNote[] = c.unpriced.map((u) => ({ text: `${tokens(u.tokens)} tokens on ${u.model} have no API price, so they aren't in the total.`, title: u.why || undefined }));
  if (c.legacyTokens > 0) out.push({ text: `${tokens(c.legacyTokens)} tokens counted before costs have no model recorded, so they aren't in the total.` });
  if (c.estimate) out.push({ text: "≈ Older Claude Code messages didn't record how long their cache was kept, so their cache writes are priced at the 1-hour rate." });
  const off = c.notOnHost;
  if (off && off.sessions > 0) {
    const n = `${off.sessions} ${off.sessions === 1 ? "session isn't" : "sessions aren't"} on this host: `;
    out.push({ text: off.countedAt ? `${n}their cost is as last counted, ${shortDate(Date.parse(off.countedAt), now)}.` : `${n}their cost is as last counted.` });
  }
  out.push({ text: "Not counted: topic summaries, image descriptions, and Sova's own side calls." });
  if (c.pricesAsOf) out.push({ text: `Prices from models.dev, as of ${shortDate(Date.parse(c.pricesAsOf), now)}.` });
  return out;
}

/** The empty card's line. */
export const emptyLine = (sessions: number): string => (sessions > 0 ? `${sessions} ${sessions === 1 ? "session" : "sessions"} in this project. Nothing spent yet.` : "Nothing spent yet.");
