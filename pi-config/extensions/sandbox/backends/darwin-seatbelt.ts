/**
 * The macOS backend: Seatbelt through `/usr/bin/sandbox-exec -f <profile file>` (plan v2 §13).
 *
 * Seatbelt cannot remap a path the way a bind mount does, so the shape differs from bwrap while
 * the policy is the same: the whole filesystem stays readable, writes are allowed only below the
 * policy's writable roots and the session tmp (reached through TMPDIR, since a literal /tmp cannot
 * be redirected), and the protected paths are denied after them (in SBPL the last matching rule
 * wins, so the rules go shallow to deep: see writeLayers). Everything is spelled canonically:
 * Seatbelt matches the resolved vnode path, so a rule for `/tmp/x` never matches (the file is at
 * `/private/tmp/x`), and the same holds for /var.
 *
 * The profile is always a file, never an inline `-p` string: one per policy, named by its hash,
 * next to (not inside) the session tmp, re-checked byte for byte before each use.
 *
 * Network: `(deny network*)`, then outbound to exactly one loopback port, a host-side TCP relay
 * to the session proxy's Unix socket (proxy.ts), plus the policy's `localPorts`. No DNS inside
 * (mDNSResponder is a Unix socket, and so are ssh-agent, Docker and every launchd service
 * socket): only sockets under the session tmp and the writable roots can be reached.
 *
 * Mach services are denied by default with a short allowlist; Keychain (securityd) is denied
 * explicitly as well as its files.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
	Backend,
	ConfineRequest,
	ConfineResult,
	Confined,
	PlatformContext,
	PlatformDefaults,
	Policy,
	ProbeResult,
	Shadow,
} from "../backend.ts";
import { canonicalizePath, isWithin, policyKey, writeSet } from "../backend.ts";
import { proxyEnv } from "../env.ts";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Test-only: a runtime opened in-process (the red-team suite loads the extension through its own
 * module instance) reads its sandbox-exec from this global when set. A global, not an env var or
 * PATH: only code already running in the agent process can set it, and nothing inherits it.
 */
export const SANDBOX_EXEC_OVERRIDE = Symbol.for("sova.sandbox.test.sandboxExec");

export const DENIAL_SIGNATURES: readonly string[] = [
	"Operation not permitted",
	// zsh's spelling, e.g. for an exec Seatbelt refused (setuid binaries: sudo, ps, top).
	"operation not permitted",
	"Permission denied",
	"Read-only file system",
	"Could not resolve host",
	"nodename nor servname provided",
	"not in the sandbox proxy allowlist",
	"CONNECT tunnel failed",
	"from proxy after CONNECT",
];

/** sandbox-exec prefixes its own failures (bad profile, sandbox_apply refused when already sandboxed). */
export const RUNNER_FATAL: readonly string[] = ["^sandbox-exec: ", "^sandbox_apply: "];

/**
 * The mach services a sandboxed command may look up. Each one is here because ordinary tools fail
 * without it; everything else (securityd, launchd services, pasteboard, WindowServer, …) is denied.
 */
export const MACH_ALLOW: readonly string[] = [
	// getpwuid/getgrgid and friends: node's os.userInfo, id, git, python's getpass.
	"com.apple.system.opendirectoryd.libinfo",
	"com.apple.system.opendirectoryd.membership",
	// notify(3): timezone and locale change notifications used by libc.
	"com.apple.system.notification_center",
	// os_log: without it every process logs a lookup failure; it carries no host data back.
	"com.apple.logd",
	// TLS certificate evaluation (Security.framework): curl, git and python https through the proxy.
	"com.apple.trustd",
	"com.apple.trustd.agent",
];

/** Keychain and the security daemons: denied even if a later edit widened MACH_ALLOW. */
export const MACH_DENY_PREFIXES: readonly string[] = ["com.apple.SecurityServer", "com.apple.securityd", "com.apple.security."];

export function findExecutable(name: string, pathVar = process.env.PATH ?? ""): string | undefined {
	for (const dir of pathVar.split(":")) {
		if (!dir) continue;
		const candidate = join(dir, name);
		try {
			accessSync(candidate, constants.X_OK);
			if (statSync(candidate).isFile()) return candidate;
		} catch {}
	}
	return undefined;
}

function kindOf(path: string): "dir" | "file" | "missing" {
	try {
		return statSync(path).isDirectory() ? "dir" : "file";
	} catch {
		return "missing";
	}
}

function uniq<T>(xs: T[]): T[] {
	return [...new Set(xs)];
}

/** An SBPL string literal. */
export function sbplString(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Every spelling Seatbelt may see for a canonical path: the canonical one, and for the firmlinked
 * /private/{tmp,var,etc} the short one too (harmless if never matched; cheap if some kernel path
 * reports it).
 */
export function spellings(canonical: string): string[] {
	const out = [canonical];
	const m = /^\/private(\/(?:tmp|var|etc)(?:\/.*)?)$/.exec(canonical);
	if (m) out.push(m[1]!);
	return out;
}

const subpaths = (paths: string[]) => paths.flatMap(spellings).map((p) => `(subpath ${sbplString(p)})`);
const literals = (paths: string[]) => paths.flatMap(spellings).map((p) => `(literal ${sbplString(p)})`);

export interface ProfileInput {
	policy: Policy;
	/** The relay's loopback port in proxy mode; undefined means no proxy. */
	relayPort?: number;
}

/** What the profile allows and denies, as data; `renderProfile` turns it into SBPL. Exported for tests. */
export interface ProfilePlan {
	writable: string[];
	readOnly: string[];
	/** Ancestors between a writable root and a protected path: the entry itself may not be renamed or removed. */
	pins: string[];
	hidden: string[];
	/** Unix sockets may be bound and reached only here. */
	socketRoots: string[];
	ports: number[];
	shadowed: Shadow[];
}

/** Keychain files: hidden in every profile, whatever the policy file lists (the service is denied too). */
export function keychainDirs(home: string): string[] {
	return [join(home, "Library", "Keychains"), "/Library/Keychains"];
}

function homeOf(policy: Policy): string {
	return policy.env.HOME || homedir();
}

export function profilePlan({ policy, relayPort }: ProfileInput): ProfilePlan {
	const canon = (p: string) => canonicalizePath(p);
	const tmp = canon(policy.tmpDir);
	const hidden = uniq([...policy.hidden, ...keychainDirs(homeOf(policy))].map(canon));
	const set = writeSet(policy);
	const shadows = set.shadowed;
	// A shadowed path is the host's (a cache host tools run code from): read-only here. Its private
	// copy (the source) is what the sandbox writes, reached through the env (see shadowEnv).
	const shadowPaths = new Set(shadows.map((s) => s.path));
	const realWritable = set.writable.filter((w) => !shadowPaths.has(w));
	const writable = uniq([tmp, ...realWritable, ...shadows.map((s) => s.source)]);
	const readOnly = uniq([...set.readOnly, ...shadows.map((s) => s.path)]);
	const inWritable = (p: string) => writable.some((w) => isWithin(p, w));
	const protectedPaths = [...readOnly, ...hidden].filter(inWritable);
	const pins: string[] = [];
	for (const p of protectedPaths) {
		const root = writable.filter((w) => isWithin(p, w) && w !== p).sort((a, b) => b.length - a.length)[0];
		if (!root) continue;
		// The protected path itself and each ancestor below the root: renaming one away and
		// recreating it would plant a fresh copy on the host (`mv .git .x && mkdir -p .git/hooks`).
		for (let a = p; a !== root && isWithin(a, root); a = dirname(a)) pins.push(a);
	}
	// A writable root inside a read-only path (a linked worktree's admin dir in <common>/worktrees)
	// is a mount point under bwrap: here too its entry may not be renamed or removed.
	for (const w of writable) if (readOnly.some((r) => r !== w && isWithin(w, r))) pins.push(w);
	const ports = uniq([...(relayPort ? [relayPort] : []), ...(policy.network.localPorts ?? [])]).filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
	return { writable, readOnly, pins: uniq(pins), hidden, socketRoots: writable.filter((w) => !shadows.some((s) => s.source === w)), ports, shadowed: shadows };
}

/**
 * The writable and read-only paths in the order SBPL needs so the deeper path has the last word,
 * as in checkWrite and bwrap's stacked mounts: a layer allows only paths inside a path an earlier
 * layer denied, and denies only paths inside (or equal to) one an earlier layer allowed. So a
 * linked worktree's admin dir is writable inside the read-only <common>/worktrees, and its own
 * read-only paths are denied again after it. Paths that do not nest may share a layer.
 */
export function writeLayers(plan: Pick<ProfilePlan, "writable" | "readOnly">): { allow: string[]; deny: string[] }[] {
	const entries = [...plan.writable.map((path) => ({ path, allow: true })), ...plan.readOnly.map((path) => ({ path, allow: false }))];
	// Shallow first; for the identical path the allow first, so the deny (read-only) wins.
	entries.sort((a, b) => a.path.length - b.path.length || Number(b.allow) - Number(a.allow));
	const layers: { allow: string[]; deny: string[] }[] = [];
	const placed: { path: string; allow: boolean; layer: number }[] = [];
	for (const e of entries) {
		const over = placed.filter((q) => q.allow !== e.allow && isWithin(e.path, q.path) && (q.allow || q.path !== e.path));
		const layer = Math.max(-1, ...over.map((q) => q.layer)) + 1;
		placed.push({ ...e, layer });
		layers[layer] ??= { allow: [], deny: [] };
		layers[layer]![e.allow ? "allow" : "deny"].push(e.path);
	}
	return layers;
}

export function renderProfile(plan: ProfilePlan): string {
	const L: string[] = [];
	const rule = (head: string, filters: string[]) => {
		if (filters.length) L.push(`(${head}\n  ${filters.join("\n  ")})`);
	};
	L.push(
		"(version 1)",
		";; Generated by the sova sandbox (darwin-seatbelt). Do not edit: it is rewritten from the policy.",
		"(deny default)",
		"(allow process-exec process-fork)",
		"(allow signal (target same-sandbox))",
		"(allow sysctl-read)",
		"(allow file-read*)",
		"(allow pseudo-tty)",
		"(allow ipc-posix-sem)",
		// libnotify's read-only fast path (the notification_center service is on the allowlist anyway).
		'(allow ipc-posix-shm-read-data (ipc-posix-name "apple.shm.notification_center"))',
		`(allow file-write* file-ioctl
  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (literal "/dev/tty") (literal "/dev/ptmx")
  (regex #"^/dev/ttys[0-9]+$") (regex #"^/dev/fd/"))`,
	);
	rule("allow mach-lookup", MACH_ALLOW.map((n) => `(global-name ${sbplString(n)})`));
	L.push(";; writable roots and what stays read-only inside them, shallow to deep (the last matching rule wins)");
	for (const layer of writeLayers(plan)) {
		rule("allow file-write*", subpaths(layer.allow));
		rule("deny file-write*", subpaths(layer.deny));
	}
	rule("deny file-write*", literals(plan.pins));
	L.push(";; hidden: neither read nor written");
	rule("deny file-read* file-write*", subpaths(plan.hidden));
	L.push(";; Keychain and the security daemons, whatever the allowlist above says");
	rule("deny mach-lookup", MACH_DENY_PREFIXES.map((n) => `(global-name-prefix ${sbplString(n)})`));
	L.push(";; network: none, except Unix sockets under the writable roots and the listed loopback ports", "(deny network*)");
	rule("allow network-bind network-outbound", plan.socketRoots.flatMap(spellings).map((p) => `(local unix-socket (subpath ${sbplString(p)}))`));
	rule("allow network-outbound", plan.socketRoots.flatMap(spellings).map((p) => `(remote unix-socket (subpath ${sbplString(p)}))`));
	rule("allow network-outbound", plan.ports.map((p) => `(remote ip ${sbplString(`localhost:${p}`)})`));
	return L.join("\n") + "\n";
}

/**
 * Tools that honour a variable get pointed at a shadow's private copy; the host path itself is
 * read-only inside the sandbox. Only the caches whose tools have such a variable are redirected.
 */
export function shadowEnv(shadows: Shadow[], env: Record<string, string>, home: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const s of shadows) {
		if (s.path === canonicalizePath(env.XDG_CACHE_HOME || join(home, ".cache"))) out.XDG_CACHE_HOME = s.source;
		else if (s.path === canonicalizePath(join(home, ".npm"))) out.npm_config_cache = s.source;
		else if (s.path === canonicalizePath(join(home, ".m2"))) out.MAVEN_OPTS = `${env.MAVEN_OPTS ? env.MAVEN_OPTS + " " : ""}-Dmaven.repo.local=${join(s.source, "repository")}`;
	}
	return out;
}

/** Writes the profile next to the session tmp (never inside it), named by its hash; re-checked on reuse. */
export function writeProfile(tmpDir: string, text: string): string {
	const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
	const file = join(dirname(canonicalizePath(tmpDir)), `seatbelt-${hash}.sb`);
	try {
		if (readFileSync(file, "utf8") === text) return file;
	} catch {}
	const tmp = `${file}.${randomBytes(4).toString("hex")}`;
	writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
	chmodSync(tmp, 0o600);
	renameSync(tmp, file);
	return file;
}

/** host TCP 127.0.0.1:<port> → the proxy's Unix socket, one per socket for the process lifetime. */
class Relays {
	private readonly bySocket = new Map<string, Promise<{ server: Server; port: number }>>();

	async portFor(socket: string): Promise<number> {
		let entry = this.bySocket.get(socket);
		if (!entry) {
			entry = new Promise((resolveRelay, reject) => {
				const server = createServer((client: Socket) => {
					const upstream = connect(socket);
					client.on("error", () => upstream.destroy());
					upstream.on("error", () => client.destroy());
					client.pipe(upstream);
					upstream.pipe(client);
				});
				server.once("error", reject);
				server.listen(0, "127.0.0.1", () => {
					server.off("error", reject);
					server.on("error", () => {});
					server.unref();
					resolveRelay({ server, port: (server.address() as { port: number }).port });
				});
			});
			this.bySocket.set(socket, entry);
			entry.catch(() => this.bySocket.delete(socket));
		}
		return (await entry).port;
	}

	/** Relays whose proxy socket is gone (the session's proxy closed) are closed too. */
	sweep(): void {
		for (const [socket, entry] of this.bySocket) {
			if (existsSync(socket)) continue;
			this.bySocket.delete(socket);
			void entry.then((e) => e.server.close(), () => {});
		}
	}
}

export interface DarwinSeatbeltOptions {
	sandboxExec?: string;
}

export class DarwinSeatbeltBackend implements Backend {
	readonly id = "darwin-seatbelt" as const;
	private readonly opts: DarwinSeatbeltOptions;
	private readonly probeCache = new Map<string, ProbeResult>();
	private readonly relays = new Relays();

	constructor(opts: DarwinSeatbeltOptions = {}) {
		this.opts = opts;
	}

	async canonicalize(path: string): Promise<string> {
		return canonicalizePath(path);
	}

	platformDefaults(ctx: PlatformContext): PlatformDefaults {
		const h = (p: string) => join(ctx.home, p);
		return {
			hidden: [
				h(".ssh"), h(".gnupg"), h(".aws"), h(".docker"), h(".kube"), h(".azure"), h(".password-store"),
				h(".config/gh"), h(".config/gcloud"), h(".config/hub"),
				h(".netrc"), h(".git-credentials"), h(".npmrc"), h(".pypirc"), h(".cargo/credentials.toml"),
				h(".claude/.credentials.json"), h(".claude.json"),
				// Keychain files are always hidden by the profile itself (keychainDirs); browser and mail data.
				h("Library/Keychains"), "/Library/Keychains",
				h("Library/Cookies"), h("Library/Safari"), h("Library/Mail"), h("Library/Messages"),
				h("Library/Group Containers"), h("Library/Application Support/com.apple.TCC"),
				h("Library/Application Support/Google/Chrome"), h("Library/Application Support/BraveSoftware"),
				h("Library/Application Support/Firefox"), h("Library/Application Support/Microsoft Edge"),
				h("Library/Application Support/Arc"),
				...uniq([ctx.agentDir, h(".pi/agent")]).flatMap((a) => [join(a, "auth.json"), join(a, "sova", "api-token")]),
			],
			writable: [h(".local/state/mise")],
			shadowed: [h(".cache"), h(".npm"), h(".m2")],
			readOnlyWithinWritable: [
				ctx.agentDir, h(".pi"), h(".claude"), h(".config"), h(".local/bin"), h(".local/share"),
				h(".bashrc"), h(".bash_profile"), h(".profile"), h(".zshrc"), h(".zprofile"), h(".zshenv"), h(".zlogin"),
				h(".gitconfig"), h(".envrc"), h("Library/LaunchAgents"), h("Library/Preferences"),
			],
		};
	}

	async confine(req: ConfineRequest): Promise<ConfineResult> {
		const { policy } = req;
		if ((policy.level as string) === "full") {
			return { ok: false, code: "SANDBOX_UNAVAILABLE", reason: 'level "full" is not confined; the caller runs it directly' };
		}
		const override = (globalThis as Record<symbol, unknown>)[SANDBOX_EXEC_OVERRIDE];
		const sandboxExec = this.opts.sandboxExec ?? (typeof override === "string" ? override : SANDBOX_EXEC);
		if (kindOf(sandboxExec) !== "file") return { ok: false, code: "SANDBOX_UNAVAILABLE", reason: `${sandboxExec} not found` };
		if (!req.argv.length) return { ok: false, code: "SANDBOX_UNAVAILABLE", reason: "empty argv" };
		if (kindOf(policy.tmpDir) !== "dir") {
			try {
				mkdirSync(policy.tmpDir, { recursive: true, mode: 0o700 });
			} catch (err) {
				return { ok: false, code: "SANDBOX_UNAVAILABLE", reason: `cannot create the session tmp dir ${policy.tmpDir}: ${(err as Error).message}` };
			}
		}

		const notes: string[] = [];
		let network = policy.network.mode;
		let relayPort: number | undefined;
		this.relays.sweep();
		if (network === "proxy") {
			const socket = policy.network.proxy?.socket;
			if (!socket || !existsSync(socket)) {
				network = "none";
				notes.push("network: the proxy socket is not available; the sandbox has no network");
			} else {
				try {
					relayPort = await this.relays.portFor(socket);
				} catch (err) {
					network = "none";
					notes.push(`network: the proxy relay did not start (${(err as Error).message}); the sandbox has no network`);
				}
			}
		}

		let plan: ProfilePlan;
		let profile: string;
		try {
			plan = profilePlan({ policy, relayPort });
			for (const s of plan.shadowed) mkdirSync(s.source, { recursive: true, mode: 0o700 });
			profile = writeProfile(policy.tmpDir, renderProfile(plan));
		} catch (err) {
			return { ok: false, code: "SANDBOX_UNAVAILABLE", reason: `cannot write the Seatbelt profile: ${(err as Error).message}` };
		}
		if (plan.shadowed.length) {
			notes.push("shadowed caches: the host copies are read-only here; XDG_CACHE_HOME, npm_config_cache and MAVEN_OPTS point at the sandbox's own copies");
		}

		const home = policy.env.HOME || process.env.HOME || "";
		const env: Record<string, string> = {
			...policy.env,
			...(req.env ?? {}),
			...shadowEnv(plan.shadowed, policy.env, home),
			TMPDIR: canonicalizePath(policy.tmpDir) + "/",
		};
		if (network === "proxy") Object.assign(env, proxyEnv(relayPort!));

		const confined: Confined = {
			argv: [sandboxExec, "-f", profile, ...req.argv],
			env,
			enforcement: "full",
			network,
			denialSignatures: [...DENIAL_SIGNATURES],
			runnerFailure: { fatalSignatures: [...RUNNER_FATAL] },
		};
		if (notes.length) confined.notes = notes;
		return { ok: true, confined };
	}

	/**
	 * Runs the real profile with self-checks, each confirmed from the host where it can be: a write
	 * outside the policy never lands, a host loopback listener outside the allowed ports is never
	 * reached, the Keychain directory cannot be listed, and (proxy mode) the relay port connects.
	 */
	async probe(policy: Policy): Promise<ProbeResult> {
		const key = policyKey(policy);
		const cached = this.probeCache.get(key);
		if (cached) return cached;

		const outside = pickOutsideDir(policy);
		const target = outside ? join(outside, `.sova-sandbox-probe-${randomBytes(6).toString("hex")}`) : "";
		let reached = false;
		const listener = createServer((s) => {
			reached = true;
			s.destroy();
		});
		const bait = await new Promise<number>((r) => listener.listen(0, "127.0.0.1", () => r((listener.address() as { port: number }).port)));
		try {
			const keychains = keychainDirs(homeOf(policy))[0]!;
			const script = [
				`if [ -n "$1" ]; then ( : > "$1" ) 2>/dev/null && { echo "probe: wrote outside the policy" >&2; exit 73; }; fi`,
				`if [ -d "$2" ]; then ls "$2" >/dev/null 2>&1 && { echo "probe: the Keychain directory is readable" >&2; exit 75; }; fi`,
				`/usr/bin/nc -z -G 2 127.0.0.1 "$3" >/dev/null 2>&1 && { echo "probe: reached a loopback port outside the policy" >&2; exit 76; }`,
				`if [ -n "$4" ]; then /usr/bin/nc -z -G 2 127.0.0.1 "$4" >/dev/null 2>&1 || { echo "probe: the proxy relay is not reachable" >&2; exit 74; }; fi`,
				`( : > "$TMPDIR/.probe" ) 2>/dev/null || { echo "probe: the session tmp is not writable" >&2; exit 77; }`,
				`exit 0`,
			].join("\n");
			const res = await this.confine({ argv: ["/bin/sh", "-c", script, "sova-sandbox-probe", target, keychains, String(bait)], cwd: policy.workspaceRoot, policy });
			if (!res.ok) return { ok: false, reason: res.reason };
			const c = res.confined;
			c.argv.push(c.network === "proxy" ? c.env.HTTP_PROXY!.replace(/^.*:/, "") : "");
			const run = await runCapture(c.argv, c.env, policy.workspaceRoot, 15_000);
			if (target && existsSync(target)) {
				try {
					rmSync(target, { force: true });
				} catch {}
				return { ok: false, reason: `probe: a write to ${outside} reached the host` };
			}
			if (reached) return { ok: false, reason: "probe: a loopback port outside the policy was reached" };
			if (run.code !== 0) {
				const why = run.output.trim().split("\n").filter(Boolean).slice(-3).join("; ") || `exit ${run.code ?? run.signal}`;
				return { ok: false, reason: `sandbox probe failed: ${why}` };
			}
			const result: ProbeResult = { ok: true, enforcement: c.enforcement, network: c.network };
			if (c.partialReasons?.length) result.reasons = c.partialReasons;
			if (c.notes?.length) result.notes = c.notes;
			this.probeCache.set(key, result);
			return result;
		} finally {
			listener.close();
		}
	}
}

/** A host-writable directory the policy must NOT let the sandbox write, for the probe's write check. */
function pickOutsideDir(policy: Policy): string | undefined {
	const writable = policy.level === "workspace-write" ? [...policy.writable, policy.workspaceRoot].map((p) => canonicalizePath(p)) : [];
	const candidates = policy.level === "read-only" ? [policy.workspaceRoot] : [];
	candidates.push(process.env.HOME ?? "", dirname(policy.workspaceRoot));
	for (const c of candidates) {
		if (!c) continue;
		const d = canonicalizePath(c);
		if (writable.some((w) => isWithin(d, w))) continue;
		try {
			accessSync(d, constants.W_OK);
			if (statSync(d).isDirectory()) return d;
		} catch {}
	}
	return undefined;
}

export function runCapture(argv: string[], env: Record<string, string>, cwd: string, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
	return new Promise((resolveRun) => {
		const child = spawn(argv[0]!, argv.slice(1), { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (d) => (output += d));
		child.stderr.on("data", (d) => (output += d));
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			resolveRun({ code: null, signal: null, output: `sandbox-exec: ${err.message}` });
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolveRun({ code, signal, output });
		});
	});
}
