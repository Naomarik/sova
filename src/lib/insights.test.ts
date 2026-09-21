// Run: npx tsx --test src/lib/insights.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageInsight, UsageProvider } from "../../shared/protocol";
import { money, moneyCompact, PROVIDER_ABBR, PROVIDER_NAME, providerChip, providerProblem, usageGlance, windowLabel } from "./insights";

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
