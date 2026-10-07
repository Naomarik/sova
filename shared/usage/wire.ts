// The usage ledger's wire contract (§app.insights/usage-ledger, §app.insights/cost-history): what
// the browser asks the server, which relays the usage helper's answer unparsed. Types and constants
// only. Every figure here comes from the ledger's records priced by the one priceUsage(…, at); no
// surface computes spend another way. Main listener only: never the share listener, the owner
// page's projection or the overseer's tools (§app.project-costs/privacy).
//
// Routes (all GET unless said; tz = the browser's IANA zone, Intl…resolvedOptions().timeZone,
// which decides local days; an unknown or missing zone reads as UTC):
//   GET  /api/usage/costs?range=7d|30d|all[&provider=<p>]…[&model=<p>/<m>]…&tz=<zone>  -> UsageCosts
//   GET  /api/usage/today?tz=<zone>                                                     -> UsageToday
//   GET  /api/usage/session?sid=<session id>                                            -> UsageSessionSpend
//   POST /api/usage/sessions  body UsageSessionsRequest                                 -> UsageSessionsTotals
//   GET  /api/usage/prices                                                              -> PricesInfo
//   POST /api/usage/prices/refresh  (pulls models.dev now; answers when the pull settles) -> PricesInfo
//   GET  /api/projects/:pid/costs  -> ProjectCost (shared/costs.ts), GET /api/orgs/:id/costs -> OrgCosts:
//        same paths and shapes as before, now answered by the helper from the ledger.
// The helper not running (starting, crashed): 503 `{error: "usage-unavailable"}`; a bad parameter:
// 400 `{error}`. The browser shows its own error state; it never falls back to another count.

import type { CostTokens } from "../costs";

export type { CostTokens };

/** The Costs tab's range: the last 7 or 30 local days (today included), or everything recorded. */
export type UsageRange = "7d" | "30d" | "all";
export const USAGE_RANGES: readonly UsageRange[] = ["7d", "30d", "all"];

/** The ledger's kinds (usage-record.ts UsageKind), in the order tables list them. */
export type UsageKind = "main" | "overseer" | "worker" | "oneshot";
export const USAGE_KIND_ORDER: readonly UsageKind[] = ["main", "overseer", "worker", "oneshot"];

/**
 * A sum of calls at API prices. `usd` adds priced and free calls (free ones add 0); unpriced
 * tokens are in `tokens` and `unpricedTokens` but add no dollars. `usdBy` splits `usd` by token
 * kind (`cacheWrite` includes `cacheWrite1h`'s).
 */
export interface UsageSpend {
  usd: number;
  tokens: CostTokens;
  usdBy: CostTokens;
  /** Records (model calls) summed. */
  calls: number;
  /** Tokens of calls with no price (all kinds). */
  unpricedTokens: number;
}

/** How a model is priced: the price key and name when priced or free; why, when free or unpriced. */
export interface UsagePricing {
  status: "priced" | "free" | "unpriced" | "mixed";
  /** models.dev key (`anthropic/claude-opus-5-5`) of the newest priced call. */
  priceKey?: string;
  /** models.dev's name, when it has one. */
  name?: string;
  /** Why free (`local`, `synthetic`) or unpriced (a sentence). */
  why?: string;
}

/** One provider's row. */
export interface UsageProviderRow extends UsageSpend {
  provider: string;
}

/** One model's row: the recorded `provider/model` (what the filter names), however it was priced. */
export interface UsageModelRow extends UsageSpend, UsagePricing, UsageModelIdentity {
  provider: string;
  model: string;
}

/** How a by-model row was grouped (§app.insights/usage-model-rows): `model` is the model that
    answered (a Claude catalog id); these say what was asked for. */
export interface UsageModelIdentity {
  /** The ids the calls asked for, when any differs from `model`. */
  requested?: string[];
  /** The calls asked for this other model and `model` answered (§app.claude-code-provider/model-identity). */
  asked?: string;
}

export interface UsageKindRow extends UsageSpend {
  kind: UsageKind;
}

/** One project's row: the org project when the calls named one, else the working directory. */
export interface UsageProjectRow extends UsageSpend {
  /** `prj_…` when known (the browser names it from its projects), else null. */
  project: string | null;
  /** The working directory, when no project: null for calls with neither (Sova's own decisions). */
  cwd: string | null;
}

/** One owning session's spend: the calls it owns (its turns, housekeeping and the side calls made for
    it). Its workers are their own rows, so no call is in two rows. */
export interface UsageSessionRow extends UsageSpend {
  /** The owner id as recorded (a pi session id, or a Claude Code worker's Claude session id). */
  sid: string;
  /** The kind of the session itself (`worker` for a worker; never `oneshot`). */
  kind: Exclude<UsageKind, "oneshot">;
  /** A worker's parent session, and its roster id: the browser opens the parent. */
  parent: string | null;
  worker?: string;
  /** The session's working directory and org project, when recorded. */
  cwd: string | null;
  project: string | null;
  /** Its newest call (ms). */
  lastAt: number;
}

/** One local day of the chart. */
export interface UsageDay {
  /** `yyyy-mm-dd` in the request's zone. */
  day: string;
  usd: number;
  tokens: number;
}

/** The price data's standing (§app.insights/cost-history's "Prices as of"). */
export interface PricesInfo {
  source: "models.dev";
  /** The last successful download (ISO), or null when the prices are the seed's, never refreshed here. */
  asOf: string | null;
  /** When a download last found a change (ISO), and what it was (models.dev keys). */
  changedAt: string | null;
  lastChange: { added: string[]; changed: string[] } | null;
  /** A pull is running now. */
  fetching: boolean;
  /** Pulling is on (`SOVA_PRICES_FETCH` not off). */
  enabled: boolean;
  /** The last failed download's message, until one succeeds. */
  error: string | null;
}

/** Which device the figures count: v1 always this one. */
export interface UsageDevice {
  /** `host.json` id, or null before Sova wrote one. */
  id: string | null;
  self: true;
}

/** GET /api/usage/costs: the Costs tab, every section under one range and one filter. */
export interface UsageCosts {
  device: UsageDevice;
  range: UsageRange;
  /** First and last local day covered (`yyyy-mm-dd`); `from` null when nothing is recorded yet. */
  from: string | null;
  to: string;
  /** ms: when the helper answered (its rollup is current to its last read of the files). */
  asOf: number;
  /** The filter as applied (unknown values are kept: they just match nothing). */
  providers: string[];
  models: string[];
  /** Every provider and model with records in the range, ignoring the filter: the filter's choices. */
  facets: { providers: string[]; models: { provider: string; model: string }[] };
  /** Total, and the stats: main = `main` + `overseer`, workers, one-shots. */
  total: UsageSpend;
  main: UsageSpend;
  workers: UsageSpend;
  oneshots: UsageSpend;
  /** Every local day of the range, oldest first, zero days included (`all`: from the first record). */
  daily: UsageDay[];
  byProvider: UsageProviderRow[];
  byModel: UsageModelRow[];
  byKind: UsageKindRow[];
  byProject: UsageProjectRow[];
  /** The 20 costliest owners by their own calls, most expensive first (a worker is its own row). */
  topSessions: UsageSessionRow[];
  prices: PricesInfo;
}

/** GET /api/usage/today: the Agents head's "$ today": this device's spend since local midnight. */
export interface UsageToday {
  device: UsageDevice;
  day: string;
  usd: number;
  tokens: number;
  calls: number;
  asOf: number;
}

/** Where a session's spend came from: its own conversation, side calls made for it, or its workers. */
export type UsageOrigin = "main" | "oneshot" | "worker";

/** One model × origin row of a session's spend. */
export interface UsageSessionModelRow extends UsageSpend, UsagePricing, UsageModelIdentity {
  origin: UsageOrigin;
  provider: string;
  model: string;
}

/** One worker (at any depth) under a session: its own calls (so the list sums to `workers`), and
    `withWorkers`, its own plus its workers' at any depth (what its row in the pane shows). */
export interface UsageWorkerRow extends UsageSpend {
  sid: string;
  parent: string;
  worker?: string;
  withWorkers: UsageSpend;
}

/**
 * GET /api/usage/session?sid=: one session's spend, for its Usage pane and the subagents pane's
 * token chip; a worker's sid gives the worker's own (and its workers'), for its transcript header.
 * Counts every call, on every branch, retries and housekeeping included; a fork counts only its
 * own calls.
 */
export interface UsageSessionSpend {
  sid: string;
  device: UsageDevice;
  asOf: number;
  /** own + oneshots + workers. */
  total: UsageSpend;
  own: UsageSpend;
  oneshots: UsageSpend;
  /** Every worker whose parent chain reaches this session, at any depth. */
  workers: UsageSpend;
  models: UsageSessionModelRow[];
  workerList: UsageWorkerRow[];
  /** The newest call (ms), or null when nothing is recorded for it. */
  lastAt: number | null;
  prices: Pick<PricesInfo, "asOf">;
}

/** POST /api/usage/sessions: totals for many sessions at once (the board's rows). At most 500 sids. */
export interface UsageSessionsRequest {
  sids: string[];
}
export const MAX_USAGE_SESSIONS = 500;
export interface UsageSessionsTotals {
  asOf: number;
  /** Per asked sid with any record: its total and its workers' part. Absent = nothing recorded. */
  sessions: Record<string, { total: UsageSpend; workers: UsageSpend }>;
}
