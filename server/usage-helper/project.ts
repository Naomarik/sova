import fs from "node:fs";
import type { CostKind, CostModelRow, CostRow, CostSession, CostStarter, CostTokens, OrgCosts, ProjectCost } from "../../shared/costs";
import type { PricedUsage, TokenUsage } from "../../shared/model-prices/prices";
import { readCostLedger, writeCostLedger, type CostBucket, type CostLedger, type CostSnapshot } from "./cost-snapshots";
import type { Ledger, Row } from "./ledger";
import type { PriceBook } from "./price-book";
import type { Queries } from "./query";

/**
 * A project's cost (§app/project-costs) from the usage ledger. The server names the project's
 * sessions (its scope: contributed sessions with their wrap-up turns, overseer conversations,
 * coding sessions) and where its costs.json is; everything else happens here: each session's
 * records and its workers' at any depth (by the records' parent links), the project's reconciler
 * calls (records naming the project with purpose `reconcile`), other hosts' rows from costs.json
 * "as last counted", the pricing (the one priceUsage, per bucket in its calls' tier band), and
 * this host's own rows written back to costs.json at most once a minute. No transcript is read.
 */

/** One session the project counts, as the server's scope names it. */
export interface CostScopeSource {
  key: string;
  sessionId: string;
  title: string;
  kind: CostKind;
  by: CostStarter;
  /** The session file on this host, or null. */
  path: string | null;
  /** It has wrap-up turns: its calls with the purpose `wrapup` count as `wrapup`. */
  wrapupEntry?: string;
}

export interface ProjectScope {
  projectId: string;
  /** Absolute path of the project's costs.json. */
  costsPath: string;
  sources: CostScopeSource[];
}

interface Source {
  key: string;
  sessionId: string;
  title: string;
  kind: CostKind;
  by: CostStarter;
  path: string | null;
  buckets: CostBucket[];
  live: boolean;
  countedAt?: string;
}

const TOP_MAX = 20;
const WRITE_GAP_MS = 60_000;
const NO_MODEL_WHY = "A tool's own model calls, with no model recorded.";
const KIND_ORDER: CostKind[] = ["overseer", "gathering", "settle", "wrapup", "coding-overseer", "coding-operator", "workers", "reconcile"];
const STARTER_ORDER: CostStarter[] = ["overseer", "operator", "sova"];

const zeroTokens = (): CostTokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 });
const zeroRow = (): CostRow => ({ usd: 0, tokens: zeroTokens(), usdBy: zeroTokens() });
const tokenSum = (b: Pick<CostBucket, "input" | "output" | "cacheRead" | "cacheWrite5m" | "cacheWrite1h">) => b.input + b.output + b.cacheRead + b.cacheWrite5m + b.cacheWrite1h;

/** Rows folded into costs.json buckets: one per kind, model, UTC day, price period and tier band. */
class Buckets {
  private readonly map = new Map<string, CostBucket>();
  add(kind: CostKind, row: Row): void {
    const [, , , , , , , , provider, model, responseModel] = row.d;
    const day = new Date(row.b).toISOString().slice(0, 10);
    const key = `${kind}\0${provider}\0${model}\0${responseModel ?? ""}\0${day}\0${row.tier ?? ""}\0${row.pk}@${row.pf ?? ""}`;
    let b = this.map.get(key);
    if (!b) {
      b = {
        kind,
        provider: provider!,
        model: model!,
        ...(responseModel ? { responseModel } : {}),
        at: new Date(row.a0).toISOString(),
        n: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        ...(row.tier !== null ? { band: row.tier } : {}),
      };
      this.map.set(key, b);
    } else if (Date.parse(b.at) > row.a0) b.at = new Date(row.a0).toISOString();
    b.n += row.n;
    b.input += row.t[0];
    b.output += row.t[1];
    b.cacheRead += row.t[2];
    b.cacheWrite5m += row.t[3];
    b.cacheWrite1h += row.t[4];
  }
  list(): CostBucket[] {
    return [...this.map.values()].sort((a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind) || a.model.localeCompare(b.model));
  }
}

export interface ProjectDeps {
  ledger: Ledger;
  queries: Queries;
  prices: PriceBook;
  device: () => string | null;
  now: () => number;
}

const lastWrite = new Map<string, number>();

function priceBucket(prices: PriceBook, b: CostBucket): PricedUsage {
  const usage: TokenUsage = { input: b.input, output: b.output, cacheRead: b.cacheRead, cacheWrite5m: b.cacheWrite5m, cacheWrite1h: b.cacheWrite1h };
  if (b.noModel) return { status: "unpriced", ref: `${b.provider}/${b.model}`, why: NO_MODEL_WHY };
  return prices.priceUsage({ provider: b.provider, model: b.model, ...(b.responseModel ? { responseModel: b.responseModel } : {}) }, usage, b.at, { tier: b.band ?? null });
}

/** This host's sources for the project, from the ledger. `here` collects the keys this host speaks for. */
function liveSources(d: ProjectDeps, scope: ProjectScope, here: Set<string>): Source[] {
  const out: Source[] = [];
  const claimed = new Set<string>();
  for (const s of scope.sources) {
    if (claimed.has(s.sessionId)) continue;
    // A session whose file is on this host is this host's to count: its old snapshot no longer stands.
    const path = s.path && fs.existsSync(s.path) ? s.path : null;
    if (path) here.add(s.key);
    const fam = d.queries.family(s.sessionId);
    const per = new Map<string, Buckets>();
    d.queries.eachRow(fam, (row) => {
      const owner = row.d[0]!;
      if (claimed.has(owner)) return;
      let b = per.get(owner);
      if (!b) per.set(owner, (b = new Buckets()));
      // A wrap-up turn's calls carry the purpose `wrapup` (the chat sets it for the turn).
      const kind: CostKind = owner !== s.sessionId ? "workers" : s.wrapupEntry && row.d[4] === "wrapup" ? "wrapup" : s.kind;
      b.add(kind, row);
    });
    for (const o of fam) claimed.add(o);
    for (const [owner, b] of per) {
      const buckets = b.list();
      if (!buckets.length) continue;
      if (owner === s.sessionId) out.push({ key: s.key, sessionId: s.sessionId, title: s.title, kind: s.kind, by: s.by, path, buckets, live: true });
      else {
        const info = d.ledger.owners.get(owner);
        const key = `w:${owner}`;
        here.add(key);
        out.push({ key, sessionId: owner, title: info?.worker ?? "Worker", kind: "workers", by: s.by, path: null, buckets, live: true });
      }
    }
  }
  // The project's reconciler calls: records naming the project, owned by no session counted above.
  const recon = new Buckets();
  for (const day of [...(d.ledger.projects.get(scope.projectId) ?? [])].sort()) {
    for (const row of d.ledger.rowsOf(day).rows) {
      if (row.d[6] !== scope.projectId || row.d[4] !== "reconcile") continue;
      if (row.d[0] && claimed.has(row.d[0])) continue;
      recon.add("reconcile", row);
    }
    d.ledger.evict(day);
  }
  const reconKey = `reconcile:${d.device() ?? "this-host"}`;
  here.add(reconKey);
  const rb = recon.list();
  if (rb.length) out.push({ key: reconKey, sessionId: reconKey, title: "Reconciler", kind: "reconcile", by: "sova", path: null, buckets: rb, live: true });
  for (const o of claimed) here.add(`w:${o}`);
  return out;
}

/** Old worker keys named their backend (`w:pi:<id>`); the ledger knows a worker by its session id. */
const workerId = (key: string) => (key.startsWith("w:") ? key.slice(key.lastIndexOf(":") + 1) : null);

function keepSnapshots(scope: ProjectScope, ledger: CostLedger, live: Source[], now: number): void {
  if (now - (lastWrite.get(scope.projectId) ?? 0) < WRITE_GAP_MS) return;
  lastWrite.set(scope.projectId, now);
  let changed = false;
  const next: CostLedger = { version: 1, sources: { ...ledger.sources } };
  for (const s of live) {
    const prev = ledger.sources[s.key];
    if (prev && prev.kind === s.kind && prev.by === s.by && JSON.stringify(prev.buckets) === JSON.stringify(s.buckets)) continue;
    const snap: CostSnapshot = { sessionId: s.sessionId, title: s.title, kind: s.kind, by: s.by, countedAt: new Date(now).toISOString(), buckets: s.buckets };
    next.sources[s.key] = snap;
    changed = true;
  }
  if (!changed) return;
  try {
    writeCostLedger({ costs: scope.costsPath }, next);
  } catch (err) {
    console.warn(`[usage-helper] ${scope.projectId}: costs.json not written: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function projectCost(d: ProjectDeps, scope: ProjectScope): ProjectCost {
  const now = d.now();
  const snapshots = readCostLedger({ costs: scope.costsPath });
  const here = new Set<string>();
  const live = liveSources(d, scope, here);
  keepSnapshots(scope, snapshots, live, now);
  const sources = [...live];
  for (const [key, snap] of Object.entries(snapshots.sources)) {
    if (here.has(key)) continue;
    const w = workerId(key);
    if (w && here.has(`w:${w}`)) continue;
    sources.push({ key, sessionId: snap.sessionId, title: snap.title, kind: snap.kind, by: snap.by, path: null, buckets: snap.buckets, live: false, countedAt: snap.countedAt });
  }

  const total = zeroRow();
  const byKind = new Map<CostKind, CostRow>();
  const byStarter = new Map<CostStarter, CostRow>();
  const byModel = new Map<string, CostModelRow>();
  const unpriced = new Map<string, { model: string; tokens: number; why: string }>();
  const top: CostSession[] = [];
  let since: number | null = null;
  let notOnHost = 0;
  let oldestCount: string | null = null;
  const add = (row: CostRow, b: CostBucket, p: PricedUsage) => {
    if (p.status === "priced") {
      row.usd += p.usd.total;
      row.usdBy.input += p.usd.input;
      row.usdBy.output += p.usd.output;
      row.usdBy.cacheRead += p.usd.cacheRead;
      row.usdBy.cacheWrite += p.usd.cacheWrite5m + p.usd.cacheWrite1h;
      row.usdBy.cacheWrite1h += p.usd.cacheWrite1h;
    }
    row.tokens.input += b.input;
    row.tokens.output += b.output;
    row.tokens.cacheRead += b.cacheRead;
    row.tokens.cacheWrite += b.cacheWrite5m + b.cacheWrite1h;
    row.tokens.cacheWrite1h += b.cacheWrite1h;
  };
  const get = <K, V>(m: Map<K, V>, k: K, make: () => V): V => {
    let v = m.get(k);
    if (v === undefined) m.set(k, (v = make()));
    return v;
  };

  for (const s of sources) {
    const row = zeroRow();
    for (const b of s.buckets) {
      const p = priceBucket(d.prices, b);
      add(row, b, p);
      add(total, b, p);
      add(get(byKind, b.kind, zeroRow), b, p);
      add(get(byStarter, s.by, zeroRow), b, p);
      const ref = `${b.provider}/${b.model}`;
      const model = p.status === "priced" ? p.key : ref;
      const why = p.status === "priced" ? undefined : p.why;
      const name = p.status === "priced" ? d.prices.table().models[p.key]?.name : undefined;
      add(get(byModel, `${p.status}\0${model}`, () => ({ model, ...(name ? { name } : {}), status: p.status, ...(why ? { why } : {}), ...zeroRow() })), b, p);
      if (p.status === "unpriced") get(unpriced, ref, () => ({ model: ref, tokens: 0, why: p.why })).tokens += tokenSum(b);
      const at = Date.parse(b.at);
      if (Number.isFinite(at)) since = since === null ? at : Math.min(since, at);
    }
    if (!s.live && s.countedAt) {
      notOnHost++;
      if (!oldestCount || s.countedAt < oldestCount) oldestCount = s.countedAt;
    }
    top.push({ sessionId: s.sessionId, title: s.title, kind: s.kind, by: s.by, path: s.path, ...(s.countedAt && !s.live ? { countedAt: s.countedAt } : {}), ...row });
  }

  const allTokens = (r: CostRow) => r.tokens.input + r.tokens.output + r.tokens.cacheRead + r.tokens.cacheWrite;
  const spent = (r: CostRow) => r.usd > 0 || allTokens(r) > 0;
  return {
    projectId: scope.projectId,
    totalUsd: total.usd,
    asOf: new Date(now).toISOString(),
    since: since === null ? null : new Date(since).toISOString(),
    prices: { source: "models.dev", fetchedAt: d.prices.info().asOf },
    sessions: new Set(sources.map((s) => (s.kind === "reconcile" ? "reconcile" : s.key))).size,
    byKind: KIND_ORDER.filter((k) => byKind.has(k) && spent(byKind.get(k)!)).map((kind) => ({ kind, ...byKind.get(kind)! })),
    byStarter: STARTER_ORDER.filter((k) => byStarter.has(k) && spent(byStarter.get(k)!)).map((by) => ({ by, ...byStarter.get(by)! })),
    byModel: [...byModel.values()].filter(spent).sort((a, b) => b.usd - a.usd || allTokens(b) - allTokens(a) || a.model.localeCompare(b.model)),
    top: top.filter(spent).sort((a, b) => b.usd - a.usd || allTokens(b) - allTokens(a)).slice(0, TOP_MAX),
    unpriced: [...unpriced.values()].sort((a, b) => b.tokens - a.tokens),
    estimates: [],
    notOnHost: notOnHost ? { sessions: notOnHost, countedAt: oldestCount } : null,
    notCounted: [],
  };
}

export function orgCosts(d: ProjectDeps, orgId: string, scopes: ProjectScope[]): OrgCosts {
  const projects = scopes.map((s) => {
    const c = projectCost(d, s);
    return { projectId: s.projectId, totalUsd: c.totalUsd, unpricedTokens: c.unpriced.reduce((n, u) => n + u.tokens, 0) };
  });
  return { orgId, totalUsd: projects.reduce((n, p) => n + p.totalUsd, 0), asOf: new Date(d.now()).toISOString(), projects };
}
