/**
 * Claude Code's own login read from the macOS keychain — with an injected exec, so it runs on any
 * platform and never touches a real keychain.
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { KEYCHAIN_SERVICE, KEYCHAIN_TIMEOUT_MS, keychainAccount, keychainApplies, readKeychainCredentials, type KeychainExec, type KeychainOptions } from "./keychain.ts";

const HOME = "/fixture/home";
const OWN = path.join(HOME, ".claude");
const ITEM = JSON.stringify({ claudeAiOauth: { accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt: 5 } });

function fakeExec(answer: string | Error) {
	const calls: { file: string; args: string[]; timeout: number }[] = [];
	const exec: KeychainExec = async (file, args, o) => {
		calls.push({ file, args, timeout: o.timeout });
		if (answer instanceof Error) throw answer;
		return answer;
	};
	return { calls, exec };
}

const mac = (exec: KeychainExec, over: Partial<KeychainOptions> = {}): KeychainOptions => ({ platform: "darwin", env: { USER: "someone" }, home: HOME, userHome: HOME, exec, ...over });

test("on macOS, Claude Code's own directory reads the item by service and user, with a timeout, afresh every call", async () => {
	const f = fakeExec(ITEM);
	assert.deepEqual(await readKeychainCredentials(OWN, mac(f.exec)), JSON.parse(ITEM));
	assert.deepEqual(await readKeychainCredentials(OWN, mac(f.exec)), JSON.parse(ITEM));
	assert.equal(f.calls.length, 2, "never kept between reads: a refreshed token is seen at once");
	assert.deepEqual(f.calls[0], { file: "/usr/bin/security", args: ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "someone", "-w"], timeout: KEYCHAIN_TIMEOUT_MS });
});

test("no other platform, directory, config dir or home ever runs security", async () => {
	const f = fakeExec(ITEM);
	for (const platform of ["linux", "win32", "freebsd"] as const) assert.equal(await readKeychainCredentials(OWN, mac(f.exec, { platform })), undefined);
	assert.equal(await readKeychainCredentials("/fixture/agent/claude-accounts/l-0000000a", mac(f.exec)), undefined, "an added login");
	assert.equal(await readKeychainCredentials(OWN, mac(f.exec, { env: { USER: "someone", CLAUDE_CONFIG_DIR: "/elsewhere" } })), undefined, "its own CLAUDE_CONFIG_DIR renames the item");
	assert.equal(await readKeychainCredentials(OWN, mac(f.exec, { env: { USER: "someone", CLAUDE_SECURESTORAGE_CONFIG_DIR: "" } })), undefined);
	assert.equal(await readKeychainCredentials(OWN, mac(f.exec, { userHome: "/real/home" })), undefined, "a throwaway HOME (tests) never reads the user's keychain");
	assert.equal(f.calls.length, 0);
	assert.equal(keychainApplies(OWN, mac(f.exec)), true);
	assert.equal(keychainApplies(OWN + "/", mac(f.exec)), true);
});

test("a CLAUDE_CONFIG_DIR naming an added login's directory is not Claude Code's own: ~/.claude still reads the keychain", async () => {
	const f = fakeExec(ITEM);
	const env = { USER: "someone", CLAUDE_CONFIG_DIR: "/fixture/agent/claude-accounts/l-0000000a" };
	assert.deepEqual(await readKeychainCredentials(OWN, mac(f.exec, { env, agentDir: "/fixture/agent" })), JSON.parse(ITEM));
});

test("every failure is quiet: no item, a locked keychain, a timeout, unparsable output", async () => {
	for (const answer of [new Error("exit 44"), new Error("exit 36"), new Error("timed out"), "not json", ""]) {
		assert.equal(await readKeychainCredentials(OWN, mac(fakeExec(answer).exec)), undefined);
	}
});

test("the account is $USER, as Claude Code files it, with its fallback for an unusual name", () => {
	assert.equal(keychainAccount({ USER: "a.b-c_1" }), "a.b-c_1");
	assert.equal(keychainAccount({ USER: "a b" }), "claude-code-user");
});
