// Shared plumbing for the sandbox red-team suites: fixtures on the HOST side, a pi runtime opened
// the way Sova opens one (createAgentSessionServices + bindExtensions in rpc mode with a UI
// context), and direct calls into the session's own wrapped tools (`_toolRegistry`), which is the
// exact object the agent loop executes. Nothing here imports sandbox implementation code.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const EXT_DIR = path.resolve(TESTS_DIR, "..");
export const EXT_ENTRY = path.join(EXT_DIR, "index.ts");
export const PI_CONFIG = path.resolve(EXT_DIR, "../..");
export const REPO = path.resolve(PI_CONFIG, "..");
export const POLICY_TEMPLATE = path.join(PI_CONFIG, "sandbox-policy");
export const PLATFORM_DIR = process.platform === "darwin" ? "darwin" : "linux";

// Sova embeds the repo-pinned pi (node_modules, 0.86.1); PI_PACKAGE_DIR overrides (e.g. the global
// 0.87 the TUI runs) so the same suite can be pointed at either.
export const packageDir = process.env.PI_PACKAGE_DIR ?? path.join(REPO, "node_modules/@earendil-works/pi-coding-agent");
const require = createRequire(path.join(packageDir, "package.json"));
const { createJiti } = require("jiti");
const resolver = createJiti(path.join(packageDir, "package.json"));
const alias = Object.fromEntries(
	["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "typebox"].map((n) => {
		try {
			return [n, resolver.esmResolve(n)];
		} catch {
			return undefined;
		}
	}).filter(Boolean),
);
export const jiti = createJiti(import.meta.url, { alias, moduleCache: false });
let piModule;
export async function pi() {
	piModule ??= await jiti.import("@earendil-works/pi-coding-agent");
	return piModule;
}

export const rand = (n = 6) => randomBytes(n).toString("hex");

/** Minimal event bus matching pi's EventBus on/emit/off surface (mirrors subagents' test helper). */
export function makeBus() {
	const listeners = new Map();
	return {
		on(name, handler) {
			if (!listeners.has(name)) listeners.set(name, new Set());
			listeners.get(name).add(handler);
			return () => listeners.get(name)?.delete(handler);
		},
		off(name, handler) { listeners.get(name)?.delete(handler); },
		emit(name, data) { for (const handler of listeners.get(name) ?? []) handler(data); },
		_listenerCount(name) { return listeners.get(name)?.size ?? 0; },
	};
}
export const sha = (file) => (existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "<absent>");
export const hostMntNs = () => readlinkSync("/proc/self/ns/mnt");
export const hostNetNs = () => readlinkSync("/proc/self/ns/net");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** All red-team artifacts live under one host directory in $HOME (not /tmp: the sandbox replaces /tmp,
 * and not ~/.cache: that is a default writable root). Removed by `cleanupAll`. */
export const ARTIFACT_ROOT = path.join(homedir(), ".sova-redteam");
const created = new Set();

/**
 * A fixture: a git repo as cwd, an escape dir outside cwd, and an agent dir. With `agentInsideCwd`
 * the agent dir is `<cwd>/.agent` exactly like the test server's (BRIEF decision 7, the hard case).
 */
export function makeFixture({ agentInsideCwd = true, cwdUnderTmp = false } = {}) {
	mkdirSync(ARTIFACT_ROOT, { recursive: true });
	const root = mkdtempSync(path.join(ARTIFACT_ROOT, "fx-"));
	created.add(root);
	let cwd = path.join(root, "work");
	if (cwdUnderTmp) {
		cwd = mkdtempSync("/tmp/sova-redteam-cwd-");
		created.add(cwd);
	}
	mkdirSync(cwd, { recursive: true });
	const escape = path.join(root, "escape");
	mkdirSync(escape);
	execFileSync("git", ["init", "-q", cwd]);
	execFileSync("git", ["-C", cwd, "config", "user.email", "redteam@example.invalid"]);
	execFileSync("git", ["-C", cwd, "config", "user.name", "redteam"]);
	mkdirSync(path.join(cwd, ".git/hooks"), { recursive: true });
	writeFileSync(path.join(cwd, "README"), "fixture\n");
	execFileSync("git", ["-C", cwd, "add", "README"]);
	execFileSync("git", ["-C", cwd, "commit", "-qm", "init"]);
	const tmp = path.join(root, "tmp");
	mkdirSync(tmp);
	const agentDir = agentInsideCwd ? path.join(cwd, ".agent") : path.join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(path.join(agentDir, "settings.json"), "{}\n");
	if (existsSync(POLICY_TEMPLATE)) cpSync(POLICY_TEMPLATE, path.join(agentDir, "sandbox-policy"), { recursive: true });
	const policyFile = path.join(agentDir, "sandbox-policy", PLATFORM_DIR, "policy.json");
	return { root, cwd, escape, agentDir, policyFile, tmp };
}

export function cleanupAll() {
	for (const p of created) rmSync(p, { recursive: true, force: true });
	created.clear();
	try {
		execFileSync("rmdir", [ARTIFACT_ROOT], { stdio: "ignore" });
	} catch {}
}

/** Host-side TCP listener that answers a canned HTTP response and records every accepted connection. */
export async function hostListener() {
	const hits = [];
	const socks = new Set();
	const server = net.createServer((s) => {
		socks.add(s);
		s.on("close", () => socks.delete(s));
		hits.push(Date.now());
		s.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return { port: server.address().port, hits, close: () => new Promise((r) => { for (const s of socks) s.destroy(); server.close(r); }) };
}

/** Host-side abstract unix socket listener (Linux: a leading NUL); answers with a byte. */
export async function abstractListener() {
	const name = `sova-redteam-${rand()}`;
	const hits = [];
	const socks = new Set();
	const server = net.createServer((s) => {
		socks.add(s);
		s.on("close", () => socks.delete(s));
		hits.push(Date.now());
		s.end("k\n");
	});
	await new Promise((r, j) => server.once("error", j).listen(`\0${name}`, r));
	return { name, hits, close: () => new Promise((r) => { for (const s of socks) s.destroy(); server.close(r); }) };
}

/** Spawn and collect, never throwing. */
export function run(argv, { cwd, env, timeoutMs = 30_000 } = {}) {
	return new Promise((resolve) => {
		const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.on("error", (e) => {
			clearTimeout(t);
			resolve({ code: 127, stdout, stderr: stderr + String(e), spawnError: true });
		});
		child.on("close", (code, signal) => {
			clearTimeout(t);
			resolve({ code: code ?? 128, signal, stdout, stderr });
		});
	});
}

/** A UI context whose every method is a no-op; `confirm` DENIES and is recorded (an escalation
 * prompt must never be auto-granted by a test). */
export function stubUi(log = []) {
	return new Proxy(
		{},
		{
			get(_t, key) {
				if (key === "then") return undefined;
				if (key === "confirm") return async (...a) => (log.push(["confirm", ...a]), false);
				if (key === "select" || key === "input" || key === "editor") return async (...a) => (log.push([key, ...a]), undefined);
				if (key === "theme") return undefined;
				return (...a) => {
					log.push([String(key), ...a]);
					return undefined;
				};
			},
		},
	);
}

/**
 * Open a pi runtime like Sova does. `withExtension` loads ONLY the sandbox extension (noExtensions
 * otherwise, so the comparison is sandbox vs nothing). `flags` become extensionFlagValues.
 */
export async function openSession({ cwd, agentDir, withExtension, flags = {}, ui = true, mode = "rpc", entries, eventBus } = {}) {
	const P = await pi();
	process.env.PI_CODING_AGENT_DIR = agentDir; // getAgentDir() is read at call time by extensions
	const uiLog = [];
	const errors = [];
	const createRuntime = async ({ cwd: c, sessionManager, sessionStartEvent }) => {
		const services = await P.createAgentSessionServices({
			cwd: c,
			agentDir,
			extensionFlagValues: new Map(Object.entries(flags)),
			resourceLoaderOptions: { noExtensions: true, additionalExtensionPaths: withExtension ? [EXT_ENTRY] : [], ...(eventBus ? { eventBus } : {}) },
		});
		return { ...(await P.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })), services, diagnostics: services.diagnostics };
	};
	const runtime = await P.createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: P.SessionManager.inMemory(cwd, undefined, entries) });
	for (const d of runtime.diagnostics ?? []) if (d.type === "error") errors.push(`diagnostic: ${d.message}`);
	const session = runtime.session;
	await session.bindExtensions({
		...(ui ? { uiContext: stubUi(uiLog) } : {}),
		mode,
		onError: (err) => errors.push(`[${err.extensionPath}] ${err.error}`),
	});
	let callN = 0;
	const tool = (name) => session._toolRegistry.get(name);
	/** Execute a tool through the session's own wrapped registry entry. Never throws. */
	async function call(name, params, { signal } = {}) {
		const t = tool(name);
		if (!t) return { isError: true, text: `no tool ${name}`, missing: true };
		try {
			const r = await t.execute(`rt-${++callN}`, params, signal ?? new AbortController().signal, () => {});
			const text = (r?.content ?? []).map((c) => c.text ?? "").join("");
			return { isError: !!r?.isError, text, raw: r };
		} catch (e) {
			return { isError: true, threw: true, text: String(e?.message ?? e) };
		}
	}
	const runner = () => session._extensionRunner; // TS-private, runtime-present (agent-session.js)
	async function command(name, args) {
		const cmd = runner().getCommand(name);
		if (!cmd) throw new Error(`no /${name} command registered`);
		const ctx = runner().createCommandContext();
		return await cmd.handler(args, ctx);
	}
	const registry = () =>
		["read", "bash", "edit", "write", "grep", "find", "ls"].map((n) => {
			const d = session.getToolDefinition(n);
			const info = session.getAllTools().find((t) => t.name === n);
			return d
				? {
						name: n,
						label: d.label,
						description: d.description,
						parameters: JSON.stringify(d.parameters),
						promptSnippet: d.promptSnippet,
						promptGuidelines: JSON.stringify(d.promptGuidelines),
						executionMode: d.executionMode,
						source: info?.sourceInfo?.source,
					}
				: { name: n, absent: true };
		});
	return {
		session,
		runtime,
		errors,
		uiLog,
		call,
		bash: (command, opts) => call("bash", { command, ...(opts?.timeout ? { timeout: opts.timeout } : {}) }, opts),
		command,
		runner,
		/** Whether some extension holds a handler for an event type (F1: must stay false for before_agent_start). */
		hasHandler: (eventType) => {
			try {
				const exts = runner().extensions;
				if (!Array.isArray(exts) && !(exts instanceof Map)) return { unknown: true };
				const list = exts instanceof Map ? [...exts.values()] : exts;
				for (const ext of list) {
					const hs = ext?.handlers?.get?.(eventType);
					if (hs && hs.length > 0) return true;
				}
				return false;
			} catch {
				return { unknown: true };
			}
		},
		systemPrompt: () => session.systemPrompt,
		registry,
		entries: () => session.sessionManager.getEntries?.() ?? session.sessionManager.getBranch(),
		dispose: async () => {
			try {
				await runtime.dispose();
			} catch {}
		},
	};
}

/** Env keys from `env -0` output. */
export const envKeys = (out) =>
	out
		.split("\0")
		.filter(Boolean)
		.map((l) => l.slice(0, l.indexOf("=")))
		.filter(Boolean)
		.sort();

/** Variables the env allowlist must always drop (plan v2 §3.4). */
export const FORBIDDEN_ENV = [
	"DBUS_SESSION_BUS_ADDRESS","SSH_AUTH_SOCK","SSH_AGENT_PID","DISPLAY","WAYLAND_DISPLAY","XAUTHORITY",
	"TMUX","TMUX_PANE","STY","DOCKER_HOST","XDG_RUNTIME_DIR","GPG_AGENT_INFO","GPG_TTY",
	"DBUS_STARTER_ADDRESS","SYSTEMD_EXEC_PID","INVOCATION_ID","NOTIFY_SOCKET","GH_TOKEN","GITHUB_TOKEN","NPM_TOKEN",
];

/** Minimal already-scrubbed env for the confined process, per the Policy.env contract: callers pass exactly
 * what the sandbox may see (backend.ts: "The already-scrubbed environment. Backends add, never widen."). */
export function baseEnv(extra = {}) {
	const pick = (k) => (process.env[k] !== undefined ? { [k]: process.env[k] } : {});
	return {
		...pick("PATH"), ...pick("HOME"), ...pick("USER"), ...pick("LOGNAME"),
		...pick("SHELL"), ...pick("LANG"), ...pick("TERM"), ...pick("TZ"),
		TMPDIR: "/tmp",
		...extra,
	};
}

/** Raw TCP connect attempt; true when the connection was accepted. */
export function tryConnect(host, port, timeoutMs = 4000) {
	return new Promise((resolve) => {
		const s = net.connect({ host, port });
		const done = (yes) => { try { s.destroy(); } catch {} resolve(yes); };
		s.setTimeout(timeoutMs);
		s.once("connect", () => done(true));
		s.once("timeout", () => done(false));
		s.once("error", () => done(false));
	});
}

/** Host-side quick HTTP reachability check; resolves the status code or null. */
export async function hostHttpStatus(url, timeoutMs = 5000) {
	try {
		const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
		return r.status;
	} catch {
		return null;
	}
}

/**
 * Test-side reference allowlisting proxy, the shape plan v2 §3.3 specifies for proxy.ts: one HTTP
 * CONNECT proxy on a Unix socket; allowlisted hostnames get a tunnel, everything else a 403.
 * Independent of the implementation under test; records connect attempts for assertions.
 */
export async function stubProxy({ allow = [], socketPath } = {}) {
	const hits = [];
	const refused = [];
	const pxSocks = new Set();
	const ok = (host) => allow.some((a) => host === a || host.endsWith(`.${a}`));
	const server = net.createServer((conn) => {
		pxSocks.add(conn);
		conn.on("close", () => pxSocks.delete(conn));
		let buf = "";
		const onData = (d) => {
			buf += d.toString("utf8");
			const end = buf.indexOf("\r\n\r\n");
			if (end === -1) return;
			conn.off("data", onData);
			const line = buf.slice(0, buf.indexOf("\r\n"));
			const m = /^CONNECT ([^:\s]+):(\d+)/.exec(line);
			if (!m) {
				conn.end("HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n");
				return;
			}
			const [, host, port] = m;
			if (!ok(host)) {
				refused.push(host);
				conn.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nsandbox proxy: ${host} is not on the allowlist\n`);
				return;
			}
			targetNet(host, Number(port))
				.then((up) => {
					if (!up) {
						conn.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
						return;
					}
					hits.push(host);
					conn.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					const rest = Buffer.from(buf.slice(end + 4), "utf8");
					if (rest.length) up.write(rest);
					conn.pipe(up).pipe(conn);
				})
				.catch(() => conn.destroy());
		};
		conn.on("data", onData);
		conn.on("error", () => {});
	});
	function targetNet(host, port) {
		return new Promise((resolve, reject) => {
			const up = net.connect({ host, port, timeout: 8000 });
			up.once("connect", () => { up.removeAllListeners("error"); up.removeAllListeners("timeout"); resolve(up); });
			up.once("error", reject);
			up.once("timeout", () => { up.destroy(); reject(new Error("timeout")); });
		});
	}
	await new Promise((r, j) => server.once("error", j).listen(socketPath, r));
	return { socket: socketPath, hits, refused, close: () => new Promise((r) => { for (const s of pxSocks) s.destroy(); server.close(r); }) };
}

/** Deterministic stringify for deep-equality of registry snapshots (sorted keys, full depth). */
export function stable(value) {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
	return JSON.stringify(value) ?? "undefined";
}
