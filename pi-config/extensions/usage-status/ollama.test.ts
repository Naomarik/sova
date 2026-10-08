import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const agent = mkdtempSync(join(tmpdir(), "ollama-usage-"));
process.env.PI_CODING_AGENT_DIR = agent;
after(() => rmSync(agent, { recursive: true, force: true }));
const { CACHE_SCHEMA, FRESH_MS, fetchOllama, fetchOllamaBalance, fetchOllamaPair, normalizeOllama, readCache, writeCache } = await import("./fetch.ts");
import { creditsCurrent, includedPct, parseActivity, parseCredits, parseReading, utc } from "./ollama.ts";
import { ollamaCompact, ollamaDetail } from "./ollama-presentation.ts";
const from = "2026-03-01T00:00:00Z", until = "2026-03-03T12:00:00Z";
const at = Date.parse("2026-03-03T12:00:00Z");
const activity = (extra = {}) => ({ range: "7d", scope: "self", from, until, totals: { request_count: 9, usage_usd: 1.25, input_tokens: 12, cached_input_tokens: 5, output_tokens: 7 }, buckets: [{ from, until: "2026-03-02T00:00:00Z", request_count: 0, usage_usd: 0 }, { from: "2026-03-03T00:00:00Z", until, request_count: 9, usage_usd: 1.25, partial: true }], ...extra });
const balance = (extra = {}) => ({ included: { balance_usd: 8, allowance_usd: 17, period: { from, until: "2026-04-01T00:00:00Z" } }, purchased: { balance_usd: 3 }, ...extra });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function transport(a: unknown, b: unknown, statuses = [200, 200]) {
 const asked: { url: URL; authorization: string | null }[] = [];
 const request: typeof fetch = async (input, options) => {
  const url = new URL(String(input));
  asked.push({ url, authorization: new Headers(options?.headers).get("Authorization") });
  return response(url.pathname.endsWith("balance") ? b : a, statuses[url.pathname.endsWith("balance") ? 1 : 0]);
 };
 return { asked, request, key: "synthetic-key" };
}

test("activity parses independent optional metrics, includes cached input without summing it, and allowlists metadata", () => {
 const a = parseActivity(activity({ identity: "not for the cache", granularity: "day" }))!;
 assert.equal(a.totals.input_tokens, 12);
 assert.equal(a.totals.cached_input_tokens, 5);
 assert.equal(a.buckets[0]!.usage_usd, 0);
 assert.equal(a.buckets[1]!.partial, true);
 assert.ok(!("identity" in a));
 assert.ok(!("granularity" in a), "unused metadata is neither required nor retained");
 const missing = parseActivity(activity({ totals: { request_count: 2, input_tokens: -1, usage_usd: Infinity, output_tokens: 4, cached_input_tokens: Number.MAX_SAFE_INTEGER + 1 } }))!;
 assert.deepEqual(missing.totals, { request_count: 2, output_tokens: 4 });
 const zero = parseActivity(activity({ totals: { request_count: 0, usage_usd: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } }))!;
 assert.equal(zero.totals.usage_usd, 0);
 assert.equal(parseActivity(activity({ totals: { request_count: 2 } }))!.totals.usage_usd, undefined);
 for (const request_count of [undefined, null, -1, 0.5, "0", Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  assert.equal(parseActivity(activity({ totals: { request_count } })), undefined, `required total requests: ${request_count}`);
  assert.equal(parseActivity(activity({ buckets: [{ from, until: "2026-03-02T00:00:00Z", request_count }] })), undefined, `required bucket requests: ${request_count}`);
 }
 assert.equal(parseActivity(activity({ totals: {} })), undefined);
});

test("activity rejects malformed UTC intervals, counts, overlapping/unbounded buckets, unsupported reporting bounds", () => {
 for (const bad of ["2026-02-30T00:00:00Z", "2026-03-01T24:00:00Z", "2026-03-01", "2026-03-01T00:00:00+01:00", "2026-03-01T00:00:00", "not a date"]) assert.equal(utc(bad), undefined, bad);
 assert.equal(utc("2026-03-01T00:00:00.12Z"), "2026-03-01T00:00:00.120Z");
 assert.equal(utc("2026-03-01T00:00:00+00:00"), "2026-03-01T00:00:00.000Z");
 assert.equal(utc("2026-03-01T00:00:00.123456789Z"), "2026-03-01T00:00:00.123456789Z", "no provider boundary precision lost");
 assert.ok(parseActivity(activity({ from: "2026-03-01T00:00:00.000000001Z", buckets: [] })));
 for (const extra of [{ from: until }, { until: from }, { range: "month" }, { range: { toString: "malformed" } }, { scope: "private-user" }, { scope: { toString: "malformed" } }, { totals: [] }, { buckets: Array(33).fill({ from, until }) }, { buckets: [{ from, until: "2026-03-02T01:00:00Z" }] }, { buckets: [{ from: "2026-02-28T00:00:00Z", until: from }] }, { buckets: [activity().buckets[0], activity().buckets[0]] }]) assert.equal(parseActivity(activity(extra)), undefined, JSON.stringify(extra));
 const partial = parseActivity(activity({ buckets: [{ from: "2026-03-03T01:00:00Z", until, request_count: 0, partial: false }] }))!;
 assert.equal(partial.buckets[0]!.partial, true, "bounds can be partial without the provider flag");
 const reportedPartial = parseActivity(activity({ buckets: [{ from, until: "2026-03-02T00:00:00Z", request_count: 0, partial: true }] }))!;
 assert.equal(reportedPartial.buckets[0]!.partial, true, "provider partial means in progress even for full-day bounds");
 for (const partial of ["true", "false", 0, 1, null, {}, []]) assert.equal(parseActivity(activity({ buckets: [{ from, until: "2026-03-02T00:00:00Z", request_count: 0, partial }] })), undefined, `malformed partial: ${JSON.stringify(partial)}`);
});

test("official cloud-usage response uses flattened per-bucket metrics, not a nested metrics object", () => {
 // Public documentation example: https://docs.ollama.com/api/cloud-usage.md (empty buckets omitted there).
 const example = {
  range: "24h", scope: "self", granularity: "hour", from: "2026-09-30T02:00:00Z", until: "2026-10-01T02:30:00Z",
  totals: { request_count: 15, usage_usd: 0.01718, input_tokens: 106000, cached_input_tokens: 46000, output_tokens: 13600 },
  buckets: [
   { from: "2026-09-30T12:00:00Z", until: "2026-09-30T13:00:00Z", request_count: 4, usage_usd: 0.0052, input_tokens: 24000, cached_input_tokens: 0, output_tokens: 3200 },
   { from: "2026-10-01T00:00:00Z", until: "2026-10-01T01:00:00Z", request_count: 8, usage_usd: 0.0088, input_tokens: 64000, cached_input_tokens: 40000, output_tokens: 8000 },
   { from: "2026-10-01T02:00:00Z", until: "2026-10-01T02:30:00Z", partial: true, request_count: 3, usage_usd: 0.00318, input_tokens: 18000, cached_input_tokens: 6000, output_tokens: 2400 },
  ],
 };
 const parsed = parseActivity(example)!;
 assert.ok(parsed);
 assert.equal(parsed.totals.request_count, 15);
 assert.deepEqual(parsed.buckets.map((b) => [b.request_count, b.usage_usd, b.input_tokens, b.cached_input_tokens, b.output_tokens]), [[4, 0.0052, 24000, 0, 3200], [8, 0.0088, 64000, 40000, 8000], [3, 0.00318, 18000, 6000, 2400]]);
 assert.equal(parsed.buckets[2]!.partial, true);
});

test("credits independently preserves zero/valid included fields and purchased, rejects unsafe pairs for percentages", () => {
 const c = parseCredits(balance())!;
 assert.equal(includedPct(c), 9 / 17 * 100);
 assert.equal(c.purchased!.balance_usd, 3);
 assert.deepEqual(parseCredits({ included: { balance_usd: -1, allowance_usd: 0, period: { from: until, until: from } }, purchased: { balance_usd: 0 } }), { included: { allowance_usd: 0 }, purchased: { balance_usd: 0 } });
 assert.equal(includedPct(parseCredits({ included: { balance_usd: 0, allowance_usd: 0 } })), undefined);
 assert.equal(includedPct(parseCredits({ included: { balance_usd: 18, allowance_usd: 17 } })), undefined);
 assert.equal(includedPct(parseCredits({ included: { allowance_usd: 17 } })), undefined);
 assert.deepEqual(parseCredits({ included: null, purchased: { balance_usd: 2 }, customer: "discard" }), { purchased: { balance_usd: 2 } });
 assert.equal(parseCredits({ included: { balance_usd: Infinity }, purchased: { balance_usd: "3" } }), undefined);
 assert.deepEqual(parseCredits({ session: { remaining_percent: 25, resets_at: from }, weekly: { remaining_percent: 100 } }), { session: { remaining_percent: 25, resets_at: "2026-03-01T00:00:00.000Z" }, weekly: { remaining_percent: 100 } });
 assert.equal(parseCredits({ session: { remaining_percent: 101 } }), undefined);
 for (const malformed of [{}, { included: {}, purchased: {} }, { included: { balance_usd: -1 } }, { included: { balance_usd: -1, allowance_usd: "17", period: { from: until, until: from } }, purchased: { balance_usd: -1 } }]) assert.equal(parseCredits(malformed), undefined, "no usable empty or wholly malformed credits");
 const periodOnly = parseCredits({ included: { balance_usd: -1, period: balance().included.period } });
 assert.equal(includedPct(periodOnly), undefined, "a valid period alone does not invent credit amounts");
 assert.equal(creditsCurrent({ data: periodOnly, fetchedAt: at }, at), false);
});

test("modern activity and authoritative balance use the same bearer, no queries or scope changes; legacy percent remains ok", async () => {
 const options = transport(activity(), balance());
 const result = await fetchOllamaPair(undefined, () => at, options);
 assert.equal(result.data.state, "na", "older readers never encounter ok without usedPct");
 assert.equal(result.data.activity!.fetchedAt, at);
 assert.equal(result.data.credits!.fetchedAt, at);
 assert.equal(result.error, undefined);
 assert.deepEqual(options.asked.map((v) => v.url.pathname).sort(), ["/api/balance", "/api/usage"]);
 for (const request of options.asked) {
  assert.equal(request.url.origin, "https://ollama.com");
  assert.equal(request.url.search, "");
  assert.equal(request.authorization, "Bearer synthetic-key");
 }
 assert.deepEqual(await fetchOllama(transport({ limits: { monthly: { usage: 0.375 } } }, {})), { state: "ok", usedPct: 37.5 });
 assert.deepEqual(await fetchOllama(transport({ limits: { monthly: { usage: 0 } } }, {})), { state: "ok", usedPct: 0 });
 assert.deepEqual(await fetchOllama(transport({ invalid: true }, {})), { state: "na" });
 assert.equal(CACHE_SCHEMA, 3, "additive shape must not trigger a schema/refetch loop");
 assert.equal(FRESH_MS, 150_000);
});

test("activity/balance independent failure, recovery and mixed stale cycles retain only their own last-success times", async () => {
 const first = await fetchOllamaPair(undefined, () => at, transport(activity(), balance()));
 const bFails = await fetchOllamaPair(first.data, () => at + 100, transport(activity({ totals: { request_count: 10 } }), {}, [200, 503]));
 assert.equal(bFails.data.activity!.fetchedAt, at + 100);
 assert.equal(bFails.data.activity!.data!.totals.usage_usd, undefined, "missing USD is unknown, not carried from a prior total");
 assert.equal(bFails.data.credits!.fetchedAt, at);
 assert.deepEqual(bFails.data.credits!.data, first.data.credits!.data);
 assert.equal(bFails.data.credits!.error, "ollama balance HTTP 503");
 assert.equal(creditsCurrent(bFails.data.credits, at + 100), false);
 const aFails = await fetchOllamaPair(bFails.data, () => at + 200, transport({}, balance({ purchased: { balance_usd: 4 } }), [500, 200]));
 assert.equal(aFails.data.activity!.fetchedAt, at + 100);
 assert.equal(aFails.data.activity!.error, "ollama activity HTTP 500");
 assert.equal(aFails.data.credits!.fetchedAt, at + 200);
 assert.equal(aFails.data.credits!.error, undefined);
 assert.equal(creditsCurrent(aFails.data.credits, at + 200), true);
 const recovered = await fetchOllamaPair(aFails.data, () => at + 300, transport(activity(), balance()));
 assert.equal(recovered.error, undefined);
 assert.equal(recovered.data.activity!.fetchedAt, at + 300);
 assert.equal(recovered.data.credits!.fetchedAt, at + 300);
 const malformed = await fetchOllamaPair(recovered.data, () => at + 400, transport(activity({ from: "invalid" }), { included: { balance_usd: -1 } }));
 assert.equal(malformed.data.activity!.error, "ollama activity unavailable");
 assert.equal(malformed.data.credits!.error, "ollama balance unavailable");
 assert.equal(malformed.data.activity!.fetchedAt, at + 300);
 assert.equal(malformed.data.credits!.fetchedAt, at + 300);
 const succeededAt = recovered.data.credits!.fetchedAt!;
 assert.equal(creditsCurrent(recovered.data.credits, succeededAt + 600_000), true, "exact freshness boundary after recovery");
 assert.equal(creditsCurrent(recovered.data.credits, succeededAt + 600_001), false, "staleness is measured from this endpoint's last success");
 assert.equal(creditsCurrent(recovered.data.credits, Date.parse("2026-04-01T00:00:00Z")), false);
});

test("auth states, HTTP and request/JSON failure preserve old credential behavior and never cache raw errors", async () => {
 let calls = 0;
 const request: typeof fetch = async () => { calls++; throw new Error("raw identity must not leave the process"); };
 const missing = await fetchOllamaPair(undefined, () => at, { key: null, request });
 assert.deepEqual(missing, { data: { state: "nokey", usageEndpoint: { error: "ollama activity no key" } } });
 assert.equal(missing.data.usageEndpoint!.fetchedAt, undefined, "missing credentials never produce a successful usage timestamp");
 assert.equal(missing.error, undefined, "missing credentials retain ordinary cadence, not a retry error");
 assert.deepEqual(normalizeOllama(missing.data), missing.data, "additive endpoint metadata survives cache validation");
 assert.equal(calls, 0, "missing credentials never invoke either endpoint transport");
 for (const status of [401, 403]) {
  const refused = await fetchOllamaPair(undefined, () => at, transport({}, {}, [status, status]));
  assert.equal(refused.data.state, "badkey");
  assert.equal(refused.error, undefined, "auth refusal retains ordinary cadence");
 }
 const prev = (await fetchOllamaPair(undefined, () => at, transport(activity(), balance()))).data;
 const refused = await fetchOllamaPair(prev, () => at + 1, transport({}, {}, [401, 403]));
 assert.equal(refused.data.activity!.error, "ollama activity bad key");
 assert.equal(refused.data.credits!.fetchedAt, at);
 const failed = await fetchOllamaPair(prev, () => at + 1, { key: "synthetic", request });
 assert.equal(failed.data.activity!.error, "ollama activity request failed");
 assert.ok(!JSON.stringify(failed).includes("raw identity"));
 const invalidJson: typeof fetch = async () => new Response("not JSON");
 const badJson = await fetchOllamaPair(prev, () => at + 1, { key: "synthetic", request: invalidJson });
 assert.equal(badJson.data.credits!.error, "ollama balance request failed");
 await assert.rejects(fetchOllamaBalance(transport({}, {}, [200, 502])), /HTTP 502/);
});

test("persisted payload validates again, timestamps cannot throw, and legacy caches remain readable", () => {
 assert.deepEqual(normalizeOllama({ state: "ok", usedPct: 42, customer: "discard" }), { state: "ok", usedPct: 42 });
 const r = parseReading({ data: activity(), fetchedAt: Infinity, error: "customer-secret", customer: "discard" }, parseActivity)!;
 assert.equal(r.fetchedAt, undefined);
 assert.equal(r.error, "ollama reading unavailable");
 assert.ok(!JSON.stringify(r).includes("customer-secret"));
 assert.equal(parseReading({ data: activity(), fetchedAt: 9e20 }, parseActivity)!.fetchedAt, undefined);
 const malformed = normalizeOllama({ state: "ok", usedPct: "0", activity: { data: activity({ until: from }) } })!;
 assert.equal(malformed.state, "na");
 assert.equal(malformed.activity, undefined);
});

test("old percent caches, modern caches and old writers missing additive readings stay due only at ordinary cadence", async () => {
 const nextFetchAt = Date.now() + 150_000;
 const base = { schemaVersion: CACHE_SCHEMA, fetchedAt: Date.now(), nextFetchAt, errors: {}, openai: { state: "nologin" as const }, zai: { state: "nokey" as const } };
 for (const ollama of [{ state: "ok" as const, usedPct: 42 }, { state: "na" as const }, { state: "na" as const, activity: { data: parseActivity(activity())!, fetchedAt: at }, credits: { data: parseCredits(balance())!, fetchedAt: at, error: "ollama balance HTTP 503" } }]) {
  await writeCache({ ...base, ollama });
  for (let read = 0; read < 2; read++) {
   const cache = await readCache();
   assert.ok(cache);
   assert.equal(cache.nextFetchAt, nextFetchAt, "no refetch loop on absent modern fields, stale credits or a second read");
   assert.equal(cache.ollama!.state, ollama.state);
  }
 }
});

test("pure TUI detail/footer present balances, cached included tokens, missing metrics, stale sources and legacy without undefined percents", () => {
 const o = normalizeOllama({ state: "na", activity: { data: activity({ totals: { request_count: 9, input_tokens: 12, cached_input_tokens: 5 } }), fetchedAt: at }, credits: { data: balance(), fetchedAt: at } })!;
 const detail = ollamaDetail(o, at).join("\n");
 assert.match(detail, /Included remaining: \$8\.00/);
 assert.match(detail, /Included allowance: \$17\.00/);
 assert.match(detail, /Purchased remaining: \$3\.00/);
 assert.match(detail, /Reported USD: Unknown/);
 assert.match(detail, /Cached input tokens \(included in input\): 5/);
 assert.match(detail, /end exclusive/);
 assert.ok(!detail.includes("undefined"));
 assert.equal(ollamaCompact(o, at), "oll incl $8.00");
 assert.equal(ollamaCompact({ ...o, credits: { ...o.credits, error: "ollama balance HTTP 503" } }, at), "oll credits ?");
 assert.match(ollamaDetail({ ...o, credits: { ...o.credits, error: "ollama balance HTTP 503" } }, at).join("\n"), /Credits: Previous reading.*HTTP 503/);
 assert.equal(ollamaCompact({ ...o, activity: { ...o.activity, error: "ollama activity HTTP 500" } }, at), "oll incl $8.00", "failed activity does not stale current credits");
 assert.equal(ollamaCompact({ state: "na", activity: o.activity }, at), "oll act 9 req · credits ?");
 assert.equal(ollamaCompact({ state: "ok", usedPct: 42 }, at), undefined, "legacy footer stays on its original percentage renderer");
 assert.equal(ollamaCompact({ state: "ok", usedPct: 42, credits: { error: "ollama balance unavailable" } }, at), undefined, "an unavailable new endpoint does not replace the legacy percent footer");
 assert.deepEqual(ollamaDetail({ state: "ok", usedPct: 42 }, at), [], "legacy detail stays on its original declared-month renderer");
});
