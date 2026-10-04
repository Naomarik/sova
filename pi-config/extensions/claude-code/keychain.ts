/**
 * Claude logins as macOS keeps them (§app.claude-logins/macos-keychain): a generic password in the
 * login keychain (account the user's name) holding the JSON a `.credentials.json` would, with no
 * file in the login's directory. The service is `Claude Code-credentials` for Claude Code run
 * without CLAUDE_CONFIG_DIR, else `Claude Code-credentials-<first 8 hex of sha256(that exact
 * CLAUDE_CONFIG_DIR)>` (read from Claude Code 2.1.289, and confirmed against it). Callers pass the
 * CLAUDE_CONFIG_DIR a login runs with (accounts.ts claudeConfigDirEnv), and read here only when the
 * login's file is missing.
 *
 * Only read, never written: Claude Code renews a token by rewriting the item, so every token read
 * runs again rather than keeping it. The item's text lives in memory for one read and is never
 * logged, cached or written; a failure of any kind is quiet (undefined). Whether an item exists
 * (and since when) is read from its attributes alone, never the secret. No platform but darwin
 * ever runs `security`.
 *
 * Node builtins only, and nothing from ./accounts.ts (which imports this).
 */
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import * as os from "node:os";

export const KEYCHAIN_SERVICE = "Claude Code-credentials";
/** A read that takes longer is given up (a prompt, a hung keychain). */
export const KEYCHAIN_TIMEOUT_MS = 5_000;
/** How long an item's modification time (or its absence) is kept: a number, never the item. */
export const KEYCHAIN_MTIME_TTL_MS = 2_000;
const SECURITY = "/usr/bin/security";
const MAX_ITEM_BYTES = 64 * 1024;

type ExecOptions = { timeout: number; maxBuffer: number };
/** Runs `file args` and resolves its stdout; rejects on any failure. Tests pass a fake. */
export type KeychainExec = (file: string, args: string[], options: ExecOptions) => Promise<string>;
/** The same, synchronously: returns stdout, throws on any failure. */
export type KeychainExecSync = (file: string, args: string[], options: ExecOptions) => string;

export interface KeychainOptions {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	/** os.homedir(). */
	home?: string;
	/** The user's own home (os.userInfo()): a different HOME (a test's throwaway one) never reads the keychain. */
	userHome?: string;
	exec?: KeychainExec;
	execSync?: KeychainExecSync;
}

// The error (which carries stdout) is dropped, so the item never reaches a message.
const execSecurity: KeychainExec = (file, args, options) =>
	new Promise((resolve, reject) => {
		execFile(file, args, { ...options, encoding: "utf8", windowsHide: true }, (err, stdout) => (err ? reject(new Error("keychain read failed")) : resolve(stdout)));
	});
const execSecuritySync: KeychainExecSync = (file, args, options) => {
	try {
		return execFileSync(file, args, { ...options, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
	} catch {
		throw new Error("keychain query failed");
	}
};

function userHome(): string | undefined {
	try { return os.userInfo().homedir; } catch { return undefined; }
}

/** The account Claude Code files an item under: $USER, else the login name; "claude-code-user" for anything unusual. */
export function keychainAccount(env: NodeJS.ProcessEnv = process.env): string {
	let name: string | undefined;
	try { name = env.USER || os.userInfo().username; } catch { name = undefined; }
	return name && /^[a-zA-Z0-9._-]+$/.test(name) ? name : "claude-code-user";
}

/** The item's service for a login Claude Code runs with CLAUDE_CONFIG_DIR `configDir` (undefined: unset). */
export function keychainService(configDir: string | undefined): string {
	return configDir === undefined ? KEYCHAIN_SERVICE : `${KEYCHAIN_SERVICE}-${createHash("sha256").update(configDir.normalize("NFC")).digest("hex").slice(0, 8)}`;
}

/**
 * Whether the keychain may be asked at all: darwin, HOME the user's own, and no
 * CLAUDE_SECURESTORAGE_CONFIG_DIR (which renames every item).
 */
export function keychainApplies(o: KeychainOptions = {}): boolean {
	if ((o.platform ?? process.platform) !== "darwin") return false;
	const env = o.env ?? process.env;
	if (env.CLAUDE_SECURESTORAGE_CONFIG_DIR !== undefined) return false;
	return (o.home ?? os.homedir()) === (o.userHome ?? userHome());
}

/** A login's credentials JSON from its item, parsed, or undefined (not applicable, or any failure). Read afresh on every call. */
export async function readKeychainCredentials(configDir: string | undefined, o: KeychainOptions = {}): Promise<unknown> {
	if (!keychainApplies(o)) return undefined;
	try {
		const out = await (o.exec ?? execSecurity)(SECURITY, ["find-generic-password", "-s", keychainService(configDir), "-a", keychainAccount(o.env), "-w"], { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: MAX_ITEM_BYTES });
		return JSON.parse(out);
	} catch {
		return undefined;
	}
}

const MDAT_RE = /"mdat"<timedate>=0x[0-9A-Fa-f]+\s+"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z/;
const mtimes = new Map<string, { at: number; mtime: number | undefined }>();

/**
 * When a login's item was last written (ms), from its attributes only (`security
 * find-generic-password` without `-w`: no secret, no prompt, works while the keychain is locked);
 * undefined when there is none or the keychain may not be asked. Kept 2 s unless `fresh`.
 */
export function keychainItemMtime(configDir: string | undefined, o: KeychainOptions & { fresh?: boolean; now?: number } = {}): number | undefined {
	if (!keychainApplies(o)) return undefined;
	const service = keychainService(configDir);
	const now = o.now ?? Date.now();
	const kept = mtimes.get(service);
	if (!o.fresh && kept && now >= kept.at && now - kept.at < KEYCHAIN_MTIME_TTL_MS) return kept.mtime;
	let mtime: number | undefined;
	try {
		const out = (o.execSync ?? execSecuritySync)(SECURITY, ["find-generic-password", "-s", service, "-a", keychainAccount(o.env)], { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: MAX_ITEM_BYTES });
		const m = MDAT_RE.exec(out);
		mtime = m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) : undefined;
	} catch {
		mtime = undefined;
	}
	mtimes.set(service, { at: now, mtime });
	return mtime;
}

/** Tests: forget the kept modification times. */
export function resetKeychainMtimes(): void {
	mtimes.clear();
}
