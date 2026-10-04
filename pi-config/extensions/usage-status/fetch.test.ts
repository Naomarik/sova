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
const { CACHE_FILE, FAILURE_RETRY_MS, FRESH_MS, RATE_LIMITED_RETRY_MS, claudeReadingDue, fetchAll, fetchClaude, fetchClaudeAccounts, nextClaudeReset, readCache, writeCache } = fetchMod;
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

	const failing = fakeLogins({ [loginDir(AGENT, A)]: new Error("claude HTTP 500") });
	assert.deepEqual((await fetchClaudeAccounts(prev, true, { logins, fetchLogin: failing.fetchLogin, now: () => 1000 }))![A], {
		data: reading(10),
		fetchedAt: 900,
		nextFetchAt: 1000 + FAILURE_RETRY_MS,
		error: "claude HTTP 500",
	});

	// The usage endpoint refusing (429) backs off further than an ordinary failure.
	const refused = fakeLogins({ [loginDir(AGENT, A)]: new Error("claude HTTP 429") });
	assert.equal((await fetchClaudeAccounts(prev, true, { logins, fetchLogin: refused.fetchLogin, now: () => 1000 }))![A]!.nextFetchAt, 1000 + RATE_LIMITED_RETRY_MS);
	assert.ok(RATE_LIMITED_RETRY_MS > FRESH_MS);
});

const at = (ms: number) => new Date(ms).toISOString();

test("a login whose reading has a window that reset since it was read is due before its nextFetchAt, and only once", async () => {
	setup();
	const logins = new ClaudeLogins();
	// Read at 900 with a 5-hour window resetting at 950; its ordinary next fetch is at 5000.
	const prev = { [A]: { data: { state: "ok" as const, fiveHour: { pct: 100, resetsAt: at(950) } }, fetchedAt: 900, nextFetchAt: 5000 } };
	assert.equal(claudeReadingDue(prev[A], 940), false, "before the reset: the ordinary cadence");
	assert.equal(claudeReadingDue(prev[A], 1000), true, "after it: the reading describes a window that's gone");
	const f = fakeLogins({ [loginDir(AGENT, A)]: { state: "ok", fiveHour: { pct: 2, resetsAt: at(19_000) } } });
	const out = (await fetchClaudeAccounts(prev, false, { logins, fetchLogin: f.fetchLogin, now: () => 1000 }))![A]!;
	assert.equal(f.asked.length, 1, "fetched without force");
	assert.equal(claudeReadingDue(out, 1001), false, "the new reading is past the reset: no loop");
	// A failed refetch waits out its own retry rather than refetching on every read.
	const failed = { ...prev[A], error: "claude HTTP 429", nextFetchAt: 1000 + RATE_LIMITED_RETRY_MS };
	assert.equal(claudeReadingDue(failed, 2000), false);
	assert.equal(claudeReadingDue(failed, 1000 + RATE_LIMITED_RETRY_MS), true);
	// A reset the reading already had behind it when read is not a new one.
	assert.equal(claudeReadingDue({ data: { state: "ok", sevenDay: { pct: 100, resetsAt: at(800) } }, fetchedAt: 900, nextFetchAt: 5000 }, 1000), false);
	assert.equal(claudeReadingDue({ ...prev[A], skipped: "auth" }, 99_999), false, "never a login that needs sign-in");
});

test("Claude Code's own login keeps its own cadence: its failure never shortens the other providers' refresh", async () => {
	setup();
	const logins = new ClaudeLogins();
	const clock = 10_000_000;
	const refused = fakeLogins({ [CLAUDE]: new Error("claude HTTP 429"), [loginDir(AGENT, A)]: reading(30) });
	const first = await fetchAll({ fetchedAt: 1, nextFetchAt: 1, claude: reading(99), errors: {} }, false, { logins, fetchLogin: refused.fetchLogin, now: () => clock });
	assert.equal(first.errors.claude, "claude HTTP 429");
	assert.deepEqual(first.claude, reading(99), "the last reading is kept");
	assert.equal(first.nextFetchAt, clock + FRESH_MS, "the whole cache keeps the ordinary cadence");
	assert.equal(first.claudeNextFetchAt, clock + RATE_LIMITED_RETRY_MS, "default backs off on 429");
	assert.equal(first.claudeFetchedAt, 1, "still the reading from before");

	// The next ordinary refresh, before default's own retry: default is not asked again, and its error stays.
	const later = clock + FRESH_MS;
	const again = fakeLogins({ [loginDir(AGENT, A)]: reading(31) });
	const second = await fetchAll({ ...first, claudeAccounts: { [A]: { ...first.claudeAccounts![A]!, nextFetchAt: later } } }, false, { logins, fetchLogin: again.fetchLogin, now: () => later });
	assert.ok(!again.asked.includes(CLAUDE), "default waits out its back-off");
	assert.equal(second.errors.claude, "claude HTTP 429");
	assert.equal(second.claudeNextFetchAt, first.claudeNextFetchAt);
	assert.equal(second.nextFetchAt, later + FRESH_MS);

	// Its retry has come: fetched, and back on the ordinary cadence.
	const due = clock + RATE_LIMITED_RETRY_MS;
	const ok = fakeLogins({ [CLAUDE]: reading(40), [loginDir(AGENT, A)]: reading(32) });
	const third = await fetchAll(second, false, { logins, fetchLogin: ok.fetchLogin, now: () => due });
	assert.deepEqual(third.claude, reading(40));
	assert.equal(third.errors.claude, undefined);
	assert.equal(third.claudeFetchedAt, due);
	assert.equal(third.claudeNextFetchAt, due + FRESH_MS);
	// A forced refresh asks it whatever its back-off.
	const forced = fakeLogins({ [CLAUDE]: reading(41), [loginDir(AGENT, A)]: reading(33) });
	await fetchAll(first, true, { logins, fetchLogin: forced.fetchLogin, now: () => clock + 1 });
	assert.ok(forced.asked.includes(CLAUDE));
});

test("readCache makes the cache due for a login just held here, and for a reading whose window has reset since", async () => {
	setup();
	const now = Date.now();
	const entry = (over: object = {}) => ({ data: reading(10), fetchedAt: now - 1000, nextFetchAt: now + 60_000, ...over });
	const base = {
		schemaVersion: fetchMod.CACHE_SCHEMA,
		fetchedAt: now - 1000,
		nextFetchAt: now + 60_000,
		openai: { state: "na" as const },
		zai: { state: "na" as const },
		claude: reading(20),
		claudeFetchedAt: now - 1000,
		claudeNextFetchAt: now + 60_000,
		errors: {},
	};
	await writeCache({ ...base, claudeAccounts: { [A]: entry(), [B]: entry({ skipped: "auth" }) } });
	assert.equal((await readCache())!.nextFetchAt, base.nextFetchAt, "every held login has a current reading");

	await writeCache({ ...base, claudeAccounts: { [B]: entry({ skipped: "auth" }) } });
	assert.equal((await readCache())!.nextFetchAt, 0, "A was just taken: no entry yet");

	const gone = { state: "ok" as const, sevenDay: { pct: 100, resetsAt: at(now - 500) } };
	await writeCache({ ...base, claudeAccounts: { [A]: entry({ data: gone }), [B]: entry({ skipped: "auth" }) } });
	assert.equal((await readCache())!.nextFetchAt, 0, "A's 7-day window reset after it was read");
	await writeCache({ ...base, claudeAccounts: { [A]: entry({ data: gone, error: "claude HTTP 429" }), [B]: entry({ skipped: "auth" }) } });
	assert.equal((await readCache())!.nextFetchAt, base.nextFetchAt, "a failed refetch waits out its own retry: no loop");
	await writeCache({ ...base, claudeAccounts: { [A]: entry(), [B]: entry({ data: gone, skipped: "auth" }) } });
	assert.equal((await readCache())!.nextFetchAt, base.nextFetchAt, "a login that needs sign-in is never fetched, so never due");

	await writeCache({ ...base, claude: gone, claudeAccounts: { [A]: entry(), [B]: entry({ skipped: "auth" }) } });
	assert.equal((await readCache())!.nextFetchAt, 0, "default's own reading reset since it was read");
	await writeCache({ ...base, claude: gone, errors: { claude: "claude HTTP 429" }, claudeAccounts: { [A]: entry(), [B]: entry({ skipped: "auth" }) } });
	assert.equal((await readCache())!.nextFetchAt, base.nextFetchAt, "default waiting out its back-off");
	const { claudeFetchedAt: _f, claudeNextFetchAt: _n, ...older } = base;
	await writeCache({ ...older, claude: gone, fetchedAt: now - 1000, claudeAccounts: { [A]: entry(), [B]: entry({ skipped: "auth" }) } });
	assert.equal((await readCache())!.nextFetchAt, 0, "an older writer's file: default read with the file");
});

test("nextClaudeReset is the earliest Claude reset still ahead, default's or a login's", () => {
	const c = {
		fetchedAt: 0,
		nextFetchAt: 0,
		errors: {},
		claude: { state: "ok" as const, fiveHour: { pct: 1, resetsAt: at(5000) }, sevenDay: { pct: 1, resetsAt: at(900) } },
		claudeAccounts: { [A]: { data: { state: "ok" as const, limits: [{ label: "7d", pct: 1, resetsAt: at(3000) }] }, nextFetchAt: 0 } },
	};
	assert.equal(nextClaudeReset(c, 1000), 3000);
	assert.equal(nextClaudeReset(c, 4000), 5000);
	assert.equal(nextClaudeReset(c, 6000), undefined);
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
	await writeCache({ ...base, claudeAccounts: { [A]: { nextFetchAt: Date.now() + 60_000 }, [B]: { nextFetchAt: Date.now() + 60_000, skipped: "auth" } } });
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

test("OpenAI: each window keeps its own length and is labelled from it", async () => {
	setup();
	fs.mkdirSync(path.join(ROOT, ".pi/agent"), { recursive: true });
	fs.writeFileSync(path.join(ROOT, ".pi/agent/auth.json"), JSON.stringify({ "openai-codex": { access: "fake-openai" } }));
	const answer = (rate_limit: unknown) => async () => ({ ok: true, status: 200, json: async () => ({ plan_type: "plus", rate_limit }) }) as Response;
	const real = globalThis.fetch;
	try {
		globalThis.fetch = answer({
			primary_window: { used_percent: 97, limit_window_seconds: 604_800, reset_at: 1_791_000_000 },
			secondary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_after_seconds: 60 },
		});
		const both = await fetchMod.fetchOpenAi();
		assert.equal(both.state, "ok");
		assert.deepEqual(both.state === "ok" && both.windows.map((w) => [w.label, w.pct, w.seconds]), [["5h", 12, 18_000], ["7d", 97, 604_800]]);
		// A secondary window that isn't five hours is labelled by its own seconds, never "5h".
		globalThis.fetch = answer({ secondary_window: { used_percent: 30, limit_window_seconds: 604_800 } });
		const weekly = await fetchMod.fetchOpenAi();
		assert.deepEqual(weekly.state === "ok" && weekly.windows.map((w) => [w.label, w.seconds]), [["7d", 604_800]]);
		// No length sent: the old labels, and no `seconds`.
		globalThis.fetch = answer({ primary_window: { used_percent: 5 }, secondary_window: { used_percent: 6 } });
		const bare = await fetchMod.fetchOpenAi();
		assert.deepEqual(bare.state === "ok" && bare.windows.map((w) => [w.label, "seconds" in w]), [["5h", false], ["pri", false]]);
		// An odd length is "pri", with its seconds kept.
		globalThis.fetch = answer({ primary_window: { used_percent: 5, limit_window_seconds: 86_400 } });
		const odd = await fetchMod.fetchOpenAi();
		assert.deepEqual(odd.state === "ok" && odd.windows.map((w) => [w.label, w.seconds]), [["pri", 86_400]]);
	} finally {
		globalThis.fetch = real;
	}
});

test("Claude Code's own login on macOS with no credentials file: the keychain's token, read afresh for each fetch; a file always wins, and elsewhere nothing changes", async () => {
	setup();
	const own = path.join(ROOT, ".claude");
	fs.mkdirSync(own, { recursive: true });
	let token = "fake-keychain-1";
	const execs: string[][] = [];
	const exec = async (_file: string, args: string[]) => (execs.push(args), JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: "fake-keychain-refresh" } }));
	const keychain = { platform: "darwin" as const, env: { USER: "someone" }, home: ROOT, userHome: ROOT, exec };
	const sent: string[] = [];
	const answer = async (_url: string, init: { headers: Record<string, string> }) => (sent.push(init.headers.Authorization!), { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 7 } }) });

	assert.equal((await fetchClaude(own, answer, keychain)).state, "ok");
	token = "fake-keychain-2"; // Claude Code refreshed: it rewrote the item
	await fetchClaude(own, answer, keychain);
	assert.deepEqual(sent, ["Bearer fake-keychain-1", "Bearer fake-keychain-2"]);
	assert.equal(execs.length, 2);

	// A failed keychain read is today's "nologin", with no request.
	assert.equal((await fetchClaude(own, async () => assert.fail("no token, no request"), { ...keychain, exec: async () => { throw new Error("exit 36"); } })).state, "nologin");
	// Not macOS: no keychain call at all.
	assert.equal((await fetchClaude(own, async () => assert.fail("no request"), { ...keychain, platform: "linux" })).state, "nologin");
	// An added login never reads it.
	fs.rmSync(path.join(loginDir(AGENT, A), ".credentials.json"));
	assert.equal((await fetchClaude(loginDir(AGENT, A), async () => assert.fail("no request"), keychain)).state, "nologin");
	// A file present (even unreadable) decides alone.
	creds(own, "fake-file");
	sent.length = 0;
	await fetchClaude(own, answer, keychain);
	fs.writeFileSync(path.join(own, ".credentials.json"), "{not json");
	assert.equal((await fetchClaude(own, answer, keychain)).state, "nologin");
	assert.deepEqual(sent, ["Bearer fake-file"]);
	assert.equal(execs.length, 2, "the keychain is not read while the file exists");
});
