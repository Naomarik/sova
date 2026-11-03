/**
 * The sandbox environment: an allowlist, never a denylist (plan v2 §3.4). Everything not named
 * here is dropped, which removes DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR, SSH_AUTH_SOCK,
 * DOCKER_HOST, DISPLAY, WAYLAND_DISPLAY, TMUX, the API keys and tokens, without listing them.
 * Node builtins only; platform-neutral (the seam's caller builds Policy.env with it).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Exact names, or a prefix ending in `*`. */
export const DEFAULT_ENV_ALLOW: readonly string[] = [
	"PATH", "HOME", "USER", "LOGNAME", "SHELL",
	"LANG", "LANGUAGE", "LC_*", "TERM", "COLORTERM", "TZ",
	"XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
	// pi's own per-call variables (bash.js) — the caller passes them per request too.
	"PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL",
	// Not a secret: where pi's agent dir is, so bash finds the same one (the spec tools' `core=` line).
	// `$AGENT_DIR/auth.json` stays hidden.
	"PI_CODING_AGENT_DIR",
	"MISE_*", "CARGO_HOME", "RUSTUP_HOME", "GOPATH", "GOROOT", "JAVA_HOME", "NVM_DIR",
	"EDITOR", "VISUAL", "PAGER", "NO_COLOR", "FORCE_COLOR", "CI",
];

/** Never passed in, even if a user allowlist names them (an allowlist extension is a loosening, but not these). */
const NEVER: readonly string[] = [
	"DBUS_SESSION_BUS_ADDRESS", "DBUS_STARTER_ADDRESS", "XDG_RUNTIME_DIR", "SSH_AUTH_SOCK", "SSH_AGENT_PID",
	"DOCKER_HOST", "NOTIFY_SOCKET", "LISTEN_FDS", "LISTEN_PID", "LISTEN_FDNAMES",
	"LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "NODE_OPTIONS", "BASH_ENV", "ENV",
	// Set by the backend when the network mode needs them; a caller value would point elsewhere.
	"TMPDIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy",
];

function matcher(allow: readonly string[]): (name: string) => boolean {
	const exact = new Set(allow.filter((a) => !a.endsWith("*")));
	const prefixes = allow.filter((a) => a.endsWith("*")).map((a) => a.slice(0, -1));
	return (name) => exact.has(name) || prefixes.some((p) => p.length > 0 && name.startsWith(p));
}

/** Pick the allowlisted variables from `source`; `extraAllow` is the policy file's `env.allow`. */
export function scrubEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined>, extraAllow: readonly string[] = []): Record<string, string> {
	const allowed = matcher([...DEFAULT_ENV_ALLOW, ...extraAllow]);
	const never = new Set(NEVER);
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(source)) {
		if (v === undefined || never.has(k) || !allowed(k)) continue;
		out[k] = v;
	}
	return out;
}

/** A write-only worker's environment: the host's as it is, minus what the backend sets itself. */
export function hostEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(source)) if (v !== undefined && k !== "TMPDIR") out[k] = v;
	return out;
}

// ─── git's background cleanup ─────────────────────────────────────────────────────────────────────────────────────
//
// After a commit, merge or fetch git starts `git maintenance run --auto --detach`. Every process of a
// sandboxed command dies when the command ends (bwrap's PID namespace), so that cleanup is cut off
// partway, and a cut-off run can leave a lock that makes every later run write a whole pack and give
// up. So the backend points GIT_CONFIG_SYSTEM at a file of its own: the machine's system config,
// then maintenance.auto=false and gc.auto=0. System scope is the lowest, but a command's own
// GIT_CONFIG_COUNT adds to it rather than replacing it (an env GIT_CONFIG_COUNT would be replaced).
// The file never has an [include] of its own (the machine's text is copied in), because a reader
// that sees an include in a config can no longer tell which files the config depends on.

/** The file's name in the session tmp. */
export const GIT_CLEANUP_FILE = "sova-no-background-cleanup.gitconfig";
/** The first line of every such file: how a later writer knows not to copy one into another. */
export const GIT_CLEANUP_MARKER = "# Written by Sova: git starts no background cleanup here (maintenance.auto, gc.auto).";

const gitBool = (v: string | undefined) => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());
let defaultSystemPath: string | undefined;

/** True when `path` is a file this module wrote (its first line is the marker). */
function isCleanupFile(path: string): boolean {
	try {
		return readFileSync(path, "utf8").split("\n", 1)[0] === GIT_CLEANUP_MARKER;
	} catch {
		return false;
	}
}

/**
 * The machine's own git system config: the one an inherited GIT_CONFIG_SYSTEM names (unless that is
 * one of these files), else the one git names with the variable unset (`git var`, asked once per
 * process; /etc/gitconfig when git can't say). null under GIT_CONFIG_NOSYSTEM.
 */
export function machineGitSystemConfig(source: Record<string, string | undefined>): string | null {
	if (gitBool(source.GIT_CONFIG_NOSYSTEM)) return null;
	const inherited = source.GIT_CONFIG_SYSTEM;
	if (inherited && !isCleanupFile(inherited)) return inherited;
	if (defaultSystemPath === undefined) {
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
		try {
			defaultSystemPath = execFileSync("git", ["var", "GIT_CONFIG_SYSTEM"], { env, encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }).trim() || "/etc/gitconfig";
		} catch {
			defaultSystemPath = "/etc/gitconfig";
		}
	}
	return defaultSystemPath;
}

const quoted = (p: string) => `"${p.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** What the file holds: the marker, the machine's config (copied; included by path only when it has includes of its own), then the two keys, last so they win inside it. */
export function gitCleanupConfig(machine: string | null): string {
	let base = "";
	if (machine) {
		try {
			const text = readFileSync(machine, "utf8");
			if (/\[\s*include(?:if)?\b/i.test(text)) base = `[include]\n\tpath = ${quoted(machine)}\n`;
			else if (text) base = text.endsWith("\n") ? text : `${text}\n`;
		} catch {}
	}
	return `${GIT_CLEANUP_MARKER}\n${base}[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n`;
}

/** Write `file` (atomically, and only when its content would change); false when it can't be written. */
export function writeGitCleanupConfig(file: string, source: Record<string, string | undefined>): boolean {
	const content = gitCleanupConfig(machineGitSystemConfig(source));
	try {
		if (readFileSync(file, "utf8") === content) return true;
	} catch {}
	try {
		mkdirSync(dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.tmp`;
		writeFileSync(tmp, content, { mode: 0o644 });
		renameSync(tmp, file);
		return true;
	} catch {
		return false;
	}
}

/**
 * A confined command's git config, added by the backend after the allowlist: the file written into
 * the session tmp (`hostTmp` on the host, `sandboxTmp` as the command sees it), GIT_CONFIG_SYSTEM
 * naming it, and GIT_CONFIG_NOSYSTEM (which would make git skip it) gone. `source` is where the
 * machine's config is looked up: the command's env over the host's. A file that can't be written
 * leaves the env as it was; the command still runs.
 */
export function addGitCleanupEnv(env: Record<string, string>, hostTmp: string, sandboxTmp: string, source: Record<string, string | undefined>): void {
	if (!writeGitCleanupConfig(join(hostTmp, GIT_CLEANUP_FILE), source)) return;
	delete env.GIT_CONFIG_NOSYSTEM;
	env.GIT_CONFIG_SYSTEM = join(sandboxTmp, GIT_CLEANUP_FILE);
}

/** Variables the relay needs (both spellings; many tools read only one). */
export function proxyEnv(port: number): Record<string, string> {
	const url = `http://127.0.0.1:${port}`;
	const noProxy = "127.0.0.1,localhost,::1";
	return {
		HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url, NO_PROXY: noProxy,
		http_proxy: url, https_proxy: url, all_proxy: url, no_proxy: noProxy,
		// Node ≥ 24 honours the variables above for fetch/http only with this set.
		NODE_USE_ENV_PROXY: "1",
	};
}
