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
import {
	ACCOUNTS_DEV_ENV, ClaudeLogins, DEFAULT_LIMIT_COOLDOWN_MS, SHARED_ENTRIES, accountsPath, deviceOrder, ensureLoginDir,
	loginDir, loginEntryFor, parseAccounts, planLabel, readAccounts, readAccountsState, readIdentityFile, recordedLogin, switchText,
	thisDeviceId, updateAccounts, writeAccounts, type ClaudeAccountsFile, type ClaudeLoginRecord,
} from "./accounts.ts";
import { classifyClaudeFailure, ClaudeFailureDetector } from "./transport.ts";

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
