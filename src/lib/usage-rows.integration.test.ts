import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageClaudeLogin, UsageProvider } from "../../shared/protocol";
// @ts-expect-error the shared SSR test compiler is an untyped .mjs helper
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const { UsageRow, ClaudeAccountRows } = await importSsr(new URL("../components/UsageView.tsx", import.meta.url), (s: string) => import.meta.resolve(s));
const now = Date.parse("2026-10-09T12:00:00Z");
const H = 3_600_000;

/** The element `<div class="{cls}"…>` opens, through its matching `</div>`. */
function block(html: string, cls: string): string {
  const start = html.indexOf(`<div class="${cls}"`);
  assert.ok(start >= 0, `no .${cls}`);
  const tag = /<(\/?)div\b[^>]*>/g;
  tag.lastIndex = start;
  let depth = 0;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  throw new Error(`.${cls} never closes`);
}
const count = (html: string, re: RegExp) => html.match(re)?.length ?? 0;

const claude: UsageProvider = {
  id: "claude",
  state: "ok",
  windows: [
    { label: "5h", pct: 42, resetsAt: new Date(now + 2 * H).toISOString() },
    { label: "7d", pct: 61, resetsAt: new Date(now + 50 * H).toISOString() },
  ],
};
const login = (id: string, label: string, inUse: boolean): UsageClaudeLogin => ({
  id,
  label,
  email: "me@example.com",
  accountUuid: "acct-1",
  planLabel: "Max 20x",
  enabled: true,
  signedIn: true,
  standing: { state: "ready" },
  inUse,
  usage: claude,
  fetchedAt: now - 60_000,
});

test("a 2-login Claude account is one row: its logins sit outside its lines, and each window is one line", () => {
  const html = renderToString(() => solid.createComponent(ClaudeAccountRows, { logins: [login("l-0000000a", "Work", true), login("l-0000000b", "Spare", false)], now }));
  assert.equal(count(html, /<article class="usage-row"/g), 1, "the account's logins share one row");
  assert.match(html, /<h2 class="usage-row-title" id="u-claude-l-0000000a">me@example\.com<\/h2>/);
  const lines = block(html, "usage-row-lines");
  assert.equal(count(lines, /class="usage-line"/g), 2, "one line per window");
  assert.equal(count(lines, /class="meter usage-line-meter[^"]*"/g), 2, "each line has one meter block");
  assert.ok(!lines.includes("usage-logins"), "the logins list is not inside the lines");
  const logins = block(html, "usage-logins");
  assert.equal(count(logins, /data-login="/g), 2);
  assert.ok(html.indexOf(logins) > html.indexOf(lines), "the logins follow the lines in DOM order");
});

test("a DeepSeek row is one balance line with no trend block", () => {
  const html = renderToString(() =>
    solid.createComponent(UsageRow, { p: { id: "deepseek", state: "ok", windows: [], balance: { currency: "USD", total: 19.99, granted: 0, toppedUp: 19.99, available: true } }, now }),
  );
  assert.match(html, /<h2 class="usage-row-title" id="u-deepseek">DeepSeek<\/h2>/);
  assert.equal(count(html, /class="usage-line"/g), 1);
  assert.ok(!html.includes("usage-line-trend"), "a balance with no spend line has no trend block");
});
