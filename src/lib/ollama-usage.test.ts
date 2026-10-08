import assert from "node:assert/strict";
import { test } from "node:test";
import type { OllamaActivity, OllamaCredits, UsageInsight, UsageProvider } from "../../shared/protocol";
import { activityMetrics, activityTrend, currentIncluded, includedCreditPct } from "./ollama-usage";
import { providerChip, providerProblem, usageSummary } from "./insights";
const now = Date.parse("2026-03-03T12:00:00Z");
const from = "2026-03-01T00:00:00Z", until = "2026-03-03T12:00:00Z";
const activity: OllamaActivity = { range: "7d", scope: "self", from, until, totals: { request_count: 9, input_tokens: 12, cached_input_tokens: 5 }, buckets: [{ from, until: "2026-03-02T00:00:00Z", usage_usd: 0, partial: false }, { from: "2026-03-03T00:00:00Z", until, partial: true }] };
const credits: OllamaCredits = { included: { balance_usd: 8, allowance_usd: 17, period: { from, until: "2026-04-01T00:00:00Z" } }, purchased: { balance_usd: 3 } };
const provider = (extra: Partial<UsageProvider> = {}): UsageProvider => ({ id: "ollama", state: "na", windows: [], activity: { data: activity, fetchedAt: now }, ...extra });
const payload = (p: UsageProvider): UsageInsight => ({ available: true, fetchedAt: now, nextFetchAt: now + 150_000, stale: false, providers: [p] });

test("activity card metrics explicitly include cached input, absent USD/output are unknown and never sums", () => {
 assert.deepEqual(activityMetrics(activity), [
  { label: "Reported USD", value: "Unknown" },
  { label: "Requests", value: "9" },
  { label: "Input tokens", value: "12" },
  { label: "Cached input tokens (included in input)", value: "5" },
  { label: "Output tokens", value: "Unknown" },
 ]);
 const zero = activityMetrics({ ...activity, totals: { usage_usd: 0, request_count: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } });
 assert.equal(zero[0]!.value, "$0.00");
 assert.equal(zero[2]!.value, "0");
});

test("daily trend shows exact UTC dates/intervals, zero dollars distinct from missing days and missing USD, and partial bounds", () => {
 const rows = activityTrend(activity);
 assert.deepEqual(rows.map((r) => [r.date, r.usd, r.partial]), [["2026-03-01", 0, false], ["2026-03-02", undefined, false], ["2026-03-03", undefined, true]]);
 assert.equal(rows[2]!.until, until);
 assert.equal(rows[0]!.from, from);
 assert.equal(activityTrend({ ...activity, from: "2026-03-01T02:00:00Z", buckets: [] })[0]!.partial, true);
 assert.equal(activityTrend({ ...activity, buckets: [{ ...activity.buckets[0]!, partial: true }] })[0]!.partial, true, "in-progress flag retained even for full-day bounds");
 assert.deepEqual(activityTrend({ ...activity, from: "malformed" }), []);
});

test("activity alone has no limit chip or quota problem and the lead explicitly says included credits unknown", () => {
 const p = provider();
 assert.equal(providerChip(p, now), null);
 assert.equal(providerProblem(p, now), null);
 assert.equal(usageSummary(payload(p), now), "No reported limit needs attention. Ollama Cloud's included credits are unknown.");
 const u = payload(p);
 u.providers.unshift({ id: "deepseek", state: "ok", windows: [], balance: { total: 0, granted: 0, toppedUp: 0, currency: "USD", available: false } });
 assert.equal(usageSummary(u, now), "DeepSeek is out of credit. Ollama Cloud's included credits are unknown.");
});

test("positive-allowance current included reading drives status without adding purchased or activity dollars", () => {
 const p = provider({ credits: { data: credits, fetchedAt: now } });
 assert.equal(currentIncluded(p, now), true);
 assert.equal(includedCreditPct(credits), 9 / 17 * 100);
 assert.equal(usageSummary(payload(p), now), "All providers under limits.");
 const highRequestValue = provider({ ...p, activity: { data: { ...activity, totals: { ...activity.totals, usage_usd: 1_700_000 } }, fetchedAt: now }, credits: { data: { ...credits, purchased: { balance_usd: 1_700_000 } }, fetchedAt: now } });
 assert.equal(usageSummary(payload(highRequestValue), now), "All providers under limits.", "neither request value nor purchased credits is the included-credit numerator/denominator");
 const exhausted = provider({ credits: { data: { ...credits, included: { ...credits.included!, balance_usd: 0 } }, fetchedAt: now } });
 assert.equal(providerChip(exhausted, now)!.text, "Included credits used");
 assert.equal(usageSummary(payload(exhausted), now), "Ollama Cloud's included credits are used up.");
 assert.ok(!usageSummary(payload(exhausted), now)!.includes("out of credit"), "purchased credits still remain");
 const failedActivity = provider({ credits: p.credits, activity: { ...p.activity, error: "ollama activity HTTP 500" }, error: "ollama activity HTTP 500" });
 assert.equal(usageSummary(payload(failedActivity), now), "All providers under limits.", "fresh balance is independent of failing activity");
});

test("zero/missing/inconsistent allowance, expired period, old/error reading never justifies all-under-limits", () => {
 for (const data of [{ ...credits, included: { ...credits.included!, allowance_usd: 0 } }, { ...credits, included: { ...credits.included!, balance_usd: 18 } }, { purchased: credits.purchased }, { included: { balance_usd: 0, allowance_usd: 0, period: credits.included!.period } }]) {
  const p = provider({ credits: { data, fetchedAt: now } });
  assert.equal(includedCreditPct(data), undefined);
  assert.equal(currentIncluded(p, now), false);
  assert.equal(providerChip(p, now), null);
  assert.match(usageSummary(payload(p), now)!, /included credits are unknown/);
 }
 for (const reading of [{ data: credits, fetchedAt: now - 600_001 }, { data: credits, fetchedAt: now, error: "ollama balance HTTP 503" }, { data: credits }, { data: { ...credits, included: { ...credits.included!, period: { from, until } } }, fetchedAt: now }]) {
  const p = provider({ credits: reading });
  assert.equal(currentIncluded(p, now), false);
  assert.match(usageSummary(payload(p), now)!, /included credits are unknown/);
 }
});

test("legacy monthly percentage card retains its meter/status without modern endpoint fields", () => {
 const p: UsageProvider = { id: "ollama", state: "ok", windows: [{ label: "month", pct: 42 }] };
 assert.equal(providerProblem(p, now), null);
 assert.equal(providerChip(p, now), null);
 assert.equal(usageSummary(payload(p), now), "All providers under limits.");
 assert.equal(providerChip({ ...p, windows: [{ label: "month", pct: 100 }] }, now)!.text, "Quota used");
});
