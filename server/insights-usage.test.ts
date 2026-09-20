// Run: npx tsx --test server/insights-usage.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { UsageProvider } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-usage-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the module below computes USAGE_FILE
const usageFile = join(agentDir, "cache", "usage-status.json");
mkdirSync(join(agentDir, "cache"), { recursive: true });

const { getUsageInsight } = await import("./insights");

after(() => rmSync(agentDir, { recursive: true, force: true }));

/** Each write needs a distinct (mtime, size) to beat the module's cache; the counter does it. */
let n = 0;
function writeCache(extra: Record<string, unknown>, errors: Record<string, string> = {}): void {
  writeFileSync(
    usageFile,
    JSON.stringify({
      schemaVersion: 3,
      fetchedAt: Date.now(),
      nextFetchAt: Date.now() + 150_000,
      claude: { state: "ok", fiveHour: { pct: 96, resetsAt: "2026-09-19T07:50:00.621229+00:00" }, sevenDay: { pct: 41 } },
      openai: { state: "ok", windows: [{ label: "7d", pct: 95 }] },
      ollama: { state: "ok", usedPct: 75.6 },
      zai: { state: "ok", fiveHour: { label: "5h", pct: 12 }, mcp: { pct: 0, used: 0, limit: 1000 } },
      ...extra,
      errors,
      pad: "x".repeat(n++), // keeps the file size changing between writes
    }),
  );
}

const byId = (providers: UsageProvider[], id: UsageProvider["id"]): UsageProvider => {
  const p = providers.find((x) => x.id === id);
  assert.ok(p, `no ${id} provider`);
  return p;
};

test("deepseek ok: the first readable balance, and never a window", async () => {
  writeCache({ deepseek: { state: "ok", available: true, balances: [{ currency: "USD", total: 4.29, granted: 0, toppedUp: 4.29 }] } });
  const ds = byId((await getUsageInsight()).providers, "deepseek");
  assert.equal(ds.state, "ok");
  assert.deepEqual(ds.windows, []);
  assert.deepEqual(ds.balance, { currency: "USD", total: 4.29, granted: 0, toppedUp: 4.29, available: true });
});

test("deepseek balance: missing granted/toppedUp default to 0, available:false passes through, extra entries ignored", async () => {
  writeCache({
    deepseek: {
      state: "ok",
      available: false,
      balances: [{ currency: "CNY", total: 0 }, { currency: "USD", total: 9 }],
    },
  });
  const ds = byId((await getUsageInsight()).providers, "deepseek");
  assert.deepEqual(ds.balance, { currency: "CNY", total: 0, granted: 0, toppedUp: 0, available: false });
});

test("deepseek ok without a readable balance reports na", async () => {
  for (const balances of [[], [{ currency: "", total: 1 }], [{ currency: "USD" }], ["nope"], undefined]) {
    writeCache({ deepseek: { state: "ok", available: true, ...(balances === undefined ? {} : { balances }) } });
    const ds = byId((await getUsageInsight()).providers, "deepseek");
    assert.equal(ds.state, "na", `balances ${JSON.stringify(balances)}`);
    assert.deepEqual(ds.windows, []);
    assert.equal(ds.balance, undefined);
  }
});

test("a cache without a deepseek key reports error with no data", async () => {
  writeCache({});
  const ds = byId((await getUsageInsight()).providers, "deepseek");
  assert.equal(ds.state, "error");
  assert.equal(ds.error, "no data");
  assert.deepEqual(ds.windows, []);
  assert.equal(ds.balance, undefined);
});

test("deepseek nokey/badkey pass through, with the fetch error when there is one", async () => {
  writeCache({ deepseek: { state: "nokey" } });
  assert.equal(byId((await getUsageInsight()).providers, "deepseek").state, "nokey");
  writeCache({ deepseek: { state: "badkey" } }, { deepseek: "deepseek HTTP 401" });
  const bad = byId((await getUsageInsight()).providers, "deepseek");
  assert.equal(bad.state, "badkey");
  assert.equal(bad.error, "deepseek HTTP 401");
});

test("the other providers still parse, in the order claude, openai, ollama, zai, deepseek", async () => {
  writeCache({ deepseek: { state: "ok", available: true, balances: [{ currency: "USD", total: 4.29, granted: 0, toppedUp: 4.29 }] } });
  const insight = await getUsageInsight();
  assert.equal(insight.available, true);
  assert.deepEqual(insight.providers.map((p) => p.id), ["claude", "openai", "ollama", "zai", "deepseek"]);
  assert.deepEqual(byId(insight.providers, "claude").windows, [
    { label: "5h", pct: 96, resetsAt: "2026-09-19T07:50:00.621229+00:00" },
    { label: "7d", pct: 41 },
  ]);
  assert.deepEqual(byId(insight.providers, "openai").windows, [{ label: "7d", pct: 95 }]);
  assert.deepEqual(byId(insight.providers, "ollama").windows, [{ label: "month", pct: 75.6 }]);
  assert.deepEqual(byId(insight.providers, "zai").windows, [{ label: "5h", pct: 12 }, { label: "mcp", pct: 0, used: 0, limit: 1000 }]);
  // No provider but deepseek carries a balance.
  assert.deepEqual(insight.providers.filter((p) => p.balance).map((p) => p.id), ["deepseek"]);
});

test("a malformed cache is unavailable, not an error", async () => {
  writeFileSync(usageFile, "{ not json");
  const insight = await getUsageInsight();
  assert.equal(insight.available, false);
  assert.equal(insight.reason, "corrupt");
  assert.deepEqual(insight.providers, []);
});
