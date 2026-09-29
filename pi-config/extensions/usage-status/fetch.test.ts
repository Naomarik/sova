/**
 * The per-login Claude fetch and the cache's `claudeAccounts` shape — against a temporary HOME
 * and agent dir with synthetic logins and credentials, and a fake fetch: no request leaves the
 * process, and no real credential or cache is read.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

// Before fetch.ts loads: its paths (auth.json, the cache) are fixed at import from HOME and the agent dir.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "usage-status-fetch-"));
const AGENT = path.join(ROOT, "agent");
const CLAUDE = path.join(ROOT, "claude");
process.env.HOME = ROOT;
process.env.PI_CODING_AGENT_DIR = AGENT;
process.env.CLAUDE_CONFIG_DIR = CLAUDE;
delete process.env.SOVA_DEVICE_ID;
process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));

const accounts = await import("../claude-code/accounts.ts");
const fetchMod = await import("./fetch.ts");
const { ClaudeLogins, loginDir, writeAccounts } = accounts;
const { CACHE_FILE, FAILURE_RETRY_MS, FRESH_MS, fetchAll, fetchClaude, fetchClaudeAccounts, readCache, writeCache } = fetchMod;
type ClaudeData = import("./fetch.ts").ClaudeData;

const A = "l-0000000a"; // ready here
const B = "l-0000000b"; // needs sign-in here
const C = "l-0000000c"; // assigned to another device

function creds(dir: string, token: string): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: 1 } }));
}

function setup(): void {
	fs.rmSync(ROOT, { recursive: true, force: true });
	fs.mkdirSync(AGENT, { recursive: true });
	creds(CLAUDE, "fake-token-default");
	writeAccounts(AGENT, {
		version: 1,
		logins: [
			{ id: A, addedAt: 1, enabled: true, device: "local", identity: { accountUuid: "acct-1", email: "a@example.com" } },
			{ id: B, addedAt: 2, enabled: true, device: "local", identity: { accountUuid: "acct-2", email: "b@example.com" } },
			{ id: C, addedAt: 3, enabled: true, device: "other-device", identity: { accountUuid: "acct-3", email: "c@example.com" } },
		],
		devices: { local: { order: [B, "default", A] } },
	});
	creds(loginDir(AGENT, A), "fake-token-a");
	creds(loginDir(AGENT, B), "fake-token-b");
	// B failed to sign in after its credentials were written: out until they change.
	fs.writeFileSync(path.join(AGENT, "claude-accounts-state.json"), JSON.stringify({ version: 1, logins: { [B]: { kind: "auth", at: Date.now() + 60_000 } } }));
}

const reading = (pct: number): ClaudeData => ({ state: "ok", fiveHour: { pct } });

/** A fetchLogin that answers by directory and records which it was asked for. */
function fakeLogins(answers: Record<string, ClaudeData | Error>) {
	const asked: string[] = [];
	const fetchLogin = async (dir: string) => {
		asked.push(dir);
		const a = answers[dir];
		if (a instanceof Error) throw a;
		if (!a) throw new Error(`unexpected fetch for ${dir}`);
		return a;
	};
	return { asked, fetchLogin };
}

test("fetches each added login on this host from its own directory, and never one that needs sign-in", async () => {
	setup();
	const logins = new ClaudeLogins();
	const f = fakeLogins({ [loginDir(AGENT, A)]: reading(40) });
	const kept = { data: reading(90), fetchedAt: 5, nextFetchAt: 0 };
	const out = await fetchClaudeAccounts({ [B]: kept, [C]: { data: reading(1), nextFetchAt: 0 } }, false, { logins, fetchLogin: f.fetchLogin, now: () => 1000 });
	assert.deepEqual(f.asked, [loginDir(AGENT, A)], "A only: B needs sign-in, C belongs to another device, default is `claude`");
	assert.deepEqual(Object.keys(out!).sort(), [A, B], "a login assigned elsewhere drops out");
	assert.deepEqual(out![A], { data: reading(40), fetchedAt: 1000, nextFetchAt: 1000 + FRESH_MS });
	assert.deepEqual(out![B], { data: reading(90), fetchedAt: 5, nextFetchAt: 1000 + FRESH_MS, skipped: "auth" }, "B keeps its last reading, marked as skipped");
});

test("each login keeps its own cadence: not due is not fetched unless forced, and a failure keeps the reading and retries sooner", async () => {
	setup();
	const logins = new ClaudeLogins();
	const prev = { [A]: { data: reading(10), fetchedAt: 900, nextFetchAt: 2000 } };

	const idle = fakeLogins({});
	assert.deepEqual((await fetchClaudeAccounts(prev, false, { logins, fetchLogin: idle.fetchLogin, now: () => 1000 }))![A], prev[A]);
	assert.deepEqual(idle.asked, [], "not due yet");

	const forced = fakeLogins({ [loginDir(AGENT, A)]: reading(20) });
	assert.equal((await fetchClaudeAccounts(prev, true, { logins, fetchLogin: forced.fetchLogin, now: () => 1000 }))![A]!.data!.state, "ok");
	assert.equal(forced.asked.length, 1, "a forced refresh fetches a login that is not due");

	const failing = fakeLogins({ [loginDir(AGENT, A)]: new Error("claude HTTP 429") });
	assert.deepEqual((await fetchClaudeAccounts(prev, true, { logins, fetchLogin: failing.fetchLogin, now: () => 1000 }))![A], {
		data: reading(10),
		fetchedAt: 900,
		nextFetchAt: 1000 + FAILURE_RETRY_MS,
		error: "claude HTTP 429",
	});
});

test("a host with no added login writes no claudeAccounts", async () => {
	setup();
	fs.rmSync(path.join(AGENT, "claude-accounts.json"));
	const f = fakeLogins({});
	assert.equal(await fetchClaudeAccounts(undefined, true, { logins: new ClaudeLogins(), fetchLogin: f.fetchLogin }), undefined);
	assert.deepEqual(f.asked, []);
});

test("the cache keeps `claude` as Claude Code's own login and adds claudeAccounts by login id", async () => {
	setup();
	// HOME is the temporary root: every other provider finds no key and makes no request.
	const f = fakeLogins({ [CLAUDE]: reading(70), [loginDir(AGENT, A)]: reading(30) });
	const cache = await fetchAll(undefined, false, { logins: new ClaudeLogins(), fetchLogin: f.fetchLogin });
	assert.deepEqual(cache.claude, reading(70));
	assert.deepEqual(Object.keys(cache.claudeAccounts ?? {}).sort(), [A, B]);
	assert.deepEqual(cache.claudeAccounts![A]!.data, reading(30));
	assert.equal(cache.claudeAccounts![B]!.skipped, "auth");
	assert.equal(cache.claudeAccounts!.default, undefined, "default is never repeated under claudeAccounts");
	assert.deepEqual(cache.errors, {});
	assert.ok(!JSON.stringify(cache).includes("fake-token"), "no token reaches the cache");
});

test("Claude Code's own login is skipped too while it needs sign-in, keeping its last reading", async () => {
	setup();
	fs.writeFileSync(path.join(AGENT, "claude-accounts-state.json"), JSON.stringify({ version: 1, logins: { default: { kind: "auth", at: Date.now() + 60_000 } } }));
	const f = fakeLogins({ [loginDir(AGENT, A)]: reading(30), [loginDir(AGENT, B)]: reading(50) });
	const cache = await fetchAll({ fetchedAt: 1, nextFetchAt: 1, claude: reading(99), errors: {} }, false, { logins: new ClaudeLogins(), fetchLogin: f.fetchLogin });
	assert.deepEqual(cache.claude, reading(99));
	assert.ok(!f.asked.includes(CLAUDE));
});

test("fetchClaude reads the token from the login's directory and sends it only to the usage endpoint", async () => {
	setup();
	const calls: { url: string; auth: string }[] = [];
	const ok = await fetchClaude(loginDir(AGENT, A), async (url, init) => {
		calls.push({ url, auth: init.headers.Authorization! });
		return { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 12, resets_at: "2026-01-01T00:00:00Z" } }) };
	});
	assert.deepEqual(calls, [{ url: "https://api.anthropic.com/api/oauth/usage", auth: "Bearer fake-token-a" }]);
	assert.equal(ok.state, "ok");
	assert.equal(await fetchClaude(path.join(ROOT, "nowhere"), async () => assert.fail("no token, no request")).then((d) => d.state), "nologin");
	assert.equal((await fetchClaude(loginDir(AGENT, A), async () => ({ ok: false, status: 401, json: async () => ({}) }))).state, "expired");
});

test("a cache without claudeAccounts is refetched once on a host that has added logins", async () => {
	setup();
	const base = { schemaVersion: fetchMod.CACHE_SCHEMA, fetchedAt: Date.now(), nextFetchAt: Date.now() + 60_000, openai: { state: "na" as const }, zai: { state: "na" as const }, errors: {} };
	await writeCache(base);
	assert.equal((await readCache())!.nextFetchAt, 0, "written by a reader that dropped the logins");
	await writeCache({ ...base, claudeAccounts: {} });
	assert.equal((await readCache())!.nextFetchAt, base.nextFetchAt);
	fs.rmSync(path.join(AGENT, "claude-accounts.json"));
	await writeCache(base);
	assert.equal((await readCache())!.nextFetchAt, base.nextFetchAt, "no added login: nothing is missing");
	assert.ok(CACHE_FILE.startsWith(AGENT));
});

test("a session with no recorded login reads the first ready login in this device's order, not always Claude Code's own", () => {
	setup();
	const { firstReadyLogin } = fetchMod;
	// Order [B, default, A] runs as [B, A, default] (Claude Code's own login is always the last
	// resort): B needs sign-in, so the first ready one is A.
	assert.equal(firstReadyLogin(), A);
	// A limited too: `default`.
	fs.writeFileSync(
		path.join(AGENT, "claude-accounts-state.json"),
		JSON.stringify({ version: 1, logins: { [B]: { kind: "auth", at: Date.now() + 60_000 }, [A]: { kind: "limit", at: Date.now(), until: Date.now() + 3_600_000 } } }),
	);
	assert.equal(firstReadyLogin(), "default");
	assert.equal(firstReadyLogin({ selectId: () => { throw new Error("unreadable registry"); } }), undefined);
});
