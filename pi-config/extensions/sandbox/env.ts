/**
 * The sandbox environment: an allowlist, never a denylist (plan v2 §3.4). Everything not named
 * here is dropped, which removes DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR, SSH_AUTH_SOCK,
 * DOCKER_HOST, DISPLAY, WAYLAND_DISPLAY, TMUX, the API keys and tokens, without listing them.
 * Node builtins only; platform-neutral (the seam's caller builds Policy.env with it).
 */

/** Exact names, or a prefix ending in `*`. */
export const DEFAULT_ENV_ALLOW: readonly string[] = [
	"PATH", "HOME", "USER", "LOGNAME", "SHELL",
	"LANG", "LANGUAGE", "LC_*", "TERM", "COLORTERM", "TZ",
	"XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME",
	// pi's own per-call variables (bash.js) — the caller passes them per request too.
	"PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL",
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
