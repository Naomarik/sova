// Run: npx tsx --test src/lib/insights.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageInsight, UsageProvider } from "../../shared/protocol";
import { PROVIDER_ABBR, PROVIDER_NAME, providerChip, providerProblem, usageGlance, windowLabel } from "./insights";

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

test("providerChip: a kept balance behind a failed fetch is Stale, but out of credit wins", () => {
  assert.deepEqual(providerChip({ ...deepseek(true), error: "deepseek HTTP 500" }), { text: "Stale" });
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

test("usageGlance leaves a balance-only provider out and keeps the others in order", () => {
  const usage: UsageInsight = {
    available: true,
    fetchedAt: 1789796008254,
    nextFetchAt: null,
    stale: false,
    providers: [
      provider({ id: "claude", windows: [{ label: "7d", pct: 47 }] }),
      provider({ id: "openai", windows: [{ label: "7d", pct: 95 }] }),
      provider({ id: "ollama", windows: [{ label: "month", pct: 80 }] }),
      provider({ id: "zai", windows: [{ label: "5h", pct: 0 }] }),
      deepseek(true),
    ],
  };
  const parts = usageGlance(usage);
  assert.deepEqual(parts.map((p) => p.id), ["claude", "openai", "ollama", "zai"]);
  assert.deepEqual(parts.map((p) => `${p.abbr} ${p.pct}%`), ["C 47%", "O 95%", "OL 80%", "Z 0%"]);
  assert.equal(parts[0]!.full, "Claude 7-day 47%");
  assert.equal(parts[1]!.high, true);
  // Out of credit doesn't put it in the foot either: the glance is percentages only.
  assert.equal(usageGlance({ ...usage, providers: [deepseek(false)] }).length, 0);
});

test("windowLabel names the known windows", () => {
  assert.equal(windowLabel({ label: "5h", pct: 0 }), "5-hour");
  assert.equal(windowLabel({ label: "month", pct: 0 }), "Monthly");
  assert.equal(windowLabel({ label: "7d scoped", pct: 0, scope: "Fable" }), "7-day Fable");
});
