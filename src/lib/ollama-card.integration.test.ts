import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageProvider } from "../../shared/protocol";
// @ts-expect-error the shared SSR test compiler is an untyped .mjs helper
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const { clockTime, dateClock, stampTime } = await import("./format");
const { UsageRow } = await importSsr(new URL("../components/UsageView.tsx", import.meta.url), (s: string) => import.meta.resolve(s));
const now = Date.parse("2026-03-03T12:00:00Z");
const from = "2026-03-01T00:00:00Z", until = "2026-03-03T12:00:00Z";
const p = (extra: Partial<UsageProvider> = {}): UsageProvider => ({ id: "ollama", state: "na", windows: [], activity: { fetchedAt: now, data: { range: "7d", scope: "self", from, until, totals: { request_count: 9, input_tokens: 12, cached_input_tokens: 5 }, buckets: [{ from, until: "2026-03-02T00:00:00Z", usage_usd: 0, partial: false }, { from: "2026-03-03T00:00:00Z", until, usage_usd: 1.25, partial: true }] } }, credits: { fetchedAt: now, data: { included: { balance_usd: 8, allowance_usd: 17, period: { from, until: "2026-04-01T00:00:00Z" } }, purchased: { balance_usd: 3 } } }, ...extra });
const draw = (value: UsageProvider) => renderToString(() => solid.createComponent(UsageRow, { p: value, now }));
const words = (html: string) => html.replace(/<!--.*?-->/g, "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

const iso = (ms: number) => new Date(ms).toISOString();

test("rendered modern Usage card shows independent authoritative included/purchased amounts, local period and activity interval", () => {
 const html = draw(p());
 const text = words(html);
 assert.match(html, /aria-labelledby="u-ollama"/);
 assert.match(html, /aria-labelledby="u-ollama-credits"/);
 assert.match(html, /id="u-ollama-credits"/);
 assert.match(html, /aria-labelledby="u-ollama-activity"/);
 assert.match(html, /id="u-ollama-activity"/);
 assert.match(text, /Included remaining \$8\.00/);
 assert.match(text, /Included allowance \$17\.00/);
 assert.match(text, /Purchased remaining \$3\.00/);
 const figures = html.match(/<div class="usage-credit-figures">([\s\S]*?)<\/div>/)?.[1];
 assert.ok(figures, "credits share one figures block");
 assert.match(words(figures), /Included remaining \$8\.00 Included allowance \$17\.00 Purchased remaining \$3\.00/);
 assert.ok(html.includes(`<time class="usage-period" datetime="${iso(now)}" title="${iso(now)}">${stampTime(now, now)}</time>`), "as-of is the local stamp, its ISO in title");
 assert.ok(text.includes(`Included credits As of ${stampTime(now, now)} `));
 assert.ok(text.includes(`${dateClock(from, now)} → ${dateClock("2026-04-01T00:00:00Z", now)} · end exclusive`), "credit period in local time");
 assert.ok(html.includes('title="2026-04-01T00:00:00Z"'), "the period bound's exact ISO stays in title");
 assert.ok(text.includes(`${dateClock(from, now)} → ${dateClock(until, now)} · end exclusive · self`), "activity interval in local time");
 assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(text), "no raw ISO in visible text");
 assert.ok(!text.includes("UTC"), "no UTC label once times are local");
 assert.match(text, /Reported USD Unknown/);
 assert.match(text, /Requests 9/);
 assert.match(text, /Input tokens 12/);
 assert.match(text, /Cached input tokens \(included in input\) 5/);
 assert.match(text, /Output tokens Unknown/);
 assert.match(text, /Daily reported USD/);
 assert.match(text, /Sun Mar 1 · \$0\.00/);
 assert.match(text, /Mon Mar 2 · Unknown/);
 assert.match(text, /Tue Mar 3 · \$1\.25 · Partial/);
 assert.ok(html.includes(`title="${from} → 2026-03-02T00:00:00Z UTC"`), "a day's exact bucket bounds stay in title");
 assert.match(html, /<svg[^>]*aria-hidden="true"/);
 assert.ok(!html.includes("usage-burn-chart"));
 assert.ok(!text.includes("Monthly"));
 assert.ok(!text.includes("undefined"));
});

test("rendered stale balance does not borrow fresh activity time; no declared reset or reset-day control in any case", () => {
 const value = p();
 value.credits = { ...value.credits!, fetchedAt: now - 60_000, error: "ollama balance HTTP 503" };
 const text = words(draw(value));
 assert.ok(text.includes(`Previous reading · as of ${stampTime(now - 60_000, now)} · ollama balance HTTP 503`));
 assert.ok(text.includes(`Activity As of ${stampTime(now, now)} `));
 assert.ok(!text.includes("Declared subscription reset"), "provider period is authoritative");
 const bare = draw(p({ credits: undefined }));
 const only = words(bare);
 assert.match(only, /Included remaining Unknown/);
 assert.match(only, /Purchased remaining Unknown/);
 assert.ok(!/Declared subscription reset|Reset day|usage-reset-day|usage-declared-reset/.test(bare), "no reset-day line or control without a provider period");
 const legacy = draw(p({ state: "ok", windows: [{ label: "month", pct: 42 }], activity: undefined, credits: undefined }));
 assert.ok(!/Reset day|usage-reset-day|Resets /.test(legacy), "a legacy month has no reset line and no Set control");
});

test("rendered zero allowance/missing amounts have no fabricated percent; legacy still has the original monthly meter", () => {
 const zero = p({ credits: { fetchedAt: now, data: { included: { balance_usd: 0, allowance_usd: 0 }, purchased: { balance_usd: 0 } } } });
 const text = words(draw(zero));
 assert.match(text, /Included remaining \$0\.00/);
 assert.match(text, /Included allowance \$0\.00/);
 assert.match(text, /Purchased remaining \$0\.00/);
 assert.ok(!text.includes("% included credits used"));
 const old = words(draw({ id: "ollama", state: "ok", windows: [{ label: "month", pct: 42 }] }));
 assert.match(old, /Monthly 42% used/);
 assert.ok(!old.includes("Daily reported USD"));
});

test("a day split into buckets labels each with its 12-hour local clock, never a 24-hour time", () => {
 const value = p();
 const a = value.activity!.data!;
 a.from = "2026-03-02T00:00:00Z";
 a.until = "2026-03-03T00:00:00Z";
 a.buckets = [{ from: "2026-03-02T00:00:00Z", until: "2026-03-02T15:00:00Z", usage_usd: 1, partial: false }, { from: "2026-03-02T15:00:00Z", until: "2026-03-03T00:00:00Z", usage_usd: 2, partial: false }];
 const text = words(draw(value));
 assert.ok(text.includes(`Mon Mar 2 ${clockTime("2026-03-02T15:00:00Z")} · $2.00`), text);
 assert.match(clockTime("2026-03-02T15:00:00Z"), /^\d{1,2}:\d{2} [AP]M$/);
 assert.ok(!/\b(1[3-9]|2[0-3]):\d{2}\b/.test(text), "no 24-hour time");
});

test("rendered times follow the viewer's zone; daily buckets keep their UTC calendar day", () => {
 const tz = process.env.TZ;
 try {
  const seen = new Set<string>();
  for (const zone of ["UTC", "America/Los_Angeles", "Asia/Dubai"]) {
   process.env.TZ = zone;
   const text = words(draw(p()));
   seen.add(dateClock(from, now));
   assert.ok(text.includes(`As of ${stampTime(now, now)} `), zone);
   assert.ok(text.includes(`${dateClock(from, now)} → ${dateClock(until, now)} · end exclusive · self`), zone);
   assert.match(text, /Sun Mar 1 · \$0\.00 Mon Mar 2 · Unknown Tue Mar 3 · \$1\.25 · Partial/, zone);
  }
  assert.ok(seen.size > 1, "the zone switch took effect, so the local assertions were exercised");
 } finally {
  if (tz === undefined) delete process.env.TZ;
  else process.env.TZ = tz;
 }
});
