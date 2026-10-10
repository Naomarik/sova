import assert from "node:assert/strict";
import { test } from "node:test";
import { usageProvider, withBurn } from "./insights";
import { readingsOf } from "./usage-history";
import { fetchOllamaPair, normalizeOllama, type CacheFile } from "../pi-config/extensions/usage-status/fetch.ts";
const at = Date.parse("2026-03-03T12:00:00Z");
const activity = { range: "7d", scope: "self", from: "2026-03-01T00:00:00Z", until: "2026-03-03T12:00:00Z", totals: { request_count: 9, usage_usd: 1.25, input_tokens: 12, cached_input_tokens: 5 }, buckets: [], customer: "discard" };
const credits = { included: { balance_usd: 8, allowance_usd: 17, period: { from: "2026-03-01T00:00:00Z", until: "2026-04-01T00:00:00Z" } }, purchased: { balance_usd: 3 }, customer: "discard" };

test("server validates persisted modern readings and keeps independent times/errors without quota windows, resets, burn or history", () => {
 const p = usageProvider("ollama", { state: "na", activity: { data: activity, fetchedAt: at, customer: "discard" }, credits: { data: credits, fetchedAt: at - 100, error: "ollama balance HTTP 503" } }, "ollama balance HTTP 503");
 assert.equal(p.state, "na");
 assert.deepEqual(p.windows, []);
 assert.equal(p.activity!.fetchedAt, at);
 assert.equal(p.credits!.fetchedAt, at - 100);
 assert.equal(p.credits!.error, "ollama balance HTTP 503");
 assert.equal(p.activity!.data!.totals.output_tokens, undefined);
 assert.equal(p.activity!.data!.totals.input_tokens, 12);
 assert.equal(p.activity!.data!.totals.cached_input_tokens, 5);
 assert.ok(!JSON.stringify(p).includes("discard"));
 assert.deepEqual(withBurn(p, "ollama", at), p);
});

test("server keeps valid independent persisted fields, sanitizes unknown errors and rejects malformed metric values", () => {
 const p = usageProvider("ollama", { state: "na", activity: { data: { ...activity, totals: { request_count: 2, usage_usd: "zero", output_tokens: -1, input_tokens: 3.2, cached_input_tokens: 0 } }, fetchedAt: Infinity, error: "customer identity" }, credits: { data: { included: { balance_usd: -1, allowance_usd: 0 }, purchased: { balance_usd: 0 } }, fetchedAt: at } }, "customer identity");
 assert.deepEqual(p.activity!.data!.totals, { request_count: 2, cached_input_tokens: 0 });
 assert.equal(p.activity!.fetchedAt, undefined);
 assert.equal(p.activity!.error, "ollama reading unavailable");
 assert.deepEqual(p.credits!.data, { included: { allowance_usd: 0 }, purchased: { balance_usd: 0 } });
 assert.ok(!JSON.stringify(p).includes("customer identity"));
 const invalid = usageProvider("ollama", { state: "ok", usedPct: "0", activity: { data: { ...activity, from: "invalid" } } }, undefined);
 assert.equal(invalid.state, "na");
 assert.deepEqual(invalid.windows, []);
 assert.equal(invalid.activity, undefined);
});

test("persisted activity requires requests and a boolean partial flag, independently of valid credits", () => {
 for (const invalid of [
  { ...activity, totals: { usage_usd: 1.25, input_tokens: 12 } },
  { ...activity, totals: { request_count: "9" } },
  { ...activity, buckets: [{ from: activity.from, until: "2026-03-02T00:00:00Z", request_count: 0, partial: "true" }] },
 ]) {
  const p = usageProvider("ollama", { state: "na", activity: { data: invalid, fetchedAt: at }, credits: { data: credits, fetchedAt: at } }, undefined);
  assert.equal(p.activity, undefined, "malformed persisted activity is not a usable empty reading");
  assert.equal(p.credits!.data!.included!.balance_usd, 8, "independent credits survive");
 }
 const legacyMetrics = usageProvider("ollama", { state: "na", activity: { data: { ...activity, totals: { request_count: 9 }, buckets: [{ from: activity.from, until: "2026-03-02T00:00:00Z", request_count: 0 }] }, fetchedAt: at } }, undefined);
 assert.equal(legacyMetrics.activity!.data!.totals.request_count, 9);
 assert.equal(legacyMetrics.activity!.data!.totals.usage_usd, undefined);
 assert.equal(legacyMetrics.activity!.data!.buckets[0]!.usage_usd, undefined);
});

test("legacy cache percent remains a monthly window with no reset; an authoritative provider period supersedes it", () => {
 const old = usageProvider("ollama", { state: "ok", usedPct: 42 }, undefined);
 assert.deepEqual(old.windows, [{ label: "month", pct: 42 }]);
 const modern = usageProvider("ollama", { state: "ok", usedPct: 42, credits: { data: credits, fetchedAt: at } }, undefined);
 assert.deepEqual(modern.windows, []);
 assert.equal(modern.credits!.data!.included!.period!.until, "2026-04-01T00:00:00.000Z");
 const zero = usageProvider("ollama", { state: "ok", usedPct: 0 }, undefined);
 assert.equal(zero.windows[0]!.pct, 0);
});

test("fresh legacy usage survives balance503 in monthly history; usage503 with fresh balance records no legacy sample", async () => {
 const stamp = at + 1000;
 const previous = { state: "ok" as const, usedPct: 12 };
 const roundtrip = async (usageStatus: number, balanceStatus: number) => {
  const request: typeof fetch = async (url) => {
   const isBalance = String(url).endsWith("/balance");
   return new Response(JSON.stringify(isBalance ? credits : { limits: { monthly: { usage: 0.375 } } }), { status: isBalance ? balanceStatus : usageStatus });
  };
  const result = await fetchOllamaPair(previous, () => stamp, { key: "synthetic-key", request });
  const cache: CacheFile = JSON.parse(JSON.stringify({ schemaVersion: 3, fetchedAt: stamp, nextFetchAt: stamp + 150_000, ollama: result.data, errors: result.error ? { ollama: result.error } : {} }));
  return { cache, samples: readingsOf(cache, { accounts: {} }) };
 };
 const reverse = await roundtrip(503, 200);
 assert.equal(reverse.cache.errors.ollama, "ollama activity HTTP 503");
 assert.equal(reverse.cache.ollama!.credits!.fetchedAt, stamp);
 assert.deepEqual(reverse.samples, [], "fresh balance cannot republish a kept legacy percentage as new usage");
 const fresh = await roundtrip(200, 503);
 assert.equal(fresh.cache.errors.ollama, "ollama balance HTTP 503");
 assert.equal(fresh.cache.ollama!.state, "ok");
 assert.deepEqual(fresh.samples, [{ series: "ollama", window: "month", label: "month", t: stamp, pct: 37.5 }], "balance failure must not suppress a successful legacy usage sample");
});

test("legacy history uses validated usage-endpoint time, rejects retained or malformed status, and supports old caches", () => {
 const sample = (raw: unknown, errors = {}) => readingsOf({ fetchedAt: at + 9000, nextFetchAt: at + 150_000, errors, ollama: normalizeOllama(raw) } as CacheFile, { accounts: {} });
 const legacy = { state: "ok", usedPct: 37.5 };
 assert.equal(sample({ ...legacy, usageEndpoint: { fetchedAt: at } }, { ollama: "ollama balance HTTP 503" })[0]!.t, at, "sample time belongs to usage, not the later shared cache write");
 assert.deepEqual(sample({ ...legacy, usageEndpoint: { fetchedAt: at, error: "ollama activity HTTP 503" } }), [], "a retained percentage is never fresh even without an aggregate error");
 for (const usageEndpoint of [{}, null, { fetchedAt: -1 }, { fetchedAt: "123" }, { fetchedAt: Infinity }, { fetchedAt: at, error: "untrusted identity" }]) {
  assert.deepEqual(sample({ ...legacy, usageEndpoint }), [], "explicit invalid status cannot fall back to shared cache time");
 }
 assert.equal(sample(legacy)[0]!.t, at + 9000, "old caches without endpoint metadata still use their file time");
 assert.deepEqual(sample(legacy, { ollama: "old fetch failure" }), [], "old failed caches still exclude retained readings");
});

test("activity dollars and authoritative credits never enter percentage history, including mixed/old-looking caches", () => {
 const cache = (ollama: unknown) => ({ fetchedAt: at, nextFetchAt: at + 150_000, errors: {}, ollama }) as CacheFile;
 const samples = (o: unknown) => readingsOf(cache(o), { accounts: {} });
 assert.deepEqual(samples({ state: "na", activity: { data: activity, fetchedAt: at } }), []);
 assert.deepEqual(samples({ state: "na", credits: { data: credits, fetchedAt: at } }), []);
 assert.deepEqual(samples({ state: "ok", usedPct: 42, credits: { data: credits, fetchedAt: at } }), []);
 const legacy = samples({ state: "ok", usedPct: 42 })[0]!;
 assert.ok("pct" in legacy);
 assert.equal(legacy.pct, 42, "legacy monthly quota history remains intact");
});
