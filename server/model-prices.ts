import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  mergeFetched,
  normalizeModelsDev,
  parseTable,
  priceUsage as priceWith,
  resolvePriceRef as resolveWith,
  EMPTY_TABLE,
  type Aliases,
  type ModelRef,
  type PricedUsage,
  type PriceTable,
  type Resolved,
  type TokenUsage,
} from "../shared/model-prices/prices";
import { stateRoot } from "./state-root";

/**
 * The host's price table (§app.project-costs/pricing): models.dev prices, kept host-local in
 * `<state root>/model-prices.json` and refreshed in the background when older than 3 days. The
 * checked-in seed (`shared/model-prices/seed.json`, `pnpm run prices:update`) is the fallback
 * and the floor: a host with no cache, or a cache older than the seed, prices from the seed. A
 * host with no cache fetches at its first check, however fresh the seed.
 * A failed fetch keeps the last good table and logs one line. `SOVA_PRICES_FETCH=off` never
 * fetches (hermetic tests), so prices then come from the seed or an existing cache.
 */

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const STALE_MS = 3 * 24 * 60 * 60 * 1000;
/** How often the timer asks "is the table stale?"; a fetch happens only when it is. */
export const CHECK_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

const PRICES_DIR = join(import.meta.dirname, "..", "shared", "model-prices");
export const SEED_FILE = join(PRICES_DIR, "seed.json");
export const ALIASES_FILE = join(PRICES_DIR, "aliases.json");

export interface PriceBookOptions {
  seed?: PriceTable;
  aliases?: Aliases;
  cachePath?: string;
  fetch?: (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  now?: () => number;
  log?: (line: string) => void;
  enabled?: boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export interface PriceBook {
  table(): PriceTable;
  aliases(): Aliases;
  priceUsage(ref: ModelRef, usage: TokenUsage, at: number | string): PricedUsage;
  resolvePriceRef(ref: ModelRef, at: number | string): Resolved;
  info(): { source: "models.dev"; fetchedAt: string | null; version: string };
  /** Fetch when stale (or `force`); resolves true when the table was refreshed. Never throws. */
  refresh(force?: boolean): Promise<boolean>;
  /** The start-up check (next tick, never blocking) and the periodic one. */
  start(): { stop(): void };
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

function readCache(path: string): PriceTable | null {
  try {
    return parseTable(readJson(path));
  } catch {
    return null;
  }
}

function writeAtomic(path: string, table: PriceTable): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(table, null, 1)}\n`);
  renameSync(tmp, path);
}

/** The seed's current prices, as a fetch: folded into an older cache so a newer seed always wins. */
function currentOf(table: PriceTable): Parameters<typeof mergeFetched>[1] {
  const out: Parameters<typeof mergeFetched>[1] = {};
  for (const [key, m] of Object.entries(table.models)) {
    const last = m.periods[m.periods.length - 1]!;
    out[key] = { ...(m.name ? { name: m.name } : {}), rates: last.rates, ...(last.tiers ? { tiers: last.tiers } : {}) };
  }
  return out;
}

const ms = (iso: string | null) => (iso ? Date.parse(iso) : -Infinity);

export function createPriceBook(opts: PriceBookOptions = {}): PriceBook {
  const aliases = opts.aliases ?? (readJson(ALIASES_FILE) as Aliases);
  const seed = opts.seed ?? parseTable(readJson(SEED_FILE)) ?? EMPTY_TABLE;
  const cachePath = opts.cachePath ?? join(stateRoot(), "model-prices.json");
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.warn(`[model-prices] ${line}`));
  const enabled = opts.enabled ?? !["off", "0", "false"].includes(process.env.SOVA_PRICES_FETCH ?? "");
  const doFetch = opts.fetch ?? ((url, init) => fetch(url, init));

  let current: PriceTable = seed;
  const cache = readCache(cachePath);
  /** No usable host cache yet: fetch at the first check, however fresh the seed is. */
  let cached = cache !== null;
  if (cache) {
    current = ms(cache.fetchedAt) >= ms(seed.fetchedAt) ? cache : mergeFetched(cache, currentOf(seed), seed.fetchedAt!).table;
  }

  let inFlight: Promise<boolean> | null = null;
  const refresh = (force = false): Promise<boolean> => {
    if (!enabled) return Promise.resolve(false);
    if (!force && cached && now() - ms(current.fetchedAt) < STALE_MS) return Promise.resolve(false);
    inFlight ??= (async () => {
      try {
        const res = await doFetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const fetched = normalizeModelsDev(await res.json(), aliases);
        const { table, report } = mergeFetched(current, fetched, new Date(now()).toISOString());
        writeAtomic(cachePath, table);
        current = table;
        cached = true;
        if (report.changed.length) log(`prices changed for ${report.changed.join(", ")}`);
        return true;
      } catch (err) {
        log(`refresh failed, keeping prices from ${current.fetchedAt ?? "the seed"}: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  return {
    table: () => current,
    aliases: () => aliases,
    priceUsage: (ref, usage, at) => priceWith(current, aliases, ref, usage, at),
    resolvePriceRef: (ref, at) => resolveWith(current, aliases, ref, at),
    info: () => ({ source: "models.dev", fetchedAt: current.fetchedAt, version: current.changedAt ?? current.fetchedAt ?? "seed" }),
    refresh,
    start() {
      if (!enabled) {
        log("fetching off (SOVA_PRICES_FETCH=off)");
        return { stop() {} };
      }
      const setTimer = opts.setTimer ?? ((fn, t) => setTimeout(fn, t).unref());
      const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
      let stopped = false;
      let timer: unknown;
      const tick = (delay: number) => {
        timer = setTimer(() => {
          if (stopped) return;
          void refresh().finally(() => !stopped && tick(CHECK_MS));
        }, delay);
      };
      tick(0);
      return {
        stop() {
          stopped = true;
          clearTimer(timer);
        },
      };
    },
  };
}

let book: PriceBook | null = null;
const shared = () => (book ??= createPriceBook());

/** Price one usage record at its timestamp with the host's current table. */
export const priceUsage = (ref: ModelRef, usage: TokenUsage, at: number | string): PricedUsage => shared().priceUsage(ref, usage, at);
/** Which models.dev key (or $0, or why unpriced) a model ref resolves to at a time. */
export const resolvePriceRef = (ref: ModelRef, at: number | string): Resolved => shared().resolvePriceRef(ref, at);
/** Where the prices come from and when, for "Prices as of …". */
export const pricesInfo = () => shared().info();
/** Call once at server start: a background refresh when stale, then a check every 6 hours. */
export const startPriceRefresh = () => shared().start();

export type { ModelRef, PricedUsage, Resolved, TokenUsage } from "../shared/model-prices/prices";
