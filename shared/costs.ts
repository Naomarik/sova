// A project's cost at API prices (§app/project-costs): the wire shape of
// GET /api/projects/:pid/costs and GET /api/orgs/:id/costs (main listener only; never the
// share listener, the owner page's projection or the overseer's tools). Types only.

/** What a session is to the project. Workers are every worker of a coding session, at any depth. */
export type CostKind = "overseer" | "gathering" | "settle" | "wrapup" | "coding-overseer" | "coding-operator" | "workers" | "reconcile";
export const COST_KINDS: readonly CostKind[] = ["overseer", "gathering", "settle", "wrapup", "coding-overseer", "coding-operator", "workers", "reconcile"];

/** Who started it: the project's overseer (its conversations and what it started, with their
    workers and wrap-ups), the operator (their own batons, Start coding session, Reconcile Now, their
    workers), or Sova on its own (the reconciler's automatic runs). */
export type CostStarter = "overseer" | "operator" | "sova";

/** Tokens by kind. `cacheWrite` is both TTLs (5-minute and 1-hour writes); `cacheWrite1h` is the
    1-hour part of it, for the curious. */
export interface CostTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
}

export interface CostRow {
  /** Dollars at API prices; unpriced tokens add nothing. */
  usd: number;
  /** Every token counted, priced or not. */
  tokens: CostTokens;
  /** The dollars by token kind (`cacheWrite` includes `cacheWrite1h`'s). */
  usdBy: CostTokens;
}

export interface CostModelRow extends CostRow {
  /** The price key (`anthropic/claude-opus-5-5`) when priced or free; else the recorded ref (`openai-codex/gpt-5.3-codex-spark`). */
  model: string;
  /** models.dev's name, when it has one. */
  name?: string;
  status: "priced" | "free" | "unpriced";
  /** Why it is free ("local", "synthetic") or unpriced (a sentence). */
  why?: string;
}

export interface CostSession extends CostRow {
  sessionId: string;
  title: string;
  kind: CostKind;
  by: CostStarter;
  /** The session file on this host, for #/s/<path>; null when it is not here (or a reconcile). */
  path: string | null;
  /** Its figures are the ledger's snapshot, not its file (not on this host): when they were counted. */
  countedAt?: string;
}

/** A part of the total that is an estimate. `cache-write-1h-assumed`: Claude Code messages from before
    the bridge split its cache writes, priced at the 1-hour rate. `model-from-alias`: Claude Code
    messages that didn't record the model that answered, priced by the alias's date. */
export interface CostEstimate {
  code: "cache-write-1h-assumed" | "model-from-alias";
  messages: number;
  usd: number;
}

export interface ProjectCost {
  projectId: string;
  totalUsd: number;
  /** When this was counted (ISO). */
  asOf: string;
  /** The earliest counted message (ISO), or null when nothing was spent. */
  since: string | null;
  /** The price table's source and when it was fetched (null: the checked-in seed's date is unknown). */
  prices: { source: "models.dev"; fetchedAt: string | null };
  /** Sessions counted (every kind, workers included; the reconciler counts as one). */
  sessions: number;
  byKind: ({ kind: CostKind } & CostRow)[];
  byStarter: ({ by: CostStarter } & CostRow)[];
  byModel: CostModelRow[];
  /** The top 20 by cost. */
  top: CostSession[];
  /** Tokens with no API price, summed per model: not in the total. `model` is the recorded ref, or
      "unknown" for a legacy count with no model. */
  unpriced: { model: string; tokens: number; why: string }[];
  estimates: CostEstimate[];
  /** Sessions whose files aren't on this host, shown as last counted. */
  notOnHost: { sessions: number; countedAt: string | null } | null;
  /** What the total leaves out, one sentence each. */
  notCounted: string[];
}

export interface OrgCosts {
  orgId: string;
  totalUsd: number;
  asOf: string;
  projects: { projectId: string; totalUsd: number; unpricedTokens: number }[];
}
