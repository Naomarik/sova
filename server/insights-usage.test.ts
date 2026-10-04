// Run: npx tsx --test server/insights-usage.test.ts
// Uses a throwaway PI_CODING_AGENT_DIR in the OS temp dir and the runner's throwaway home
// (hermetic-env.mjs, or test:bun's environment); ~/.pi and the real credential files are never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { UsageProvider } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-usage-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the module below computes USAGE_FILE
// Credential files (auth-status) resolve under os.homedir(), which Bun won't let a test move in-process:
// the runner's throwaway home, and no other.
const home = homedir();
assert.ok(process.env.SOVA_TEST_HOME && home.startsWith(process.env.SOVA_TEST_HOME), `${home} is not the runner's throwaway home`);
const usageFile = join(agentDir, "cache", "usage-status.json");
mkdirSync(join(agentDir, "cache"), { recursive: true });

const { getUsageInsight } = await import("./insights");
const { LAST_KNOWN_REASON, lastKnownUsage, rememberUsage, resetLastKnownCache } = await import("./usage-last-known");
const lastKnownFile = join(agentDir, "sova", "usage-last-known.json");

/** Forget both the parsed-cache memo's input file state and the last-known store's memory. */
function clearStore(): void {
  rmSync(lastKnownFile, { force: true });
  resetLastKnownCache();
}
const readStore = (): any => JSON.parse(readFileSync(lastKnownFile, "utf8"));

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

test("a cache without a deepseek key, and nothing remembered, reports error with no data", async () => {
  clearStore();
  writeCache({});
  const ds = byId((await getUsageInsight()).providers, "deepseek");
  assert.equal(ds.state, "error");
  assert.equal(ds.error, "no data");
  assert.deepEqual(ds.windows, []);
  assert.equal(ds.balance, undefined);
});

// ---------------------------------------------------------------------------
// Last-known readings: an older pi session rewriting the cache with a pre-deepseek schema drops
// the key entirely, and that absence is the only signal we treat as "not the current source".

const balance = { currency: "USD", total: 4.29, granted: 0, toppedUp: 4.29, available: true };
const dsOk = { state: "ok", available: true, balances: [{ currency: "USD", total: 4.29, granted: 0, toppedUp: 4.29 }] };

test("an absent key falls back to the last known reading, with the older-session reason", async () => {
  clearStore();
  writeCache({ deepseek: dsOk });
  assert.equal(byId((await getUsageInsight()).providers, "deepseek").state, "ok");
  // An older pi rewrites the cache at schemaVersion 2: no deepseek key at all.
  writeCache({});
  const ds = byId((await getUsageInsight()).providers, "deepseek");
  assert.equal(ds.state, "ok");
  assert.deepEqual(ds.balance, balance);
  assert.deepEqual(ds.windows, []);
  assert.equal(ds.error, LAST_KNOWN_REASON);
  assert.equal(ds.error, "an older pi session is rewriting the cache (run /reload in it)");
  assert.equal(ds.lastKnown, true);
});

test("a window provider's absent key comes back the same way", async () => {
  clearStore();
  writeCache({});
  assert.deepEqual(byId((await getUsageInsight()).providers, "claude").windows, [
    { label: "5h", pct: 96, resetsAt: "2026-09-19T07:50:00.621229+00:00" },
    { label: "7d", pct: 41 },
  ]);
  writeFileSync(
    usageFile,
    JSON.stringify({ schemaVersion: 2, fetchedAt: Date.now(), nextFetchAt: null, ollama: { state: "ok", usedPct: 1 }, errors: {}, pad: "y" }),
  );
  const claude = byId((await getUsageInsight()).providers, "claude");
  assert.equal(claude.state, "ok");
  assert.equal(claude.error, LAST_KNOWN_REASON);
  assert.equal(claude.lastKnown, true);
  assert.deepEqual(claude.windows, [
    { label: "5h", pct: 96, resetsAt: "2026-09-19T07:50:00.621229+00:00" },
    { label: "7d", pct: 41 },
  ]);
  // The key that IS there wins, remembered reading or not.
  assert.deepEqual(byId((await getUsageInsight()).providers, "ollama").windows, [{ label: "month", pct: 1 }]);
});

test("a present key is never replaced by the store, whatever it says", async () => {
  clearStore();
  writeCache({ deepseek: dsOk });
  await getUsageInsight();
  for (const [data, state] of [
    [{ state: "badkey" }, "badkey"],
    [{ state: "na" }, "na"],
    [{ state: "ok", available: true, balances: [] }, "na"], // ok without a readable balance
  ] as const) {
    writeCache({ deepseek: data }, { deepseek: "deepseek HTTP 401" });
    const ds = byId((await getUsageInsight()).providers, "deepseek");
    assert.equal(ds.state, state, JSON.stringify(data));
    assert.equal(ds.balance, undefined);
    assert.notEqual(ds.error, LAST_KNOWN_REASON);
    assert.equal(ds.lastKnown, undefined);
  }
});

test("plan, limitReached, level and extraUsage pass through; malformed ones are dropped", async () => {
  writeCache({
    claude: { state: "ok", fiveHour: { pct: 10 }, extraUsage: { enabled: true, pct: 42.5 } },
    openai: { state: "ok", plan: "plus", limitReached: true, windows: [{ label: "7d", pct: 100 }] },
    zai: { state: "ok", level: "pro", fiveHour: { label: "5h", pct: 12 } },
  });
  const ps = (await getUsageInsight()).providers;
  assert.deepEqual(byId(ps, "claude").extraUsage, { enabled: true, pct: 42.5 });
  assert.equal(byId(ps, "openai").plan, "plus");
  assert.equal(byId(ps, "openai").limitReached, true);
  assert.equal(byId(ps, "zai").level, "pro");
  assert.equal(byId(ps, "claude").lastKnown, undefined);

  writeCache({
    claude: { state: "ok", fiveHour: { pct: 10 }, extraUsage: { enabled: true } },
    openai: { state: "ok", plan: 7, limitReached: "yes", windows: [{ label: "7d", pct: 1 }] },
    zai: { state: "ok", level: "", fiveHour: { label: "5h", pct: 12 } },
  });
  const qs = (await getUsageInsight()).providers;
  assert.deepEqual(byId(qs, "claude").extraUsage, { enabled: true }); // switch on, no reading
  for (const key of ["plan", "limitReached", "level"] as const) {
    assert.equal(byId(qs, "openai")[key], undefined);
    assert.equal(byId(qs, "zai")[key], undefined);
  }
  // A claude without extra_usage in the source carries none.
  writeCache({});
  assert.equal(byId((await getUsageInsight()).providers, "claude").extraUsage, undefined);
});

test("a last-known reading keeps its plan, level and extra usage", async () => {
  clearStore();
  writeCache({
    claude: { state: "ok", fiveHour: { pct: 10 }, extraUsage: { enabled: true, pct: 5 } },
    openai: { state: "ok", plan: "pro", windows: [{ label: "7d", pct: 1 }] },
    zai: { state: "ok", level: "lite", fiveHour: { label: "5h", pct: 12 } },
  });
  await getUsageInsight();
  writeFileSync(
    usageFile,
    JSON.stringify({ schemaVersion: 2, fetchedAt: Date.now(), nextFetchAt: null, ollama: { state: "ok", usedPct: 1 }, errors: {}, pad: "z" }),
  );
  resetLastKnownCache(); // read back from disk, the path a restarted server takes
  const ps = (await getUsageInsight()).providers;
  assert.deepEqual(byId(ps, "claude").extraUsage, { enabled: true, pct: 5 });
  assert.equal(byId(ps, "openai").plan, "pro");
  assert.equal(byId(ps, "zai").level, "lite");
  for (const id of ["claude", "openai", "zai"] as const) assert.equal(byId(ps, id).lastKnown, true);
  assert.equal(byId(ps, "ollama").lastKnown, undefined);
});

test("a stored reading older than 24h is ignored", async () => {
  clearStore();
  writeCache({ deepseek: dsOk });
  await getUsageInsight();
  const stored = readStore();
  writeFileSync(lastKnownFile, JSON.stringify({ ...stored, savedAt: Date.now() - 24 * 60 * 60_000 - 1000 }));
  resetLastKnownCache();
  writeCache({});
  const ds = byId((await getUsageInsight()).providers, "deepseek");
  assert.equal(ds.state, "error");
  assert.equal(ds.error, "no data");
  assert.equal(lastKnownUsage("deepseek"), null);
});

test("the store only ever holds ok readings that carry data, and never an error", async () => {
  clearStore();
  writeCache({ deepseek: { state: "nokey" }, claude: { state: "ok", fiveHour: { pct: 3 } } }, { claude: "claude HTTP 500" });
  await getUsageInsight();
  const stored = readStore();
  assert.equal(stored.version, 1);
  assert.ok(typeof stored.savedAt === "number" && stored.savedAt > 0);
  assert.equal(stored.providers.deepseek, undefined); // not ok
  assert.deepEqual(stored.providers.claude, { id: "claude", state: "ok", windows: [{ label: "5h", pct: 3 }] });
  assert.equal("error" in stored.providers.claude, false);
  // Nothing to add: an unchanged reading doesn't rewrite the file.
  const before = statSync(lastKnownFile).mtimeMs;
  writeCache({ claude: { state: "ok", fiveHour: { pct: 3 } } });
  await getUsageInsight();
  assert.equal(statSync(lastKnownFile).mtimeMs, before);
  // A changed reading does.
  rememberUsage([{ id: "claude", state: "ok", windows: [{ label: "5h", pct: 9 }] }]);
  assert.deepEqual(readStore().providers.claude, { id: "claude", state: "ok", windows: [{ label: "5h", pct: 9 }] });
});

test("a corrupt or absent store is empty, not a throw", () => {
  writeFileSync(lastKnownFile, "{ not json");
  resetLastKnownCache();
  assert.equal(lastKnownUsage("deepseek"), null);
  writeFileSync(lastKnownFile, JSON.stringify({ version: 9, savedAt: Date.now(), providers: { deepseek: { state: "ok", windows: [], balance } } }));
  resetLastKnownCache();
  assert.equal(lastKnownUsage("deepseek"), null);
  clearStore();
  assert.equal(lastKnownUsage("deepseek"), null);
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

test("auth: the sign-in rides on its provider, and only there", async () => {
  const exp = Date.now() + 5 * 3_600_000;
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "FIXTUREtokenNeverSent", expiresAt: exp } }));
  try {
    writeCache({});
    const u = await getUsageInsight();
    assert.deepEqual(byId(u.providers, "claude").auth, { kind: "oauth", source: "claude-cli", expiresAt: exp, expired: false });
    for (const id of ["openai", "ollama", "zai", "deepseek"] as const) assert.equal(byId(u.providers, id).auth, undefined, id);
    assert.ok(!JSON.stringify(u).includes("FIXTUREtoken"));
  } finally {
    rmSync(join(home, ".claude", ".credentials.json"), { force: true });
  }
  writeCache({});
  assert.equal(byId((await getUsageInsight()).providers, "claude").auth, undefined, "signed out: no auth");
});

test("a cache without claudeAccounts carries over only the readings of logins still held here", async () => {
  const { carriedClaudeAccounts } = await import("./insights");
  const reading = (pct: number) => ({ usage: { id: "claude" as const, state: "ok" as const, windows: [{ label: "7d", pct }] }, fetchedAt: 1 });
  const prev = { "l-0000000a": reading(10), "l-0000000b": reading(100) };
  assert.deepEqual(carriedClaudeAccounts(prev, ["l-0000000a"]), { "l-0000000a": reading(10) }, "b was handed back: its reading goes with it");
  assert.equal(carriedClaudeAccounts(prev, []), undefined, "nothing held here: nothing carried");
  assert.equal(carriedClaudeAccounts(undefined, ["l-0000000a"]), undefined);
});

test("Claude Code's own login is dated by the cache's claudeFetchedAt, else the file's fetchedAt", async () => {
  writeCache({ claudeFetchedAt: 12_345, claudeNextFetchAt: 99_999 });
  const u = await getUsageInsight();
  const own = u.claudeLogins?.find((l) => l.id === "default");
  assert.ok(own, "this host lists Claude Code's own login");
  assert.equal(own.fetchedAt, 12_345);
  assert.notEqual(u.fetchedAt, 12_345, "the file's own age is unchanged");
  writeCache({});
  const older = (await getUsageInsight()).claudeLogins?.find((l) => l.id === "default");
  assert.equal(older?.fetchedAt, (await getUsageInsight()).fetchedAt);
});

test("Ollama's month takes its span from the declared reset day as usage is read, never from the cache", async () => {
  const { setUsageResetDay, withDeclaredReset } = await import("./insights");
  writeCache({});
  rmSync(join(agentDir, "usage-windows.json"), { force: true });
  const unset = await getUsageInsight();
  assert.equal(unset.ollamaResetDay, null);
  assert.deepEqual(byId(unset.providers, "ollama").windows, [{ label: "month", pct: 75.6 }], "no day: no reset, no start");
  const set = await setUsageResetDay({ provider: "ollama", day: 14 });
  assert.ok(!("error" in set));
  assert.equal(set.ollamaResetDay, 14);
  const w = byId(set.providers, "ollama").windows[0]!;
  assert.equal(w.declared, true);
  const start = new Date(w.startsAt!);
  const end = new Date(w.resetsAt!);
  assert.deepEqual([start.getDate(), start.getHours(), end.getDate(), end.getHours()], [14, 0, 14, 0]);
  assert.ok(start.getTime() <= Date.now() && Date.now() < end.getTime());
  // The cache file itself never gains it.
  assert.equal(JSON.parse(readFileSync(usageFile, "utf8")).ollama.resetsAt, undefined);
  assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "usage-windows.json"), "utf8")), { version: 1, ollama: { resetDay: 14 } });
  // A rollover shows without a fetch: the same reading, read a month on.
  const p = byId(set.providers, "ollama");
  const later = withDeclaredReset({ ...p, windows: [{ label: "month", pct: 75.6 }] }, 14, end.getTime() + 3_600_000).windows[0]!;
  assert.equal(later.startsAt, w.resetsAt);
  // Other providers never gain a declared reset.
  assert.equal(byId(set.providers, "openai").windows[0]!.declared, undefined);
  const cleared = await setUsageResetDay({ provider: "ollama", day: null });
  assert.ok(!("error" in cleared) && cleared.ollamaResetDay === null);
  for (const bad of [{ provider: "openai", day: 3 }, { provider: "ollama", day: 0 }, { provider: "ollama", day: 32 }, { provider: "ollama", day: 2.5 }, { provider: "ollama" }, null])
    assert.ok("error" in (await setUsageResetDay(bad)), JSON.stringify(bad));
});

test("an OpenAI window with its own length sends its start", async () => {
  writeCache({ openai: { state: "ok", windows: [{ label: "7d", pct: 97, resetsAt: "2026-10-08T17:30:59.000Z", seconds: 604_800 }, { label: "pri", pct: 5, seconds: 3600 }] } });
  const insight = await getUsageInsight();
  assert.deepEqual(byId(insight.providers, "openai").windows, [
    { label: "7d", pct: 97, resetsAt: "2026-10-08T17:30:59.000Z", startsAt: "2026-10-01T17:30:59.000Z" },
    { label: "pri", pct: 5 },
  ]);
});
