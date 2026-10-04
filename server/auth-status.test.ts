// Run: npx tsx --test server/auth-status.test.ts
// Fixture credential files in a throwaway dir (removed after); the real ~/.claude, ~/.pi and
// ~/.codex are never read.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { KEYCHAIN_FACTS_TTL_MS, ownClaudeLoginUnreadable, readAuthStatus, resetAuthStatusCache, type AuthStatusPaths } from "./auth-status";

const dir = mkdtempSync(join(tmpdir(), "sova-auth-status-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  for (const f of ["claude.json", "pi.json", "codex.json"]) rmSync(join(dir, f), { force: true });
  resetAuthStatusCache();
});

const paths: AuthStatusPaths = { claudeCreds: join(dir, "claude.json"), piAuth: join(dir, "pi.json"), codexAuth: join(dir, "codex.json") };
const H = 3_600_000;
const NOW = Date.parse("2026-09-26T12:00:00Z");

/** Every secret-looking string the fixtures carry; none may reach the output. */
const SECRETS = {
  claudeAccess: "sk-ant-oat01-FIXTUREaccessTOKENclaude000",
  claudeRefresh: "sk-ant-ort01-FIXTURErefreshTOKENclaude111",
  piAccess: "eyFIXTUREpiOpenAIaccess.payload.sig222",
  piRefresh: "FIXTUREpiOpenAIrefresh333",
  piAccount: "acct-FIXTURE-444",
  ollama: "FIXTUREollamaKEY555",
  zai: "FIXTUREzaiKEY666",
  deepseek: "sk-FIXTUREdsKEY777",
  codexAccess: "eyFIXTUREcodexAccess888",
  codexRefresh: "FIXTUREcodexRefresh999",
  codexId: "eyFIXTUREcodexIdToken000",
  subscription: "FIXTUREmaxPlan",
  tier: "FIXTURE_tier_20x",
};

/** Write a file with a chosen mtime (ms). */
function put(name: string, body: unknown, mtimeMs = NOW): void {
  const p = join(dir, name);
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
}

function claudeCreds(expiresAt: number, refreshTokenExpiresAt?: number) {
  return {
    claudeAiOauth: {
      accessToken: SECRETS.claudeAccess,
      refreshToken: SECRETS.claudeRefresh,
      expiresAt,
      ...(refreshTokenExpiresAt === undefined ? {} : { refreshTokenExpiresAt }),
      scopes: ["user:inference", "user:profile"],
      subscriptionType: SECRETS.subscription,
      rateLimitTier: SECRETS.tier,
    },
  };
}

function piAuth(expires?: number) {
  return {
    "openai-codex": { type: "oauth", access: SECRETS.piAccess, refresh: SECRETS.piRefresh, ...(expires === undefined ? {} : { expires }), accountId: SECRETS.piAccount },
    "ollama-cloud": { type: "api_key", key: SECRETS.ollama },
    zai: { type: "api_key", key: SECRETS.zai },
    deepseek: { type: "api_key", key: SECRETS.deepseek },
  };
}

const codexAuth = (lastRefresh?: string) => ({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: { id_token: SECRETS.codexId, access_token: SECRETS.codexAccess, refresh_token: SECRETS.codexRefresh, account_id: SECRETS.piAccount },
  ...(lastRefresh === undefined ? {} : { last_refresh: lastRefresh }),
});

test("no secret string from any credential file reaches the output", async () => {
  // Renewed 3h ago (mtime = expiresAt − 8h), so every field is filled in.
  put("claude.json", claudeCreds(NOW + 5 * H, NOW + 20 * 24 * H), NOW - 3 * H);
  put("pi.json", piAuth(NOW + 7 * 24 * H));
  put("codex.json", codexAuth("2026-07-29T10:00:00Z"));
  const out = JSON.stringify(await readAuthStatus(paths, NOW));
  for (const [name, secret] of Object.entries(SECRETS)) {
    // Any 8-char window of the secret, not just the whole string: a prefix or suffix leaks too.
    for (let i = 0; i + 8 <= secret.length; i++) assert.ok(!out.includes(secret.slice(i, i + 8)), `${name} leaked (${secret.slice(i, i + 8)})`);
  }
  // And the payload is numbers, enums and booleans only.
  const walk = (v: unknown, at: string): void => {
    if (typeof v === "string") assert.ok(["oauth", "apiKey", "claude-cli", "pi", "codex-cli"].includes(v), `string ${JSON.stringify(v)} at ${at}`);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
    else assert.ok(typeof v === "number" || typeof v === "boolean", `${typeof v} at ${at}`);
  };
  walk(JSON.parse(out), "$");
});

test("claude: expiries, flags, and the file mtime as the renewal time when it agrees with an 8h lifetime", async () => {
  put("claude.json", claudeCreds(NOW + 5 * H, NOW + 20 * 24 * H), NOW - 3 * H);
  assert.deepEqual((await readAuthStatus(paths, NOW)).claude, {
    kind: "oauth",
    source: "claude-cli",
    expiresAt: NOW + 5 * H,
    expired: false,
    refreshExpiresAt: NOW + 20 * 24 * H,
    refreshExpired: false,
    refreshedAt: NOW - 3 * H,
  });
});

test("claude: 9 minutes off still counts as the renewal; 11 minutes off is left out, never guessed", async () => {
  put("claude.json", claudeCreds(NOW + 5 * H), NOW - 3 * H + 9 * 60_000);
  assert.equal((await readAuthStatus(paths, NOW)).claude?.refreshedAt, NOW - 3 * H + 9 * 60_000);
  put("claude.json", claudeCreds(NOW + 5 * H), NOW - 3 * H - 11 * 60_000);
  const c = (await readAuthStatus(paths, NOW)).claude;
  assert.equal(c?.refreshedAt, undefined);
  assert.equal("refreshedAt" in (c ?? {}), false, "no undefined key on the wire");
  assert.equal(c?.expiresAt, NOW + 5 * H);
});

test("claude: expired access token with a live refresh token, and both expired", async () => {
  put("claude.json", claudeCreds(NOW - 2 * H, NOW + 20 * 24 * H), NOW - 10 * H);
  let c = (await readAuthStatus(paths, NOW)).claude;
  assert.equal(c?.expired, true);
  assert.equal(c?.refreshExpired, false);
  assert.equal(c?.refreshedAt, NOW - 10 * H);
  // The flags use the clock of each call, not the one at parse time (the parse is memoized).
  c = (await readAuthStatus(paths, NOW + 21 * 24 * H)).claude;
  assert.equal(c?.refreshExpired, true);
  // Exactly at expiry counts as expired.
  assert.equal((await readAuthStatus(paths, NOW + 20 * 24 * H)).claude?.refreshExpired, true);
});

test("claude: no token, missing, corrupt or odd-shaped files say nothing", async () => {
  assert.equal((await readAuthStatus(paths, NOW)).claude, undefined, "missing");
  put("claude.json", "{not json");
  assert.equal((await readAuthStatus(paths, NOW)).claude, undefined, "corrupt");
  put("claude.json", { claudeAiOauth: { accessToken: "", expiresAt: NOW } });
  assert.equal((await readAuthStatus(paths, NOW)).claude, undefined, "empty token = not signed in");
  put("claude.json", { claudeAiOauth: { accessToken: SECRETS.claudeAccess, expiresAt: "soon" } });
  assert.deepEqual((await readAuthStatus(paths, NOW)).claude, { kind: "oauth", source: "claude-cli" }, "no readable expiry");
});

test("a changed file is re-read; an unchanged one is not", async () => {
  put("claude.json", claudeCreds(NOW + 5 * H), NOW - 3 * H);
  assert.equal((await readAuthStatus(paths, NOW)).claude?.expiresAt, NOW + 5 * H);
  put("claude.json", claudeCreds(NOW + 7 * H), NOW - 1 * H); // a renewal: new mtime
  assert.equal((await readAuthStatus(paths, NOW)).claude?.expiresAt, NOW + 7 * H);
  rmSync(join(dir, "claude.json"));
  assert.equal((await readAuthStatus(paths, NOW)).claude, undefined, "deleted: nothing, not the memo");
});

test("openai: pi's entry first (expiry, no renewal time), else the Codex CLI's last_refresh", async () => {
  put("pi.json", piAuth(NOW + 7 * 24 * H));
  put("codex.json", codexAuth("2026-07-29T10:00:00Z"));
  assert.deepEqual((await readAuthStatus(paths, NOW)).openai, { kind: "oauth", source: "pi", expiresAt: NOW + 7 * 24 * H, expired: false });
  put("pi.json", { ...piAuth(), "openai-codex": undefined });
  assert.deepEqual((await readAuthStatus(paths, NOW)).openai, { kind: "oauth", source: "codex-cli", refreshedAt: Date.parse("2026-07-29T10:00:00Z") });
  put("codex.json", codexAuth("yesterday-ish"));
  assert.deepEqual((await readAuthStatus(paths, NOW)).openai, { kind: "oauth", source: "codex-cli" });
  rmSync(join(dir, "codex.json"));
  assert.equal((await readAuthStatus(paths, NOW)).openai, undefined);
});

test("API-key providers are just { kind: apiKey }, and only with a key", async () => {
  put("pi.json", { ...piAuth(), zai: { type: "api_key", key: "" } });
  const out = await readAuthStatus(paths, NOW);
  assert.deepEqual(out.ollama, { kind: "apiKey" });
  assert.deepEqual(out.deepseek, { kind: "apiKey" });
  assert.equal(out.zai, undefined);
});

test("macOS, no credentials file: Claude's sign-in numbers come from the keychain item (no renewal time), kept 30 s; no string leaves", async () => {
  const own = join(dir, ".claude");
  rmSync(own, { recursive: true, force: true });
  mkdirSync(own, { recursive: true });
  const ownPaths = { ...paths, claudeCreds: join(own, ".credentials.json") };
  let reads = 0;
  let item: string | Error = JSON.stringify(claudeCreds(NOW + 2 * H, NOW + 30 * 24 * H));
  const keychain = { platform: "darwin" as const, env: { USER: "someone" }, home: dir, userHome: dir, exec: async () => { reads++; if (item instanceof Error) throw item; return item; } };

  const out = await readAuthStatus(ownPaths, NOW, keychain);
  assert.deepEqual(out.claude, { kind: "oauth", source: "claude-cli", expiresAt: NOW + 2 * H, expired: false, refreshExpiresAt: NOW + 30 * 24 * H, refreshExpired: false });
  for (const s of Object.values(SECRETS)) assert.ok(!JSON.stringify(out).includes(s), `no ${s}`);
  assert.equal(await ownClaudeLoginUnreadable(ownPaths, NOW + 1000, keychain), false);
  assert.equal(reads, 1, "one read serves both within 30 s");

  // Locked (an ssh session) or gone: no auth, and the hint, once the kept answer is old.
  item = new Error("exit 36");
  assert.deepEqual(await readAuthStatus(ownPaths, NOW + KEYCHAIN_FACTS_TTL_MS, keychain), {});
  assert.equal(await ownClaudeLoginUnreadable(ownPaths, NOW + KEYCHAIN_FACTS_TTL_MS, keychain), true);
  assert.equal(reads, 2);

  // A file present decides alone: no keychain read, no hint.
  writeFileSync(ownPaths.claudeCreds, "{not json");
  assert.equal(await ownClaudeLoginUnreadable(ownPaths, NOW + 10 * KEYCHAIN_FACTS_TTL_MS, keychain), false);
  assert.equal((await readAuthStatus(ownPaths, NOW + 10 * KEYCHAIN_FACTS_TTL_MS, keychain)).claude, undefined);
  assert.equal(reads, 2);
  rmSync(own, { recursive: true, force: true });
});

test("not macOS: no keychain call and never the hint, whatever the file says", async () => {
  let reads = 0;
  const keychain = { platform: "linux" as const, env: { USER: "someone" }, home: dir, userHome: dir, exec: async () => (reads++, "{}") };
  const ownPaths = { ...paths, claudeCreds: join(dir, ".claude", ".credentials.json") };
  assert.deepEqual(await readAuthStatus(ownPaths, NOW, keychain), {});
  assert.equal(await ownClaudeLoginUnreadable(ownPaths, NOW, keychain), false);
  assert.equal(reads, 0);
});
