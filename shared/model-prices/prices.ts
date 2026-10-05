/**
 * API prices for the models Sova runs (§app.project-costs/pricing). Pure: no fs, no network, no
 * imports, so the server, `scripts/prices-update.mjs` and the tests share one rule.
 *
 * The only price source is models.dev (https://models.dev/api.json). `aliases.json` (hand-kept)
 * maps a Sova model ref onto a models.dev `provider/model` key; a ref with no mapping, or whose
 * key models.dev doesn't price, is "unpriced": its tokens still count, it gets no dollars, and it
 * never borrows a sibling's price. Rates are USD per 1M tokens. A key keeps dated periods: when a
 * refresh sees a changed price it closes the old period and opens a new one, so an older message
 * keeps the price that was in force at its timestamp.
 */

/** USD per 1M tokens. A missing rate means models.dev lists none. */
export interface Rates {
  input: number;
  output: number;
  cacheRead?: number;
  /** A 5-minute cache write, or the only cache write a provider has. */
  cacheWrite5m?: number;
  /** A 1-hour cache write (Anthropic only; derived from input by aliases.json `derive`). */
  cacheWrite1h?: number;
}

/** Above `inputAbove` request-input tokens, the whole request is priced at `rates`. */
export interface Tier {
  inputAbove: number;
  rates: Rates;
}

export interface PricePeriod {
  /** ISO time the period starts; null for the first known price (it also prices older messages). */
  from: string | null;
  /** ISO time the period ends (exclusive); null while current. */
  until: string | null;
  rates: Rates;
  tiers?: Tier[];
}

export interface ModelPrice {
  name?: string;
  periods: PricePeriod[];
}

export interface PriceTable {
  version: 1;
  source: "models.dev";
  /** Last successful fetch (ISO), or null for a table never fetched. */
  fetchedAt: string | null;
  /** When the prices last changed (ISO); the table's version for audit. */
  changedAt: string | null;
  /** What the last change was: the keys a download added or repriced at `changedAt`. */
  lastChange?: MergeReport;
  /** `provider/model` (models.dev ids) → its dated prices. */
  models: Record<string, ModelPrice>;
}

/** One entry of aliases.json `models`: a target key, $0, or a stated reason for no price. */
export interface AliasTarget {
  /** Applies to messages before this ISO time (exclusive); absent = no end. */
  until?: string;
  to?: string;
  free?: "local" | "synthetic";
  unpriced?: string;
}

export interface Aliases {
  /** Per Sova provider: map `<provider>/<id>` onto `<to>/<id>`, or price everything at $0. */
  providers: Record<string, { to?: string; local?: true }>;
  /** Explicit refs (`provider/id`, or `* /id` for any provider), each one target or dated targets in order. */
  models: Record<string, AliasTarget | AliasTarget[]>;
  /** Per models.dev provider: rates models.dev doesn't list, as multiples of the input rate. */
  derive?: Record<string, Partial<Record<keyof Rates, { input: number }>>>;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export type TokenKind = keyof TokenUsage;
export const TOKEN_KINDS: readonly TokenKind[] = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"];

export type ModelRef = { provider: string; model: string; responseModel?: string };

export type Resolved = { key: string } | { free: "local" | "synthetic" } | { unpriced: string };

export type PricedUsage =
  | {
      status: "priced";
      key: string;
      /** The `from` of the period used (null = the first known price). */
      period: string | null;
      /** The tier threshold applied, or null for the base rates. */
      tier: number | null;
      usd: Record<TokenKind, number> & { total: number };
      /** Token kinds that had tokens but no listed rate (priced at $0). */
      missing?: TokenKind[];
    }
  | { status: "free"; why: "local" | "synthetic" }
  | { status: "unpriced"; ref: string; why: string };

const toMs = (at: number | string): number => (typeof at === "number" ? at : Date.parse(at));

/** `opus[1m]` → `opus`: the 1M window is a request option, not a model. */
const baseId = (id: string) => id.replace(/\[1m\]$/i, "");

function pickTarget(entry: AliasTarget | AliasTarget[], atMs: number): AliasTarget | null {
  const list = Array.isArray(entry) ? entry : [entry];
  return list.find((t) => t.until === undefined || atMs < Date.parse(t.until)) ?? null;
}

/**
 * Which models.dev key prices `ref` at `at`. The recorded `responseModel` (the model that
 * actually answered) beats the alias, so a dated alias only covers messages that lack it.
 */
export function resolvePriceRef(table: PriceTable, aliases: Aliases, ref: ModelRef, at: number | string): Resolved {
  const atMs = toMs(at);
  const provider = ref.provider;
  const rule = aliases.providers[provider];
  if (rule?.local) return { free: "local" };
  const lookup = (id: string): Resolved | null => {
    const entry = aliases.models[`${provider}/${id}`] ?? aliases.models[`*/${id}`];
    if (entry) {
      const t = pickTarget(entry, atMs);
      if (!t) return null;
      if (t.free) return { free: t.free };
      if (t.unpriced) return { unpriced: t.unpriced };
      if (t.to) return table.models[t.to] ? { key: t.to } : { unpriced: `models.dev lists no price for ${t.to}` };
      return null;
    }
    if (!rule?.to) return null;
    const direct = `${rule.to}/${id}`;
    if (table.models[direct]) return { key: direct };
    const undated = `${rule.to}/${id.replace(/-\d{8}$/, "")}`;
    if (table.models[undated]) return { key: undated };
    return null;
  };
  if (ref.responseModel) {
    const hit = lookup(baseId(ref.responseModel));
    if (hit && !("unpriced" in hit)) return hit;
  }
  const id = baseId(ref.model);
  const hit = lookup(id);
  if (hit) return hit;
  if (!rule) return { unpriced: `no price mapping for provider ${provider}` };
  return { unpriced: `models.dev lists no price for ${rule.to}/${id}` };
}

/** The period in force at `atMs`: from ≤ at < until; before the first period, the first. */
export function periodAt(model: ModelPrice, atMs: number): PricePeriod | null {
  for (const p of model.periods) {
    const from = p.from === null ? -Infinity : Date.parse(p.from);
    const until = p.until === null ? Infinity : Date.parse(p.until);
    if (atMs >= from && atMs < until) return p;
  }
  return model.periods[0] ?? null;
}

const RATE_OF: Record<TokenKind, keyof Rates> = {
  input: "input",
  output: "output",
  cacheRead: "cacheRead",
  cacheWrite5m: "cacheWrite5m",
  cacheWrite1h: "cacheWrite1h",
};

/** A kind's rate: a tier falls back to base rates it doesn't list; a 1h write with no 1h rate is a plain cache write. */
function rateFor(kind: TokenKind, rates: Rates, base: Rates): number | undefined {
  const own = (r: Rates) => (kind === "cacheWrite1h" ? (r.cacheWrite1h ?? r.cacheWrite5m) : r[RATE_OF[kind]]);
  return own(rates) ?? own(base);
}

export interface PriceOptions {
  /**
   * The context tier its calls were in (a tier's `inputAbove`, or null for the base rates). A sum of
   * calls (a usage rollup row) passes the band its calls were sorted into one by one, since the
   * sum's request input says nothing about any one request's.
   */
  tier?: number | null;
}

/** Price one usage record at its timestamp. */
export function priceUsage(table: PriceTable, aliases: Aliases, ref: ModelRef, usage: TokenUsage, at: number | string, opts: PriceOptions = {}): PricedUsage {
  const atMs = toMs(at);
  const r = resolvePriceRef(table, aliases, ref, atMs);
  if ("free" in r) return { status: "free", why: r.free };
  if ("unpriced" in r) return { status: "unpriced", ref: `${ref.provider}/${ref.model}`, why: r.unpriced };
  const period = periodAt(table.models[r.key]!, atMs);
  if (!period) return { status: "unpriced", ref: `${ref.provider}/${ref.model}`, why: `models.dev lists no price for ${r.key}` };
  let tier: Tier | null = null;
  if (opts.tier !== undefined) tier = (opts.tier !== null && period.tiers?.find((t) => t.inputAbove === opts.tier)) || null;
  else {
    const requestInput = usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h;
    for (const t of period.tiers ?? []) if (requestInput > t.inputAbove && (!tier || t.inputAbove > tier.inputAbove)) tier = t;
  }
  const rates = tier?.rates ?? period.rates;
  const usd = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, total: 0 };
  const missing: TokenKind[] = [];
  for (const kind of TOKEN_KINDS) {
    const tokens = usage[kind] || 0;
    if (!tokens) continue;
    const rate = rateFor(kind, rates, period.rates);
    if (rate === undefined) {
      missing.push(kind);
      continue;
    }
    usd[kind] = (tokens * rate) / 1e6;
    usd.total += usd[kind];
  }
  return { status: "priced", key: r.key, period: period.from, tier: tier?.inputAbove ?? null, usd, ...(missing.length ? { missing } : {}) };
}

// ---- models.dev → table ---------------------------------------------------------------------

type DevCost = Record<string, unknown> & { tiers?: unknown; context_over_200k?: unknown };

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

function devRates(c: Record<string, unknown>, derive: Partial<Record<keyof Rates, { input: number }>> | undefined): Rates | null {
  const input = num(c.input);
  const output = num(c.output);
  if (input === undefined || output === undefined) return null;
  const rates: Rates = { input, output };
  const cacheRead = num(c.cache_read);
  const cacheWrite = num(c.cache_write);
  if (cacheRead !== undefined) rates.cacheRead = cacheRead;
  if (cacheWrite !== undefined) rates.cacheWrite5m = cacheWrite;
  for (const [k, rule] of Object.entries(derive ?? {}) as [keyof Rates, { input: number }][]) {
    if (rates[k] === undefined && rule) rates[k] = +(input * rule.input).toFixed(6);
  }
  return rates;
}

/** The priced models of the providers `aliases` points at, from a models.dev api.json body. */
export function normalizeModelsDev(api: unknown, aliases: Aliases): Record<string, { name?: string; rates: Rates; tiers?: Tier[] }> {
  if (typeof api !== "object" || api === null) throw new Error("models.dev: not an object");
  const wanted = new Set<string>();
  for (const p of Object.values(aliases.providers)) if (p.to) wanted.add(p.to);
  for (const e of Object.values(aliases.models)) for (const t of Array.isArray(e) ? e : [e]) if (t.to) wanted.add(t.to.split("/")[0]!);
  const out: Record<string, { name?: string; rates: Rates; tiers?: Tier[] }> = {};
  for (const provider of [...wanted].sort()) {
    const models = (api as Record<string, { models?: Record<string, { name?: unknown; cost?: DevCost }> }>)[provider]?.models;
    if (!models || typeof models !== "object") throw new Error(`models.dev: provider ${provider} missing`);
    for (const id of Object.keys(models).sort()) {
      const m = models[id]!;
      if (!m.cost || typeof m.cost !== "object") continue;
      const derive = aliases.derive?.[provider];
      const rates = devRates(m.cost, derive);
      if (!rates) continue;
      const tiers: Tier[] = [];
      if (Array.isArray(m.cost.tiers)) {
        for (const t of m.cost.tiers as Record<string, unknown>[]) {
          const spec = t?.tier as { type?: unknown; size?: unknown } | undefined;
          const size = num(spec?.size);
          const tr = t && devRates({ ...m.cost, ...t }, derive);
          if (spec?.type === "context" && size !== undefined && tr) tiers.push({ inputAbove: size, rates: tr });
        }
      } else if (m.cost.context_over_200k && typeof m.cost.context_over_200k === "object") {
        const tr = devRates({ ...m.cost, ...(m.cost.context_over_200k as Record<string, unknown>) }, derive);
        if (tr) tiers.push({ inputAbove: 200_000, rates: tr });
      }
      out[`${provider}/${id}`] = { ...(typeof m.name === "string" ? { name: m.name } : {}), rates, ...(tiers.length ? { tiers } : {}) };
    }
  }
  if (Object.keys(out).length === 0) throw new Error("models.dev: no priced models");
  return out;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface MergeReport {
  added: string[];
  changed: string[];
}

/**
 * Fold a fresh fetch into `base` at `at` (ISO). A new key starts with `from: null`; a changed
 * price closes the current period at `at` and opens a new one; a key models.dev dropped keeps its
 * history. Earlier periods are never rewritten, so hand-entered dates survive every download. Returns a new table; `base` is untouched.
 */
export function mergeFetched(base: PriceTable, fetched: ReturnType<typeof normalizeModelsDev>, at: string): { table: PriceTable; report: MergeReport } {
  const models: Record<string, ModelPrice> = structuredClone(base.models);
  const report: MergeReport = { added: [], changed: [] };
  for (const key of Object.keys(fetched).sort()) {
    const f = fetched[key]!;
    const next: PricePeriod = { from: null, until: null, rates: f.rates, ...(f.tiers ? { tiers: f.tiers } : {}) };
    const cur = models[key];
    if (!cur || cur.periods.length === 0) {
      models[key] = { ...(f.name ? { name: f.name } : {}), periods: [next] };
      report.added.push(key);
      continue;
    }
    if (f.name) cur.name = f.name;
    const last = cur.periods[cur.periods.length - 1]!;
    if (same(last.rates, f.rates) && same(last.tiers ?? [], f.tiers ?? [])) continue;
    last.until = at;
    cur.periods.push({ ...next, from: at });
    report.changed.push(key);
  }
  const sorted: Record<string, ModelPrice> = {};
  for (const k of Object.keys(models).sort()) sorted[k] = models[k]!;
  const dirty = report.added.length > 0 || report.changed.length > 0;
  const lastChange = dirty ? report : base.lastChange;
  return { table: { version: 1, source: "models.dev", fetchedAt: at, changedAt: dirty ? at : base.changedAt, ...(lastChange ? { lastChange } : {}), models: sorted }, report };
}

/** A table read from disk, or null when its shape is wrong (a corrupt cache falls back to the seed). */
export function parseTable(raw: unknown): PriceTable | null {
  if (typeof raw !== "object" || raw === null) return null;
  const t = raw as Partial<PriceTable>;
  if (t.version !== 1 || t.source !== "models.dev" || typeof t.models !== "object" || t.models === null) return null;
  for (const m of Object.values(t.models)) {
    if (!m || !Array.isArray(m.periods) || m.periods.length === 0) return null;
    for (const p of m.periods) if (!p?.rates || num(p.rates.input) === undefined || num(p.rates.output) === undefined) return null;
  }
  const lc = t.lastChange;
  const lastChange = lc && Array.isArray(lc.added) && Array.isArray(lc.changed) ? { lastChange: { added: lc.added, changed: lc.changed } } : {};
  return { version: 1, source: "models.dev", fetchedAt: t.fetchedAt ?? null, changedAt: t.changedAt ?? null, ...lastChange, models: t.models };
}

export const EMPTY_TABLE: PriceTable = { version: 1, source: "models.dev", fetchedAt: null, changedAt: null, models: {} };
