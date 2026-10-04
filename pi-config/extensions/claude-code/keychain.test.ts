/**
 * Claude logins read from the macOS keychain — with an injected exec, so it runs on any platform
 * and never touches a real keychain.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
	KEYCHAIN_MTIME_TTL_MS, KEYCHAIN_SERVICE, KEYCHAIN_TIMEOUT_MS, keychainAccount, keychainApplies, keychainItemMtime, keychainService, readKeychainCredentials, resetKeychainMtimes,
	type KeychainExec, type KeychainExecSync, type KeychainOptions,
} from "./keychain.ts";

const HOME = "/fixture/home";
const LOGIN = "/fixture/agent/claude-accounts/l-0000000a";
const ITEM = JSON.stringify({ claudeAiOauth: { accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: 5 } });
/** What `security find-generic-password` (no -w) prints for an item written 2026-10-04 13:03:50 UTC, trimmed. */
const ATTRS = `keychain: "/fixture/login.keychain-db"\nclass: "genp"\nattributes:\n    "acct"<blob>="someone"\n    "mdat"<timedate>=0x32303236313030343133303335305A00  "20261004130350Z\\000"\n    "svce"<blob>="x"\n`;

function fakeExec(answer: string | Error) {
	const calls: { file: string; args: string[]; timeout: number }[] = [];
	const exec: KeychainExec = async (file, args, o) => {
		calls.push({ file, args, timeout: o.timeout });
		if (answer instanceof Error) throw answer;
		return answer;
	};
	return { calls, exec };
}

const mac = (over: Partial<KeychainOptions> = {}): KeychainOptions => ({ platform: "darwin", env: { USER: "someone" }, home: HOME, userHome: HOME, ...over });

test("the service: Claude Code-credentials without CLAUDE_CONFIG_DIR, else suffixed with sha256 of that exact path", () => {
	assert.equal(keychainService(undefined), KEYCHAIN_SERVICE);
	const h = createHash("sha256").update(LOGIN).digest("hex").slice(0, 8);
	assert.equal(keychainService(LOGIN), `${KEYCHAIN_SERVICE}-${h}`);
	assert.notEqual(keychainService(LOGIN + "/"), keychainService(LOGIN), "the exact string: a trailing slash is another item");
});

test("on macOS a token read asks for the item by service and user, with a timeout, afresh every call", async () => {
	const f = fakeExec(ITEM);
	assert.deepEqual(await readKeychainCredentials(undefined, mac({ exec: f.exec })), JSON.parse(ITEM));
	assert.deepEqual(await readKeychainCredentials(LOGIN, mac({ exec: f.exec })), JSON.parse(ITEM));
	assert.equal(f.calls.length, 2, "never kept between reads: a refreshed token is seen at once");
	assert.deepEqual(f.calls[0], { file: "/usr/bin/security", args: ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "someone", "-w"], timeout: KEYCHAIN_TIMEOUT_MS });
	assert.deepEqual(f.calls[1]!.args, ["find-generic-password", "-s", keychainService(LOGIN), "-a", "someone", "-w"]);
});

test("no other platform, no CLAUDE_SECURESTORAGE_CONFIG_DIR and no throwaway HOME ever runs security", async () => {
	const f = fakeExec(ITEM);
	const sync: KeychainExecSync = () => assert.fail("no query");
	for (const platform of ["linux", "win32", "freebsd"] as const) {
		assert.equal(await readKeychainCredentials(undefined, mac({ platform, exec: f.exec })), undefined);
		assert.equal(keychainItemMtime(LOGIN, mac({ platform, execSync: sync })), undefined);
	}
	assert.equal(await readKeychainCredentials(undefined, mac({ exec: f.exec, env: { USER: "someone", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" } })), undefined);
	assert.equal(await readKeychainCredentials(undefined, mac({ exec: f.exec, userHome: "/real/home" })), undefined, "a test's HOME never reads the user's keychain");
	assert.equal(f.calls.length, 0);
	assert.equal(keychainApplies(mac()), true);
});

test("every token-read failure is quiet: no item, a locked keychain, a timeout, unparsable output", async () => {
	for (const answer of [new Error("exit 44"), new Error("exit 36"), new Error("timed out"), "not json", ""]) {
		assert.equal(await readKeychainCredentials(undefined, mac({ exec: fakeExec(answer).exec })), undefined);
	}
});

test("an item's modification time comes from its attributes only (no -w), kept 2 s unless fresh; none is undefined", () => {
	resetKeychainMtimes();
	const calls: string[][] = [];
	let answer: string | Error = ATTRS;
	const execSync: KeychainExecSync = (_file, args) => {
		calls.push(args);
		if (answer instanceof Error) throw answer;
		return answer;
	};
	const at = Date.UTC(2026, 9, 4, 13, 3, 50);
	assert.equal(keychainItemMtime(LOGIN, mac({ execSync, now: 1000 })), at);
	assert.deepEqual(calls[0], ["find-generic-password", "-s", keychainService(LOGIN), "-a", "someone"], "never -w: the secret is not read");
	answer = new Error("exit 44");
	assert.equal(keychainItemMtime(LOGIN, mac({ execSync, now: 1000 + KEYCHAIN_MTIME_TTL_MS - 1 })), at, "kept");
	assert.equal(keychainItemMtime(LOGIN, mac({ execSync, now: 1001, fresh: true })), undefined, "fresh asks again: the item is gone");
	assert.equal(keychainItemMtime(LOGIN, mac({ execSync, now: 1002 })), undefined);
	answer = "attributes without a date";
	assert.equal(keychainItemMtime(undefined, mac({ execSync, now: 1003 })), undefined);
	assert.equal(calls.length, 3);
	resetKeychainMtimes();
});

test("the account is $USER, as Claude Code files it, with its fallback for an unusual name", () => {
	assert.equal(keychainAccount({ USER: "a.b-c_1" }), "a.b-c_1");
	assert.equal(keychainAccount({ USER: "a b" }), "claude-code-user");
});
