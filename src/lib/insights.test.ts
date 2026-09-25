// Run: npx tsx --test src/lib/insights.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageInsight, UsageProvider } from "../../shared/protocol";
import {
  balanceBreakdown,
  extraUsageMeter,
  meterReset,
  money,
  moneyCompact,
  planLabel,
  PROVIDER_ABBR,
  PROVIDER_NAME,
  providerChip,
  providerProblem,
  resetWhen,
  usageGlance,
  usageSummary,
  usesLine,
  windowLabel,
} from "./insights";

const provider = (p: Partial<UsageProvider> & Pick<UsageProvider, "id">): UsageProvider => ({ state: "ok", windows: [], ...p });

const deepseek = (available: boolean): UsageProvider =>
  provider({ id: "deepseek", balance: { currency: "USD", total: 4.29, granted: 0, toppedUp: 4.29, available } });

test("DeepSeek has a provider name and a foot abbreviation", () => {
  assert.equal(PROVIDER_NAME.deepseek, "DeepSeek");
  assert.equal(PROVIDER_ABBR.deepseek, "DS");
});

test("providerChip: a balance that can't fund calls reads 'Out of credit'", () => {
  assert.deepEqual(providerChip(deepseek(false)), { tone: "error", text: "Out of credit" });
  assert.equal(providerChip(deepseek(true)), null);
});

test("providerChip: a kept balance behind a failed fetch gets no chip, and out of credit still wins", () => {
  assert.equal(providerChip({ ...deepseek(true), error: "deepseek HTTP 500" }), null);
  assert.deepEqual(providerChip({ ...deepseek(false), error: "deepseek HTTP 500" }), { tone: "error", text: "Out of credit" });
});

test("providerProblem: an ok provider with a balance renders the balance, not a note", () => {
  assert.equal(providerProblem(deepseek(true)), null);
  assert.equal(providerProblem(deepseek(false)), null);
  // The generic key branches still read as sentences for DeepSeek.
  assert.deepEqual(providerProblem(provider({ id: "deepseek", state: "nokey" })), {
    lead: "No DeepSeek key in ",
    code: "~/.pi/agent/auth.json",
    rest: ".",
  });
  assert.deepEqual(providerProblem(provider({ id: "deepseek", state: "badkey" })), {
    lead: "DeepSeek refused the key in ",
    code: "~/.pi/agent/auth.json",
    rest: ".",
  });
});

test("usageGlance shows DeepSeek's balance last, and every window provider as a percentage", () => {
  const usage: UsageInsight = {
    available: true,
    fetchedAt: 1789796008254,
    nextFetchAt: null,
    stale: false,
    providers: [
      provider({ id: "claude", windows: [{ label: "7d", pct: 47 }] }),
      provider({ id: "openai", windows: [{ label: "7d", pct: 95 }] }),
      provider({ id: "ollama", windows: [{ label: "month", pct: 80 }] }),
      provider({ id: "zai", windows: [{ label: "5h", pct: 7 }] }),
      deepseek(true),
    ],
  };
  const parts = usageGlance(usage);
  assert.deepEqual(parts.map((p) => p.id), ["claude", "openai", "ollama", "zai", "deepseek"]);
  assert.deepEqual(
    parts.map((p) => `${p.abbr} ${p.amount ?? `${p.pct}%`}`),
    ["C 47%", "O 95%", "OL 80%", "Z 7%", "DS $4"],
  );
  assert.equal(parts[0]!.full, "Claude 7-day 47%");
  assert.equal(parts[1]!.high, true);
  // The money part carries no percentage, and the window parts carry no amount.
  const ds = parts[4]!;
  assert.equal(ds.pct, undefined);
  // The foot rounds to whole units; the tooltip keeps the cents.
  assert.equal(ds.amount, "$4");
  assert.equal(ds.full, "DeepSeek balance $4.29");
  assert.equal(ds.high, false);
  assert.equal(ds.stale, false);
  assert.equal(parts[0]!.amount, undefined);
  // The foot row's tooltip and accessible name spell the providers out.
  assert.equal(
    `Usage: ${parts.map((p) => p.full).join(", ")}`,
    "Usage: Claude 7-day 47%, OpenAI 7-day 95%, Ollama Cloud Monthly 80%, Z.ai 5-hour 7%, DeepSeek balance $4.29",
  );
});

test("money keeps the cents, moneyCompact rounds to whole units", () => {
  assert.equal(money(4.29, "USD"), "$4.29");
  assert.equal(moneyCompact(4.29, "USD"), "$4");
  assert.equal(moneyCompact(4.99, "USD"), "$5");
  assert.equal(moneyCompact(0, "USD"), "$0");
  // An unusable currency code falls back to the code plus the number, at each precision.
  assert.equal(money(4.29, "nope"), "nope 4.29");
  assert.equal(moneyCompact(4.29, "nope"), "nope 4");
});

test("usageGlance: a rounded balance in the row, the exact one in the tooltip", () => {
  const usage: UsageInsight = {
    available: true,
    fetchedAt: 1789796008254,
    nextFetchAt: null,
    stale: false,
    providers: [provider({ id: "deepseek", balance: { currency: "USD", total: 4.99, granted: 0, toppedUp: 4.99, available: true } })],
  };
  const part = usageGlance(usage)[0]!;
  assert.equal(part.amount, "$5");
  assert.equal(part.full, "DeepSeek balance $4.99");
});

test("usageGlance: out of credit is the balance's emphasis, and only an old file is stale", () => {
  const usage = (p: UsageProvider, stale = false): UsageInsight => ({
    available: true,
    fetchedAt: 1789796008254,
    nextFetchAt: null,
    stale,
    providers: [p],
  });
  assert.equal(usageGlance(usage(deepseek(false)))[0]!.high, true);
  const kept = usageGlance(usage({ ...deepseek(true), error: "deepseek HTTP 500" }))[0]!;
  assert.equal(kept.stale, false);
  assert.equal(kept.full, "DeepSeek balance $4.29");
  assert.equal(kept.amount, "$4");
  assert.equal(usageGlance(usage(deepseek(true), true))[0]!.stale, true);
});

test("usageGlance leaves out a DeepSeek without a balance, or one that isn't ok", () => {
  const usage = (p: UsageProvider): UsageInsight => ({
    available: true,
    fetchedAt: 1789796008254,
    nextFetchAt: null,
    stale: false,
    providers: [p],
  });
  // No balance to show: nothing in the foot (it never gets a percentage).
  assert.deepEqual(usageGlance(usage(provider({ id: "deepseek" }))), []);
  assert.deepEqual(usageGlance(usage(provider({ id: "deepseek", state: "nokey" }))), []);
  assert.deepEqual(usageGlance(usage({ ...deepseek(true), state: "error", error: "no data" })), []);
});

test("windowLabel names the known windows", () => {
  assert.equal(windowLabel({ label: "5h", pct: 0 }), "5-hour");
  assert.equal(windowLabel({ label: "month", pct: 0 }), "Monthly");
  assert.equal(windowLabel({ label: "7d scoped", pct: 0, scope: "Fable" }), "7-day Fable");
});

// ---------------------------------------------------------------------------
// Usage cards and the summary lead

const NOW = Date.parse("2026-09-19T05:33:00Z");
const inMs = (ms: number) => new Date(NOW + ms).toISOString();
const usage = (providers: UsageProvider[]): UsageInsight => ({ available: true, fetchedAt: NOW, nextFetchAt: null, stale: false, providers });

test("resetWhen / meterReset: under 24h a duration, else a date, past a clock time; never estimated", () => {
  assert.deepEqual(resetWhen(inMs(2 * 3_600_000 + 17 * 60_000), NOW), { past: false, when: "in 2h 17m" });
  assert.deepEqual(resetWhen("2026-09-25T10:00:00Z", NOW), { past: false, when: "Sep 25" });
  assert.deepEqual(resetWhen(inMs(-60_000), NOW), { past: true });
  assert.equal(resetWhen(undefined, NOW), null);
  assert.equal(resetWhen("soon", NOW), null);
  assert.deepEqual(meterReset({ label: "5h", pct: 96, resetsAt: inMs(2 * 3_600_000 + 17 * 60_000) }, NOW), { lead: "Resets in 2h 17m" });
  assert.deepEqual(meterReset({ label: "7d", pct: 40, resetsAt: "2026-09-25T10:00:00Z" }, NOW), { lead: "Resets Sep 25" });
  const past = meterReset({ label: "5h", pct: 96, resetsAt: inMs(-60_000) }, NOW);
  assert.equal(past?.lead, "Reset at ");
  assert.match(past?.time ?? "", /^(1[0-2]|[1-9]):[0-5]\d [AP]M$/);
  assert.equal(past?.rest, ". New reading at the next refresh.");
  assert.equal(meterReset({ label: "7d", pct: 40 }, NOW), null);
});

test("usesLine: MCP counts with comma thousands, only for mcp with both counts", () => {
  assert.equal(usesLine({ label: "mcp", pct: 1, used: 12, limit: 1000 }), "12 of 1,000 uses");
  assert.equal(usesLine({ label: "mcp", pct: 1, used: 12 }), null);
  assert.equal(usesLine({ label: "5h", pct: 1, used: 12, limit: 1000 }), null);
});

test("balanceBreakdown: the non-zero parts, joined; nothing when both are 0", () => {
  const b = { currency: "USD", total: 4.29, granted: 0, toppedUp: 4.29, available: true };
  assert.equal(balanceBreakdown(b), "Topped up $4.29");
  assert.equal(balanceBreakdown({ ...b, granted: 1 }), "Granted $1.00 \u00b7 Topped up $4.29");
  assert.equal(balanceBreakdown({ ...b, toppedUp: 0 }), null);
});

test("planLabel: OpenAI plan or Z.ai level, capitalised, 'plan' never doubled; absent is null", () => {
  assert.equal(planLabel(provider({ id: "openai", plan: "plus" })), "Plus plan");
  assert.equal(planLabel(provider({ id: "zai", level: "pro" })), "Pro plan");
  assert.equal(planLabel(provider({ id: "openai", plan: "Team plan" })), "Team plan");
  assert.equal(planLabel(provider({ id: "openai", plan: " " })), null);
  assert.equal(planLabel(provider({ id: "claude" })), null);
});

test("extraUsageMeter: a fill when there's a reading, 'On' when only switched on, nothing when off", () => {
  assert.deepEqual(extraUsageMeter(provider({ id: "claude", extraUsage: { enabled: true, pct: 42 } })), { pct: 42 });
  assert.deepEqual(extraUsageMeter(provider({ id: "claude", extraUsage: { enabled: true } })), { on: true });
  assert.equal(extraUsageMeter(provider({ id: "claude", extraUsage: { enabled: false, pct: 42 } })), null);
  assert.equal(extraUsageMeter(provider({ id: "claude" })), null);
});

test("usageSummary: null without data; all healthy is one sentence", () => {
  assert.equal(usageSummary(undefined, NOW), null);
  assert.equal(usageSummary({ available: false, reason: "missing", fetchedAt: null, nextFetchAt: null, stale: false, providers: [] }, NOW), null);
  const healthy = usage([
    provider({ id: "claude", windows: [{ label: "5h", pct: 79.4 }], extraUsage: { enabled: true, pct: 100 } }),
    provider({ id: "ollama", state: "na" }),
    deepseek(true),
  ]);
  assert.equal(usageSummary(healthy, NOW), "All providers under limits.");
});

test("usageSummary: one sentence per problem provider, worst state first, payload order", () => {
  const u = usage([
    provider({ id: "claude", windows: [{ label: "5h", pct: 85 }, { label: "7d", pct: 96.4 }] }),
    provider({ id: "openai", windows: [{ label: "5h", pct: 100, resetsAt: inMs(2 * 3_600_000 + 17 * 60_000) }, { label: "7d", pct: 90 }] }),
    provider({ id: "ollama", windows: [{ label: "month", pct: 100, resetsAt: "2026-09-25T10:00:00Z" }] }),
    provider({ id: "zai", windows: [{ label: "5h", pct: 10 }, { label: "mcp", pct: 100 }] }),
    deepseek(false),
  ]);
  assert.equal(
    usageSummary(u, NOW),
    "Claude's 7-day window is at 96%. " +
      "OpenAI's 5-hour window is rate-limited \u2014 resets in 2h 17m. " +
      "Ollama Cloud's Monthly quota is used up \u2014 resets Sep 25. " +
      "Z.ai's MCP uses quota is used up. " +
      "DeepSeek is out of credit.",
  );
});

test("usageSummary: a passed reset drops the suffix; limitReached speaks only without a window sentence", () => {
  const passed = usage([provider({ id: "claude", windows: [{ label: "5h", pct: 100, resetsAt: inMs(-60_000) }] })]);
  assert.equal(usageSummary(passed, NOW), "Claude's 5-hour window is rate-limited.");
  const reached = usage([provider({ id: "openai", limitReached: true, windows: [{ label: "7d", pct: 40 }] })]);
  assert.equal(usageSummary(reached, NOW), "OpenAI's usage limit is reached.");
  const both = usage([provider({ id: "openai", limitReached: true, windows: [{ label: "7d", pct: 100 }] })]);
  assert.equal(usageSummary(both, NOW), "OpenAI's 7-day quota is used up.");
});

test("usageSummary: not-ok states each have a sentence; na and kept readings don't", () => {
  const u = usage([
    provider({ id: "claude", state: "nologin" }),
    provider({ id: "openai", state: "expired" }),
    provider({ id: "ollama", state: "nokey" }),
    provider({ id: "zai", state: "badkey" }),
    provider({ id: "deepseek", state: "error", error: "HTTP 500" }),
  ]);
  assert.equal(
    usageSummary(u, NOW),
    "Claude isn't signed in. OpenAI's sign-in expired. Ollama Cloud needs an API key. Z.ai's API key was refused. DeepSeek's usage couldn't be fetched.",
  );
  const quiet = usage([
    provider({ id: "ollama", state: "na" }),
    provider({ id: "zai", state: "error", error: "timeout", windows: [{ label: "5h", pct: 10 }] }),
    provider({ id: "claude", lastKnown: true, error: "older pi", windows: [{ label: "7d", pct: 10 }] }),
  ]);
  assert.equal(usageSummary(quiet, NOW), "All providers under limits.");
});
