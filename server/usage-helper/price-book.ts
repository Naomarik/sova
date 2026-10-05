import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  mergeFetched,
  normalizeModelsDev,
  parseTable,
  priceUsage as priceWith,
  EMPTY_TABLE,
  type Aliases,
  type MergeReport,
  type ModelRef,
  type PriceOptions,
  type PricedUsage,
  type PriceTable,
  type TokenUsage,
} from "../../shared/model-prices/prices";

/**
 * The host's dated price history, as data: `<state root>/model-prices.json`. The usage helper owns
 * it (the server never fetches or parses it). models.dev is pulled every 6 hours and on demand
 * (Refresh prices); a download only closes the current period and opens a new one, never rewrites an
 * older one, so dates entered by hand survive. The checked-in seed (`shared/model-prices/seed.json`)
 * is a starter copy, written only when the file doesn't exist. A file edited by hand is picked up
 * by `reload()` (the helper's tick). Builtins and the shared pricing rule only: the helper process
 * imports this, and must not load the pi SDK.
 */

export const MODELS_DEV_URL = "https://models.dev/api.json";
/** How often prices are pulled from models.dev; a start-up pulls when the last pull is older. */
export const PULL_MS = 6 * 60 * 60 * 1000;
/** After a failed pull (offline, models.dev down). */
export const RETRY_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;

const PRICES_DIR = join(import.meta.dirname, "..", "..", "shared", "model-prices");
export const SEED_FILE = join(PRICES_DIR, "seed.json");
export const ALIASES_FILE = join(PRICES_DIR, "aliases.json");

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface PriceBookOptions {
  /** `<state root>/model-prices.json`. */
  path: string;
  seed?: PriceTable;
  aliases?: Aliases;
  fetch?: Fetch;
  now?: () => number;
  log?: (line: string) => void;
  enabled?: boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export interface PricesInfo {
  source: "models.dev";
  /** The last successful download (ISO), or null when the prices are the seed's never refreshed here. */
  asOf: string | null;
  /** When a download last found a change (ISO), and what it was. */
  changedAt: string | null;
  lastChange: MergeReport | null;
  fetching: boolean;
  enabled: boolean;
  /** The last failed download's message, until one succeeds. */
  error: string | null;
}

export interface PriceBook {
  table(): PriceTable;
  aliases(): Aliases;
  priceUsage(ref: ModelRef, usage: TokenUsage, at: number | string, opts?: PriceOptions): PricedUsage;
  info(): PricesInfo;
  /** Pull now (`force`), or when the last pull is 6 hours old. Never throws; true when the table was replaced. */
  refresh(force?: boolean): Promise<boolean>;
  /** Re-read the file when it changed on disk (a hand edit); true when the table was replaced. */
  reload(): boolean;
  /** Called with the old and new table whenever the history is replaced (a download or a hand edit). */
  onChange(fn: (prev: PriceTable, next: PriceTable) => void): void;
  /** The start-up pull (next tick, never blocking) and one every 6 hours. */
  start(): { stop(): void };
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

/**
 * `SOVA_PRICES_FETCH=off|0|false` never fetches; `on|1|true` always may. Unset, a test process
 * (`node --test` sets NODE_TEST_CONTEXT, `bun test` sets NODE_ENV=test) never fetches.
 */
export function fetchEnabled(env: NodeJS.ProcessEnv): boolean {
  const v = (env.SOVA_PRICES_FETCH ?? "").toLowerCase();
  if (["off", "0", "false"].includes(v)) return false;
  if (["on", "1", "true"].includes(v)) return true;
  return !env.NODE_TEST_CONTEXT && env.NODE_ENV !== "test";
}

const ms = (iso: string | null) => (iso ? Date.parse(iso) : -Infinity);

export function createPriceBook(opts: PriceBookOptions): PriceBook {
  const aliases = opts.aliases ?? (readJson(ALIASES_FILE) as Aliases);
  const path = opts.path;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.warn(`[model-prices] ${line}`));
  const enabled = opts.enabled ?? fetchEnabled(process.env);
  const doFetch: Fetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const listeners: ((prev: PriceTable, next: PriceTable) => void)[] = [];

  /** The file's identity when last read or written, so our own write is not taken for a hand edit. */
  let seen = "";
  const stamp = () => {
    try {
      const s = statSync(path);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return "";
    }
  };
  const write = (table: PriceTable) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(table, null, 1)}\n`);
    renameSync(tmp, path);
    seen = stamp();
  };
  const readFile = (): PriceTable | null => {
    try {
      return parseTable(readJson(path));
    } catch {
      return null;
    }
  };

  let current: PriceTable;
  /** The seed's own fetch time: a table still at it has never been pulled on this host. */
  let pulled = false;
  seen = stamp();
  const onDisk = seen ? readFile() : null;
  if (onDisk) {
    current = onDisk;
    pulled = true;
  } else {
    current = opts.seed ?? parseTable(readJson(SEED_FILE)) ?? EMPTY_TABLE;
    if (!seen) {
      try {
        write(current);
      } catch (err) {
        log(`could not write the starter copy: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else log(`${path} is not a price table; pricing from the seed until the next download`);
  }

  const replace = (next: PriceTable) => {
    const prev = current;
    current = next;
    for (const fn of listeners) fn(prev, next);
  };

  let inFlight: Promise<boolean> | null = null;
  let error: string | null = null;
  const refresh = (force = false): Promise<boolean> => {
    if (!enabled) return Promise.resolve(false);
    if (!force && pulled && now() - ms(current.fetchedAt) < PULL_MS) return Promise.resolve(false);
    inFlight ??= (async () => {
      try {
        const res = await doFetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const fetched = normalizeModelsDev(await res.json(), aliases);
        // A hand edit since our last look is the base, never overwritten by an older copy.
        reload();
        const { table, report } = mergeFetched(current, fetched, new Date(now()).toISOString());
        write(table);
        pulled = true;
        error = null;
        replace(table);
        if (report.changed.length) log(`prices changed for ${report.changed.join(", ")}`);
        return true;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        log(`refresh failed, keeping prices from ${current.fetchedAt ?? "the seed"}: ${error}`);
        return false;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const reload = (): boolean => {
    const s = stamp();
    if (!s || s === seen) return false;
    seen = s;
    const next = readFile();
    if (!next) {
      log(`${path} changed but is not a price table; keeping the prices in use`);
      return false;
    }
    if (JSON.stringify(next) === JSON.stringify(current)) return false;
    replace(next);
    return true;
  };

  return {
    table: () => current,
    aliases: () => aliases,
    priceUsage: (ref, usage, at, o) => priceWith(current, aliases, ref, usage, at, o),
    info: () => ({
      source: "models.dev",
      asOf: pulled ? current.fetchedAt : null,
      changedAt: current.changedAt,
      lastChange: current.lastChange ?? null,
      fetching: inFlight !== null,
      enabled,
      error,
    }),
    refresh,
    reload,
    onChange: (fn) => void listeners.push(fn),
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
          void refresh().finally(() => {
            if (stopped) return;
            // The next pull is due 6 hours after the last good one; a failed one is retried sooner.
            const due = ms(current.fetchedAt) + PULL_MS - now();
            tick(error ? RETRY_MS : pulled && Number.isFinite(due) ? Math.max(RETRY_MS, due) : PULL_MS);
          });
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
