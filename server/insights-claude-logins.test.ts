// Run: npx tsx --test server/insights-claude-logins.test.ts
// The Usage page's Claude cards (§app.insights/usage-cards): one per login on this host, from a
// throwaway agent dir, HOME and Claude directory with synthetic logins; nothing real is read.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = mkdtempSync(join(tmpdir(), "sova-usage-logins-"));
const agentDir = join(root, "agent");
const claudeDir = join(root, "claude");
process.env.PI_CODING_AGENT_DIR = agentDir; // before insights computes USAGE_FILE
process.env.HOME = root;
process.env.CLAUDE_CONFIG_DIR = claudeDir;
delete process.env.SOVA_DEVICE_ID;
after(() => rmSync(root, { recursive: true, force: true }));

const A = "l-0000000a"; // same account as default
const B = "l-0000000b"; // its own account, limited
const C = "l-0000000c"; // another device's

mkdirSync(join(agentDir, "cache"), { recursive: true });
mkdirSync(claudeDir, { recursive: true });
writeFileSync(join(claudeDir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "acct-1", emailAddress: "own@example.com", organizationType: "claude_max", organizationRateLimitTier: "default_claude_max_20x", billingType: "stripe_subscription" } }));
writeFileSync(join(claudeDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fake-access", expiresAt: Date.now() + 3_600_000 } }));
for (const id of [A, B]) {
  mkdirSync(join(agentDir, "claude-accounts", id), { recursive: true });
  writeFileSync(join(agentDir, "claude-accounts", id, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fake-access", expiresAt: Date.now() + 3_600_000 } }));
}
writeFileSync(
  join(agentDir, "claude-accounts.json"),
  JSON.stringify({
    version: 1,
    logins: [
      { id: A, addedAt: 1, enabled: true, device: "local", identity: { accountUuid: "acct-1", email: "own@example.com", plan: "stripe_subscription", rateLimitTier: "default_claude_max_20x" } },
      { id: B, addedAt: 2, enabled: true, device: "local", label: "Spare", identity: { accountUuid: "acct-2", email: "spare@example.com", plan: "pro" } },
      { id: C, addedAt: 3, enabled: true, device: "other-device", identity: { accountUuid: "acct-3", email: "elsewhere@example.com" } },
    ],
    devices: { local: { order: [B, "default", A] } },
  }),
);
// B is out until an hour from now: the next new chat starts on A, the first usable one (default,
// Claude Code's own login, is always last).
writeFileSync(join(agentDir, "claude-accounts-state.json"), JSON.stringify({ version: 1, logins: { [B]: { kind: "limit", at: Date.now(), until: Date.now() + 3_600_000, window: "five_hour" } } }));

let pad = 0;
function writeCache(extra: Record<string, unknown>): void {
  writeFileSync(
    join(agentDir, "cache", "usage-status.json"),
    JSON.stringify({ schemaVersion: 3, fetchedAt: 1000, nextFetchAt: Date.now() + 150_000, claude: { state: "ok", fiveHour: { pct: 50 } }, errors: {}, ...extra, pad: "x".repeat(pad++) }),
  );
}

const { getUsageInsight } = await import("./insights");

test("one card per login on this host, in its order, with identity, standing, the login in use and its own reading", async () => {
  writeCache({ claudeAccounts: { [B]: { data: { state: "ok", fiveHour: { pct: 100 } }, fetchedAt: 900, nextFetchAt: 0 }, [C]: { data: { state: "ok", fiveHour: { pct: 1 } }, nextFetchAt: 0 } } });
  const u = await getUsageInsight();
  const logins = u.claudeLogins!;
  assert.deepEqual(logins.map((l) => l.id), [B, A, "default"], "this device's order, default last; another device's login is not listed");
  const [b, a, own] = logins as [typeof logins[0], typeof logins[0], typeof logins[0]];
  assert.equal(b.email, "spare@example.com");
  assert.equal(b.label, "Spare");
  assert.equal(b.planLabel, "Pro");
  assert.equal(b.standing.state, "limited");
  assert.equal(b.inUse, false);
  assert.deepEqual(b.usage.windows.map((w) => w.pct), [100]);
  assert.equal(b.fetchedAt, 900);
  assert.equal(b.usage.auth?.kind, "oauth", "each login's sign-in comes from its own credentials file");

  assert.equal(own.email, "own@example.com");
  assert.equal(own.planLabel, "Max 20x", "the tier names the plan, not the billing type");
  assert.equal(own.inUse, false, "default is the last resort");
  assert.equal(a.inUse, true, "B is limited, so new chats start on A");
  assert.deepEqual(own.usage.windows.map((w) => w.pct), [50], "default's reading is the provider card's `claude`");
  assert.equal(own.fetchedAt, 1000);

  assert.equal(a.accountUuid, own.accountUuid, "same account: the page groups them");
  assert.equal(a.planLabel, "Max 20x");
  assert.equal(a.usage.state, "error");
  assert.equal(a.usage.error, "not read yet");
  assert.equal(a.fetchedAt, undefined);
  assert.ok(!JSON.stringify(u).includes("fake-access"), "no token reaches the payload");
});

test("a cache an older pi rewrote without claudeAccounts keeps the logins' last readings", async () => {
  writeCache({ claudeAccounts: { [A]: { data: { state: "ok", fiveHour: { pct: 7 } }, fetchedAt: 950, nextFetchAt: 0 } } });
  assert.deepEqual((await getUsageInsight()).claudeLogins!.find((l) => l.id === A)!.usage.windows.map((w) => w.pct), [7]);
  writeCache({});
  const u = await getUsageInsight();
  assert.deepEqual(u.claudeLogins!.find((l) => l.id === A)!.usage.windows.map((w) => w.pct), [7]);
  assert.equal(u.providers.length, 5, "claudeAccounts is not a provider");
});

test("a login skipped while it needs sign-in keeps its last reading", async () => {
  writeCache({ claudeAccounts: { [A]: { data: { state: "ok", fiveHour: { pct: 33 } }, fetchedAt: 800, nextFetchAt: 0, skipped: "auth" } } });
  const a = (await getUsageInsight()).claudeLogins!.find((l) => l.id === A)!;
  assert.deepEqual(a.usage.windows.map((w) => w.pct), [33]);
  assert.equal(a.fetchedAt, 800);
});
