// Run: npx tsx --test server/model-prices.test.ts
// A fake clock, fake timers and a fetch stub: nothing touches the network; the cache lives in a temp dir.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  mergeFetched,
  normalizeModelsDev,
  priceUsage,
  resolvePriceRef,
  EMPTY_TABLE,
  type Aliases,
  type PriceTable,
  type TokenUsage,
} from "../shared/model-prices/prices";
import { ALIASES_FILE, CHECK_MS, createPriceBook, fetchEnabled, MODELS_DEV_URL, SEED_FILE, STALE_MS } from "./model-prices";

const aliases = JSON.parse(readFileSync(ALIASES_FILE, "utf8")) as Aliases;
const seed = JSON.parse(readFileSync(SEED_FILE, "utf8")) as PriceTable;
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tempCache = () => {
  const d = mkdtempSync(join(tmpdir(), "model-prices-"));
  dirs.push(d);
  return join(d, "sova", "model-prices.json");
};

const use = (u: Partial<TokenUsage>): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...u });
const M = 1_000_000;

/** A tiny models.dev body: the providers aliases.json points at, one model each where it matters. */
function api(opusInput = 4) {
  const p = (models: Record<string, unknown>) => ({ id: "x", models });
  return {
    anthropic: p({
      "claude-opus-5-5": { name: "Claude Opus 5.5", cost: { input: opusInput, output: 20, cache_read: 0.2, cache_write: 5 } },
      "claude-opus-5": { cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } },
      "claude-haiku-4-5": { cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 } },
      "claude-sonnet-5": { cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 } },
    }),
    openai: p({
      "gpt-6-astra": {
        cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5, tiers: [{ input: 20, output: 75, cache_read: 2, cache_write: 25, tier: { type: "context", size: 272000 } }] },
      },
      "gpt-5.5": { cost: { input: 5, output: 30, cache_read: 0.5, tiers: [{ input: 10, output: 45, cache_read: 1, tier: { type: "context", size: 272000 } }] } },
      "gpt-5.3-codex-spark": { cost: { input: 1.75, output: 14, cache_read: 0.175 } },
      "gpt-image-1": { name: "no cost" },
    }),
    zai: p({ "glm-5.3": { cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 } } }),
    deepseek: p({ "deepseek-flash": { cost: { input: 0.15, output: 0.6, reasoning: 0.6, cache_read: 0.003 } } }),
    "ollama-cloud": p({ "mistral-large-3:675b": { cost: { input: 0.5, output: 1.5 } }, "qwen3.5:397b": { cost: { input: 0.6, output: 3.6 } } }),
  };
}

const T0 = "2026-09-01T00:00:00.000Z";
const table0 = () => mergeFetched(EMPTY_TABLE, normalizeModelsDev(api(), aliases), T0).table;
const price = (t: PriceTable, provider: string, model: string, u: Partial<TokenUsage>, at: string | number = "2026-09-27T00:00:00Z", responseModel?: string) =>
  priceUsage(t, aliases, { provider, model, ...(responseModel ? { responseModel } : {}) }, use(u), at);

test("normalize: models.dev rates per 1M, the Anthropic 1h write derived at 2x input, tiers kept, unpriced rows skipped", () => {
  const n = normalizeModelsDev(api(), aliases);
  assert.deepEqual(n["anthropic/claude-opus-5-5"]!.rates, { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 });
  assert.deepEqual(n["openai/gpt-6-astra"]!.tiers, [{ inputAbove: 272000, rates: { input: 20, output: 75, cacheRead: 2, cacheWrite5m: 25 } }]);
  assert.equal(n["openai/gpt-6-astra"]!.rates.cacheWrite1h, undefined);
  assert.equal(n["openai/gpt-image-1"], undefined);
  assert.throws(() => normalizeModelsDev({ anthropic: { models: {} } }, aliases), /provider/);
});

test("anthropic: every token kind, 5m vs 1h writes", () => {
  const r = price(table0(), "anthropic", "claude-opus-5-5", { input: M, output: M, cacheRead: M, cacheWrite5m: M, cacheWrite1h: M });
  assert.equal(r.status, "priced");
  if (r.status !== "priced") return;
  assert.deepEqual(r.usd, { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8, total: 37.2 });
  assert.equal(r.key, "anthropic/claude-opus-5-5");
  assert.equal(r.tier, null);
});

test("claude-code-cli: [1m] dropped, the dated opus alias, responseModel beats it, sonnet/haiku, synthetic is $0", () => {
  const t = table0();
  const key = (model: string, at: string, responseModel?: string) => {
    const r = price(t, "claude-code-cli", model, { input: 1 }, at, responseModel);
    return r.status === "priced" ? r.key : r.status;
  };
  assert.equal(key("opus[1m]", "2026-09-21T17:59:59Z"), "anthropic/claude-opus-5");
  assert.equal(key("opus[1m]", "2026-09-21T18:00:00Z"), "anthropic/claude-opus-5-5");
  assert.equal(key("opus", "2026-09-10T00:00:00Z", "claude-opus-5-5"), "anthropic/claude-opus-5-5");
  assert.equal(key("sonnet", "2026-09-27T00:00:00Z"), "anthropic/claude-sonnet-5");
  assert.equal(key("haiku", "2026-09-27T00:00:00Z"), "anthropic/claude-haiku-4-5");
  assert.equal(key("claude-haiku-4-5-20251001", "2026-09-27T00:00:00Z"), "anthropic/claude-haiku-4-5");
  assert.deepEqual(price(t, "claude", "<synthetic>", { output: 5 }), { status: "free", why: "synthetic" });
  assert.equal(key("claude-opus-5-5", "2026-09-27T00:00:00Z"), "anthropic/claude-opus-5-5");
});

test("openai-codex priced at OpenAI's API; the 272k tier applies to the whole request, above not at", () => {
  const t = table0();
  const at = price(t, "openai-codex", "gpt-6-astra", { input: 200_000, cacheRead: 72_000, output: M });
  const over = price(t, "openai-codex", "gpt-6-astra", { input: 200_001, cacheRead: 72_000, output: M });
  assert.ok(at.status === "priced" && over.status === "priced");
  if (at.status !== "priced" || over.status !== "priced") return;
  assert.equal(at.tier, null);
  assert.equal(at.usd.output, 50);
  assert.equal(over.tier, 272000);
  assert.equal(over.usd.output, 75);
  assert.equal(over.usd.cacheRead, (72_000 * 2) / M);
  // gpt-5.5 lists no cache write: its writes have no rate and are named, never borrowed from input.
  const noWrite = price(t, "openai-codex", "gpt-5.5", { input: 10, cacheWrite5m: 10 });
  assert.ok(noWrite.status === "priced" && noWrite.missing?.includes("cacheWrite5m") && noWrite.usd.cacheWrite5m === 0);
});

test("unpriced: codex-spark by name (never gpt-5.3-codex's price), unknown ids and providers; ollama local is $0", () => {
  const t = table0();
  const spark = price(t, "openai-codex", "gpt-5.3-codex-spark", { input: 10 });
  assert.equal(spark.status, "unpriced");
  assert.match(spark.status === "unpriced" ? spark.why : "", /Codex only/);
  assert.deepEqual(price(t, "openai-codex", "gpt-9", { input: 1 }), { status: "unpriced", ref: "openai-codex/gpt-9", why: "models.dev lists no price for openai/gpt-9" });
  assert.deepEqual(price(t, "jev", "jev-1", { input: 1 }), { status: "unpriced", ref: "jev/jev-1", why: "no price mapping for provider jev" });
  assert.deepEqual(price(t, "ollama", "qwen3:4b", { input: 1 }), { status: "free", why: "local" });
  assert.equal(price(t, "zai", "glm-5.3", { input: M }).status, "priced");
  assert.equal(price(t, "deepseek", "deepseek-flash", { input: M }).status, "priced");
  const ollama = price(t, "ollama-cloud", "mistral-large-3:675b", { input: M, output: M });
  assert.ok(ollama.status === "priced" && ollama.usd.total === 2);
});

test("price periods: a changed price opens a new period at the refresh; older messages keep the old one", () => {
  const T1 = "2026-09-20T12:00:00.000Z";
  const { table, report } = mergeFetched(table0(), normalizeModelsDev(api(3), aliases), T1);
  assert.deepEqual(report.changed, ["anthropic/claude-opus-5-5"]);
  assert.deepEqual(report.added, []);
  const periods = table.models["anthropic/claude-opus-5-5"]!.periods;
  assert.deepEqual(
    periods.map((p) => [p.from, p.until]),
    [
      [null, T1],
      [T1, null],
    ],
  );
  const before = price(table, "anthropic", "claude-opus-5-5", { input: M }, "2026-09-20T11:59:59Z");
  const onEdge = price(table, "anthropic", "claude-opus-5-5", { input: M }, T1);
  const long = price(table, "anthropic", "claude-opus-5-5", { input: M }, "2020-01-01T00:00:00Z");
  assert.ok(before.status === "priced" && onEdge.status === "priced" && long.status === "priced");
  if (before.status !== "priced" || onEdge.status !== "priced" || long.status !== "priced") return;
  assert.equal(before.usd.input, 4);
  assert.equal(onEdge.usd.input, 3);
  assert.equal(onEdge.period, T1);
  assert.equal(long.usd.input, 4, "the first known price covers older messages");
  // Unchanged prices keep their period; a model models.dev dropped keeps its history.
  const again = mergeFetched(table, normalizeModelsDev(api(3), aliases), "2026-09-25T00:00:00.000Z");
  assert.deepEqual(again.report, { added: [], changed: [] });
  assert.equal(again.table.changedAt, T1);
  const dropped = api(3) as Record<string, { models: Record<string, unknown> }>;
  delete dropped["ollama-cloud"]!.models["qwen3.5:397b"];
  assert.ok(mergeFetched(table, normalizeModelsDev(dropped, aliases), "2026-09-26T00:00:00.000Z").table.models["ollama-cloud/qwen3.5:397b"]);
});

test("the checked-in seed covers every model Sova runs; the explicit unpriced ones say why", () => {
  const at = "2026-09-28T00:00:00Z";
  const priced = (provider: string, model: string) => resolvePriceRef(seed, aliases, { provider, model }, at);
  for (const [p, m] of [
    ["claude-code-cli", "opus[1m]"],
    ["claude-code-cli", "claude-fable-5-1[1m]"],
    ["claude-code-cli", "sonnet"],
    ["claude-code-cli", "haiku"],
    ["openai-codex", "gpt-6-astra"],
    ["openai-codex", "gpt-5.6-sol"],
    ["zai", "glm-5.3"],
    ["deepseek", "deepseek-v4-pro"],
    ["ollama-cloud", "deepseek-v4-pro:0813"],
    ["ollama-cloud", "gemma4:31b"],
  ]) {
    assert.ok("key" in priced(p!, m!), `${p}/${m} is priced`);
  }
  const models = JSON.parse(readFileSync(join(import.meta.dirname, "..", "pi-config", "models.json"), "utf8"));
  for (const m of models.providers["ollama-cloud"].models) assert.ok("key" in priced("ollama-cloud", m.id), `ollama-cloud/${m.id}`);
  assert.ok("unpriced" in priced("openai-codex", "gpt-5.3-codex-spark"));
  assert.ok("unpriced" in priced("zai", "glm-5.3-highspeed"));
});

/** A book on a temp cache, a fake clock and timers, and a fetch stub. */
function harness(o: { cache?: PriceTable | string; seed?: PriceTable; enabled?: boolean } = {}) {
  let clock = Date.parse("2026-09-28T00:00:00Z");
  const cachePath = tempCache();
  if (o.cache !== undefined) {
    mkdirSync(join(cachePath, ".."), { recursive: true });
    writeFileSync(cachePath, typeof o.cache === "string" ? o.cache : JSON.stringify(o.cache));
  }
  const logs: string[] = [];
  const fetches: string[] = [];
  let reply: () => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> = async () => ({ ok: true, status: 200, json: async () => api() });
  const timers: { fn: () => void; at: number; cleared: boolean }[] = [];
  const book = createPriceBook({
    seed: o.seed ?? table0(),
    aliases,
    cachePath,
    enabled: o.enabled ?? true,
    now: () => clock,
    log: (l) => logs.push(l),
    fetch: (url) => {
      fetches.push(url);
      return reply();
    },
    setTimer: (fn, ms) => {
      const t = { fn, at: clock + ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => ((t as { cleared: boolean }).cleared = true),
  });
  return {
    book,
    cachePath,
    logs,
    fetches,
    timers,
    advance: (ms: number) => (clock += ms),
    reply: (r: typeof reply) => (reply = r),
    /** Fire the due timers, then let the refresh they started settle. */
    async fire() {
      for (const t of timers.filter((t) => !t.cleared && t.at <= clock)) {
        t.cleared = true;
        t.fn();
      }
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
  };
}
test("refresh: a stale seed fetches in the background at start, writes the cache atomically, then re-checks every 6h", async () => {
  const h = harness(); // seed fetched 2026-09-01: stale on 2026-09-28
  const stop = h.book.start();
  assert.equal(h.fetches.length, 0, "start never fetches synchronously");
  await h.fire();
  assert.deepEqual(h.fetches, [MODELS_DEV_URL]);
  assert.equal(h.book.info().fetchedAt, "2026-09-28T00:00:00.000Z");
  const onDisk = JSON.parse(readFileSync(h.cachePath, "utf8")) as PriceTable;
  assert.equal(onDisk.fetchedAt, "2026-09-28T00:00:00.000Z");
  assert.deepEqual(readdirSync(join(h.cachePath, "..")), ["model-prices.json"], "no temp file left behind");
  // Fresh now: the 6h checks don't fetch until 3 days have passed.
  h.advance(CHECK_MS);
  await h.fire();
  assert.equal(h.fetches.length, 1);
  h.advance(STALE_MS);
  await h.fire();
  assert.equal(h.fetches.length, 2);
  stop.stop();
  assert.ok(h.timers.every((t) => t.cleared));
});

test("refresh: a failed fetch keeps the last good table and logs one line", async () => {
  const h = harness();
  h.reply(async () => ({ ok: false, status: 503, json: async () => ({}) }));
  assert.equal(await h.book.refresh(), false);
  assert.equal(h.logs.length, 1);
  assert.match(h.logs[0]!, /refresh failed, keeping prices from 2026-09-01.*HTTP 503/);
  assert.equal(h.book.info().fetchedAt, T0);
  assert.equal(existsSync(h.cachePath), false);
  h.reply(async () => ({ ok: true, status: 200, json: async () => ({ garbage: true }) }));
  assert.equal(await h.book.refresh(), false);
  assert.equal(h.logs.length, 2);
  h.reply(() => Promise.reject(new Error("offline")));
  assert.equal(await h.book.refresh(), false);
  assert.match(h.logs[2]!, /offline/);
  assert.equal(h.book.priceUsage({ provider: "anthropic", model: "claude-opus-5-5" }, use({ input: M }), Date.now()).status, "priced");
});

test("refresh: no host cache fetches at the first check even when the seed is fresh; a fresh cache doesn't", async () => {
  const fresh = mergeFetched(EMPTY_TABLE, normalizeModelsDev(api(), aliases), "2026-09-27T23:00:00.000Z").table;
  const none = harness({ seed: fresh });
  none.book.start();
  await none.fire();
  assert.deepEqual(none.fetches, [MODELS_DEV_URL]);
  assert.ok(existsSync(none.cachePath));
  const has = harness({ seed: fresh, cache: fresh });
  has.book.start();
  await has.fire();
  assert.deepEqual(has.fetches, []);
});

test("refresh: SOVA_PRICES_FETCH=off (enabled: false) never fetches, not even forced", async () => {
  const h = harness({ enabled: false });
  h.book.start();
  await h.fire();
  assert.equal(await h.book.refresh(true), false);
  assert.deepEqual(h.fetches, []);
  assert.deepEqual(h.logs, ["fetching off (SOVA_PRICES_FETCH=off)"]);
});

test("load: a newer cache wins; an older one takes the seed's prices on top of its history; a corrupt one falls back to the seed", async () => {
  const later = mergeFetched(table0(), normalizeModelsDev(api(3), aliases), "2026-09-27T00:00:00.000Z").table;
  const newer = harness({ cache: later });
  assert.equal(newer.book.info().fetchedAt, "2026-09-27T00:00:00.000Z");
  assert.equal(newer.fetches.length, 0);
  // The seed (2026-09-27, opus at 3) is newer than the cache (2026-09-01, opus at 4).
  const older = harness({ cache: table0(), seed: later });
  const p = older.book.priceUsage({ provider: "anthropic", model: "claude-opus-5-5" }, use({ input: M }), "2026-09-28T00:00:00Z");
  assert.ok(p.status === "priced" && p.usd.input === 3);
  const corrupt = harness({ cache: "{not json" });
  assert.equal(corrupt.book.info().fetchedAt, T0);
});

test("fetchEnabled: the env switch, and a test process never fetches unless told to", () => {
  assert.equal(fetchEnabled({}), true);
  for (const v of ["off", "0", "false", "OFF"]) assert.equal(fetchEnabled({ SOVA_PRICES_FETCH: v }), false);
  assert.equal(fetchEnabled({ NODE_TEST_CONTEXT: "child-v8" }), false);
  assert.equal(fetchEnabled({ NODE_TEST_CONTEXT: "child-v8", SOVA_PRICES_FETCH: "on" }), true);
  assert.equal(process.env.NODE_TEST_CONTEXT !== undefined, true, "this runner sets it");
});
