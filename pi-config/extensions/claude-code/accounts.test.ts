/**
 * Claude logins: the registry, a login's directory, the order, selection and the failover state
 * machine — against temporary agent and Claude directories, never the real ones.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
	ACCOUNTS_DEV_ENV, ClaudeLogins, LEASES_DIR_NAME, LEASE_STALE_MS, readLoginUse, DEFAULT_LIMIT_COOLDOWN_MS, SHARED_ENTRIES, accountsPath, claudeBaseEnv, claudeJsonPath,
	defaultClaudeDir, deviceOrder, ensureLoginDir, groupByAccount,
	loginDir, loginEntryFor, manualSwitchText, parseAccounts, poolAgentPath, readWants, wantsDir, planLabel, readAccounts, readAccountsState, readIdentityFile, recordedLogin, switchText,
	thisDeviceId, updateAccounts, writeAccounts, type ClaudeAccountsFile, type ClaudeLoginRecord,
	accessTokenFor, freshAccessToken, refreshLogin, REFRESH_ARGV, TOKEN_REFRESH_MARGIN_MS, claudeConfigDirEnv, credentialsMtime,
} from "./accounts.ts";
import { keychainService, resetKeychainMtimes } from "./keychain.ts";
import { buildDiscoveryArgv, claudeEnv, classifyClaudeFailure, ClaudeFailureDetector } from "./transport.ts";

const FIXTURES = fileURLToPath(new URL("./tests/fixtures/failures/", import.meta.url));
const events = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

function sandbox(t: { after: (fn: () => void) => void }) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-accounts-test-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const agentDir = path.join(root, "agent");
	const claudeDir = path.join(root, "claude");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(path.join(claudeDir, "projects"), { recursive: true });
	fs.writeFileSync(path.join(claudeDir, "settings.json"), "{}");
	fs.writeFileSync(path.join(claudeDir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "acct-default", emailAddress: "me@example.com", organizationName: "Me" } }));
	const env = { PI_CODING_AGENT_DIR: agentDir, CLAUDE_CONFIG_DIR: claudeDir } as NodeJS.ProcessEnv;
	let now = 1_800_000_000_000;
	const logins = new ClaudeLogins({ agentDir, env, now: () => now });
	return { root, agentDir, claudeDir, env, logins, setNow: (ms: number) => { now = ms; }, get now() { return now; } };
}

const login = (id: string, accountUuid: string | undefined, extra: Partial<ClaudeLoginRecord> = {}): ClaudeLoginRecord => ({
	id, addedAt: Number.parseInt(id.slice(2), 16), enabled: true, device: "local",
	identity: accountUuid ? { accountUuid, email: `${id}@example.com` } : null, ...extra,
});
const A = "l-0000000a", B = "l-0000000b", C = "l-0000000c";

test("registry: absent means only default; a valid file round-trips; malformed is never overwritten", (t) => {
	const s = sandbox(t);
	assert.equal(readAccounts(s.agentDir).state, "absent");
	assert.deepEqual(s.logins.order(), ["default"]);
	const file: ClaudeAccountsFile = { version: 1, logins: [login(A, "acct-1")], devices: { local: { order: [A, "default"] } } };
	writeAccounts(s.agentDir, file);
	const read = readAccounts(s.agentDir);
	assert.equal(read.state, "ok");
	assert.deepEqual(read.value, file);
	assert.equal(fs.statSync(accountsPath(s.agentDir)).mode & 0o777, 0o600);
	fs.writeFileSync(accountsPath(s.agentDir), JSON.stringify({ version: 1, logins: [{ id: "nope" }] }));
	assert.equal(readAccounts(s.agentDir).state, "malformed");
	assert.throws(() => updateAccounts(s.agentDir, () => {}), /malformed and is never overwritten/);
	assert.match(fs.readFileSync(accountsPath(s.agentDir), "utf8"), /nope/);
	assert.deepEqual(s.logins.order(), ["default"], "a malformed registry leaves only default");
});

test("registry: strict parse refuses unknown keys, duplicate ids and bad orders", () => {
	assert.ok(parseAccounts({ version: 1, logins: [], devices: {}, extra: 1 }).errors.some((e) => /unknown key extra/.test(e)));
	assert.ok(parseAccounts({ version: 1, logins: [login(A, "x"), login(A, "y")] }).errors.some((e) => /twice/.test(e)));
	assert.ok(parseAccounts({ version: 1, logins: [], devices: { local: { order: ["x"] } } }).errors.some((e) => /order/.test(e)));
	assert.ok(parseAccounts({ version: 1, logins: [{ ...login(A, "x"), token: "secret" }] }).errors.some((e) => /unknown key token/.test(e)));
	assert.deepEqual(parseAccounts({ version: 1 }).errors, []);
});

test("a login's directory is 0700 and links the shared entries to default's, projects always", (t) => {
	const s = sandbox(t);
	fs.rmSync(path.join(s.claudeDir, "projects"), { recursive: true });
	const dir = ensureLoginDir(s.agentDir, A, s.claudeDir);
	assert.equal(dir, loginDir(s.agentDir, A));
	assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
	assert.equal(fs.readlinkSync(path.join(dir, "projects")), path.join(s.claudeDir, "projects"));
	assert.ok(fs.statSync(path.join(s.claudeDir, "projects")).isDirectory(), "projects/ is created where every login writes");
	assert.equal(fs.readlinkSync(path.join(dir, "settings.json")), path.join(s.claudeDir, "settings.json"));
	for (const name of SHARED_ENTRIES.filter((n) => n !== "projects" && n !== "settings.json")) {
		assert.ok(!fs.existsSync(path.join(dir, name)), `${name} does not exist in default's dir, so it is not linked`);
	}
	// A record written through the link lands in the shared projects/.
	fs.writeFileSync(path.join(dir, "projects", "x.jsonl"), "{}\n");
	assert.ok(fs.existsSync(path.join(s.claudeDir, "projects", "x.jsonl")));
	// Idempotent, and a real file is left alone.
	fs.rmSync(path.join(dir, "settings.json"));
	fs.writeFileSync(path.join(dir, "settings.json"), "{\"own\":true}");
	ensureLoginDir(s.agentDir, A, s.claudeDir);
	assert.equal(fs.readFileSync(path.join(dir, "settings.json"), "utf8"), "{\"own\":true}");
	assert.throws(() => loginDir(s.agentDir, "../escape"), /Not a login id/);
});

test("an inherited CLAUDE_CONFIG_DIR naming a login's directory is not default: ~/.claude is, and the login's links stay", (t) => {
	const s = sandbox(t);
	assert.ok(os.homedir().startsWith(process.env.SOVA_TEST_HOME ?? "\0"), "the throwaway home");
	const home = path.join(os.homedir(), ".claude");
	writeAccounts(s.agentDir, { version: 1, logins: [login(A, "acct-1")], devices: { local: { order: [A] } } });
	const dirA = ensureLoginDir(s.agentDir, A, home);
	const links = () => SHARED_ENTRIES.map((n) => { try { return fs.readlinkSync(path.join(dirA, n)); } catch { return null; } });
	const before = links();
	assert.equal(before[0], path.join(home, "projects"));
	// As a pi started inside a Sova-spawned worker on A: its agent dir, and CLAUDE_CONFIG_DIR = A's dir.
	const env = { PI_CODING_AGENT_DIR: s.agentDir, CLAUDE_CONFIG_DIR: dirA } as NodeJS.ProcessEnv;
	const logins = new ClaudeLogins({ agentDir: s.agentDir, env });
	assert.equal(logins.defaultDir, home);
	assert.equal(defaultClaudeDir(env), home);
	assert.equal(claudeJsonPath(logins.defaultDir, true, env), path.join(os.homedir(), ".claude.json"));
	// Through a link to the agent dir, and a trailing slash, it is still A's directory.
	const alias = path.join(s.root, "alias");
	fs.symlinkSync(s.agentDir, alias);
	assert.equal(defaultClaudeDir({ PI_CODING_AGENT_DIR: s.agentDir, CLAUDE_CONFIG_DIR: `${path.join(alias, "claude-accounts", A)}/` }), home);
	// Under pi's default ~/.pi/agent too, whatever the effective agent dir is.
	const piDefault = path.join(os.homedir(), ".pi", "agent", "claude-accounts", B);
	assert.equal(defaultClaudeDir({ PI_CODING_AGENT_DIR: s.agentDir, CLAUDE_CONFIG_DIR: piDefault }), home);
	// Claude Code's own directory elsewhere is still default's.
	assert.equal(defaultClaudeDir({ PI_CODING_AGENT_DIR: s.agentDir, CLAUDE_CONFIG_DIR: s.claudeDir }), s.claudeDir);
	// Using A repairs its links against ~/.claude's entries, never against itself.
	assert.equal(logins.select().id, A);
	assert.deepEqual(links(), before, "A's shared links are untouched");
	// A spawn on default starts without the login's directory; one on A sets it explicitly.
	assert.equal(claudeBaseEnv(env).CLAUDE_CONFIG_DIR, undefined);
	assert.equal(claudeBaseEnv({ ...env, CLAUDE_CONFIG_DIR: s.claudeDir }).CLAUDE_CONFIG_DIR, s.claudeDir);
	const inherited = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = piDefault;
	try {
		assert.equal(claudeEnv({}).CLAUDE_CONFIG_DIR, undefined, "a default spawn does not run on the inherited login");
		assert.equal(claudeEnv({ CLAUDE_CONFIG_DIR: dirA }).CLAUDE_CONFIG_DIR, dirA);
	} finally {
		if (inherited === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = inherited;
	}
});

test("a login's directory: a wrong link is re-pointed; a link into the login itself is refused", (t) => {
	const s = sandbox(t);
	const dir = ensureLoginDir(s.agentDir, A, s.claudeDir);
	// A projects link to another directory (a symlink to a directory) is replaced, not kept.
	const elsewhere = path.join(s.root, "elsewhere");
	fs.mkdirSync(elsewhere);
	fs.writeFileSync(path.join(elsewhere, "keep.jsonl"), "{}\n");
	fs.unlinkSync(path.join(dir, "projects"));
	fs.symlinkSync(elsewhere, path.join(dir, "projects"));
	ensureLoginDir(s.agentDir, A, s.claudeDir);
	assert.equal(fs.readlinkSync(path.join(dir, "projects")), path.join(s.claudeDir, "projects"));
	assert.ok(fs.existsSync(path.join(elsewhere, "keep.jsonl")), "the old target's contents are untouched");
	// Default's directory given as a login's own (or another login's): refused before any write.
	const dirB = loginDir(s.agentDir, B);
	assert.throws(() => ensureLoginDir(s.agentDir, B, dirB), /cannot be a login's directory/);
	assert.ok(!fs.existsSync(dirB), "nothing is created for the refused login");
	assert.throws(() => ensureLoginDir(s.agentDir, A, dir), /cannot be a login's directory/);
	assert.equal(fs.readlinkSync(path.join(dir, "projects")), path.join(s.claudeDir, "projects"));
	// A shared entry of default's that resolves into the login's own directory is not linked.
	fs.mkdirSync(path.join(dir, "own-agents"));
	fs.symlinkSync(path.join(dir, "own-agents"), path.join(s.claudeDir, "agents"));
	ensureLoginDir(s.agentDir, A, s.claudeDir);
	assert.ok(!fs.existsSync(path.join(dir, "agents")) && !isLink(path.join(dir, "agents")), "no link back into the login");
});
const isLink = (p: string): boolean => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

test("identity comes from oauthAccount and never carries a token", (t) => {
	const s = sandbox(t);
	const file = path.join(s.root, ".claude.json");
	fs.writeFileSync(file, JSON.stringify({ oauthAccount: { accountUuid: "u1", emailAddress: "a@b.c", organizationUuid: "o1", organizationName: "Org", billingType: "stripe", subscriptionType: "max", organizationRateLimitTier: "tier" }, primaryApiKey: "sk-secret" }));
	assert.deepEqual(readIdentityFile(file), { accountUuid: "u1", email: "a@b.c", orgUuid: "o1", orgName: "Org", plan: "max", rateLimitTier: "tier" });
	fs.writeFileSync(file, "{}");
	assert.equal(readIdentityFile(file), null);
});

test("the plan is the subscription, never the billing type, and reads as people say it", (t) => {
	const s = sandbox(t);
	const file = path.join(s.root, ".claude.json");
	// What Claude Code writes without a subscriptionType: the billing type and the organization's type.
	fs.writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: "a@example.com", billingType: "stripe_subscription", organizationType: "claude_max", organizationRateLimitTier: "default_claude_max_20x" } }));
	assert.deepEqual(readIdentityFile(file), { email: "a@example.com", plan: "max", rateLimitTier: "default_claude_max_20x" });
	assert.equal(planLabel(readIdentityFile(file)), "Max 20x");
	assert.equal(planLabel({ plan: "max", rateLimitTier: "default_claude_max_5x" }), "Max 5x");
	assert.equal(planLabel({ plan: "pro", rateLimitTier: "default_claude_ai" }), "Pro");
	assert.equal(planLabel({ plan: "claude_team" }), "Team");
	// An older registry's identity holds the billing type as its plan: the tier still names it, and alone it names nothing.
	assert.equal(planLabel({ plan: "stripe_subscription", rateLimitTier: "default_claude_max_20x" }), "Max 20x");
	assert.equal(planLabel({ plan: "stripe_subscription" }), undefined);
	assert.equal(planLabel(null), undefined);
});

test("device id: SOVA_DEVICE_ID, else the mesh self id, else local; order follows assignment", (t) => {
	const s = sandbox(t);
	assert.equal(thisDeviceId(s.agentDir, {}), "local");
	fs.mkdirSync(path.join(s.agentDir, "sova"));
	fs.writeFileSync(path.join(s.agentDir, "sova", "peers.json"), JSON.stringify({ version: 1, self: { id: "laptop", label: "Laptop" }, peers: [] }));
	assert.equal(thisDeviceId(s.agentDir, {}), "laptop");
	assert.equal(thisDeviceId(s.agentDir, { SOVA_DEVICE_ID: "phone" }), "phone");
	const file: ClaudeAccountsFile = {
		version: 1,
		logins: [login(A, "1"), login(B, "2", { device: "laptop" }), login(C, "3", { device: "phone" })],
		devices: { laptop: { order: [B, C, "default"] } },
	};
	// C is the phone's: never used on the laptop, even if its order names it. `default` is always
	// last (Claude Code's own login is the last resort), wherever an order places it.
	assert.deepEqual(deviceOrder(file, "laptop"), [B, A, "default"]);
	assert.deepEqual(deviceOrder(file, "phone"), [A, C, "default"], "no entry for phone: its own and local logins by age, then default");
	assert.deepEqual(deviceOrder({ ...file, devices: {} }, "laptop"), [A, B, "default"]);
	// The pool (mesh on): a login kept here for lending (`device: null`) is never used here; off, it is.
	const kept: ClaudeAccountsFile = { version: 1, logins: [login(A, "1", { device: null }), login(B, "2", { device: "laptop" })], devices: {} };
	assert.deepEqual(deviceOrder(kept, "laptop", true), [B, "default"]);
	assert.deepEqual(deviceOrder(kept, "laptop", false), [A, B, "default"]);
});

test("accounts, then logins: every order keeps an account's logins together, where its first falls", (t) => {
	const accountOf = (id: string) => ({ [A]: "acct-1", [B]: "acct-2", [C]: "acct-1" } as Record<string, string | undefined>)[id];
	assert.deepEqual(groupByAccount([A, B, C], accountOf), [A, C, B]);
	assert.deepEqual(groupByAccount([B, C, "l-0000000d", A], accountOf), [B, C, A, "l-0000000d"], "a login with no account is its own, in its place");
	assert.deepEqual(groupByAccount([A, C, B], accountOf), [A, C, B], "an order already grouped is kept as it is");
	// The user's order splits account 1 (A, then B of account 2, then C): the device reads it grouped.
	const file: ClaudeAccountsFile = { version: 1, logins: [login(A, "acct-1"), login(B, "acct-2"), login(C, "acct-1")], devices: { local: { order: [A, "default", B, C] } } };
	assert.deepEqual(deviceOrder(file, "local"), [A, C, B, "default"]);
	// So a failed sign-in moves to the account's next login first, and a limit skips the account.
	const s = sandbox(t);
	writeAccounts(s.agentDir, file);
	const dirA = ensureLoginDir(s.agentDir, A, s.claudeDir);
	fs.writeFileSync(path.join(dirA, ".credentials.json"), "{}");
	assert.equal(s.logins.failover(s.logins.select(), { kind: "auth" })?.id, C);
	assert.equal(s.logins.failover(s.logins.select(), { kind: "limit" })?.id, B);
});

test("selection: first usable login in order; the recorded one while usable; disabled is skipped", (t) => {
	const s = sandbox(t);
	writeAccounts(s.agentDir, { version: 1, logins: [login(A, "1"), login(B, "2")], devices: { local: { order: [A, B, "default"] } } });
	assert.equal(s.logins.select().id, A);
	assert.deepEqual(s.logins.select().env, { CLAUDE_CONFIG_DIR: loginDir(s.agentDir, A) });
	assert.equal(s.logins.select(B).id, B, "a session keeps its recorded login while usable");
	assert.equal(s.logins.select("l-0000dead").id, A, "a login that is gone falls back to the order");
	updateAccounts(s.agentDir, (f) => { f.logins[0]!.enabled = false; });
	assert.equal(s.logins.select().id, B);
	assert.equal(s.logins.select(A).id, B, "a disabled recorded login is left");
	updateAccounts(s.agentDir, (f) => { f.devices.local!.defaultEnabled = false; f.logins[1]!.enabled = false; });
	assert.equal(s.logins.select().id, A, "nothing usable: the order's first, as before");
	assert.equal(s.logins.select(B).id, B, "nothing usable: the recorded login");
	// Selecting a login repairs its directory.
	assert.ok(fs.lstatSync(path.join(loginDir(s.agentDir, A), "projects")).isSymbolicLink());
	assert.deepEqual(s.logins.choice("default")!.env, {}, "default inherits the environment");
	assert.equal(s.logins.choice("default")!.label, "me@example.com");
});

test("failover on a limit: records the cooldown for the whole account, skips its logins, and recovers at reset", (t) => {
	const s = sandbox(t);
	writeAccounts(s.agentDir, {
		version: 1,
		logins: [login(A, "acct-1"), login(B, "acct-1"), login(C, "acct-2")],
		devices: { local: { order: [A, B, C, "default"] } },
	});
	const from = s.logins.select();
	assert.equal(from.id, A);
	const resetsAt = s.now + 3_600_000;
	const to = s.logins.failover(from, { kind: "limit", resetsAt, window: "five_hour" });
	assert.equal(to?.id, C, "B shares A's account, so its quota is gone too");
	const state = readAccountsState(s.agentDir);
	assert.equal(state.logins[A]?.until, resetsAt);
	assert.equal(state.logins[B]?.via, A);
	assert.equal(state.logins[C], undefined);
	assert.equal(s.logins.select().id, C, "new spawns start on C");
	assert.equal(s.logins.readinessOf(A).state, "limited");
	s.setNow(resetsAt + 1);
	assert.equal(s.logins.select().id, A, "after the reset A is first again");
	// No reset time: the default cooldown.
	const again = s.logins.failover(s.logins.select(), { kind: "limit" });
	assert.equal(again?.id, C);
	assert.equal(readAccountsState(s.agentDir).logins[A]?.until, s.now + DEFAULT_LIMIT_COOLDOWN_MS);
});

test("failover on auth: another login of the same account is fine; recovers when its credentials change", (t) => {
	const s = sandbox(t);
	writeAccounts(s.agentDir, { version: 1, logins: [login(A, "acct-1"), login(B, "acct-1")], devices: { local: { order: [A, B, "default"] } } });
	const dirA = ensureLoginDir(s.agentDir, A, s.claudeDir);
	fs.writeFileSync(path.join(dirA, ".credentials.json"), "{}");
	fs.utimesSync(path.join(dirA, ".credentials.json"), new Date(1000), new Date(1000));
	const to = s.logins.failover(s.logins.select(), { kind: "auth", message: "Not logged in" });
	assert.equal(to?.id, B);
	assert.equal(s.logins.readinessOf(A).state, "auth");
	assert.equal(s.logins.readinessOf(B).state, "ready", "an auth failure is the login's own, not the account's");
	fs.utimesSync(path.join(dirA, ".credentials.json"), new Date(), new Date());
	assert.equal(s.logins.readinessOf(A).state, "ready", "signed in again (or refreshed): usable");
});

test("failover: none left returns undefined, and the chain visits each login once", (t) => {
	const s = sandbox(t);
	writeAccounts(s.agentDir, { version: 1, logins: [login(A, "acct-1"), login(B, "acct-2")], devices: { local: { order: [A, B, "default"] } } });
	const seen: string[] = [];
	let current = s.logins.select();
	for (let i = 0; i < 10; i++) {
		seen.push(current.id);
		const next = s.logins.failover(current, { kind: "auth" });
		if (!next) break;
		current = next;
	}
	assert.deepEqual(seen, [A, B, "default"]);
});

test("the development switch is read only with its variable set", (t) => {
	const s = sandbox(t);
	fs.writeFileSync(path.join(s.agentDir, "claude-accounts-dev.json"), JSON.stringify({ forceLimit: [A], forceAuth: ["default"] }));
	assert.equal(s.logins.forcedFailure(A), undefined);
	const dev = new ClaudeLogins({ agentDir: s.agentDir, env: { ...s.env, [ACCOUNTS_DEV_ENV]: "1" }, now: () => s.now });
	assert.equal(dev.forcedFailure(A)?.kind, "limit");
	assert.equal(dev.forcedFailure("default")?.kind, "auth");
	assert.equal(dev.forcedFailure(B), undefined);
});

test("notices and the session entry", () => {
	const from = { id: A, label: "work@example.com", env: {} };
	const to = { id: B, label: "home", env: {} };
	const now = new Date(2026, 8, 29, 12, 0).getTime();
	const text = switchText(from, to, { kind: "limit", window: "five_hour", resetsAt: new Date(2026, 8, 29, 15, 0).getTime() }, now);
	assert.equal(text, "Claude: switched work@example.com → home (5h limit, resets 15:00)");
	assert.equal(switchText(from, to, { kind: "auth" }, now), "Claude: switched work@example.com → home (sign-in failed)");
	const entry = loginEntryFor(to, { from, to, failure: { kind: "auth" }, text: "t" });
	assert.deepEqual(entry, { v: 1, login: B, label: "home", from: A, fromLabel: "work@example.com", reason: "auth", text: "t" });
	assert.equal(recordedLogin([
		{ type: "custom", customType: "claude-login", data: { login: A } },
		{ type: "message" },
		{ type: "custom", customType: "claude-login", data: { login: B } },
	]), B);
	assert.equal(recordedLogin([{ type: "custom", customType: "other", data: { login: A } }]), undefined);
});

// ---------------------------------------------------------------------------
// The classifier, on fixture streams (shaped after CLI 2.1.282's schema)
// ---------------------------------------------------------------------------

test("classifier: a rejected rate_limit_event then an error result is a limit with its reset and window", () => {
	assert.deepEqual(classifyClaudeFailure(events("limit-rejected.ndjson")), { kind: "limit", resetsAt: 1_790_000_000_000, window: "five_hour", message: "You've hit your limit · resets 3pm" });
});
test("classifier: the legacy usage-limit text carries its reset", () => {
	const f = classifyClaudeFailure(events("limit-weekly-text-only.ndjson"));
	assert.equal(f?.kind, "limit");
	assert.equal(f?.resetsAt, 1_790_003_600_000);
});
test("classifier: a rejection followed by extra usage and a success is no failure", () => {
	assert.equal(classifyClaudeFailure(events("limit-then-overage.ndjson")), undefined);
});
test("classifier: authentication_failed, repeated 401 retries, and 401 text are auth", () => {
	assert.equal(classifyClaudeFailure(events("auth-not-logged-in.ndjson"))?.kind, "auth");
	assert.equal(classifyClaudeFailure(events("auth-retrying.ndjson"))?.kind, "auth", "decided before the CLI's minutes of retries end");
	assert.equal(classifyClaudeFailure(events("auth-401-text.ndjson"))?.kind, "auth");
});
test("classifier: overloaded and aborted turns are not account failures", () => {
	assert.equal(classifyClaudeFailure(events("overloaded.ndjson")), undefined);
	assert.equal(classifyClaudeFailure(events("aborted-after-limit-warning.ndjson")), undefined);
});
test("classifier: one api_retry is not yet a failure, and the synthetic error message is recognised", () => {
	const d = new ClaudeFailureDetector();
	const [init, retry] = events("auth-retrying.ndjson");
	assert.equal(d.observe(init!), undefined);
	assert.equal(d.observe(retry!), undefined);
	const synthetic = events("limit-rejected.ndjson")[3]!;
	assert.equal(d.isFailureMessage(synthetic), true);
	assert.equal(d.isFailureMessage(events("overloaded.ndjson")[1]!), false);
	assert.equal(d.isFailureMessage({ type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "text", text: "usage limit reached is a phrase" }] } }), false, "a real answer mentioning limits is an answer");
});

test("leases: a dead owner's lease counts only through a live claude on that login; a reused pid or a lease left unwritten counts for nothing", { skip: process.platform !== "linux" }, async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-accounts-leases-"));
	const id = "l-1ea5e001";
	const dir = loginDir(agentDir, id);
	const leases = path.join(dir, LEASES_DIR_NAME);
	fs.mkdirSync(leases, { recursive: true });
	const now = Date.now();
	const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
	const lease = (owner: number, children: number[], at = now) =>
		fs.writeFileSync(path.join(leases, `${owner}.json`), JSON.stringify({ v: 1, owner, users: 1, busy: 1, children, lastActiveAt: at, at }));
	const orphan = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, stdio: "ignore" });
	try {
		await new Promise((r) => setTimeout(r, 100));
		// The owner died, its claude runs on: the login is still in use, and that claude is the one to stop.
		lease(dead, [orphan.pid!]);
		assert.deepEqual(readLoginUse(agentDir, id), { inUse: true, busy: false, lastActiveAt: now, children: [orphan.pid] });
		// The owner died and its child's pid now belongs to another process (this test's): nothing.
		lease(dead, [process.pid]);
		assert.deepEqual(readLoginUse(agentDir, id), { inUse: false, busy: false, lastActiveAt: 0, children: [] });
		assert.equal(fs.existsSync(path.join(leases, `${dead}.json`)), false, "and the stale lease is cleaned up");
		// A live owner pid whose lease was not rewritten for longer than LEASE_STALE_MS: a reused pid.
		lease(process.pid, [], now - LEASE_STALE_MS - 1);
		assert.equal(readLoginUse(agentDir, id, undefined, now).inUse, false);
		lease(process.pid, [], now);
		assert.equal(readLoginUse(agentDir, id, undefined, now).busy, true, "a fresh lease of a live owner holds the login");
	} finally {
		orphan.kill();
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// The access token a confined worker is handed
// ---------------------------------------------------------------------------

const REFRESH_SECRET = "refresh-SECRET-never-leaves";
function credentials(dir: string, token: string, expiresAt: number | undefined): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: REFRESH_SECRET, ...(expiresAt === undefined ? {} : { expiresAt }), scopes: ["user:inference"] } }), { mode: 0o600 });
}

test("accessTokenFor: the access token and its expiry only, never the refresh token; nothing readable is undefined", (t) => {
	const { root } = sandbox(t);
	const dir = path.join(root, "login");
	assert.equal(accessTokenFor(dir), undefined, "no credentials file");
	credentials(dir, "sk-ant-oat01-access", 1_900_000_000_000);
	const got = accessTokenFor(dir)!;
	assert.deepEqual(got, { token: "sk-ant-oat01-access", expiresAt: 1_900_000_000_000 });
	assert.ok(!JSON.stringify(got).includes(REFRESH_SECRET));
	credentials(dir, "sk-ant-oat01-access", undefined);
	assert.deepEqual(accessTokenFor(dir), { token: "sk-ant-oat01-access" });
	for (const bad of ["", "two words", "line\nbreak"]) {
		credentials(dir, bad, 1);
		assert.equal(accessTokenFor(dir), undefined, JSON.stringify(bad));
	}
	fs.writeFileSync(path.join(dir, ".credentials.json"), "{not json");
	assert.equal(accessTokenFor(dir), undefined);
});

test("freshAccessToken: refreshes first when under 60 minutes are left, when forced (a 401), or with no expiry; otherwise reads only", async (t) => {
	const { root } = sandbox(t);
	const dir = path.join(root, "login");
	const now = 1_800_000_000_000;
	let refreshed = 0;
	const refresh = async (d: string) => { assert.equal(d, dir); refreshed++; credentials(dir, `new-${refreshed}`, now + 8 * 3600_000); return true; };
	credentials(dir, "old", now + TOKEN_REFRESH_MARGIN_MS + 1);
	assert.equal((await freshAccessToken(dir, { now: () => now, refresh }))!.token, "old");
	assert.equal(refreshed, 0);
	assert.equal((await freshAccessToken(dir, { now: () => now, refresh, force: true }))!.token, "new-1", "a 401 refreshes whatever is left");
	credentials(dir, "old", now + TOKEN_REFRESH_MARGIN_MS - 1);
	assert.equal((await freshAccessToken(dir, { now: () => now, refresh }))!.token, "new-2");
	credentials(dir, "old", undefined);
	assert.equal((await freshAccessToken(dir, { now: () => now, refresh }))!.token, "new-3");
	// A refresh that changes nothing (the CLI only refreshes near expiry) still hands over the token there is.
	credentials(dir, "kept", now + 30 * 60_000);
	assert.equal((await freshAccessToken(dir, { now: () => now, refresh: async () => false }))!.token, "kept");
	assert.equal(await freshAccessToken(path.join(root, "none"), { now: () => now, refresh: async () => false }), undefined);
});

test("refreshLogin: runs the discovery argv unconfined on the login dir, one initialize, then EOF; false when initialize fails or the CLI is missing", async (t) => {
	const { root } = sandbox(t);
	assert.deepEqual([...REFRESH_ARGV], buildDiscoveryArgv(), "the refresh run is the discovery argv");
	const dir = path.join(root, "login");
	credentials(dir, "before", 1);
	const log = path.join(root, "calls.jsonl");
	const fake = path.join(root, "fake-claude.mjs");
	fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), dir: process.env.CLAUDE_CONFIG_DIR, cwd: process.cwd() }) + "\\n");
let buf = "";
process.stdin.on("data", (d) => { buf += d; const i = buf.indexOf("\\n"); if (i < 0) return; const f = JSON.parse(buf.slice(0, i));
  if (process.env.FAKE_FAIL) { process.stdout.write(JSON.stringify({ type: "control_response", response: { request_id: f.request_id, subtype: "error", error: "no" } }) + "\\n"); return; }
  fs.writeFileSync(process.env.CLAUDE_CONFIG_DIR + "/.credentials.json", JSON.stringify({ claudeAiOauth: { accessToken: "after", refreshToken: "r", expiresAt: 2 } }));
  process.stdout.write(JSON.stringify({ type: "control_response", response: { request_id: f.request_id, subtype: "success", response: {} } }) + "\\n"); });
process.stdin.on("end", () => process.exit(0));
`, { mode: 0o755 });
	assert.equal(await refreshLogin(dir, { executable: fake, env: { ...process.env, CLAUDE_CONFIG_DIR: "/elsewhere", CLAUDECODE: "1" } }), true);
	assert.equal(accessTokenFor(dir)!.token, "after");
	const call = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n")[0]);
	assert.deepEqual(call, { argv: [...REFRESH_ARGV], dir, cwd: fs.realpathSync(dir) });
	assert.equal(await refreshLogin(dir, { executable: fake, env: { ...process.env, FAKE_FAIL: "1" } }), false);
	assert.equal(await refreshLogin(dir, { executable: path.join(root, "missing-claude") }), false);
	// macOS: CLAUDE_CONFIG_DIR names the keychain item, so Claude Code's own login is refreshed without it; elsewhere, as before.
	const own = path.join(os.homedir(), ".claude");
	const env = { ...process.env, FAKE_FAIL: "1" };
	delete env.CLAUDE_CONFIG_DIR;
	fs.rmSync(log, { force: true });
	await refreshLogin(own, { executable: fake, env, platform: "darwin" });
	await refreshLogin(own, { executable: fake, env, platform: "linux" });
	await refreshLogin(dir, { executable: fake, env, platform: "darwin" });
	assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l).dir), [undefined, own, dir]);
});

// ---------------------------------------------------------------------------
// macOS keychain (§app.claude-logins/macos-keychain), with an injected exec
// ---------------------------------------------------------------------------

test("claudeConfigDirEnv: unset for ~/.claude without a CLAUDE_CONFIG_DIR of the host's own, else the directory itself", () => {
	const own = path.join(os.homedir(), ".claude");
	assert.equal(claudeConfigDirEnv(own, {}), undefined);
	assert.equal(claudeConfigDirEnv(own + "/", {}), undefined);
	assert.equal(claudeConfigDirEnv(own, { CLAUDE_CONFIG_DIR: own }), own, "a CLAUDE_CONFIG_DIR of its own is passed down, so it names the item");
	assert.equal(claudeConfigDirEnv("/fixture/agent/claude-accounts/l-0000000a", {}), "/fixture/agent/claude-accounts/l-0000000a");
});

test("credentialsMtime: the file's mtime; on macOS with no file, the keychain item's (attributes only); elsewhere nothing is asked", (t) => {
	const { root } = sandbox(t);
	const dir = path.join(root, "login");
	fs.mkdirSync(dir, { recursive: true });
	resetKeychainMtimes();
	const asked: string[][] = [];
	const execSync = (_f: string, args: string[]) => (asked.push(args), `    "mdat"<timedate>=0x00  "20261004130350Z\\000"\n`);
	const mac = { platform: "darwin" as const, env: { USER: "someone" }, home: os.homedir(), userHome: os.homedir(), execSync };
	assert.equal(credentialsMtime(dir, { ...mac, platform: "linux" }), undefined);
	assert.equal(asked.length, 0, "not macOS: no query");
	assert.equal(credentialsMtime(dir, mac), Date.UTC(2026, 9, 4, 13, 3, 50));
	assert.deepEqual(asked[0], ["find-generic-password", "-s", keychainService(dir), "-a", "someone"]);
	credentials(dir, "file", 1);
	assert.equal(credentialsMtime(dir, mac), fs.statSync(path.join(dir, ".credentials.json")).mtimeMs, "a file decides alone");
	assert.equal(asked.length, 1);
	resetKeychainMtimes();
});

test("freshAccessToken on macOS with no file: the item's access token, read at every launch; never the refresh token; elsewhere nothing", async (t) => {
	const { root } = sandbox(t);
	const dir = path.join(root, "login");
	fs.mkdirSync(dir, { recursive: true });
	const now = 1_800_000_000_000;
	let token = "kc-1";
	const services: string[] = [];
	const exec = async (_f: string, args: string[]) => (services.push(args[2]!), JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: "kc-refresh", expiresAt: now + 8 * 3600_000 } }));
	const keychain = { platform: "darwin" as const, env: { USER: "someone" }, home: os.homedir(), userHome: os.homedir(), exec };
	const refresh = async () => assert.fail("hours left: no refresh");
	assert.deepEqual(await freshAccessToken(dir, { now: () => now, refresh, keychain }), { token: "kc-1", expiresAt: now + 8 * 3600_000 });
	token = "kc-2";
	assert.equal((await freshAccessToken(dir, { now: () => now, refresh, keychain }))!.token, "kc-2");
	assert.deepEqual(services, [keychainService(dir), keychainService(dir)]);
	assert.equal(await freshAccessToken(dir, { now: () => now, refresh: async () => false, keychain: { ...keychain, platform: "linux" } }), undefined);
	assert.equal(services.length, 2, "not macOS: no keychain read");
	credentials(dir, "from-file", now + 8 * 3600_000);
	assert.equal((await freshAccessToken(dir, { now: () => now, refresh, keychain }))!.token, "from-file");
	assert.equal(services.length, 2, "a file decides alone");
});

// ---------------------------------------------------------------------------
// A pick in the composer (§app.claude-logins/switch-login)
// ---------------------------------------------------------------------------

test("a pick: its note and entry, and pickable says why a login can't be picked", (t) => {
	const from = { id: A, label: "work@example.com", env: {} };
	const to = { id: B, label: "home", env: {} };
	assert.equal(manualSwitchText(from, to), "Claude: switched work@example.com → home (chosen by you)");
	assert.deepEqual(loginEntryFor(to, { from, to, text: "t" }), { v: 1, login: B, label: "home", from: A, fromLabel: "work@example.com", reason: "manual", text: "t" });

	const s = sandbox(t);
	writeAccounts(s.agentDir, { version: 1, logins: [login(A, "acct-1"), login(B, "acct-1", { enabled: false }), login(C, "acct-2", { device: "vps" })], devices: { local: { order: [A, B, "default"] } } });
	const refused = (id: string) => { const p = s.logins.pickable(id); return "refused" in p ? p.refused : null; };
	assert.match(refused(A)!, /isn't signed in/, "no credentials file: nothing to run on");
	fs.mkdirSync(loginDir(s.agentDir, A), { recursive: true });
	fs.writeFileSync(path.join(loginDir(s.agentDir, A), ".credentials.json"), "{}");
	const picked = s.logins.pickable(A);
	assert.ok("choice" in picked && picked.choice.id === A && picked.choice.env.CLAUDE_CONFIG_DIR === loginDir(s.agentDir, A));
	assert.match(refused(B)!, /is off/);
	assert.match(refused(C)!, /isn't on this device/, "held by another device");
	assert.match(refused("l-0000dead")!, /no such Claude login/);
	const own = s.logins.pickable("default");
	assert.ok("choice" in own && own.choice.id === "default", "the device's own login counts");
	s.logins.recordFailure({ id: A, label: "a", env: {}, accountUuid: "acct-1" }, { kind: "limit", resetsAt: s.now + 3_600_000 });
	assert.match(refused(A)!, /limited until/);
	s.logins.recordFailure({ id: A, label: "a", env: {} }, { kind: "auth" });
	assert.match(refused(A)!, /signed in again/);
});

test("take: a login free at the keeper is borrowed by name (the want's `only`), and one held here asks nothing", async (t) => {
	const s = sandbox(t);
	fs.mkdirSync(path.join(s.agentDir, "sova"));
	fs.writeFileSync(path.join(s.agentDir, "sova", "peers.json"), JSON.stringify({ version: 1, self: { id: "desk", label: "Desk" }, peers: [{ id: "vps", label: "Vps" }] }));
	writeAccounts(s.agentDir, { version: 1, logins: [login(A, "acct-1", { device: "desk" }), login(C, "acct-2", { device: null })], devices: {} });
	fs.mkdirSync(path.dirname(poolAgentPath(s.agentDir)), { recursive: true });
	fs.writeFileSync(poolAgentPath(s.agentDir), JSON.stringify({ v: 1, pid: process.pid, at: Date.now(), device: "desk" }));
	const logins = new ClaudeLogins({ agentDir: s.agentDir, env: s.env, wantWaitMs: 3000, wantPollMs: 10 });
	await logins.take(A);
	assert.deepEqual(readWants(s.agentDir), [], "A is held here already: no borrow");
	const taking = logins.take(C);
	let seen: ReturnType<typeof readWants> = [];
	for (let i = 0; i < 100 && !seen.length; i++) { await new Promise((r) => setTimeout(r, 10)); seen = readWants(s.agentDir); }
	assert.equal(seen[0]?.want.only, C, "the borrow names C");
	// The pool agent's part: C arrives here.
	updateAccounts(s.agentDir, (a) => { a.logins.find((l) => l.id === C)!.device = "desk"; });
	await taking;
	assert.deepEqual(readWants(s.agentDir), [], "the want is gone once C is here");
	fs.mkdirSync(path.join(wantsDir(s.agentDir)), { recursive: true });
	fs.writeFileSync(path.join(wantsDir(s.agentDir), "1-x.json"), JSON.stringify({ v: 1, at: 1, pid: 1, only: "not-a-login" }));
	assert.equal(readWants(s.agentDir)[0]?.want.only, undefined, "a malformed `only` is dropped");
});
