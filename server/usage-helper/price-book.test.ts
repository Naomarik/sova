// The price history as data: a starter copy from the seed, a pull every 6 hours and on demand,
// downloads that only add periods, hand edits picked up. A fake clock, fake timers, a fetch stub.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { mergeFetched, normalizeModelsDev, EMPTY_TABLE, type Aliases, type PriceTable, type TokenUsage } from "../../shared/model-prices/prices";
import { ALIASES_FILE, createPriceBook, fetchEnabled, MODELS_DEV_URL, PULL_MS, RETRY_MS } from "./price-book";

const aliases = JSON.parse(readFileSync(ALIASES_FILE, "utf8")) as Aliases;
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const use = (u: Partial<TokenUsage>): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...u });
const M = 1_000_000;

function api(opusInput = 4) {
  return {
    anthropic: { models: { "claude-opus-5-5": { name: "Claude Opus 5.5", cost: { input: opusInput, output: 20, cache_read: 0.2, cache_write: 5 } } } },
    openai: { models: { "gpt-5.5": { cost: { input: 5, output: 30 } } } },
    zai: { models: { "glm-5.3": { cost: { input: 1.4, output: 4.4 } } } },
    deepseek: { models: { "deepseek-flash": { cost: { input: 0.15, output: 0.6 } } } },
    "ollama-cloud": { models: { "qwen3.5:397b": { cost: { input: 0.6, output: 3.6 } } } },
  };
}
const T0 = "2026-09-01T00:00:00.000Z";
const seed = () => mergeFetched(EMPTY_TABLE, normalizeModelsDev(api(), aliases), T0).table;

function harness(o: { file?: PriceTable | string; enabled?: boolean } = {}) {
  let clock = Date.parse("2026-09-28T00:00:00Z");
  const d = mkdtempSync(join(tmpdir(), "price-book-"));
  dirs.push(d);
  const path = join(d, "sova", "model-prices.json");
  if (o.file !== undefined) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, typeof o.file === "string" ? o.file : JSON.stringify(o.file));
  }
  const logs: string[] = [];
  const fetches: string[] = [];
  let reply: () => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> = async () => ({ ok: true, status: 200, json: async () => api() });
  const timers: { fn: () => void; at: number; cleared: boolean }[] = [];
  const book = createPriceBook({
    path,
    seed: seed(),
    aliases,
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
    path,
    logs,
    fetches,
    advance: (ms: number) => (clock += ms),
    reply: (r: typeof reply) => (reply = r),
    async fire() {
      for (const t of timers.filter((t) => !t.cleared && t.at <= clock)) {
        t.cleared = true;
        t.fn();
      }
      for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
    },
    timers,
  };
}

test("starter copy: no file -> the seed is written as the file, and pulled at once", async () => {
  const h = harness();
  assert.equal(JSON.parse(readFileSync(h.path, "utf8")).fetchedAt, T0);
  assert.equal(h.book.info().asOf, null, "the seed's own prices were never pulled here");
  h.book.start();
  assert.equal(h.fetches.length, 0, "start never fetches synchronously");
  await h.fire();
  assert.deepEqual(h.fetches, [MODELS_DEV_URL]);
  assert.equal(h.book.info().asOf, "2026-09-28T00:00:00.000Z");
  assert.deepEqual(readdirSync(join(h.path, "..")), ["model-prices.json"], "no temp file left behind");
});

test("an existing file is the data: never replaced by the seed, whatever their dates", () => {
  const old = mergeFetched(EMPTY_TABLE, normalizeModelsDev(api(9), aliases), "2026-01-01T00:00:00.000Z").table;
  const h = harness({ file: old });
  const p = h.book.priceUsage({ provider: "anthropic", model: "claude-opus-5-5" }, use({ input: M }), "2026-09-28T00:00:00Z");
  assert.ok(p.status === "priced" && p.usd.input === 9);
});

test("pull every 6 hours, not only when 3 days old; a failed pull retries in 30 minutes and keeps the prices", async () => {
  const fresh = mergeFetched(EMPTY_TABLE, normalizeModelsDev(api(), aliases), "2026-09-27T23:00:00.000Z").table;
  const h = harness({ file: fresh });
  h.book.start();
  await h.fire();
  assert.equal(h.fetches.length, 0, "pulled an hour ago: not yet");
  h.advance(5 * 60 * 60 * 1000);
  await h.fire();
  assert.equal(h.fetches.length, 1, "6 hours after the last pull");
  h.advance(PULL_MS - 1);
  await h.fire();
  assert.equal(h.fetches.length, 1);
  h.reply(async () => ({ ok: false, status: 503, json: async () => ({}) }));
  h.advance(1);
  await h.fire();
  assert.equal(h.fetches.length, 2);
  assert.match(h.book.info().error ?? "", /503/);
  assert.match(h.logs.at(-1)!, /refresh failed, keeping prices from .*HTTP 503/);
  h.reply(async () => ({ ok: true, status: 200, json: async () => api() }));
  h.advance(RETRY_MS);
  await h.fire();
  assert.equal(h.fetches.length, 3);
  assert.equal(h.book.info().error, null);
});

test("refresh now: forced pull; a download closes the current period and opens one, never touching earlier ones", async () => {
  const handDated = mergeFetched(seed(), normalizeModelsDev(api(3), aliases), "2026-09-10T00:00:00.000Z").table;
  // The operator moved the change to its announced date by hand.
  const m = handDated.models["anthropic/claude-opus-5-5"]!;
  m.periods[0]!.until = "2026-09-08T00:00:00.000Z";
  m.periods[1]!.from = "2026-09-08T00:00:00.000Z";
  const h = harness({ file: handDated });
  h.reply(async () => ({ ok: true, status: 200, json: async () => api(2) }));
  let changes = 0;
  h.book.onChange(() => changes++);
  assert.equal(await h.book.refresh(true), true);
  assert.equal(changes, 1);
  const periods = h.book.table().models["anthropic/claude-opus-5-5"]!.periods;
  assert.deepEqual(
    periods.map((p) => [p.from, p.until]),
    [
      [null, "2026-09-08T00:00:00.000Z"],
      ["2026-09-08T00:00:00.000Z", "2026-09-28T00:00:00.000Z"],
      ["2026-09-28T00:00:00.000Z", null],
    ],
  );
  const info = h.book.info();
  assert.equal(info.changedAt, "2026-09-28T00:00:00.000Z");
  assert.deepEqual(info.lastChange, { added: [], changed: ["anthropic/claude-opus-5-5"] });
  assert.deepEqual(JSON.parse(readFileSync(h.path, "utf8")).lastChange, info.lastChange, "kept in the file");
  // A pull with nothing new keeps the last change.
  h.advance(PULL_MS);
  await h.book.refresh(true);
  assert.deepEqual(h.book.info().lastChange, { added: [], changed: ["anthropic/claude-opus-5-5"] });
});

test("hand edits are picked up by reload; a broken edit keeps the prices in use", () => {
  const h = harness({ file: seed() });
  let changes = 0;
  h.book.onChange(() => changes++);
  assert.equal(h.book.reload(), false);
  const edited = seed();
  edited.models["anthropic/claude-opus-5-5"]!.periods[0]!.rates.input = 7;
  writeFileSync(h.path, JSON.stringify(edited));
  assert.equal(h.book.reload(), true);
  assert.equal(changes, 1);
  writeFileSync(h.path, "{broken");
  assert.equal(h.book.reload(), false);
  const p = h.book.priceUsage({ provider: "anthropic", model: "claude-opus-5-5" }, use({ input: M }), "2026-09-28T00:00:00Z");
  assert.ok(p.status === "priced" && p.usd.input === 7);
});

test("fetching off: never pulls, not even on demand; a corrupt file prices from the seed and is not overwritten", async () => {
  const h = harness({ enabled: false, file: "{not json" });
  h.book.start();
  await h.fire();
  assert.equal(await h.book.refresh(true), false);
  assert.deepEqual(h.fetches, []);
  assert.equal(readFileSync(h.path, "utf8"), "{not json");
  assert.equal(h.book.table().fetchedAt, T0);
  assert.equal(existsSync(h.path), true);
  assert.equal(fetchEnabled({ SOVA_PRICES_FETCH: "off" }), false);
  assert.equal(fetchEnabled({ NODE_ENV: "test" }), false);
  assert.equal(fetchEnabled({}), true);
});
