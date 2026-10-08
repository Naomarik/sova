import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageProvider } from "../../shared/protocol";
// @ts-expect-error the shared SSR test compiler is an untyped .mjs helper
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const { UsageCard } = await importSsr(new URL("../components/UsageView.tsx", import.meta.url), (s: string) => import.meta.resolve(s));
const now = Date.parse("2026-03-03T12:00:00Z");
const from = "2026-03-01T00:00:00Z", until = "2026-03-03T12:00:00Z";
const p = (extra: Partial<UsageProvider> = {}): UsageProvider => ({ id: "ollama", state: "na", windows: [], activity: { fetchedAt: now, data: { range: "7d", scope: "self", from, until, totals: { request_count: 9, input_tokens: 12, cached_input_tokens: 5 }, buckets: [{ from, until: "2026-03-02T00:00:00Z", usage_usd: 0, partial: false }, { from: "2026-03-03T00:00:00Z", until, usage_usd: 1.25, partial: true }] } }, credits: { fetchedAt: now, data: { included: { balance_usd: 8, allowance_usd: 17, period: { from, until: "2026-04-01T00:00:00Z" } }, purchased: { balance_usd: 3 } } }, ...extra });
const draw = (value: UsageProvider, resetDay?: unknown) => renderToString(() => solid.createComponent(UsageCard, { p: value, now, resetDay }));
const words = (html: string) => html.replace(/<!--.*?-->/g, "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

test("rendered modern Usage card shows independent authoritative included/purchased amounts, exact UTC period and activity interval", () => {
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
 assert.match(text, /2026-04-01T00:00:00Z UTC/);
 assert.match(text, /2026-03-03T12:00:00Z UTC/);
 assert.match(text, /Reported USD Unknown/);
 assert.match(text, /Requests 9/);
 assert.match(text, /Input tokens 12/);
 assert.match(text, /Cached input tokens \(included in input\) 5/);
 assert.match(text, /Output tokens Unknown/);
 assert.match(text, /Daily reported USD/);
 assert.match(text, /2026-03-01 · \$0\.00/);
 assert.match(text, /2026-03-02 · Unknown/);
 assert.match(text, /2026-03-03 · \$1\.25 · Partial/);
 assert.match(html, /<svg[^>]*aria-hidden="true"/);
 assert.ok(!html.includes("usage-burn-chart"));
 assert.ok(!text.includes("Monthly"));
 assert.ok(!text.includes("undefined"));
});

test("rendered stale balance does not borrow fresh activity time; provider period is not overwritten by saved reset day", () => {
 const value = p();
 value.credits = { ...value.credits!, fetchedAt: now - 60_000, error: "ollama balance HTTP 503" };
 const text = words(draw(value, { day: 14, save: async () => {} }));
 assert.match(text, /Previous reading · as of 2026-03-03T11:59:00\.000Z · ollama balance HTTP 503/);
 assert.match(text, /Activity As of 2026-03-03T12:00:00\.000Z/);
 assert.ok(!text.includes("Declared subscription reset"), "provider period is authoritative");
 const only = words(draw(p({ credits: undefined }), { day: 14, save: async () => {} }));
 assert.match(only, /Included remaining Unknown/);
 assert.match(only, /Purchased remaining Unknown/);
 assert.match(only, /Declared subscription reset: day 14 of each month/);
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
