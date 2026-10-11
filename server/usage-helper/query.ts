import type { PricedUsage } from "../../shared/model-prices/prices";
import { claudeByAnswer, resolveClaude } from "../../pi-config/extensions/claude-code/catalog.ts";
import {
  USAGE_KIND_ORDER,
  type CostTokens,
  type UsageCosts,
  type UsageDay,
  type UsageDevice,
  type UsageKind,
  type UsageModelRow,
  type UsagePricing,
  type UsageRange,
  type UsageResend,
  type UsageResendReason,
  type UsageSessionModelRow,
  type UsageSessionRow,
  type UsageSessionSpend,
  type UsageSessionsTotals,
  type UsageSpend,
  type UsageToday,
  type UsageWorkerRow,
} from "../../shared/usage/wire";
import type { Ledger, Row } from "./ledger";
import type { PriceBook } from "./price-book";

/**
 * The helper's answers (shared/usage/wire.ts), computed from the ledger's rows and priced at read
 * time with the one priceUsage(…, at): a row is priced at its first call's time in its calls' tier
 * band (a row never spans a period, so that is every call's price).
 */

const DAY_MS = 86_400_000;
const zeroTokens = (): CostTokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });

/** A row's price, cached per table version. */
interface RowPrice {
  v: number;
  n: number;
  usd: number;
  /** input, output, cacheRead, cacheWrite5m, cacheWrite1h dollars. */
  by: [number, number, number, number, number];
  p: PricedUsage;
}

export class Acc {
  usd = 0;
  tokens = zeroTokens();
  usdBy = zeroTokens();
  calls = 0;
  unpricedTokens = 0;
  lastAt = 0;
  add(row: Row, price: RowPrice): void {
    const t = row.t;
    this.tokens.input += t[0];
    this.tokens.output += t[1];
    this.tokens.cacheRead += t[2];
    this.tokens.cacheWrite += t[3] + t[4];
    this.tokens.cacheWrite1h += t[4];
    this.calls += row.n;
    if (row.a1 > this.lastAt) this.lastAt = row.a1;
    if (price.p.status === "unpriced") {
      this.unpricedTokens += t[0] + t[1] + t[2] + t[3] + t[4];
      return;
    }
    this.usd += price.usd;
    this.usdBy.input += price.by[0];
    this.usdBy.output += price.by[1];
    this.usdBy.cacheRead += price.by[2];
    this.usdBy.cacheWrite += price.by[3] + price.by[4];
    this.usdBy.cacheWrite1h += price.by[4];
  }
  merge(o: Acc): void {
    this.usd += o.usd;
    this.calls += o.calls;
    this.unpricedTokens += o.unpricedTokens;
    if (o.lastAt > this.lastAt) this.lastAt = o.lastAt;
    for (const k of ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"] as const) {
      this.tokens[k] += o.tokens[k];
      this.usdBy[k] += o.usdBy[k];
    }
  }
  tokenSum(): number {
    const t = this.tokens;
    return t.input + t.output + t.cacheRead + t.cacheWrite;
  }
  spend(): UsageSpend {
    return { usd: round(this.usd), tokens: { ...this.tokens }, usdBy: roundAll(this.usdBy), calls: this.calls, unpricedTokens: this.unpricedTokens };
  }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
const roundAll = (t: CostTokens): CostTokens => ({
  input: round(t.input),
  output: round(t.output),
  cacheRead: round(t.cacheRead),
  cacheWrite: round(t.cacheWrite),
  cacheWrite1h: round(t.cacheWrite1h),
});

/** Launches whose `how` re-sent the whole history (usage-record.ts RESEND_HOWS). */
const RESEND_HOWS = new Set(["folded", "joined"]);

/**
 * A conversation's Claude launches (§app.insights/usage-resend), from its rows' `launch` dimension
 * (each row holds first calls only, so its call count is its launches): the re-sends priced at the
 * first call's input and cache writes, by why and fallback.
 */
export class Resends {
  recorded = 0;
  resumed = 0;
  private readonly reasons = new Map<string, UsageResendReason>();
  addRow(launch: string, row: Row, price: RowPrice): void {
    const [how = "", why = "", fallback = ""] = launch.split("/");
    this.recorded += row.n;
    if (how === "resumed") this.resumed += row.n;
    if (!RESEND_HOWS.has(how)) return;
    const usd = price.p.status === "priced" ? price.by[0] + price.by[3] + price.by[4] : 0;
    this.add({ why, fallback: fallback || null, launches: row.n, usd, tokens: row.t[0] + row.t[3] + row.t[4] });
  }
  private add(r: UsageResendReason): void {
    const key = `${r.why}/${r.fallback ?? ""}`;
    const cur = this.reasons.get(key);
    if (!cur) this.reasons.set(key, { ...r });
    else {
      cur.launches += r.launches;
      cur.usd += r.usd;
      cur.tokens += r.tokens;
    }
  }
  merge(o: Resends): void {
    this.recorded += o.recorded;
    this.resumed += o.resumed;
    for (const r of o.reasons.values()) this.add(r);
  }
  /** The wire's UsageResend; undefined when no launch was recorded. */
  out(): UsageResend | undefined {
    if (!this.recorded) return undefined;
    const reasons = [...this.reasons.values()].map((r) => ({ ...r, usd: round(r.usd) })).sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);
    return {
      usd: round(reasons.reduce((n, r) => n + r.usd, 0)),
      tokens: reasons.reduce((n, r) => n + r.tokens, 0),
      launches: reasons.reduce((n, r) => n + r.launches, 0),
      resumed: this.resumed,
      recorded: this.recorded,
      reasons,
    };
  }
}

/** How a group's calls were priced: one status, or "mixed"; the newest priced call's key. */
class Pricing {
  status: UsagePricing["status"] | null = null;
  key: string | null = null;
  keyAt = -1;
  why: string | null = null;
  add(p: PricedUsage, at: number): void {
    const s = p.status;
    this.status = this.status === null || this.status === s ? s : "mixed";
    if (p.status === "priced" && at >= this.keyAt) {
      this.key = p.key;
      this.keyAt = at;
    }
    if (p.status === "free") this.why ??= p.why;
    if (p.status === "unpriced") this.why = p.why;
  }
  merge(o: Pricing): void {
    if (o.status) this.status = this.status === null || this.status === o.status ? o.status : "mixed";
    if (o.key && o.keyAt >= this.keyAt) {
      this.key = o.key;
      this.keyAt = o.keyAt;
    }
    this.why ??= o.why;
  }
  out(name: (key: string) => string | undefined): UsagePricing {
    const status = this.status ?? "unpriced";
    return {
      status,
      ...(this.key ? { priceKey: this.key } : {}),
      ...(this.key && name(this.key) ? { name: name(this.key)! } : {}),
      ...(this.why && status !== "priced" ? { why: this.why } : {}),
    };
  }
}

/** One day's rows collapsed by local day and everything but the bucket: what range queries add up. */
interface Summary {
  key: string;
  entries: Entry[];
  byOwner: Map<string, Entry[]>;
}

interface Entry {
  ld: string;
  owner: string | null;
  kind: UsageKind;
  cwd: string | null;
  project: string | null;
  provider: string;
  /** The model the row is grouped by (displayModel): the model that answered, for Claude. */
  model: string;
  /** Asked for another catalog model than the one that answered. */
  asked: string | null;
  /** The ids the calls asked for. */
  requested: Set<string>;
  acc: Acc;
  pricing: Pricing;
  /** Its Claude launches, when its rows recorded any. */
  resend: Resends | null;
}

/** Providers whose models are Claude's, named by Sova's Claude catalog. */
const CLAUDE_PROVIDERS = new Set(["claude-code-cli", "claude", "anthropic"]);
const strip1m = (id: string) => id.replace(/\[1m\]$/i, "");

/**
 * The model a call is grouped by (§app.insights/usage-model-rows). Claude: the catalog model that
 * answered (its answer ids, `[1m]` dropped), else the one asked for (through the catalog or the
 * frozen legacy table, at the call's time); a call another model answered stays apart (`asked`);
 * a Claude id the catalog doesn't know keeps its own row. Any other provider: the model asked for.
 */
export function displayModel(provider: string, model: string, responseModel: string | null | undefined, at: number): { model: string; asked: string | null } {
  if (!CLAUDE_PROVIDERS.has(provider)) return { model, asked: null };
  const answered = claudeByAnswer(responseModel);
  const asked = resolveClaude(model, { at, answered: responseModel });
  if (answered) return { model: answered.id, asked: asked && asked.id !== answered.id ? asked.id : null };
  if (responseModel && responseModel !== "<synthetic>") return { model: strip1m(responseModel), asked: null };
  return { model: asked?.id ?? model, asked: null };
}

/** A `models=` filter key as the rows now name it: `claude-code-cli/opus[1m]` → `claude-code-cli/claude-opus-5-5`. */
export function modelFilterKey(key: string, at: number): string {
  const slash = key.indexOf("/");
  if (slash < 1) return key;
  const provider = key.slice(0, slash);
  return `${provider}/${displayModel(provider, key.slice(slash + 1), null, at).model}`;
}

/** A row's requested ids and mismatch, for the wire: omitted when they say nothing new. */
const identity = (model: string, asked: string | null, requested: Set<string>) => {
  const ids = [...requested].filter((r) => r !== model).sort();
  return { ...(ids.length ? { requested: [...requested].sort() } : {}), ...(asked ? { asked } : {}) };
};

const KINDS = new Set<string>(USAGE_KIND_ORDER);
const MAX_ZONES = 3;

/** `yyyy-mm-dd` arithmetic on calendar days. */
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

export function validZone(tz: string | null | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

export interface QueryOptions {
  ledger: Ledger;
  prices: PriceBook;
  device: () => string | null;
  now?: () => number;
}

export class Queries {
  private readonly ledger: Ledger;
  private readonly prices: PriceBook;
  private readonly device: () => UsageDevice;
  private readonly now: () => number;
  /** Bumped whenever the price history changes: every cached price and summary is then stale. */
  private tv = 1;
  private readonly rowPrices = new WeakMap<Row, RowPrice>();
  private readonly zones = new Map<string, { fmt: Intl.DateTimeFormat; days: Map<number, string> }>();
  /** Per day, per zone (a few at most: the browsers' zones). */
  private readonly summaries = new Map<string, Map<string, Summary>>();
  /** The zone summaries were last built for: session queries (which ignore local days) reuse them. */
  private lastTz = "UTC";

  constructor(opts: QueryOptions) {
    this.ledger = opts.ledger;
    this.prices = opts.prices;
    this.device = () => ({ id: opts.device(), self: true });
    this.now = opts.now ?? Date.now;
    this.prices.onChange(() => {
      this.tv++;
      this.summaries.clear();
    });
  }

  private name = (key: string) => this.prices.table().models[key]?.name;

  priceRow(row: Row): RowPrice {
    const hit = this.rowPrices.get(row);
    // A row of an open day grows: its price is good for the calls it had.
    if (hit && hit.v === this.tv && hit.n === row.n) return hit;
    const [, , , , , , , , provider, model, responseModel] = row.d;
    const usage = { input: row.t[0], output: row.t[1], cacheRead: row.t[2], cacheWrite5m: row.t[3], cacheWrite1h: row.t[4] };
    const p = this.prices.priceUsage({ provider: provider!, model: model!, ...(responseModel ? { responseModel } : {}) }, usage, row.a0, { tier: row.tier });
    const by: RowPrice["by"] = p.status === "priced" ? [p.usd.input, p.usd.output, p.usd.cacheRead, p.usd.cacheWrite5m, p.usd.cacheWrite1h] : [0, 0, 0, 0, 0];
    const out = { v: this.tv, n: row.n, usd: p.status === "priced" ? p.usd.total : 0, by, p };
    this.rowPrices.set(row, out);
    return out;
  }

  /** The local day (in `tz`) of a bucket start. */
  private localDay(tz: string): (ms: number) => string {
    let z = this.zones.get(tz);
    if (!z) {
      z = { fmt: new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }), days: new Map() };
      this.zones.set(tz, z);
    }
    const { fmt, days } = z;
    return (ms) => {
      let d = days.get(ms);
      if (d === undefined) {
        d = fmt.format(ms);
        days.set(ms, d);
      }
      return d;
    };
  }

  private summary(day: string, tz: string): Entry[] {
    return this.summaryOf(day, tz).entries;
  }

  private summaryOf(day: string, tz: string): Summary {
    this.lastTz = tz;
    let zones = this.summaries.get(day);
    const hit = zones?.get(tz);
    if (hit && hit.key === `${tz}|${this.tv}|${this.ledger.versionOf(day)}`) return hit;
    const { rows, version } = this.ledger.rowsOf(day);
    const key = `${tz}|${this.tv}|${version}`;
    const ld = this.localDay(tz);
    const by = new Map<string, Entry>();
    for (const row of rows) {
      const [owner, , , kind, , cwd, project, , provider, model, responseModel, , launch] = row.d;
      const local = ld(row.b);
      const shown = displayModel(provider!, model!, responseModel, row.a0);
      const id = `${local}\u001f${owner}\u001f${kind}\u001f${cwd}\u001f${project}\u001f${provider}\u001f${shown.model}\u001f${shown.asked ?? ""}`;
      let e = by.get(id);
      if (!e) {
        e = {
          ld: local,
          owner: owner ?? null,
          kind: (KINDS.has(kind!) ? kind : "main") as UsageKind,
          cwd: cwd ?? null,
          project: project ?? null,
          provider: provider!,
          model: shown.model,
          asked: shown.asked,
          requested: new Set(),
          acc: new Acc(),
          pricing: new Pricing(),
          resend: null,
        };
        by.set(id, e);
      }
      e.requested.add(model!);
      const price = this.priceRow(row);
      e.acc.add(row, price);
      e.pricing.add(price.p, row.a1);
      if (launch) (e.resend ??= new Resends()).addRow(launch, row, price);
    }
    const entries = [...by.values()];
    const byOwner = new Map<string, Entry[]>();
    for (const e of entries) if (e.owner) get(byOwner, e.owner, () => []).push(e);
    const out = { key, entries, byOwner };
    if (!zones) this.summaries.set(day, (zones = new Map()));
    zones.delete(tz);
    zones.set(tz, out);
    if (zones.size > MAX_ZONES) zones.delete(zones.keys().next().value!);
    this.ledger.evict(day);
    return out;
  }

  /** The UTC days whose buckets can fall on local days `from`..`to` (a zone is at most ±14h off). */
  private utcDays(from: string, to: string): string[] {
    const names = this.ledger.dayNames();
    const lo = addDays(from, -1);
    const hi = addDays(to, 1);
    return names.filter((d) => d >= lo && d <= hi);
  }

  costs(q: { range: UsageRange; providers: string[]; models: string[]; tz: string }): UsageCosts {
    const tz = validZone(q.tz);
    const today = this.localDay(tz)(this.now());
    const from = q.range === "all" ? null : addDays(today, q.range === "7d" ? -6 : -29);
    const days = q.range === "all" ? this.ledger.dayNames().filter((d) => d <= addDays(today, 1)) : this.utcDays(from!, today);
    const pset = new Set(q.providers);
    // An old key (`claude-code-cli/opus[1m]`) selects the row its calls are now grouped in.
    const mset = new Set(q.models.map((k) => modelFilterKey(k, this.now())));
    const facetP = new Set<string>();
    const facetM = new Map<string, { provider: string; model: string }>();
    const total = new Acc();
    const kinds = new Map<UsageKind, Acc>();
    const daily = new Map<string, Acc>();
    const byProvider = new Map<string, Acc>();
    const byModel = new Map<string, { provider: string; model: string; asked: string | null; requested: Set<string>; acc: Acc; pricing: Pricing }>();
    const byProject = new Map<string, { project: string | null; cwd: string | null; acc: Acc }>();
    const sessions = new Map<string, Acc>();
    const resends = new Map<string, Resends>();
    let first: string | null = null;
    for (const day of days) {
      for (const e of this.summary(day, tz)) {
        if (from && e.ld < from) continue;
        if (e.ld > today) continue;
        facetP.add(e.provider);
        const mk = `${e.provider}/${e.model}`;
        if (!facetM.has(mk)) facetM.set(mk, { provider: e.provider, model: e.model });
        if (pset.size && !pset.has(e.provider)) continue;
        if (mset.size && !mset.has(mk)) continue;
        if (first === null || e.ld < first) first = e.ld;
        total.merge(e.acc);
        get(kinds, e.kind, () => new Acc()).merge(e.acc);
        get(daily, e.ld, () => new Acc()).merge(e.acc);
        get(byProvider, e.provider, () => new Acc()).merge(e.acc);
        const m = get(byModel, `${mk}\u001f${e.asked ?? ""}`, () => ({ provider: e.provider, model: e.model, asked: e.asked, requested: new Set<string>(), acc: new Acc(), pricing: new Pricing() }));
        for (const r of e.requested) m.requested.add(r);
        m.acc.merge(e.acc);
        m.pricing.merge(e.pricing);
        const pk = e.project ? `p:${e.project}` : `c:${e.cwd ?? ""}`;
        get(byProject, pk, () => ({ project: e.project, cwd: e.project ? null : e.cwd, acc: new Acc() })).acc.merge(e.acc);
        if (e.owner) get(sessions, e.owner, () => new Acc()).merge(e.acc);
        if (e.owner && e.resend && e.kind !== "oneshot") get(resends, e.owner, () => new Resends()).merge(e.resend);
      }
    }
    const start = from ?? first;
    const dailyOut: UsageDay[] = [];
    if (start) {
      for (let d = start; d <= today; d = addDays(d, 1)) {
        const a = daily.get(d);
        dailyOut.push({ day: d, usd: round(a?.usd ?? 0), tokens: a?.tokenSum() ?? 0 });
      }
    }
    const kindAcc = (k: UsageKind) => kinds.get(k) ?? new Acc();
    const main = new Acc();
    main.merge(kindAcc("main"));
    main.merge(kindAcc("overseer"));
    const byUsd = <T extends { usd: number }>(a: T, b: T) => b.usd - a.usd;
    const top: UsageSessionRow[] = [...sessions.entries()]
      .sort((a, b) => b[1].usd - a[1].usd || b[1].tokenSum() - a[1].tokenSum())
      .slice(0, 20)
      .map(([sid, acc]) => {
        const o = this.ledger.owners.get(sid);
        const resend = resends.get(sid)?.out();
        return {
          sid,
          kind: o?.kind ?? "main",
          parent: o?.parent ?? null,
          ...(o?.worker ? { worker: o.worker } : {}),
          cwd: o?.cwd ?? null,
          project: o?.project ?? null,
          lastAt: acc.lastAt,
          ...acc.spend(),
          ...(resend ? { resend } : {}),
        };
      });
    return {
      device: this.device(),
      range: q.range,
      from: start,
      to: today,
      asOf: this.now(),
      providers: q.providers,
      models: q.models,
      facets: {
        providers: [...facetP].sort(),
        models: [...facetM.values()].sort((a, b) => cmp(a.provider, b.provider) || cmp(a.model, b.model)),
      },
      total: total.spend(),
      main: main.spend(),
      workers: kindAcc("worker").spend(),
      oneshots: kindAcc("oneshot").spend(),
      daily: dailyOut,
      byProvider: [...byProvider.entries()].map(([provider, a]) => ({ provider, ...a.spend() })).sort(byUsd),
      byModel: [...byModel.values()].map((m): UsageModelRow => ({ provider: m.provider, model: m.model, ...identity(m.model, m.asked, m.requested), ...m.acc.spend(), ...m.pricing.out(this.name) })).sort(byUsd),
      byKind: USAGE_KIND_ORDER.filter((k) => kinds.has(k)).map((kind) => ({ kind, ...kinds.get(kind)!.spend() })),
      byProject: [...byProject.values()].map((p) => ({ project: p.project, cwd: p.cwd, ...p.acc.spend() })).sort(byUsd),
      topSessions: top,
      prices: this.prices.info(),
    };
  }

  today(q: { tz: string }): UsageToday {
    const tz = validZone(q.tz);
    const today = this.localDay(tz)(this.now());
    const acc = new Acc();
    for (const day of this.utcDays(today, today)) for (const e of this.summary(day, tz)) if (e.ld === today) acc.merge(e.acc);
    return { device: this.device(), day: today, usd: round(acc.usd), tokens: acc.tokenSum(), calls: acc.calls, asOf: this.now() };
  }

  /** `sid` and every owner whose parent chain reaches it. */
  family(sid: string): Set<string> {
    const out = new Set<string>([sid]);
    const queue = [sid];
    while (queue.length) {
      const s = queue.pop()!;
      for (const c of this.ledger.children.get(s) ?? []) {
        if (out.has(c)) continue;
        out.add(c);
        queue.push(c);
      }
    }
    return out;
  }

  /** Visit every row owned by one of `owners`, day by day (project costs: they keep rows' price bands). */
  eachRow(owners: Set<string>, fn: (row: Row) => void): void {
    for (const day of this.daysOf(owners)) {
      for (const row of this.ledger.rowsOf(day).rows) if (row.d[0] && owners.has(row.d[0])) fn(row);
      this.ledger.evict(day);
    }
  }

  private daysOf(owners: Set<string>): string[] {
    const days = new Set<string>();
    for (const o of owners) for (const d of this.ledger.owners.get(o)?.days ?? []) days.add(d);
    return [...days].sort();
  }

  /** Visit the summary entries of `owners` (a session's spend never needs a row: entries are per owner and model). */
  private eachEntry(owners: Set<string>, fn: (e: Entry) => void): void {
    for (const day of this.daysOf(owners)) {
      const byOwner = this.summaryOf(day, this.lastTz).byOwner;
      for (const o of owners) for (const e of byOwner.get(o) ?? []) fn(e);
    }
  }

  session(q: { sid: string }): UsageSessionSpend {
    const fam = this.family(q.sid);
    const own = new Acc();
    const oneshots = new Acc();
    const workers = new Acc();
    const models = new Map<string, { origin: UsageSessionModelRow["origin"]; provider: string; model: string; asked: string | null; requested: Set<string>; acc: Acc; pricing: Pricing }>();
    const perWorker = new Map<string, Acc>();
    const resend = new Resends();
    this.eachEntry(fam, (e) => {
      const owner = e.owner!;
      const origin = owner !== q.sid ? "worker" : e.kind === "oneshot" ? "oneshot" : "main";
      if (origin === "main" && e.resend) resend.merge(e.resend);
      (origin === "worker" ? workers : origin === "oneshot" ? oneshots : own).merge(e.acc);
      if (origin === "worker") get(perWorker, owner, () => new Acc()).merge(e.acc);
      const m = get(models, `${origin}${e.provider}${e.model}${e.asked ?? ""}`, () => ({ origin, provider: e.provider, model: e.model, asked: e.asked, requested: new Set<string>(), acc: new Acc(), pricing: new Pricing() }));
      for (const r of e.requested) m.requested.add(r);
      m.acc.merge(e.acc);
      m.pricing.merge(e.pricing);
    });
    const total = new Acc();
    total.merge(own);
    total.merge(oneshots);
    total.merge(workers);
    const workerList: UsageWorkerRow[] = [...perWorker.entries()]
      .map(([sid, acc]) => {
        const o = this.ledger.owners.get(sid);
        const withWorkers = new Acc();
        for (const s of this.family(sid)) {
          const a = perWorker.get(s);
          if (a) withWorkers.merge(a);
        }
        return { sid, parent: o?.parent ?? q.sid, ...(o?.worker ? { worker: o.worker } : {}), ...acc.spend(), withWorkers: withWorkers.spend() };
      })
      .sort((a, b) => b.usd - a.usd);
    return {
      sid: q.sid,
      device: this.device(),
      asOf: this.now(),
      total: total.spend(),
      own: own.spend(),
      oneshots: oneshots.spend(),
      workers: workers.spend(),
      models: [...models.values()]
        .map((m): UsageSessionModelRow => ({ origin: m.origin, provider: m.provider, model: m.model, ...identity(m.model, m.asked, m.requested), ...m.acc.spend(), ...m.pricing.out(this.name) }))
        .sort((a, b) => b.usd - a.usd),
      workerList,
      ...(resend.out() ? { resend: resend.out()! } : {}),
      lastAt: total.lastAt || null,
      prices: { asOf: this.prices.info().asOf },
    };
  }

  sessions(q: { sids: string[] }): UsageSessionsTotals {
    const out: UsageSessionsTotals["sessions"] = {};
    for (const sid of q.sids) {
      if (!this.ledger.owners.has(sid)) continue;
      const total = new Acc();
      const workers = new Acc();
      this.eachEntry(this.family(sid), (e) => {
        total.merge(e.acc);
        if (e.owner !== sid) workers.merge(e.acc);
      });
      out[sid] = { total: total.spend(), workers: workers.spend() };
    }
    return { asOf: this.now(), sessions: out };
  }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function get<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let v = map.get(key);
  if (v === undefined) {
    v = make();
    map.set(key, v);
  }
  return v;
}
