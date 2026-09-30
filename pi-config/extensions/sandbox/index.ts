/**
 * sandbox — confine this session's tools to the machine (see README.md and §chat/sandbox).
 *
 * On or off per session, only by the user: `/sandbox on|off` (Sova calls the same command), the
 * `--sandbox on|off` flag for a new runtime (workers get it from their parent), and a `sandbox`
 * custom entry on every change, restored from the branch like mode's `restoreActive`.
 *
 * Registration is lazy. A session that has never been on registers no tool at all, so its
 * registry and every tool call are pi's own (OFF == today). On registers the seven confined
 * definitions (tools.ts): pi's stock definitions with sandboxed operations, so no model-visible
 * field changes and there is no prompt section (BRIEF F1). Off after on re-registers pi's stock
 * factory definitions, because pi has no unregister; their source reads "extension" until the
 * session is next opened.
 *
 * Fail closed: every confined call takes a snapshot (policy re-read, proxy up, probe cached per
 * policy) and refuses when any of it fails. Never a passthrough.
 */
import { realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { backendFor, type Policy } from "./backend.ts";
import { hostEnv, scrubEnv } from "./env.ts";
import { canonicalize, loadPolicyFile, narrowScope, type ParentScope, parentScopeOf, parseParentScope, policyFilePath, type ResolvedPolicy, workerCwdRefusal, writeOnlyScope } from "./policy.ts";
import { encodeLaunchScope, OWNER_ID } from "./launch.ts";
import { type ProxyHandle, proxySocketPath, startProxy } from "./proxy.ts";
import { ensureSessionTmpDir, resolveSessionPolicy } from "./session-policy.ts";
import {
	describeActive,
	markerText,
	normalizeActive,
	parseOnOff,
	restoreActive,
	SANDBOX_DISCOVER_EVENT,
	SANDBOX_ENTRY_TYPE,
	SANDBOX_STATE_EVENT,
	type SandboxActive,
	type SandboxLevel,
	type SandboxStateEvent,
	type WorkerLaunch,
	type WorkerLaunchRequest,
} from "./state.ts";
import { confinedDefinitions, type Snapshot, type StockOptions, stockDefinitions } from "./tools.ts";

const FLAG = "sandbox";
/** Set by a sandboxed parent on its workers: its level and writable roots (`ParentScope` JSON). */
const PARENT_FLAG = "sandbox-parent";
const STATUS_KEY = "sandbox";
/** remote/workers.ts: a session on a target runs its tools there, and remote owns the seven names. */
const REMOTE_SESSION_EVENT = "remote:session";
const REMOTE_DISCOVER_EVENT = "remote:discover";
const NOT_ON_REMOTE = "not enforced on remote";
/** worktrees/state.ts WORKTREES_STATE_EVENT / WORKTREES_DISCOVER_EVENT: the session's active tracked worktrees. */
const WORKTREES_STATE_EVENT = "worktrees:state";
const WORKTREES_DISCOVER_EVENT = "worktrees:discover";

function realpathOr(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/** This extension's directory, for a worker's `-e` list. */
const SELF_DIR = realpathOr(dirname(fileURLToPath(import.meta.url)));
/** The confined-launch entry a spawner (or a hosting process) imports by path. */
const LAUNCH_MODULE = join(SELF_DIR, "launch.ts");

function offState(level: SandboxLevel = "workspace-write"): SandboxActive {
	return { version: 1, on: false, level, backend: "none", enforcement: "none" };
}

export default function sandbox(pi: ExtensionAPI) {
	pi.registerFlag(FLAG, {
		description: "Start with the sandbox on or off (on|off). Workers get it from their parent; a session started with --sandbox on cannot turn it off",
		type: "string",
	});

	pi.registerFlag(PARENT_FLAG, {
		description: "Set by a sandboxed parent on its workers: the parent's writable roots (JSON). The worker writes there only and implies --sandbox on",
		type: "string",
	});

	const backend = backendFor();
	/** This worker's parent scope, from --sandbox-parent; an error string when the flag is malformed. */
	let parentScope: ParentScope | string | undefined;
	let active: SandboxActive = offState();
	let registered: "none" | "confined" | "stock" = "none";
	let remote = false;
	let launchedOn = false;
	let statusShown = false;
	let cwd = process.cwd();
	let sessionId = "";
	let sessionDir: string | undefined;
	let proxy: ProxyHandle | undefined;
	let proxyStarting: Promise<ProxyHandle | undefined> | undefined;
	let lastPolicy: ResolvedPolicy | undefined;
	let lastNotices = "";
	let ui: ExtensionContext["ui"] | undefined;
	/** The session's active tracked worktrees (worktrees extension): writable roots while on. */
	let worktreeRoots: string[] = [];

	const agentDir = () => getAgentDir();

	function stockOptions(): StockOptions {
		const sm = SettingsManager.create(cwd, agentDir());
		return { autoResizeImages: sm.getImageAutoResize(), commandPrefix: sm.getShellCommandPrefix(), shellPath: sm.getShellPath() };
	}

	function notify(text: string, level: "info" | "warning" | "error" = "info"): void {
		try {
			ui?.notify(text, level);
		} catch {
			// Best-effort: a headless worker has nowhere to show it.
		}
	}

	/** The session id the tmp was first made for: the directory stays the same for this runtime. */
	let tmpId: string | undefined;

	function tmpDirOf(): string {
		const tmp = ensureSessionTmpDir((tmpId ??= sessionId));
		sessionDir = dirname(tmp);
		return tmp;
	}

	async function ensureProxy(allow: readonly string[]): Promise<ProxyHandle | undefined> {
		if (proxy) {
			proxy.setAllow(allow);
			return proxy;
		}
		proxyStarting ??= startProxy({ socket: proxySocketPath(sessionId || `pid${process.pid}`), allow }).then(
			(h) => (proxy = h),
			(e) => {
				notify(`Sandbox: the network proxy did not start (${(e as Error).message}); the sandbox has no network`, "warning");
				return undefined;
			},
		);
		const h = await proxyStarting;
		proxyStarting = undefined;
		h?.setAllow(allow);
		return h;
	}

	/** Everything one confined tool call runs under. Taken at the start of each call; fails closed. */
	async function snapshot(): Promise<Snapshot> {
		let tmpDir: string;
		try {
			tmpDir = tmpDirOf();
		} catch (e) {
			return { ok: false, reason: `cannot create the session tmp: ${(e as Error).message}` };
		}
		if (typeof parentScope === "string") return { ok: false, reason: parentScope };
		// The same resolution Sova's server makes for this session (session-policy.ts).
		const resolved = resolveSessionPolicy({ agentDir: agentDir(), cwd, sessionId, tmpDir, parent: parentScope, worktreeRoots, backend });
		if (!resolved.ok) return { ok: false, reason: resolved.error };
		const policy = resolved.value;
		if (policy.outsideParent) {
			const message = parentScope ? workerCwdRefusal(parentScope, cwd) : undefined;
			return { ok: false, reason: message ?? "worker cwd is outside the parent's sandbox", message };
		}
		lastPolicy = policy;
		const notices = policy.notices.join("\n");
		if (notices && notices !== lastNotices) notify(notices, "warning");
		lastNotices = notices;
		let network: Policy["network"] = { mode: policy.writeOnly ? "host" : "none" };
		if (policy.level === "workspace-write" && !policy.writeOnly) {
			const h = await ensureProxy(policy.proxyAllow);
			if (h) network = { mode: "proxy", proxy: { socket: h.socket, allow: policy.proxyAllow } };
		}
		const backendPolicy: Policy = {
			level: policy.level,
			workspaceRoot: policy.workspaceRoot,
			writable: policy.writable,
			readOnlyWithinWritable: policy.readOnlyWithinWritable,
			hidden: policy.hidden,
			tmpDir: policy.tmpDir,
			shadowed: policy.shadowed,
			network,
			env: policy.writeOnly ? hostEnv(process.env) : scrubEnv(process.env, policy.envAllow),
			sessionId,
		};
		const probe = await backend.probe(backendPolicy);
		if (!probe.ok) return { ok: false, reason: probe.reason };
		const reasons = [...(probe.reasons ?? []), ...(probe.notes ?? [])];
		return { ok: true, policy, backendPolicy, backend, enforcement: probe.enforcement, ...(reasons.length ? { reasons } : {}) };
	}

	function registerConfined(): void {
		if (remote) return;
		for (const def of confinedDefinitions(cwd, stockOptions(), { snapshot })) pi.registerTool(def);
		registered = "confined";
	}

	/** OFF: nothing when never on (the registry stays pi's own); pi's stock definitions after an on. */
	function registerStock(): void {
		if (registered !== "confined") return;
		for (const def of stockDefinitions(cwd, stockOptions())) pi.registerTool(def);
		registered = "stock";
	}

	function emitState(): void {
		const on = active.on && !remote;
		const event: SandboxStateEvent = { version: 1, on, extensionPath: SELF_DIR, enforcement: on ? active.enforcement : "none" };
		// Every worker start asks this (§chat.sandbox/workers, §chat.worktrees/workers); a remote session has none.
		if (!remote) event.workerLaunch = (req) => workerLaunch(on, req);
		pi.events?.emit(SANDBOX_STATE_EVENT, event);
	}

	/**
	 * How one worker starts (§chat.sandbox/workers, §chat.worktrees/workers). On: the parent's scope
	 * (narrowed to a tracked worktree's `root`), or the refusal; off: a write-only scope in a tracked
	 * worktree, else nothing. pi workers get the extension's flags; any other backend a scope for
	 * `confineLaunch` (launch.ts), which runs its whole process under the same policy.
	 */
	function workerLaunch(on: boolean, req: WorkerLaunchRequest): WorkerLaunch {
		const root = req.root ? canonicalize(req.root) : undefined;
		let scope: ParentScope;
		if (on) {
			const parent = lastPolicy && active.enforcement !== "unavailable" ? parentScopeOf(lastPolicy) : undefined;
			if (!parent) return { kind: "refused", reason: `Sandbox unavailable in the parent: ${active.reasons?.join("; ") ?? "no policy loaded"}. A worker cannot start sandboxed.` };
			// §chat.sandbox/fail-closed: an unattended worker (any backend) refuses to start under partial enforcement unless acceptPartial.
			if (active.enforcement === "partial" && !lastPolicy!.acceptPartial) {
				return { kind: "refused", reason: `Sandbox enforcement is partial (${active.reasons?.join("; ") ?? "unknown reason"}); set acceptPartial in the sandbox policy to start unattended workers.` };
			}
			const outside = workerCwdRefusal(parent, req.cwd);
			if (outside) return { kind: "refused", reason: outside };
			scope = root ? narrowScope(parent, root) : parent;
		} else {
			if (!root) return { kind: "none" };
			scope = writeOnlyScope(root);
		}
		if (req.backend === "pi") return { kind: "pi", extensionPath: SELF_DIR, flags: { [FLAG]: "on", [PARENT_FLAG]: JSON.stringify(scope) } };
		if (!OWNER_ID.test(req.owner) || req.owner === "." || req.owner === "..") return { kind: "refused", reason: `Sandbox: invalid worker id ${JSON.stringify(req.owner)}; a worker cannot start sandboxed.` };
		return { kind: "confine", scope: encodeLaunchScope({ v: 1, agentDir: agentDir(), sessionId: tmpId || sessionId || `pid${process.pid}`, owner: req.owner, parent: scope }), module: LAUNCH_MODULE };
	}

	function renderStatus(): void {
		if (!ui) return;
		try {
			if (active.on) {
				const tail = remote ? ` (${NOT_ON_REMOTE})` : active.enforcement === "full" ? "" : ` (${active.enforcement})`;
				ui.setStatus(STATUS_KEY, `sandbox on${tail}`);
				statusShown = true;
			} else if (statusShown) {
				ui.setStatus(STATUS_KEY, undefined);
				statusShown = false;
			}
		} catch {
			// Status is best-effort.
		}
	}

	function append(): void {
		try {
			pi.appendEntry<SandboxActive>(SANDBOX_ENTRY_TYPE, active);
		} catch {
			// Appending is impossible before session_start.
		}
	}

	/** Bring the tools and the state to `on`; the result is recorded only when `record`. */
	async function apply(on: boolean, record: boolean): Promise<void> {
		if (on) {
			registerConfined();
			if (remote) {
				active = { version: 1, on: true, level: active.level, backend: "none", enforcement: "none", reasons: [NOT_ON_REMOTE] };
			} else {
				const s = await snapshot();
				const level = s.ok ? s.policy.level : levelFromFile();
				active = s.ok
					? { version: 1, on: true, level, backend: backend.id, enforcement: s.enforcement, ...(s.reasons ? { reasons: s.reasons } : {}) }
					: { version: 1, on: true, level, backend: backend.id, enforcement: "unavailable", reasons: [s.reason] };
			}
		} else {
			registerStock();
			active = offState(active.level);
			// Off needs no proxy; the next on starts a fresh one.
			const p = proxy;
			proxy = undefined;
			await p?.close().catch(() => {});
		}
		if (record) append();
		renderStatus();
		emitState();
	}

	function levelFromFile(): SandboxLevel {
		const f = loadPolicyFile(policyFilePath(agentDir()));
		return f.ok ? f.value.level : "workspace-write";
	}

	function defaultOn(): boolean {
		const f = loadPolicyFile(policyFilePath(agentDir()));
		if (!f.ok) {
			notify(`Sandbox: ${f.error}; new sessions start with the sandbox off`, "warning");
			return false;
		}
		return f.value.defaultOn;
	}

	/** The state this branch should have: `--sandbox on` always wins, then the branch's entry, then the flag, then the policy default. */
	async function restore(ctx: ExtensionContext, first: boolean): Promise<void> {
		let restored: SandboxActive | undefined;
		try {
			restored = restoreActive(ctx.sessionManager.getBranch());
		} catch {
			restored = undefined;
		}
		if (first) {
			const raw = pi.getFlag(PARENT_FLAG);
			if (typeof raw === "string" && raw.trim()) {
				const p = parseParentScope(raw);
				parentScope = p.ok ? p.value : p.error;
			}
		}
		// A worker of a sandboxed parent is on, whatever else it was given.
		const flag = first ? (parentScope !== undefined ? true : parseOnOff(pi.getFlag(FLAG))) : launchedOn || undefined;
		if (first) launchedOn = flag === true;
		const on = launchedOn || (restored ? restored.on : flag ?? defaultOn());
		// Opening a session writes nothing unless it comes up on without an entry saying so: then the
		// choice is pinned, so a later default change cannot loosen this session.
		const record = on && restored?.on !== true;
		if (!on && registered === "none" && !active.on) {
			active = offState();
			emitState();
			return;
		}
		await apply(on, record);
		if (on && active.enforcement === "unavailable") notify(describeActive(active), "error");
	}

	pi.events?.on(REMOTE_SESSION_EVENT, () => {
		if (remote) return;
		remote = true;
		if (active.on) {
			active = { ...active, backend: "none", enforcement: "none", reasons: [NOT_ON_REMOTE] };
			renderStatus();
			emitState();
		}
	});
	pi.events?.on(SANDBOX_DISCOVER_EVENT, () => emitState());
	pi.events?.on(WORKTREES_STATE_EVENT, (data: unknown) => {
		const e = data as { version?: unknown; active?: unknown } | undefined;
		if (!e || e.version !== 1 || !Array.isArray(e.active)) return;
		const next = e.active.filter((p): p is string => typeof p === "string" && p.startsWith("/"));
		if (JSON.stringify(next) === JSON.stringify(worktreeRoots)) return;
		worktreeRoots = next;
		// On: the writable roots changed, so the scope handed to workers is taken again.
		if (active.on && !remote) void snapshot().then(() => emitState(), () => emitState());
	});
	pi.events?.emit(WORKTREES_DISCOVER_EVENT, { version: 1 });

	pi.on("session_start", async (_event, ctx) => {
		ui = ctx.hasUI ? ctx.ui : undefined;
		cwd = ctx.cwd;
		sessionId = ctx.sessionManager.getSessionId();
		// A remote target announces itself on request; it answers synchronously if it already started.
		pi.events?.emit(REMOTE_DISCOVER_EVENT, { version: 1 });
		await restore(ctx, true);
	});

	// Branch navigation (/tree, /fork) changes which entry is current.
	pi.on("session_tree", async (_event, ctx) => {
		await restore(ctx, false);
	});

	pi.on("session_shutdown", async () => {
		const p = proxy;
		proxy = undefined;
		await p?.close().catch(() => {});
		if (sessionDir) {
			try {
				rmSync(sessionDir, { recursive: true, force: true });
			} catch {
				// A leftover tmp is harmless; the next run of this session id reuses it.
			}
			sessionDir = undefined;
			tmpId = undefined;
		}
	});

	pi.registerCommand("sandbox", {
		description: "Sandbox this session's tools: /sandbox on | /sandbox off (bare: show the state)",
		getArgumentCompletions: (prefix) => ["on", "off"].filter((c) => c.startsWith(prefix.trim())).map((c) => ({ value: c, label: c })),
		handler: async (args, ctx) => {
			ui = ctx.hasUI ? ctx.ui : undefined;
			const arg = args.trim();
			if (!arg || arg === "status") {
				notify(describeActive(active));
				return;
			}
			const want = parseOnOff(arg);
			if (want === undefined) {
				notify("usage: /sandbox on | /sandbox off", "error");
				return;
			}
			if (!want && launchedOn) {
				notify("Sandbox: this session was started with --sandbox on (a worker inherits it from its parent); it cannot be turned off here", "error");
				return;
			}
			// `/sandbox on` while on re-probes (a fixed cause clears `unavailable`); it records only a change.
			const before = JSON.stringify(active);
			if (!want && !active.on) {
				notify(describeActive(active));
				return;
			}
			await apply(want, false);
			if (JSON.stringify(active) !== before) append();
			notify(describeActive(active), active.on && active.enforcement === "unavailable" ? "error" : "info");
		},
	});

	// The transcript marker for each change (TUI; Sova renders the same entry itself).
	pi.registerEntryRenderer<SandboxActive>(SANDBOX_ENTRY_TYPE, (entry, _options, theme) => {
		const a = normalizeActive(entry.data);
		return new Text(theme.fg("dim", `── ${a ? markerText(a) : "Sandbox"} ──`), 0, 0);
	});
}
