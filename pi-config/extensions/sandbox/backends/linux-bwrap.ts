/**
 * The Linux backend: bubblewrap (plan v2 §3). Per command, about 5 ms: the host root read-only,
 * the writable roots bound in place, a private /tmp backed by the session tmp dir (a write-only
 * worker instead keeps the host's /tmp, read-only, with its Unix sockets masked), /run replaced
 * (the user bus, systemd, Docker, ssh-agent, Wayland all live there), every namespace unshared
 * including the network, and the environment cleared to the policy's allowlist.
 *
 * Paths protected inside a writable root (read-only overlays, masked secrets) are only as strong
 * as their ancestors: `mv .git .x && mkdir -p .git/hooks` would plant a fresh copy on the host.
 * So every ancestor between the writable root and a protected path is bound onto itself, which
 * makes it a mount point that cannot be renamed or removed (EBUSY) while staying writable.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, type Dirent, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type {
	Backend,
	ConfineRequest,
	ConfineResult,
	Confined,
	PlatformContext,
	PlatformDefaults,
	Policy,
	ProbeResult,
} from "../backend.ts";
import { canonicalizePath, isWithin, mapShadowed, policyKey, writeSet } from "../backend.ts";
import { proxyEnv } from "../env.ts";

export { gitProtectedPaths, trustStores } from "../backend.ts";

/** The relay's loopback port inside the network namespace, and where the host proxy socket appears. */
export const RELAY_PORT = 3128;
export const SANDBOX_PROXY_SOCKET = "/run/sova/proxy.sock";

export const DENIAL_SIGNATURES: readonly string[] = [
	"Read-only file system",
	"Permission denied",
	"Operation not permitted",
	"Device or resource busy",
	"Could not resolve host",
	"Temporary failure in name resolution",
	"Network is unreachable",
	"not in the sandbox proxy allowlist",
	"CONNECT tunnel failed",
	"from proxy after CONNECT",
];

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** bwrap reports its own failures as "bwrap: …" on stderr, before the command starts. */
export const RUNNER_FATAL: readonly string[] = ["^bwrap: "];

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

type Kind = "dir" | "file" | "missing";
function kindOf(path: string): Kind {
	try {
		return statSync(path).isDirectory() ? "dir" : "file";
	} catch {
		return "missing";
	}
}

function canonical(path: string): string {
	return canonicalizePath(path);
}

/** `source` defaults to `path` (bound in place); a path inside a shadow is bound from the shadow. */
type Op =
	| { op: "bind"; path: string; source?: string }
	| { op: "ro"; path: string; source?: string }
	| { op: "hide-dir"; path: string }
	| { op: "hide-file"; path: string };

function depth(p: string): number {
	return p === sep ? 0 : p.split(sep).length - 1;
}

/**
 * The mount plan for a policy, as a list ordered so a deeper path always lands on top of a
 * shallower one. Exported for tests; `buildArgv` renders it.
 */
export function mountPlan(policy: Policy): { ops: Op[]; ensureDirs: string[] } {
	// Where a path's contents really are: inside a shadow, the shadow's source.
	const src = (p: string) => mapShadowed(policy, p);
	const hidden = uniq(policy.hidden.map(canonical)).filter((p) => kindOf(src(p)) !== "missing");
	const underHidden = (p: string) => hidden.some((h) => h !== p && isWithin(p, h));

	const set = writeSet(policy);
	const shadows = set.shadowed.filter((sh) => !underHidden(sh.path) && !hidden.includes(sh.path));
	// A shadow's source is created private on first use; its host path must exist to be a mount
	// point, so a missing one (~/.m2 on a machine without Maven) is created empty, as the tool would.
	for (const sh of shadows) {
		try {
			mkdirSync(sh.source, { recursive: true, mode: 0o700 });
			if (kindOf(sh.path) === "missing" && kindOf(dirname(sh.path)) === "dir") mkdirSync(sh.path);
		} catch {}
	}
	const shadowPaths = new Set(shadows.filter((sh) => kindOf(sh.path) === "dir" && kindOf(sh.source) === "dir").map((sh) => sh.path));
	const shadowOf = new Map(shadows.map((sh) => [sh.path, sh.source]));
	const writable = set.writable.filter((p) => !underHidden(p) && !hidden.includes(p) && (!shadowOf.has(p) || shadowPaths.has(p)));
	// Create missing hooks and trust-store dirs on the host (git and mise would) so they can be
	// bound read-only; a path that does not exist cannot be a mount point.
	for (const d of set.ensureDirs) {
		if (writable.some((w) => isWithin(d, w)) && kindOf(src(dirname(d))) === "dir" && kindOf(src(d)) === "missing") {
			try {
				mkdirSync(src(d));
			} catch {}
		}
	}
	const readOnly = set.readOnly;
	const ensureDirs = set.ensureDirs;
	const inWritable = (p: string) => writable.some((w) => isWithin(p, w));
	const ro = uniq(readOnly)
		.filter((p) => kindOf(src(p)) !== "missing" && inWritable(p) && !underHidden(p) && !hidden.includes(p));
	// Nested writable/read-only paths resolve deeper-wins (the sort below); for the identical path,
	// read-only wins.
	const writableFinal = writable.filter((w) => !ro.includes(w));

	const protectedPaths = [...ro, ...hidden.filter(inWritable)];
	const isProtectedRegion = (p: string) => ro.some((r) => isWithin(p, r)) || hidden.some((h) => isWithin(p, h));
	const pins: string[] = [];
	for (const p of protectedPaths) {
		// The nearest writable root holding p decides where the pins start.
		const root = writableFinal.filter((w) => isWithin(p, w) && w !== p).sort((a, b) => b.length - a.length)[0];
		if (!root) continue;
		for (let a = dirname(p); a !== root && isWithin(a, root); a = dirname(a)) {
			if (!isProtectedRegion(a) && !writableFinal.includes(a)) pins.push(a);
		}
	}

	// Read-only: the workspace is bound read-only in place, so it stays visible even where the
	// profile replaces the parent (a workspace under /tmp or /run).
	const roWorkspace: Op[] =
		policy.level === "read-only" && kindOf(canonical(policy.workspaceRoot)) === "dir" && !underHidden(canonical(policy.workspaceRoot))
			? [{ op: "ro", path: canonical(policy.workspaceRoot) }]
			: [];
	const withSource = <T extends "bind" | "ro">(op: T, path: string) => (src(path) === path ? { op, path } : { op, path, source: src(path) });
	const ops: Op[] = [
		...roWorkspace,
		...writableFinal.map((path) => (shadowOf.has(path) ? { op: "bind" as const, path, source: shadowOf.get(path)! } : withSource("bind", path))),
		...uniq(pins).map((path) => withSource("bind", path)),
		...ro.map((path) => withSource("ro", path)),
		...hidden.map((path) => ({ op: kindOf(src(path)) === "dir" ? ("hide-dir" as const) : ("hide-file" as const), path })),
		// A confined launch's own state, at any level: last at its depth, so it wins over a
		// read-only path it is bound exactly onto.
		...(policy.binds ?? []).map((b) => (b.source === b.path ? { op: "bind" as const, path: b.path } : { op: "bind" as const, path: b.path, source: b.source })),
	];
	// Stable sort by depth; at equal depth the order above (bind, pin, ro, hidden) is kept, and
	// equal depth with different paths never overlaps.
	ops.sort((a, b) => depth(a.path) - depth(b.path));
	return { ops, ensureDirs };
}

function uniq<T>(xs: T[]): T[] {
	return [...new Set(xs)];
}

/** How many entries `tmpSockets` reads before it gives up (the caller then keeps /tmp private). */
export const TMP_SCAN_LIMIT = 10_000;

/**
 * Every Unix socket under `root` (the host /tmp), for a write-only worker's read-only view of it:
 * a read-only mount does not stop connect(), so each is masked (a tmux server, an ssh agent, an X
 * or editor server would otherwise take commands from the worker). Symlinks are not followed, and
 * nothing under `skip` (the worker's own writable roots) is read. Undefined when `root` holds more
 * than `limit` entries: the walk would be too slow per command, and an unread socket would stay
 * reachable. Never throws; an unreadable directory is one the worker cannot list either.
 */
export function tmpSockets(root = "/tmp", skip: readonly string[] = [], limit = TMP_SCAN_LIMIT): string[] | undefined {
	const out: string[] = [];
	const stack = [root];
	let seen = 0;
	while (stack.length) {
		const dir = stack.pop()!;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		seen += entries.length;
		if (seen > limit) return undefined;
		for (const e of entries) {
			const p = join(dir, e.name);
			if (skip.some((s) => isWithin(p, s))) continue;
			if (e.isSocket()) out.push(p);
			else if (e.isDirectory()) stack.push(p);
		}
	}
	return out;
}

const RELAY_SCRIPT = [
	`"$SOVA_SOCAT" TCP-LISTEN:${RELAY_PORT},bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:${SANDBOX_PROXY_SOCKET} </dev/null >/dev/null 2>&1 &`,
	`unset SOVA_SOCAT`,
	// Wait (≤1 s) until the relay listens: /proc/net/tcp is per network namespace.
	`i=0; while [ $i -lt 200 ]; do grep -q ':${RELAY_PORT.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A' /proc/net/tcp 2>/dev/null && break; i=$((i+1)); sleep 0.005; done`,
	`exec "$@"`,
].join("\n");

export interface LinuxBwrapOptions {
	/** Resolved from PATH at each call when absent, so a PATH change (or a test shim) takes effect. */
	bwrapPath?: string;
	socatPath?: string;
}

export class LinuxBwrapBackend implements Backend {
	readonly id = "linux-bwrap" as const;
	private readonly opts: LinuxBwrapOptions;
	private readonly probeCache = new Map<string, ProbeResult>();

	constructor(opts: LinuxBwrapOptions = {}) {
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
				h(".config/gh"), h(".config/gcloud"), h(".config/hub"), h(".local/share/keyrings"),
				h(".mozilla"), h(".config/google-chrome"), h(".config/chromium"), h(".config/BraveSoftware"),
				h(".netrc"), h(".git-credentials"), h(".npmrc"), h(".pypirc"), h(".cargo/credentials.toml"),
				h(".claude/.credentials.json"), h(".claude.json"),
				// Both the runtime's agent dir and pi's default one: a hermetic agent dir (the test
				// server's) does not make the user's real credentials any less real.
				// Sova's topic store too: its open topics are other sessions' return addresses.
				...uniq([ctx.agentDir, h(".pi/agent")]).flatMap((a) => [join(a, "auth.json"), join(a, "sova", "api-token"), join(a, "claude-accounts"), join(a, "sova", "topics")]),
			],
			// Not the host caches: ~/.cache holds code host tools run later (AUR build dirs installed
			// as root, nvim bytecode, browser binaries), ~/.npm/_npx what npx runs, ~/.m2 Maven's
			// plugin jars. The sandbox gets its own persistent copies instead (`shadowed`).
			writable: [h(".local/state/mise")],
			shadowed: [h(".cache"), h(".npm"), h(".m2")],
			// No-ops unless a writable root contains them (a session opened at ~, or an agent dir inside
			// the workspace as in the test server): then they stay read-only.
			readOnlyWithinWritable: [
				ctx.agentDir, h(".pi"), h(".claude"), h(".config"), h(".local/bin"), h(".local/share"),
				h(".bashrc"), h(".bash_profile"), h(".profile"), h(".zshrc"), h(".zprofile"), h(".zshenv"),
				h(".gitconfig"), h(".envrc"),
			],
		};
	}

	private bwrap(pathVar: string | undefined): string | undefined {
		return this.opts.bwrapPath ?? findExecutable("bwrap", pathVar ?? process.env.PATH);
	}

	async confine(req: ConfineRequest): Promise<ConfineResult> {
		const { policy } = req;
		if ((policy.level as string) === "full") {
			return { ok: false, code: "SANDBOX_UNAVAILABLE", reason: 'level "full" is not confined; the caller runs it directly' };
		}
		const bwrap = this.bwrap(process.env.PATH);
		if (!bwrap) return { ok: false, code: "SANDBOX_UNAVAILABLE", reason: "bwrap not found on PATH" };
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
		let socat: string | undefined;
		if (network === "proxy") {
			socat = this.opts.socatPath ?? findExecutable("socat", policy.env.PATH ?? process.env.PATH);
			const socket = policy.network.proxy?.socket;
			if (!socat) {
				network = "none";
				notes.push("network: socat is not installed, so the proxy relay cannot run; the sandbox has no network");
			} else if (!socket || !existsSync(socket)) {
				network = "none";
				notes.push("network: the proxy socket is not available; the sandbox has no network");
			}
		}
		if (policy.network.localPorts?.length) notes.push("network: localPorts is not implemented; those ports are unreachable");

		// A write-only worker keeps the host's /tmp (read-only, sockets masked) when it can be walked;
		// its temp files go to its own tmp, bound writable at its own path by the mount plan.
		const tmp = canonical(policy.tmpDir);
		const sockets = policy.hostTmp ? tmpSockets("/tmp", [tmp, ...policy.writable.map(canonical)]) : undefined;
		if (policy.hostTmp && !sockets) notes.push("tmp: the host /tmp is too large to scan for sockets, so /tmp is the private tmp");
		const env: Record<string, string> = { ...policy.env, ...(req.env ?? {}), TMPDIR: sockets ? tmp : "/tmp" };
		if (network === "proxy") Object.assign(env, proxyEnv(RELAY_PORT));

		const argv: string[] = [bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/dev/shm", "--tmpfs", "/run"];
		// A socket removed between the walk and bwrap's start fails this one command ("bwrap: …"); the
		// next walk no longer lists it.
		if (sockets) {
			for (const s of sockets) argv.push("--ro-bind", "/dev/null", s);
			// Its own tmp, writable where TMPDIR names it (a write-only policy also lists it writable).
			argv.push("--bind", tmp, tmp);
		} else argv.push("--bind", tmp, "/tmp");
		// "host": the fresh /run above would hide a resolver config that lives there (systemd-resolved's
		// /etc/resolv.conf -> /run/systemd/resolve/stub-resolv.conf), leaving the network without DNS.
		if (network === "host") {
			const resolv = canonical("/etc/resolv.conf");
			if ((resolv === "/run" || resolv.startsWith("/run/")) && kindOf(resolv) === "file") argv.push("--ro-bind", resolv, resolv);
		}
		// A bind needs its target to exist as a mount point: a missing directory is made on the host.
		for (const b of policy.binds ?? []) {
			const kind = kindOf(b.source);
			if (kind === "missing") return { ok: false, code: "SANDBOX_UNAVAILABLE", reason: `bind source ${b.source} does not exist` };
			if (kindOf(b.path) === "missing" && kind === "dir") {
				try {
					mkdirSync(b.path, { recursive: true, mode: 0o700 });
				} catch {}
			}
			if (kindOf(b.path) !== kind) return { ok: false, code: "SANDBOX_UNAVAILABLE", reason: `bind target ${b.path} is missing or not a ${kind === "dir" ? "directory" : "file"}` };
		}
		const { ops } = mountPlan(policy);
		for (const o of ops) {
			if (o.op === "bind") argv.push("--bind", o.source ?? o.path, o.path);
			else if (o.op === "ro") argv.push("--ro-bind", o.source ?? o.path, o.path);
			else if (o.op === "hide-dir") argv.push("--tmpfs", o.path, "--remount-ro", o.path);
			else argv.push("--ro-bind", "/dev/null", o.path);
		}
		if (network === "proxy") argv.push("--bind", policy.network.proxy!.socket, SANDBOX_PROXY_SOCKET);
		argv.push(
			"--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try",
			"--die-with-parent", "--new-session", "--clearenv",
		);
		// "host" (a write-only worker): the host's network namespace, as unconfined.
		if (network !== "host") argv.push("--unshare-net");
		const plain: [string, string][] = [...Object.entries(env), ...(network === "proxy" ? [["SOVA_SOCAT", socat!] as [string, string]] : [])];
		if (!req.envOnFd) for (const [k, v] of plain) argv.push("--setenv", k, v);
		// Secrets (and with envOnFd every variable) never go on argv, which any local user reads in
		// /proc/<pid>/cmdline: bwrap reads more arguments, NUL-separated, from an inherited fd.
		const secrets = Object.entries(req.secretEnv ?? {});
		let fds: Confined["fds"];
		if (secrets.length || req.envOnFd) {
			const fd = req.secretFd;
			if (!Number.isInteger(fd) || fd! < 3) return { ok: false, code: "SANDBOX_UNAVAILABLE", reason: "variables on an fd need a free fd (secretFd >= 3)" };
			if (secrets.some(([k]) => !ENV_NAME.test(k))) return { ok: false, code: "SANDBOX_UNAVAILABLE", reason: "a secret variable has an invalid name" };
			const onFd = [...(req.envOnFd ? plain : []), ...secrets];
			if (onFd.some(([k, v]) => k.includes("\0") || v.includes("\0"))) return { ok: false, code: "SANDBOX_UNAVAILABLE", reason: "a variable has a NUL in its name or value" };
			fds = [{ fd: fd!, data: onFd.flatMap(([k, v]) => ["--setenv", k, v]).map((a) => `${a}\0`).join("") }];
			argv.push("--args", String(fd));
		}
		argv.push("--chdir", canonical(req.cwd), "--");
		if (network === "proxy") argv.push("/bin/sh", "-c", RELAY_SCRIPT, "sova-sandbox-relay");
		argv.push(...req.argv);

		const confined: Confined = {
			argv,
			env,
			enforcement: "full",
			network,
			denialSignatures: [...DENIAL_SIGNATURES],
			runnerFailure: { fatalSignatures: [...RUNNER_FATAL] },
		};
		if (notes.length) confined.notes = notes;
		if (fds) confined.fds = fds;
		return { ok: true, confined };
	}

	/**
	 * Runs the real profile for this policy with self-checks inside it: /run/user is gone, the only
	 * network interface is loopback, the relay listens (proxy mode), and a write to a host-writable
	 * path outside the policy fails, which is then confirmed from the host side.
	 */
	async probe(policy: Policy): Promise<ProbeResult> {
		const key = policyKey(policy);
		const cached = this.probeCache.get(key);
		if (cached) return cached;

		const outside = pickOutsideDir(policy);
		const target = outside ? join(outside, `.sova-sandbox-probe-${randomBytes(6).toString("hex")}`) : "";
		const script = [
			`[ -e /run/user ] && { echo "probe: /run/user is visible" >&2; exit 71; }`,
			`if [ "$2" != host ]; then [ "$(grep -c : /proc/net/dev)" = 1 ] || { echo "probe: the network is not isolated" >&2; exit 72; }; fi`,
			`if [ -n "$1" ]; then ( : > "$1" ) 2>/dev/null && { echo "probe: wrote outside the policy" >&2; exit 73; }; fi`,
			`if [ "$2" = proxy ]; then grep -q ':${RELAY_PORT.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A' /proc/net/tcp || { echo "probe: the proxy relay is not listening" >&2; exit 74; }; fi`,
			`exit 0`,
		].join("\n");
		const res = await this.confine({ argv: ["/bin/sh", "-c", script, "sova-sandbox-probe", target], cwd: policy.workspaceRoot, policy });
		if (!res.ok) return { ok: false, reason: res.reason };
		const c = res.confined;
		c.argv.push(c.network);
		const run = await runCapture(c.argv, c.env, 15_000);
		if (target && existsSync(target)) {
			try {
				rmSync(target, { force: true });
			} catch {}
			return { ok: false, reason: `probe: a write to ${outside} reached the host` };
		}
		if (run.code !== 0) {
			const why = run.output.trim().split("\n").filter(Boolean).slice(-3).join("; ") || `exit ${run.code ?? run.signal}`;
			return { ok: false, reason: `sandbox probe failed: ${why}` };
		}
		const result: ProbeResult = { ok: true, enforcement: c.enforcement, network: c.network };
		if (c.partialReasons?.length) result.reasons = c.partialReasons;
		if (c.notes?.length) result.notes = c.notes;
		this.probeCache.set(key, result);
		return result;
	}
}

/** A host-writable directory the policy must NOT let the sandbox write, for the probe's write check. */
function pickOutsideDir(policy: Policy): string | undefined {
	const writable = policy.level === "workspace-write" ? policy.writable.map(canonical) : [];
	const candidates = policy.level === "read-only" ? [policy.workspaceRoot] : [];
	candidates.push(process.env.HOME ?? "", dirname(policy.workspaceRoot));
	for (const c of candidates) {
		if (!c) continue;
		const d = canonical(c);
		if (writable.some((w) => isWithin(d, w))) continue;
		try {
			accessSync(d, constants.W_OK);
			if (statSync(d).isDirectory()) return d;
		} catch {}
	}
	return undefined;
}

export function runCapture(argv: string[], env: Record<string, string>, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }> {
	return new Promise((resolveRun) => {
		const child = spawn(argv[0]!, argv.slice(1), { env, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (d) => (output += d));
		child.stderr.on("data", (d) => (output += d));
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			resolveRun({ code: null, signal: null, output: `bwrap: ${err.message}` });
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolveRun({ code, signal, output });
		});
	});
}
