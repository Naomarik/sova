/**
 * Claude Code's own login (`default`) as macOS keeps it: a generic password in the login keychain
 * (service `Claude Code-credentials`, account the user's name) holding the JSON a
 * `.credentials.json` would, with no file in `~/.claude`. The usage fetch and the Usage page's
 * sign-in data read it through here when, and only when, the file is missing.
 *
 * Only read, never written: Claude Code renews the token by rewriting the item, so every caller
 * reads it again rather than keeping it. The item's text lives in memory for one read and is never
 * logged, cached or written; a failure of any kind is quiet (undefined). No platform but darwin,
 * and no added login, ever runs `security`.
 *
 * Node builtins only, like ./accounts.ts: imported from outside pi.
 */
import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { ownClaudeConfigDir } from "./accounts.ts";

export const KEYCHAIN_SERVICE = "Claude Code-credentials";
/** A read that takes longer is given up (a prompt, a hung keychain). */
export const KEYCHAIN_TIMEOUT_MS = 5_000;
const SECURITY = "/usr/bin/security";
const MAX_ITEM_BYTES = 64 * 1024;

/** Runs `file args` and resolves its stdout; rejects on any failure. Tests pass a fake. */
export type KeychainExec = (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<string>;

export interface KeychainOptions {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	/** os.homedir(): where `~/.claude` is. */
	home?: string;
	/** The user's own home (os.userInfo()): a different HOME (a test's throwaway one) never reads the keychain. */
	userHome?: string;
	agentDir?: string;
	exec?: KeychainExec;
}

// The error (which carries stdout) is dropped, so the item never reaches a message.
const execSecurity: KeychainExec = (file, args, options) =>
	new Promise((resolve, reject) => {
		execFile(file, args, { ...options, encoding: "utf8", windowsHide: true }, (err, stdout) => (err ? reject(new Error("keychain read failed")) : resolve(stdout)));
	});

function userHome(): string | undefined {
	try { return os.userInfo().homedir; } catch { return undefined; }
}

/** The account Claude Code files the item under: $USER, else the login name; "claude-code-user" for anything unusual. */
export function keychainAccount(env: NodeJS.ProcessEnv = process.env): string {
	let name: string | undefined;
	try { name = env.USER || os.userInfo().username; } catch { name = undefined; }
	return name && /^[a-zA-Z0-9._-]+$/.test(name) ? name : "claude-code-user";
}

/**
 * Whether `dir` is Claude Code's own directory as the keychain names it: darwin, `~/.claude` (no
 * `$CLAUDE_CONFIG_DIR` of its own, no `$CLAUDE_SECURESTORAGE_CONFIG_DIR`: either renames the item),
 * and HOME the user's own.
 */
export function keychainApplies(dir: string, o: KeychainOptions = {}): boolean {
	if ((o.platform ?? process.platform) !== "darwin") return false;
	const env = o.env ?? process.env;
	if (env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined || ownClaudeConfigDir(env, o.agentDir) !== undefined) return false;
	const home = o.home ?? os.homedir();
	if (home !== (o.userHome ?? userHome())) return false;
	return path.resolve(dir) === path.join(home, ".claude");
}

/** `dir`'s credentials JSON from the keychain, parsed, or undefined (not applicable, or any failure). Read afresh on every call. */
export async function readKeychainCredentials(dir: string, o: KeychainOptions = {}): Promise<unknown> {
	if (!keychainApplies(dir, o)) return undefined;
	try {
		const out = await (o.exec ?? execSecurity)(SECURITY, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", keychainAccount(o.env), "-w"], { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: MAX_ITEM_BYTES });
		return JSON.parse(out);
	} catch {
		return undefined;
	}
}
