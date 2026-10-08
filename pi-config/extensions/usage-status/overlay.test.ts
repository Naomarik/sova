// Exercises the actual /usage renderer and input handler on Bun. Only provider I/O and pi-tui
// drawing/key primitives are substituted; no Node module hooks, subprocess or unbounded detail oracle.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const agent = mkdtempSync(join(tmpdir(), "usage-overlay-"));
process.env.PI_CODING_AGENT_DIR = agent;
after(() => rmSync(agent, { recursive: true, force: true }));
// Bun's module mocks cover runtime imports (bundler plugins do not reliably resolve
// this transitive bare package in the named-test runner).
const { mock } = await import("bun:test");
const now = Date.now();
const cache = {
 fetchedAt: now, nextFetchAt: now + 150_000, errors: {},
 ollama: { state: "na", activity: { fetchedAt: now, data: { range: "7d", scope: "self", from: "2026-03-01T00:00:00Z", until: "2026-03-03T12:00:00Z", totals: { request_count: 9, usage_usd: 1.25, input_tokens: 12, cached_input_tokens: 5, output_tokens: 7 }, buckets: [] } }, credits: { fetchedAt: now, data: { included: { balance_usd: 8, allowance_usd: 17, period: { from: "2026-03-01T00:00:00Z", until: "2026-04-01T00:00:00Z" } }, purchased: { balance_usd: 3 } } } },
 openai: { state: "ok", windows: [{ label: "5h", pct: 12 }, { label: "7d", pct: 23 }] },
 claude: { state: "ok", fiveHour: { pct: 34 }, sevenDay: { pct: 45 } },
 zai: { state: "ok", fiveHour: { label: "5h", pct: 56 }, mcp: { used: 2, limit: 100, pct: 2 } },
 deepseek: { state: "ok", available: true, balances: [{ currency: "USD", total: 6.78, granted: 0, toppedUp: 6.78 }] },
};
let publishedResolve!: () => void, forcedResolve!: () => void;
const published = new Promise<void>(r => publishedResolve = r);
const forced = new Promise<void>(r => forcedResolve = r);
let forcedCount = 0;
const codes: Record<string, string> = { down: "\u001b[B", up: "\u001b[A", pageDown: "\u001b[6~", pageUp: "\u001b[5~", end: "\u001b[F", home: "\u001b[H", escape: "\u001b" };
mock.module("@earendil-works/pi-tui", () => ({
 matchesKey: (data: string, key: string) => data === key || data === codes[key],
 truncateToWidth: (s: string, w: number) => s.length <= w ? s : s.slice(0, Math.max(0, w - 1)) + "…",
 visibleWidth: (s: string) => s.length,
}));
mock.module("./fetch", () => ({
 refreshCache: async (force: boolean, _previous: unknown, hooks: any) => {
  hooks.onCache(cache);
  if (force) { forcedCount++; forcedResolve(); } else publishedResolve();
  return { cache, fetched: force, errors: {} };
 },
 describeErrors: () => undefined,
 errMessage: (e: unknown) => e instanceof Error ? e.message : String(e),
 firstReadyLogin: () => undefined,
}));
const { default: usageStatus } = await import("./index.ts");

test("/usage at 24 terminal rows reaches every expanded provider detail through bounded scrolling and preserves refresh/close", async () => {
 const commands = new Map<string, any>();
 usageStatus({ registerCommand: (name: string, command: unknown) => commands.set(name, command), on: () => {} } as any);
 const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
 let component: any, closed = false;
 const context = { mode: "tui", ui: {
  notify: () => assert.fail("unexpected notification"),
  custom: async (factory: any, options: any) => {
   assert.equal(options.overlay, true);
   component = factory({ terminal: { rows: 24 }, requestRender: () => {} }, theme, {}, () => { closed = true; });
   return null;
  },
 }};
 await commands.get("usage").handler("", context);
 await published;
 const frames: string[] = [];
 const capture = () => {
  const lines = component.render(80) as string[];
  assert.ok(lines.length <= Math.floor(24 * 0.9), "each actual viewport respects the terminal's height budget");
  const text = lines.join("\n");
  assert.match(text, /Subscription usage/);
  assert.match(text, /r refresh/);
  assert.match(text, /q\/esc close/);
  frames.push(text);
 };
 capture();
 const first = frames[0];
 component.handleInput("\x1b[6~"); capture();
 assert.notEqual(frames[frames.length - 1], first, "PageDown moves through actual rendered content");
 component.handleInput("\x1b[5~"); capture();
 assert.equal(frames[frames.length - 1], first, "PageUp returns to the first viewport");
 component.handleInput("\x1b[B"); capture();
 assert.notEqual(frames[frames.length - 1], first, "Down moves one content row");
 component.handleInput("\x1b[A"); capture();
 assert.equal(frames[frames.length - 1], first, "Up reverses the one-row move");
 for (let step = 0; step < 80; step++) { component.handleInput("\x1b[B"); capture(); }
 component.handleInput("\x1b[6~"); capture();
 component.handleInput("\x1b[F"); capture();
 assert.match(frames[frames.length - 1]!, /DeepSeek/);
 assert.match(frames[frames.length - 1]!, /\$6\.78/, "End reaches the last provider's final detail");
 assert.equal(closed, false, "reaching the last row never closes the overlay");
 const reached = frames.join("\n");
 for (const detail of ["Included remaining", "Included allowance", "Purchased remaining", "Reported USD", "Input tokens", "Cached input tokens (included in input)", "Output tokens", "OpenAI Codex", "Claude", "Z.ai GLM Coding Plan", "DeepSeek", "$6.78"]) assert.ok(reached.includes(detail), `${detail} must be reachable without enlarging a normal terminal`);
 assert.ok(frames.some((frame) => /scroll|↑|↓|Pg/.test(frame)), "scrolling is discoverable in visible keyboard hints");
 component.handleInput("\x1b[H"); capture();
 assert.match(frames[frames.length - 1]!, /Ollama Cloud/, "Home returns to the first provider");
 component.handleInput("r");
 await forced;
 assert.equal(forcedCount, 1, "refresh remains available while viewing details");
 component.handleInput("q");
 assert.equal(closed, true, "close remains available after scrolling/refresh");
 component.dispose();
 closed = false;
 await commands.get("usage").handler("", context);
 component.handleInput("\x1b");
 assert.equal(closed, true, "Escape retains its close behavior");
 component.dispose();
});
