// The Agents page's Costs tab (#/agents/costs): its filter and its address, and the pure shaping
// of what the usage helper answers. Nothing here touches the DOM, so it runs under the unit tests.

import { type CostTokens, USAGE_KIND_ORDER, type UsageCosts, type UsageKind, type UsageProjectRow, type UsageSpend } from "../../shared/usage/wire";

/** The range chips. */
export type CostRange = "7d" | "30d" | "all";
export const COST_RANGES: readonly { id: CostRange; label: string }[] = [
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "all", label: "All" },
];
export const DEFAULT_COST_RANGE: CostRange = "30d";

/** What the tab shows: a range, and the providers and models picked (empty = every one). A model
    is `<provider>/<model>`, so the same model id under two providers is two choices. */
export interface CostsQuery {
  range: CostRange;
  providers: readonly string[];
  models: readonly string[];
}
export const DEFAULT_COSTS_QUERY: CostsQuery = { range: DEFAULT_COST_RANGE, providers: [], models: [] };

/** A model choice's id. */
export const modelKey = (provider: string, model: string) => `${provider}/${model}`;
/** The provider a model key belongs to (provider ids carry no slash; model ids may). */
export const providerOfKey = (key: string) => key.slice(0, Math.max(0, key.indexOf("/")));

const isRange = (v: string | null): v is CostRange => v === "7d" || v === "30d" || v === "all";
/** Distinct, non-empty, sorted: one selection has one spelling, so one address. */
const tidy = (list: Iterable<string>) => [...new Set([...list].map((s) => s.trim()).filter(Boolean))].sort();

/**
 * The query from the part of the hash after `?` (with or without the `?`). Unknown keys and a bad
 * range fall to the defaults; a model whose provider isn't among the picked providers is dropped,
 * since its choice isn't on screen to clear it.
 */
export function parseCostsQuery(search: string): CostsQuery {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const range = p.get("range");
  const providers = tidy(p.getAll("provider"));
  const models = tidy(p.getAll("model")).filter((m) => providerOfKey(m) && (!providers.length || providers.includes(providerOfKey(m))));
  return { range: isRange(range) ? range : DEFAULT_COST_RANGE, providers, models };
}

/** The query as URL parameters, defaults left out: `range=7d&provider=a&model=a%2Fm`. */
export function costsSearch(q: CostsQuery): string {
  const p = new URLSearchParams();
  if (q.range !== DEFAULT_COST_RANGE) p.set("range", q.range);
  for (const v of tidy(q.providers)) p.append("provider", v);
  for (const v of tidy(q.models)) p.append("model", v);
  return p.toString();
}

/** The tab's address: `#/agents/costs`, and `?…` when something differs from the defaults. */
export function costsHref(q: CostsQuery = DEFAULT_COSTS_QUERY): string {
  const s = costsSearch(q);
  return s ? `#/agents/costs?${s}` : "#/agents/costs";
}

/** The Costs tab's query if `hash` is its address, else null. `#/agents/costs/…` is not it. */
export function costsRouteFromHash(hash: string): CostsQuery | null {
  const m = /^#\/agents\/costs(?:\?(.*))?$/.exec(hash);
  return m ? parseCostsQuery(m[1] ?? "") : null;
}

/** The request's parameters for the usage helper: the address's, the range always said, and the
    zone whose local days the chart counts. */
export function costsApiSearch(q: CostsQuery, tz: string): string {
  const p = new URLSearchParams(costsSearch(q));
  if (!p.has("range")) p.set("range", q.range);
  p.set("tz", tz);
  return p.toString();
}

/** Turn a provider on or off. Off drops its picked models too: their choices leave the list. */
export function toggleProvider(q: CostsQuery, provider: string): CostsQuery {
  const on = q.providers.includes(provider);
  const providers = on ? q.providers.filter((p) => p !== provider) : tidy([...q.providers, provider]);
  // Picking the first provider narrows the list to it: models of the others go.
  const models = q.models.filter((m) => (providers.length ? providers.includes(providerOfKey(m)) : true));
  return { ...q, providers, models };
}

/** Turn a model (its key) on or off. */
export function toggleModel(q: CostsQuery, key: string): CostsQuery {
  const models = q.models.includes(key) ? q.models.filter((m) => m !== key) : tidy([...q.models, key]);
  return { ...q, models };
}

/** What the range-wide answer offers to pick from: each provider and its models. */
export interface CostChoice {
  provider: string;
  models: readonly string[];
}

/** The model choices the picker lists: every model, or only the picked providers' ones. A picked
    model the answer no longer lists stays, so it can still be cleared. Sorted by provider, then model. */
export function modelChoices(choices: readonly CostChoice[], q: Pick<CostsQuery, "providers" | "models">): { key: string; provider: string; model: string }[] {
  const keep = (p: string) => !q.providers.length || q.providers.includes(p);
  const keys = new Set<string>();
  for (const c of choices) if (keep(c.provider)) for (const m of c.models) keys.add(modelKey(c.provider, m));
  for (const k of q.models) keys.add(k);
  return [...keys].sort().map((key) => {
    const provider = providerOfKey(key);
    return { key, provider, model: key.slice(provider.length + 1) };
  });
}

/** The provider choices: the answer's, plus any picked one it no longer lists. Sorted. */
export function providerChoices(choices: readonly CostChoice[], q: Pick<CostsQuery, "providers">): string[] {
  return tidy([...choices.map((c) => c.provider), ...q.providers]);
}

/** A multi-select's trigger word: "All providers", the one picked, or "3 providers". */
export function pickedLabel(picked: readonly string[], all: string, one: string, many: string, name: (id: string) => string = (id) => id): string {
  if (!picked.length) return all;
  if (picked.length === 1) return name(picked[0]!);
  return `${picked.length} ${many}`;
}

// ---- the answer ----

/** The browser's zone, which decides the helper's local days; UTC when the browser won't say. */
export const browserZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/** The answer's facets as one choice per provider. */
export function facetChoices(facets: UsageCosts["facets"] | undefined): CostChoice[] {
  if (!facets) return [];
  const by = new Map<string, string[]>(facets.providers.map((p) => [p, []]));
  for (const m of facets.models) {
    const list = by.get(m.provider) ?? [];
    list.push(m.model);
    by.set(m.provider, list);
  }
  return [...by].map(([provider, models]) => ({ provider, models }));
}

/** Every token of a count (`cacheWrite` already holds both TTLs). */
export const tokenSum = (t: CostTokens) => t.input + t.output + t.cacheRead + t.cacheWrite;
/** Cache read and write together, the model table's one Cache column. */
export const cacheSum = (t: CostTokens) => t.cacheRead + t.cacheWrite;

/** Most expensive first; ties by tokens, then by `name`, so two equal rows never swap between polls. */
export function byCost<T extends Pick<UsageSpend, "usd" | "tokens">>(rows: readonly T[], name: (r: T) => string): T[] {
  return [...rows].sort((a, b) => b.usd - a.usd || tokenSum(b.tokens) - tokenSum(a.tokens) || name(a).localeCompare(name(b)));
}

const PROVIDER_NAMES: Record<string, string> = {
  "claude-code-cli": "Claude Code",
  anthropic: "Anthropic",
  "openai-codex": "Codex",
  openai: "OpenAI",
  zai: "z.ai",
  "ollama-cloud": "Ollama Cloud",
  ollama: "Ollama",
  deepseek: "DeepSeek",
  google: "Google",
  openrouter: "OpenRouter",
  jev: "Jev",
};
/** A provider id as the tab says it; an unknown one as itself. */
export const providerName = (id: string) => PROVIDER_NAMES[id] ?? id;

const KIND_NAMES: Record<UsageKind, string> = {
  main: "Main sessions",
  overseer: "Overseer",
  worker: "Workers",
  oneshot: "One-shots",
};
/** A kind of spend as the tab says it. */
export const kindName = (kind: UsageKind) => KIND_NAMES[kind] ?? kind;
const KIND_ONE: Record<UsageKind, string> = { main: "Main session", overseer: "Overseer", worker: "Worker", oneshot: "One-shot" };
/** One session's kind, for its line under a top session. */
export const kindOne = (kind: UsageKind) => KIND_ONE[kind] ?? kind;

/** How a sum's cost reads: "unpriced" when none of its tokens has a price, else dollars. */
export const costWord = (s: Pick<UsageSpend, "usd" | "tokens" | "unpricedTokens">): "unpriced" | "usd" =>
  s.usd === 0 && s.unpricedTokens > 0 && s.unpricedTokens >= tokenSum(s.tokens) ? "unpriced" : "usd";
/** Kind rows in the ledger's order, never by size: the same kinds sit in the same places. */
export const kindRows = <T extends { kind: UsageKind }>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => USAGE_KIND_ORDER.indexOf(a.kind) - USAGE_KIND_ORDER.indexOf(b.kind));

/** A project row's name: its project's (`name` looks it up), else the last part of its folder, else
    "No project" for calls with neither (Sova's own decisions). */
export function projectName(row: Pick<UsageProjectRow, "project" | "cwd">, name: (id: string) => string | undefined = () => undefined): string {
  if (row.project) return name(row.project) ?? row.project;
  if (!row.cwd) return "No project";
  const parts = row.cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? row.cwd;
}

/** A date as the footer says it: `Oct 4`, or `Oct 4, 2025` in another year; null for none. */
export function priceDate(iso: string | null | undefined, now: number): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

/** The last change a price pull found, in words: "2 prices changed, 1 model added". Null for none. */
export function priceChangeWords(change: { added: readonly string[]; changed: readonly string[] } | null | undefined): string | null {
  if (!change) return null;
  const parts: string[] = [];
  const n = change.changed.length;
  const a = change.added.length;
  if (n) parts.push(`${n} ${n === 1 ? "price" : "prices"} changed`);
  if (a) parts.push(`${a} ${a === 1 ? "model" : "models"} added`);
  return parts.length ? parts.join(", ") : null;
}

// ---- the daily chart ----

/** `YYYY-MM-DD` for a local date. */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** A day key's local midnight. */
const dayDate = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** One bar: a day, or a week starting Monday when the range is long. */
export interface CostBar {
  /** The bar's first day, `YYYY-MM-DD`. */
  from: string;
  /** Its last day (the same as `from` for a day bar). */
  to: string;
  usd: number;
}

/** Past this many days a bar is a week, so the chart stays readable on a phone. */
export const DAY_BARS_MAX = 62;

/**
 * The chart's bars, oldest first: every day of the range, a day with nothing spent as a zero bar
 * (a gap is a fact), up to and including `today`. 7d and 30d end today and count back; All starts
 * at the first day with spend. Over DAY_BARS_MAX days the bars are weeks starting Monday, the
 * first and last ones partial.
 */
export function costBars(daily: readonly { day: string; usd: number }[], range: CostRange, today: string): CostBar[] {
  const by = new Map<string, number>();
  for (const d of daily) by.set(d.day, (by.get(d.day) ?? 0) + d.usd);
  const end = dayDate(today);
  const first = [...by.keys()].sort()[0];
  const start = range === "all" ? (first && first <= today ? dayDate(first) : end) : addDays(end, -(range === "7d" ? 7 : 30) + 1);
  const days: CostBar[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const k = dayKey(d);
    days.push({ from: k, to: k, usd: by.get(k) ?? 0 });
  }
  if (days.length <= DAY_BARS_MAX) return days;
  const weeks: CostBar[] = [];
  for (const d of days) {
    const monday = dayDate(d.from).getDay() === 1;
    const last = weeks[weeks.length - 1];
    if (last && !monday) {
      last.to = d.to;
      last.usd += d.usd;
    } else weeks.push({ ...d });
  }
  return weeks;
}

/** A bar's height as a share of the tallest, 0..1; every bar 0 when nothing was spent. */
export function barShare(bar: CostBar, bars: readonly CostBar[]): number {
  const max = Math.max(0, ...bars.map((b) => b.usd));
  return max > 0 ? bar.usd / max : 0;
}
