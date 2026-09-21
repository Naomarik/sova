/** Background RPC workers. Tools retain their names across extension upgrades. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	parseFrontmatter,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { type AgentGroup, AgentsModal } from "./modal.ts";
import { TeamModal } from "./team-modal.ts";
import { attachTeamWidget, type TeamWidgetHandle, type TeamWidgetUi } from "./team-widget.ts";
import { piModels, matchingModels, type CatalogModel } from "./models.ts";
import { backendDenial, policyDenial, readPolicy } from "./policy.ts";
import { BUILTIN_TOOLS as BUILTIN_TOOL_NAMES, SubagentRunner } from "./runner.ts";
import { BACKEND_DIALOG_EVENT, BACKEND_DISCOVER_EVENT, BACKEND_REGISTER_EVENT, type BackendDialogEvent, type BackendRegistration, type SteerMode, type SteerResult, type Worker, type WorkerFactory } from "./contracts.ts";
import {
	MAX_LABEL_CHARS,
	MAX_OBJECTIVE_CHARS,
	MAX_OWNED_PATHS,
	TEAM_ENTRY_TYPE,
	TeamStore,
	memberTooling,
	type PersistedMember,
	type TeamActionKind,
	type TeamActionSource,
	type TeamView,
	type WorkerObservation,
} from "./teams.ts";
import {
	MEMBER_ENV,
	appendInbox,
	encodeMemberContext,
	initMemberDir,
	scanMailboxRoot,
	writeResponse,
	type MailboxRequest,
	type MailboxResponse,
} from "./mailbox.ts";
import { MCP_SERVER_NAME } from "./member-mcp.ts";
import { WorkerRegistryRecorder } from "./registry.ts";
import { WorkerHosting, detachRequested, type HostingOptions } from "./hosting.ts";

const MAX_LIVE = 12;
const MAX_BATCH = 8;
const MAX_FINISHED = 50;
/** How often the parent looks for member mailbox requests while teams exist. */
const MAILBOX_POLL_MS = 250;
const QUESTION_CHARS = 4000;
// Public snapshot protocol consumed by sessions/workers.ts; no UI dependency.
const WORKERS_SNAPSHOT_EVENT = "subagents:workers-snapshot";
const WORKERS_REQUEST_EVENT = "subagents:workers-request";
const WORKER_PREVIEW_CHARS = 320;
/** How long a failed agent_spawn waits for rollback termination before returning. */
const ROLLBACK_WAIT_MS = 10_000;
const BUILTIN_TOOLS = new Set(BUILTIN_TOOL_NAMES);
const Effort = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const);
const Count = Type.Integer({ minimum: 1, maximum: MAX_BATCH, default: 1 });
const Nonempty = Type.String({ minLength: 1 });
const AgentSpec = Type.Object(
	{
		prompt: Type.String({ minLength: 1, description: "Self-contained task; parent conversation is not copied." }),
		name: Type.Optional(Nonempty),
		backend: Type.Optional(Type.String({ minLength: 1, description: "Worker backend; default pi. claude-code requires its extension." })),
		backendOptions: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Backend-specific options, validated by that backend." })),
		count: Type.Optional(Count),
		model: Type.Optional(
			Type.String({ description: "Backend model ID. Pi: exact provider/model, defaults to parent. Other backends use their own defaults." }),
		),
		effort: Type.Optional(Effort),
		tools: Type.Optional(
			Type.Array(Nonempty, {
				description:
					"Backend-native tool allowlist. [] disables all tools. Pi uses lowercase built-ins and inherits active parent built-ins when omitted. Claude uses native names (Read, Bash, Edit, etc.) and defaults to its own tools.",
			}),
		),
		systemPrompt: Type.Optional(Type.String()),
		agentType: Type.Optional(Type.String({ description: "Definition in ~/.pi/agent/agents/<name>.md. Must exist." })),
		cwd: Type.Optional(Type.String({ description: "Working directory, resolved relative to the parent cwd." })),
		wake: Type.Optional(
			Type.Boolean({
				description:
					"When the worker settles and you are idle, start a turn so you can act on the result. Default true; false only queues the result for your next turn.",
			}),
		),
		extensions: Type.Optional(
			Type.Array(Nonempty, {
				description:
					"Extension sources the child loads (path, npm:name, git:host/repo), e.g. [\"npm:pi-web-access\"] for web tools. Children load no extensions otherwise; this extension itself is refused.",
			}),
		),
		fork: Type.Optional(
			Type.Boolean({
				description:
					"Start the child from a copy of this conversation's full history instead of a fresh context. Requires a persisted parent session.",
			}),
		),
	},
	{ additionalProperties: false },
);
/** One role per member; count, fork, extensions and agentType stay agent_spawn-only. */
const TeamMemberSpec = Type.Object(
	{
		role: Type.String({ minLength: 1, maxLength: MAX_LABEL_CHARS, description: "Unique role within the team; also the worker name." }),
		prompt: Type.String({
			minLength: 1,
			description: "Self-contained task. A fixed team header (team, objective, this role and declared ownership, other roles) is prepended before backend validation.",
		}),
		ownedPaths: Type.Optional(
			Type.Array(Nonempty, { maxItems: MAX_OWNED_PATHS, description: "Declared scope shown to the member and in team_list. Advisory only; not a filesystem lock." }),
		),
		orchestrator: Type.Optional(
			Type.Boolean({
				description:
					"This member coordinates its teammates: it additionally gets team_roster (live sibling states) and team_steer (redirect or follow-up a sibling by role). Sibling-scoped only; it can never spawn, add or stop workers. Requires the pi or claude-code backend.",
			}),
		),
		backend: Type.Optional(Type.String({ minLength: 1, description: "Worker backend; default defaults.backend, else pi." })),
		model: AgentSpec.properties.model,
		effort: AgentSpec.properties.effort,
		tools: AgentSpec.properties.tools,
		systemPrompt: AgentSpec.properties.systemPrompt,
		cwd: AgentSpec.properties.cwd,
		wake: AgentSpec.properties.wake,
		backendOptions: AgentSpec.properties.backendOptions,
	},
	{ additionalProperties: false },
);
const TeamDefaultsSpec = Type.Object(
	{
		backend: Type.Optional(Nonempty),
		model: Type.Optional(Type.String()),
		effort: Type.Optional(Effort),
		backendOptions: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	{
		additionalProperties: false,
		description: "Applied only to members whose backend equals defaults.backend (default pi); member fields win and backendOptions merge shallowly. team_add reuses them.",
	},
);
const TeamMembers = Type.Array(TeamMemberSpec, { minItems: 1, maxItems: MAX_BATCH });
const TEAM_MEMBER_KEYS = new Set(Object.keys(TeamMemberSpec.properties));
const TEAM_DEFAULT_KEYS = new Set(Object.keys(TeamDefaultsSpec.properties));
/** Runtime twin of additionalProperties:false, independent of host schema validation. */
function checkTeamKeys(members: unknown, defaults?: unknown): void {
	if (!Array.isArray(members) || !members.length || members.length > MAX_BATCH)
		throw new Error(`Provide 1 to ${MAX_BATCH} team members per call.`);
	for (const member of members) {
		if (typeof member !== "object" || member === null || Array.isArray(member)) throw new Error("Each team member must be an object.");
		const extra = Object.keys(member).find((key) => !TEAM_MEMBER_KEYS.has(key));
		if (extra) throw new Error(`Unsupported team member option ${extra}: each member is one role; use agent_spawn for count, fork, extensions or agentType.`);
	}
	if (defaults === undefined) return;
	if (typeof defaults !== "object" || defaults === null || Array.isArray(defaults)) throw new Error("Team defaults must be an object.");
	const extra = Object.keys(defaults).find((key) => !TEAM_DEFAULT_KEYS.has(key));
	if (extra) throw new Error(`Unsupported team default ${extra}; defaults accept backend, model, effort and backendOptions.`);
}
/** Public token totals: counts only, never text. Cost is omitted when the backend reports none. */
interface WorkerUsage { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: number }
type UsageSum = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
/** Both runners keep an AgentUsage with these exact fields; a garbage value counts as 0. */
const amount = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
function addUsage(total: UsageSum, a: Worker): UsageSum {
	total.input += amount(a.usage?.input);
	total.output += amount(a.usage?.output);
	total.cacheRead += amount(a.usage?.cacheRead);
	total.cacheWrite += amount(a.usage?.cacheWrite);
	total.cost += amount(a.usage?.cost);
	return total;
}
const spent = (u: UsageSum): boolean => u.input + u.output + u.cacheRead + u.cacheWrite + u.cost > 0;
function publicUsage(u: UsageSum): WorkerUsage {
	return {
		input: Math.round(u.input), output: Math.round(u.output),
		cacheRead: Math.round(u.cacheRead), cacheWrite: Math.round(u.cacheWrite),
		...(u.cost > 0 ? { cost: u.cost } : {}),
	};
}
const emptySum = (): UsageSum => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

/** This extension's own directory; a child must never load it, or it could spawn recursively. */
const SELF_DIR = realpathOr(path.dirname(fileURLToPath(import.meta.url)));
/**
 * The one file under SELF_DIR a child may load: member-safe mailbox tools only
 * (see member.ts). It is passed by the team spawn path, never through the
 * user-facing `extensions` option, which keeps refusing everything in SELF_DIR.
 */
export const MEMBER_EXTENSION = path.join(SELF_DIR, "member.ts");
/**
 * The same member tools as a stdio MCP server for claude-code members (the CLI
 * launches it from a per-worker mcp.json; Claude sees mcp__team__<tool>). It is
 * run under the current runtime, which executes .ts files directly.
 */
export const MEMBER_MCP = path.join(SELF_DIR, "member-mcp.ts");

function realpathOr(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return path.resolve(p);
	}
}

/**
 * Map an `npm:` or `git:` source to Pi's already-installed user-scope copy, if
 * there is one. Passing the remote form to `-e` makes Pi install it again into a
 * temporary scope on every child start (measured: ~6s and a network round-trip);
 * the installed directory loads the same package manifest instantly.
 */
export function installedPackageDir(source: string, agentDir: string): string | undefined {
	let candidate: string | undefined;
	if (source.startsWith("npm:")) {
		// npm:name, npm:name@1.2.3, npm:@scope/name, npm:@scope/name@1.2.3
		const spec = source.slice(4).trim();
		const at = spec.indexOf("@", 1);
		const name = at === -1 ? spec : spec.slice(0, at);
		if (!/^(?:@[a-zA-Z0-9_-]+\/)?[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(name) || name.includes("..")) return undefined;
		candidate = path.join(agentDir, "npm", "node_modules", name);
		if (at !== -1) {
			const version = spec.slice(at + 1);
			// Ranges/tags need registry resolution; only an exact, verified pin is reusable.
			if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) return undefined;
			try {
				const manifest = JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf8"));
				if (manifest.name !== name || manifest.version !== version) return undefined;
			} catch { return undefined; }
		}
	} else if (source.startsWith("git:")) {
		// git:host/owner/repo → <agentDir>/git/host/owner/repo
		const spec = source.slice(4).trim().replace(/\.git$/, "");
		// Ref pins (and complex URL/SSH forms) must be resolved by Pi, not a guessed checkout.
		if (/[@:#?\\\\]/.test(spec)) return undefined;
		if (spec && !spec.split("/").some((part) => !part || part === "..")) candidate = path.join(agentDir, "git", spec);
	}
	return candidate && fs.existsSync(candidate) ? candidate : undefined;
}

/** Validate one child extension source: remote sources pass through (installed copy preferred); local paths must exist and must not be this extension. */
function resolveExtensionSource(source: string, cwd: string): string {
	if (/^(npm|git):/.test(source)) return installedPackageDir(source, getAgentDir()) ?? source;
	const resolved = resolvePath(source, cwd);
	if (!fs.existsSync(resolved)) throw new Error(`Extension source not found: ${resolved}`);
	const real = realpathOr(resolved);
	if (real === SELF_DIR || real.startsWith(SELF_DIR + path.sep))
		throw new Error(`Refusing to load the subagents extension into a child (${source}); children do not nest.`);
	return resolved;
}
type Spec = Static<typeof AgentSpec>;
type RunnerFactory = WorkerFactory;
type WorkspaceKind = "agents" | "team";
/** Contract shared by AgentsModal and the future team workspace. */
interface WorkspaceView { invalidate(): void; dispose(): void }
interface BatchRequest {
	specs: Spec[];
	groupLabel?: string;
	/** Team membership per spec (same order); every member gets an identity and mailbox, and the member tools where its backend can load them (memberTooling). */
	team?: { teamId: string; teamName: string; members: { role: string; orchestrator: boolean }[] };
	/**
	 * Runs after every factory returned and before the batch is published. Throwing
	 * rolls the whole batch back exactly like a factory failure.
	 */
	beforeCommit?(group: AgentGroup): void;
}
/** @internal Test seams for the member mailbox. */
export interface SubagentsOptions {
	mailboxRoot?: string;
	mailboxPollMs?: number;
	/** Detachable workers (hosting.ts): registry root, forced enablement, host timings. */
	hosting?: HostingOptions;
	/** Model policy file override (policy.ts); the real one is shared with pi-web. */
	policyFile?: string;
}
/** Emit to re-scan the registry and adopt this session's detached workers now. */
export const WORKERS_ADOPT_EVENT = "subagents:workers-adopt";

function resolvePath(value: string, cwd: string): string {
	const raw = value.startsWith("@") ? value.slice(1) : value;
	return path.resolve(
		cwd,
		raw === "~" ? os.homedir() : raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw,
	);
}

function loadDefinition(name: string): { systemPrompt: string; model?: string } {
	if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(name)) throw new Error("Invalid agentType name.");
	const file = path.join(getAgentDir(), "agents", `${name}.md`);
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (error) {
		throw new Error(`Cannot read agent definition ${file}: ${(error as Error).message}`);
	}
	const { frontmatter, body } = parseFrontmatter<{ model?: unknown }>(raw);
	if (frontmatter.model !== undefined && typeof frontmatter.model !== "string") {
		throw new Error(`Agent definition ${file}: model must be a string.`);
	}
	return { systemPrompt: body, model: frontmatter.model as string | undefined };
}

/** All tool text is capped; the caller can read the complete snapshot using read. */
export function boundedText(text: string): string {
	const truncated = truncateHead(text, { maxBytes: 50 * 1024, maxLines: 2000 });
	if (!truncated.truncated) return text;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-output-"));
	const file = path.join(dir, "output.txt");
	fs.writeFileSync(file, text, { mode: 0o600 });
	return `${truncated.content}\n\n[Output truncated at 50KB/2000 lines. Full snapshot: ${file}]`;
}

const toolResult = (text: string, details: Record<string, unknown> = {}) => ({
	content: [{ type: "text" as const, text: boundedText(text) }],
	details,
});

/** Factory injection is for offline lifecycle/tool tests; normal Pi loading uses the default export. */
export function registerSubagents(
	pi: ExtensionAPI,
	createRunner: RunnerFactory = (o, h) => new SubagentRunner(o, h),
	options: SubagentsOptions = {},
): void {
	const agents: Worker[] = [];
	// Failed batches stay owned until cleanup succeeds, but never appear as runs
	// or emit completion notifications. Include them in caps and shutdown.
	const rollingBack = new Set<Worker>();
	const backends = new Map<string, BackendRegistration>();
	const unregisterBackendListener = pi.events?.on(BACKEND_REGISTER_EVENT, (data: unknown) => {
		const backend = data as BackendRegistration | undefined;
		if (!backend || backend.version !== 1 || typeof backend.id !== "string" || !backend.id.trim() || backend.id === "pi") return;
		if (typeof backend.validate !== "function" || typeof backend.create !== "function" || (backend.prepare !== undefined && typeof backend.prepare !== "function")) return;
		// Repeated discovery is idempotent; never let a second provider hijack an ID.
		if (!backends.has(backend.id)) backends.set(backend.id, backend);
	});
	const discoverBackends = () => pi.events?.emit(BACKEND_DISCOVER_EVENT, { version: 1 });
	discoverBackends();
	const groups: AgentGroup[] = [];
	const teams = new TeamStore();
	// Worker identity records in this (owner) session file; see registry.ts.
	const registry = new WorkerRegistryRecorder((customType, data) => pi.appendEntry(customType, data));
	// Detachable workers: host processes that outlive this manager (see hosting.ts).
	const hosting = new WorkerHosting(options.hosting);
	let counter = 0;
	let groupCounter = 0;
	let activeCtx: ExtensionContext | undefined;
	let shuttingDown = false;
	// One workspace overlay at a time (/agents now, /team later); permission
	// dialogs and editors hide whichever is open.
	let workspaceKind: WorkspaceKind | undefined;
	let workspaceView: WorkspaceView | undefined;
	let renderWorkspace: (() => void) | undefined;
	let closeWorkspace: (() => void) | undefined;
	let overlayHandle: { setHidden(hidden: boolean): void; focus(): void } | undefined;
	let overlayHidden = false;
	const backendDialogs = new Set<string>();
	let composingEditor = false;
	let refreshTimer: ReturnType<typeof setTimeout> | undefined;
	// Compact team widget above the editor; attached per UI object (session
	// replacement swaps it) and driven only by the existing throttled refresh.
	// The widget owns no timers and follows the same visibility rule as the
	// workspace: whoever owns transient input (a backend permission dialog or
	// a composing editor) owns the whole screen, so the widget clears then and
	// returns with fresh views afterwards.
	let teamWidget: TeamWidgetHandle | undefined;
	let teamWidgetUi: unknown;
	let teamWidgetSuppressed = false;

	// Insertion order records observed process completion, not spawn order. Idle
	// workers are never eligible. In-flight tools retain their own worker references.
	const finished = new Set<Worker>();
	let evictedWorkers = 0;
	let evictedRuns = 0;
	// Token counts of workers the retention cap already dropped. Kept so the published
	// session total stays a lifetime total: the live list is capped, the Σ is not.
	const evictedUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	const retentionNotice = () => evictedWorkers || evictedRuns
		? `[Retention: ${evictedWorkers} finished worker(s) and ${evictedRuns} empty run(s) evicted cumulatively; only the latest ${MAX_FINISHED} finished workers are retained, plus all live/idle workers. Evicted IDs are unavailable; saved session history is unchanged.]`
		: "";
	const pruneFinished = () => {
		if (shuttingDown) return;
		for (const a of agents) if (a.isFinished() && !a.processAlive) finished.add(a);
		while (finished.size > MAX_FINISHED) {
			const a = finished.values().next().value!;
			finished.delete(a);
			teams.recordEviction(a.id, { status: a.status, taskOutcome: a.taskOutcome, error: a.error });
			addUsage(evictedUsage, a);
			agents.splice(agents.indexOf(a), 1);
			const group = groups.find(g => g.id === a.groupId);
			if (group) group.agents = group.agents.filter(worker => worker !== a);
			evictedWorkers++;
		}
		for (let i = groups.length - 1; i >= 0; i--) {
			if (!groups[i].agents.length) { groups.splice(i, 1); evictedRuns++; }
		}
	};
	const result = (text: string, details: Record<string, unknown> = {}) => toolResult(
		text,
		{ ...details, retention: { maxFinished: MAX_FINISHED, evictedWorkers, evictedRuns } },
	);
	const live = () => [...agents, ...rollingBack].filter((a) => !a.isFinished());
	const findAgent = (id: string) => {
		const exact = agents.find((a) => a.id === id);
		if (exact) return exact;
		// Never reinterpret an unavailable durable ID as a newer worker's name.
		if (/^ag_\d+$/.test(id)) throw new Error(`No such subagent: ${id} (unavailable). ${retentionNotice()}`);
		const named = agents.filter((a) => a.name === id);
		if (named.length > 1)
			throw new Error(`Ambiguous name ${id}; use an agent ID: ${named.map((a) => a.id).join(", ")}`);
		if (!named.length) throw new Error(`No such subagent: ${id}. ${retentionNotice()}`);
		return named[0];
	};
	const findGroup = (id: string) => {
		const exact = groups.find((g) => g.id === id);
		if (exact) return exact;
		if (/^run_\d+$/.test(id)) throw new Error(`No such run: ${id} (unavailable). ${retentionNotice()}`);
		const named = groups.filter((g) => g.label === id);
		if (named.length !== 1) throw new Error(`${named.length ? "Ambiguous" : "No such"} run: ${id}; use its run ID. ${retentionNotice()}`);
		return named[0];
	};
	const context = (ctx: ExtensionContext) => {
		if (shuttingDown) throw new Error("Subagent extension is shutting down.");
		activeCtx = ctx;
		pruneFinished();
	};
	const timestamps = (a: Worker) => {
		const out: { startedAt?: number; lastActivity?: number; endedAt?: number } = {};
		for (const key of ["startedAt", "lastActivity", "endedAt"] as const)
			if (typeof a[key] === "number" && Number.isFinite(a[key])) out[key] = a[key];
		return out;
	};
	// Session-team membership only; history teams have no live workers.
	const teamField = (id: string) => {
		const teamId = teams.teamOf(id);
		return teamId ? { teamId } : {};
	};
	// Lifetime Σ across every worker this session ever spawned: the live list plus what
	// retention already evicted. It is not the sum of the published rows, and must not be
	// recomputed from them.
	const sessionUsage = () => {
		const total: UsageSum = { ...evictedUsage };
		for (const a of agents) addUsage(total, a);
		return { ...publicUsage(total), workers: agents.length + evictedWorkers };
	};
	const usageField = (a: Worker) => {
		const usage = addUsage(emptySum(), a);
		return spent(usage) ? { usage: publicUsage(usage) } : {};
	};
	const publishWorkers = () => pi.events?.emit(WORKERS_SNAPSHOT_EVENT, {
		version: 1,
		...(shuttingDown ? {} : { workerUsage: sessionUsage() }),
		workers: shuttingDown ? [] : agents.map((a) => ({
			id: a.id,
			name: a.name,
			status: a.status,
			...(a.model === undefined ? {} : { model: a.model }),
			preview: (a.error || a.finalOutput() || "No response yet.").slice(0, WORKER_PREVIEW_CHARS),
			// Additive presence fields (still version 1). Never cwd, pid, or task text.
			...(typeof a.backend === "string" && a.backend ? { backend: a.backend } : {}),
			// Transcript path and backend session id only, never the transcript itself.
			...(typeof a.sessionFile === "string" && a.sessionFile ? { sessionFile: a.sessionFile } : {}),
			...(typeof a.sessionId === "string" && a.sessionId ? { sessionId: a.sessionId } : {}),
			// The thinking/effort level it was spawned with (pi: explicit, else the parent's at spawn,
			// then the child's own reported level; claude-code: resolved, "medium" by default).
			// Absent when the manager never learned one, e.g. a re-adopted worker spawned without it.
			...(typeof a.effort === "string" && a.effort ? { effort: a.effort } : {}),
			...teamField(a.id),
			...timestamps(a),
			...(a.taskOutcome === "success" || a.taskOutcome === "error" || a.taskOutcome === "aborted"
				? { outcome: a.taskOutcome } : {}),
			// Token counts this worker has used so far (cumulative, both backends);
			// a worker that has spent nothing yet carries no usage at all.
			...usageField(a),
		})),
	});
	// Answer immediately even before session_start, regardless of extension order.
	// Only committed workers are public; failed spawn batches remain private.
	const unregisterWorkersListener = pi.events?.on(WORKERS_REQUEST_EVENT, (data: unknown) => {
		if (shuttingDown || (data as { version?: unknown } | null)?.version !== 1) return;
		pruneFinished();
		publishWorkers();
	});
	const refresh = () => {
		if (shuttingDown) return;
		pruneFinished();
		for (const a of agents) {
			registry.observe(a);
			hosting.observe(a);
		}
		publishWorkers();
		try {
			if (activeCtx?.hasUI) {
				const working = agents.filter((a) => !a.isSettled()).length;
				const idle = live().length - working;
				activeCtx.ui.setStatus(
					"subagents",
					live().length ? `Agents: ${working} working · ${Math.max(0, idle)} idle` : undefined,
				);
			}
			workspaceView?.invalidate();
			renderWorkspace?.();
			// Team widget: fresh detached views ride on this same throttled
			// refresh; update([]) removes the widget when no teams remain.
			// Kept last so a widget/attach failure can never skip the workspace.
			if (activeCtx?.hasUI) {
				if (teamWidgetUi !== activeCtx.ui) {
					try {
						teamWidget?.clear();
					} catch {
						/* The previous UI may already be gone. */
					}
					teamWidget = attachTeamWidget(activeCtx.ui as unknown as TeamWidgetUi);
					teamWidgetUi = activeCtx.ui;
					teamWidgetSuppressed = backendDialogs.size > 0 || composingEditor;
				}
				if (!teamWidgetSuppressed) teamWidget?.update(teamViews());
			}
		} catch {
			/* The old session may have been invalidated during replacement. */
		}
	};
	const syncOverlayVisibility = () => {
		if (shuttingDown || !workspaceView || !overlayHandle) return;
		const hidden = backendDialogs.size > 0 || composingEditor;
		if (hidden === overlayHidden) return;
		overlayHidden = hidden;
		overlayHandle.setHidden(hidden);
		if (!hidden) overlayHandle.focus();
		refresh();
	};
	/**
	 * The team widget mirrors the workspace's visibility rule exactly: while a
	 * backend permission dialog is open or an editor is composing, extension
	 * team UI must not stay on screen (identity rows would outlive the hidden
	 * workspace and blur which surface owns input). Clears once, restores once.
	 */
	const syncTeamWidget = () => {
		if (shuttingDown || !teamWidget) return;
		const suppressed = backendDialogs.size > 0 || composingEditor;
		if (suppressed === teamWidgetSuppressed) return;
		teamWidgetSuppressed = suppressed;
		try {
			if (suppressed) teamWidget.clear();
			else teamWidget.update(teamViews());
		} catch {
			/* The UI may already be gone during session replacement. */
		}
	};
	// Pi coalesces nested ui_prompt events beneath the monitor's custom UI.
	// Backends explicitly bracket actual dialogs so permission prompts remain visible.
	const unregisterDialogListener = pi.events?.on(BACKEND_DIALOG_EVENT, (data: unknown) => {
		const event = data as BackendDialogEvent | undefined;
		if (shuttingDown || !event || event.version !== 1 || typeof event.open !== "boolean" || typeof event.token !== "string" || !event.token.trim()) return;
		if (event.open) backendDialogs.add(event.token);
		else backendDialogs.delete(event.token);
		syncOverlayVisibility();
		syncTeamWidget();
	});
	// A streamed child can emit many events per token; never render every event.
	const scheduleRefresh = () => {
		if (shuttingDown || refreshTimer) return;
		refreshTimer = setTimeout(() => {
			refreshTimer = undefined;
			refresh();
		}, 100);
		refreshTimer.unref?.();
	};
	const onExit = (a: Worker) => {
		// Constructors may synchronously report failure before their worker is
		// registered. The post-spawn refresh handles those; never retain them here.
		if (shuttingDown || !agents.includes(a)) return;
		registry.finish(a, hosting.lost(a.id) ? "lost" : undefined);
		if (a.isFinished() && !a.processAlive) finished.add(a);
		pruneFinished();
		scheduleRefresh();
	};
	const summary = (a: Worker) =>
		[
			`### ${a.id} (${a.name}) — ${a.status}${a.taskOutcome ? ` · task ${a.taskOutcome}` : ""}`,
			a.error ? `Error: ${a.error}` : "",
			a.sessionFile || a.sessionId ? `Session: ${a.sessionFile ?? a.sessionId}` : "",
			`Model: ${a.model ?? "child default"} · thinking: ${a.effort ?? "default"}${a.backend && a.backend !== "pi" ? ` · backend: ${a.backend}` : ""}`,
			a.finalOutput() || "(no output for this task)",
		]
			.filter(Boolean)
			.join("\n");
	const onSettled = (a: Worker) => {
		if (shuttingDown || !agents.includes(a)) return;
		pruneFinished();
		scheduleRefresh();
		if (shuttingDown || !activeCtx) return;
		const failed =
			Boolean(a.error) ||
			a.taskOutcome === "error" ||
			a.taskOutcome === "aborted" ||
			a.status === "error" ||
			a.status === "killed";
		const verb = a.status === "killed" ? "stopped" : failed ? "failed" : "finished";
		if (!["tui", "rpc"].includes(activeCtx.mode)) return;
		// Independent: a broken UI must not suppress the completion message/wake.
		try {
			activeCtx.ui.notify(`Subagent ${a.name} (${a.id}) ${verb}.`, failed ? "warning" : "info");
		} catch {
			/* Session replacement can invalidate the UI. */
		}
		try {
			const text = summary(a);
			// A worker the parent stopped itself does not need to wake the parent.
			const wake = a.wake && a.status !== "killed";
			pi.sendMessage(
				{
					customType: "subagent-complete",
					display: true,
					content: text.length > 4000 ? `${text.slice(0, 4000)}\n[Use agent_transcript for more.]` : text,
				},
				{ deliverAs: "followUp", triggerTurn: wake },
			);
		} catch {
			/* Session replacement can invalidate the message API. */
		}
	};

	const modelCatalog = async (ctx: ExtensionContext, backendId?: string, signal?: AbortSignal) => {
		signal?.throwIfAborted();
		const ids = backendId ? [backendId] : ["pi", ...backends.keys()];
		const models: CatalogModel[] = [];
		const errors: { backend: string; error: string }[] = [];
		await Promise.all(ids.map(async (id) => {
			try {
				if (id !== "pi" && !backends.has(id)) throw new Error(`Backend ${id} is not loaded.`);
				const backend = backends.get(id);
				if (id !== "pi" && !backend?.listModels) throw new Error("This backend does not expose model discovery.");
				const choices = id === "pi" ? piModels(ctx) : await backend!.listModels!(ctx, signal);
				// User policy (policy.ts): disabled providers and models never surface as choices.
				for (const choice of choices) {
					if (policyDenial(readPolicy(options.policyFile), id, choice.id)) continue;
					models.push({ ...choice, backend: id });
				}
			} catch (error) {
				if (signal?.aborted) throw error;
				errors.push({ backend: id, error: String(error) });
			}
		}));
		signal?.throwIfAborted();
		return { models, errors, backends: ["pi", ...backends.keys()] };
	};
	/**
	 * The one worker-creation path (agent_spawn and team tools). Validates the whole
	 * batch before any factory runs, reserves IDs durably, and on any failure rolls
	 * back every created worker and rethrows; returns only after the group is
	 * published. Callers keep context(), abort and tool-shape checks.
	 */
	const spawnBatch = async (ctx: ExtensionContext, request: BatchRequest, signal?: AbortSignal): Promise<AgentGroup> => {
		const { specs } = request;
		const total = specs.reduce((sum, s) => sum + (s.count ?? 1), 0);
		if (
			!Number.isInteger(total) ||
			total < 1 ||
			total > MAX_BATCH ||
			specs.some((s) => !Number.isInteger(s.count ?? 1) || (s.count ?? 1) < 1)
		) {
			throw new Error(`Counts must be positive integers; at most ${MAX_BATCH} agents per call.`);
		}
		if (live().length + total > MAX_LIVE)
			throw new Error(
				`Live-agent cap is ${MAX_LIVE} (${live().length} alive, including idle workers). Kill some first.`,
			);
		// Validate the whole batch before starting any child.
		const prepared = specs.map((spec) => {
			if (!spec.prompt.trim()) throw new Error("Task must not be blank.");
			const backendId = spec.backend ?? "pi";
			const cwd = resolvePath(spec.cwd ?? ctx.cwd, ctx.cwd);
			let cwdStat: fs.Stats;
			try { cwdStat = fs.statSync(cwd); }
			catch (error) { throw new Error(`Cannot access working directory ${cwd}: ${(error as Error).message}`); }
			if (!cwdStat.isDirectory()) throw new Error(`Not a directory: ${cwd}`);
			if (backendId !== "pi") {
				const backend = backends.get(backendId);
				if (!backend) throw new Error(`Unknown or unavailable backend ${backendId}; load its extension first.`);
				// User policy first, before the backend's own validation: a disabled provider
				// or model is rejected whichever form the request names it in — including a
				// model-less spec, whose backend default is still that provider's model.
				const policy = readPolicy(options.policyFile);
				const denied = spec.model !== undefined ? policyDenial(policy, backendId, spec.model) : backendDenial(policy, backendId);
				if (denied) throw new Error(denied);
				backend.validate(spec, ctx);
				const prepared = backend.prepare?.({ ...spec, cwd }, ctx) ?? {};
				return { spec, cwd, model: spec.model, tools: spec.tools, systemPrompt: spec.systemPrompt,
					extensions: undefined, forkSession: undefined, backend, prepared };
			}
			if (spec.backendOptions !== undefined) throw new Error("backendOptions are not supported by the pi backend.");
			const definition = spec.agentType !== undefined ? loadDefinition(spec.agentType) : undefined;
			const model =
				spec.model ?? definition?.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
			if (model !== undefined) {
				// User policy before the registry lookup: a disabled ref is rejected even when
				// it is stale (no longer in the registry), and the inherited parent model too.
				const denied = policyDenial(readPolicy(options.policyFile), "pi", model);
				if (denied) throw new Error(denied);
				const slash = model.indexOf("/");
				if (slash < 1 || !ctx.modelRegistry.find(model.slice(0, slash), model.slice(slash + 1))) {
					throw new Error(`Unknown model ${model}; use agent_models to discover exact provider/model IDs from this session's registry.`);
				}
			}
			if (spec.tools?.some((t) => !BUILTIN_TOOLS.has(t)))
				throw new Error(`Only built-in child tools are supported: ${[...BUILTIN_TOOLS].join(", ")}`);
			const tools = spec.tools ?? pi.getActiveTools().filter((name) => BUILTIN_TOOLS.has(name));
			// Team members load the member tools (and nothing else from this
			// package); ad hoc workers keep the user-facing source validation.
			const extensions = request.team
				? [MEMBER_EXTENSION]
				: spec.extensions?.map((source) => resolveExtensionSource(source, ctx.cwd));
			let forkSession: string | undefined;
			if (spec.fork) {
				forkSession = ctx.sessionManager.getSessionFile();
				if (!forkSession || !fs.existsSync(forkSession))
					throw new Error("fork requires a persisted parent session; this session has no session file yet.");
			}
			return {
				spec,
				backend: undefined,
				prepared: undefined,
				cwd,
				model,
				tools,
				extensions,
				forkSession,
				systemPrompt: [definition?.systemPrompt, spec.systemPrompt].filter(Boolean).join("\n\n") || undefined,
			};
		});
		const groupId = `run_${String(++groupCounter).padStart(2, "0")}`;
		// Reserve IDs durably before starting processes. Reload must never reuse an
		// ID still present in the conversation for an unrelated new worker.
		pi.appendEntry("subagents-counters-v2", { agentCounter: counter + total, groupCounter });
		const label = request.groupLabel ?? `run ${groupCounter} · ${specs[0].name ?? specs[0].agentType ?? "agents"}`;
		const group: AgentGroup = { id: groupId, label, createdAt: Date.now(), agents: [] };
		let committed = false;
		let abandoned = false;
		const launched: string[] = [];
		const earlySettled = new Set<Worker>();
		try {
			for (const [index, { spec, cwd, model, tools, systemPrompt, extensions, forkSession, backend, prepared: backendPrepared }] of prepared.entries()) {
				for (let i = 0; i < (spec.count ?? 1); i++) {
					const base = spec.name ?? spec.agentType ?? "agent";
					const id = `ag_${String(++counter).padStart(2, "0")}`;
					const teamMember = request.team?.members[index];
					// A member's identity and private mailbox exist before its process
					// does. Pi children read the identity from their environment
					// (member.ts); claude-code children get it through the member MCP
					// server's own environment, never the CLI's.
					const env = teamMember ? memberEnv(request.team!, teamMember, id) : undefined;
					const tooling = teamMember ? memberTooling(spec.backend ?? "pi") : "none";
					const name = (spec.count ?? 1) > 1 ? `${base}-${i + 1}` : base;
					// Hosted: the runner's spawnImpl starts a detached host instead of the worker itself.
					const hostedWorker = hosting.active();
					if (hostedWorker) launched.push(id);
					const hosted = hostedWorker
						? hosting.launch({
							id, groupId, groupLabel: request.groupLabel, name, backend: spec.backend ?? "pi",
							spec: {
								prompt: spec.prompt, backend: spec.backend ?? "pi", name, cwd, wake: spec.wake ?? true,
								...(model === undefined ? {} : { model }),
								...(spec.effort === undefined ? {} : { effort: spec.effort }),
								...(tools === undefined ? {} : { tools }),
								...(spec.backendOptions === undefined ? {} : { backendOptions: spec.backendOptions }),
								...(extensions === undefined ? {} : { extensions }),
							},
							...(teamMember ? { team: { teamId: request.team!.teamId, role: teamMember.role, ...(teamMember.orchestrator ? { orchestrator: true } : {}) } } : {}),
						})
						: {};
					const runner = (backend?.create ?? createRunner)(
						{
							model,
							effort: spec.effort ?? (backend ? undefined : ctx.thinkingLevel),
							tools,
							systemPrompt,
							extensions,
							forkSession,
							backendOptions: spec.backendOptions,
							...backendPrepared,
							backend: spec.backend ?? "pi",
							...(env && tooling === "pi" ? { env } : {}),
							...(env && tooling === "mcp" ? { mcpServers: { [MCP_SERVER_NAME]: { command: process.execPath, args: [MEMBER_MCP], env } } } : {}),
							...hosted,
							id,
							groupId,
							name,
							task: spec.prompt,
							cwd,
							wake: spec.wake ?? true,
						},
						{
							onChange: () => { if (committed) scheduleRefresh(); },
							onSettled: (worker) => { if (committed) onSettled(worker); else if (!abandoned) earlySettled.add(worker); },
							onExit,
						},
					);
					group.agents.push(runner);
					hosting.bind(id, runner);
				}
			}
			request.beforeCommit?.(group);
		} catch (error) {
			abandoned = true;
			// No batch member is published until every factory returns. Suppress
			// constructor/cleanup callbacks. Ownership (live-cap slot, shutdown
			// disposal) ends only at confirmed termination, never because a kill
			// promise resolved early or the caller stopped waiting.
			for (const worker of group.agents) rollingBack.add(worker);
			// A registry entry whose factory threw has no runner to finalize it.
			for (const id of launched) if (!group.agents.some((worker) => worker.id === id)) hosting.discard(id);
			const cleanup = group.agents.map(async (worker) => {
				try { await worker.kill("spawn batch rolled back after factory failure"); }
				catch { await worker.dispose(); }
				await worker.whenClosed;
				if (worker.isFinished()) rollingBack.delete(worker);
				if (!shuttingDown) scheduleRefresh();
			});
			earlySettled.clear();
			refresh();
			// Bound the caller: cleanup keeps running in the background.
			let stopWaiting!: (reason: string) => void;
			const stopped = new Promise<string>((resolve) => { stopWaiting = resolve; });
			const timer = setTimeout(() => stopWaiting(`not confirmed within ${ROLLBACK_WAIT_MS / 1000}s`), ROLLBACK_WAIT_MS);
			const onAbort = () => stopWaiting("wait cancelled");
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
			const outcomes = await Promise.race([Promise.allSettled(cleanup), stopped]);
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (typeof outcomes === "string") {
				const pending = group.agents.filter((worker) => rollingBack.has(worker)).map((worker) => worker.id);
				throw new Error(`${String(error)}; rollback termination ${outcomes} for ${pending.join(", ") || "no workers"} (still owned: counted toward the live cap, stopped at shutdown).`, { cause: error });
			}
			const failures = outcomes.flatMap((outcome, i) => outcome.status === "rejected"
				? [`${group.agents[i].id}: ${String(outcome.reason)}`] : []);
			if (failures.length) throw new Error(`${String(error)}; rollback cleanup failed (still owned for shutdown): ${failures.join("; ")}`, { cause: error });
			throw error;
		}
		groups.push(group);
		agents.push(...group.agents);
		committed = true;
		// Team batches are one worker per member, in member order. Only hosted
		// workers are recorded: the inline transport writes nothing new.
		group.agents.forEach((worker, i) => {
			const member = request.team?.members[i];
			if (hosting.owns(worker.id)) registry.track(worker, member && { teamId: request.team!.teamId, role: member.role });
		});
		// Synchronous startup failures now have registered IDs; discarded batches
		// never wake the parent. Only replay callbacks for returned workers.
		for (const worker of earlySettled) onSettled(worker);
		earlySettled.clear();
		refresh();
		return group;
	};
	/**
	 * Shared control path for tools and workspaces. Team members get a bounded
	 * action record; states never claim more than SteerResult says (accepted or
	 * queued, failed, or unknown when the caller stopped waiting).
	 */
	const steerWorker = async (a: Worker, message: string, mode: SteerMode | undefined, signal: AbortSignal | undefined, source: TeamActionSource, kind?: TeamActionKind): Promise<SteerResult> => {
		const action = teams.recordAction(a.id, kind ?? mode ?? "steer", source, message);
		if (action) scheduleRefresh();
		try {
			const accepted = await a.steer(message, signal, mode);
			if (accepted.ok) teams.settleAction(action, "accepted-or-queued");
			else teams.settleAction(action, signal?.aborted ? "unknown" : "failed", accepted.reason);
			return accepted;
		} catch (error) {
			teams.settleAction(action, signal?.aborted ? "unknown" : "failed", String(error));
			throw error;
		} finally {
			if (action) scheduleRefresh();
		}
	};
	/** Resolves when the worker's kill resolves; worker status stays authoritative. */
	const killWorker = async (a: Worker, reason: string, source: TeamActionSource): Promise<void> => {
		const action = teams.recordAction(a.id, "stop", source, reason);
		try {
			await a.kill(reason);
			teams.settleAction(action, "accepted-or-queued");
		} catch (error) {
			teams.settleAction(action, "failed", String(error));
			throw error;
		} finally {
			if (action) scheduleRefresh();
		}
	};
	// ── Team member mailbox ─────────────────────────────────────────────────
	// Members (member.ts in Pi children, member-mcp.ts beside Claude children)
	// write requests into their own directory under a private root;
	// the parent polls, derives the sender from the path, validates scope
	// against the team store and performs the delivery itself through the same
	// steer path tools and workspaces use. Members never touch each other's
	// processes, and nothing here can create or stop a worker.
	let mailboxRoot: string | undefined = options.mailboxRoot;
	let mailboxTimer: ReturnType<typeof setInterval> | undefined;
	let mailboxOwned = false;
	const memberDir = (teamId: string, workerId: string) => path.join(mailboxRoot!, teamId, workerId);
	const ensureMailbox = (): string => {
		if (!mailboxRoot && hosting.active()) {
			// Detachable members keep their mailbox across restarts; pending requests are answered after re-adoption.
			mailboxRoot = hosting.mailboxRoot();
		} else if (!mailboxRoot) {
			mailboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-teams-"));
			mailboxOwned = true;
		}
		if (!mailboxTimer) {
			mailboxTimer = setInterval(pollMailbox, options.mailboxPollMs ?? MAILBOX_POLL_MS);
			mailboxTimer.unref?.();
		}
		return mailboxRoot;
	};
	const memberEnv = (team: NonNullable<BatchRequest["team"]>, member: { role: string; orchestrator: boolean }, workerId: string): Record<string, string> => {
		const dir = memberDir(team.teamId, workerId);
		initMemberDir(dir);
		return { [MEMBER_ENV]: encodeMemberContext({ version: 1, teamId: team.teamId, teamName: team.teamName, workerId, role: member.role, orchestrator: member.orchestrator, dir }) };
	};
	const pollMailbox = () => {
		if (shuttingDown || !mailboxRoot) return;
		for (const item of scanMailboxRoot(mailboxRoot)) {
			if (!item.request) continue; // Malformed: removed, nothing to answer.
			void handleMemberRequest(item.teamId, item.workerId, item.dir, item.request);
		}
	};
	const memberLine = (m: PersistedMember) => `${m.role}${m.orchestrator ? " (orchestrator)" : ""} (${m.workerId}, ${m.backend})`;
	const rosterText = (teamId: string): string => {
		const t = teamViews().find((v) => v.id === teamId);
		if (!t) return `Team ${teamId} is not available.`;
		return [
			`${t.id} — ${t.name} · ${(["working", "idle", "failed", "done", "stopping", "stopped", "unavailable"] as const).filter((k) => t.counts[k]).map((k) => `${t.counts[k]} ${k}`).join(" · ") || "no members"}`,
			`Objective: ${t.objective}`,
			...t.members.map((m) =>
				`  ${m.workerId} ${m.role}${m.orchestrator ? " (orchestrator)" : ""} [${m.backend}${memberTooling(m.backend) === "none" ? ", receives messages only" : ", has team tools"}] ${m.state}${m.status ? ` (${m.status}${m.taskOutcome ? `/${m.taskOutcome}` : ""})` : ""} · owns: ${m.ownedPaths.join(", ") || "none declared"}${m.error ? ` · error: ${m.error}` : ""}${m.available ? "" : ` · unavailable: ${m.reason}`}`,
			),
			...(t.actions.length ? ["  Recent actions:", ...t.actions.slice(-10).map((a) => `    #${a.seq} ${a.source} ${a.kind} → ${a.workerId} (${a.role}): ${a.state}${a.reason ? ` — ${a.reason}` : ""}`)] : []),
			"States are observations; accepted-or-queued never means executed.",
		].join("\n");
	};
	/** How a recipient can answer, by what it really has; MCP tools carry the server prefix. */
	const replyHint = (target: PersistedMember, role: string): string => {
		switch (memberTooling(target.backend)) {
			case "pi": return `(Reply with team_msg to "${role}" if needed; team_inbox lists delivered messages.)`;
			case "mcp": return `(Reply with the mcp__${MCP_SERVER_NAME}__team_msg tool to "${role}" if needed; mcp__${MCP_SERVER_NAME}__team_inbox lists delivered messages.)`;
			default: return "(You cannot reply to teammates directly; put anything meant for them in your final answer.)";
		}
	};
	/** Deliver one mediated message/instruction to a sibling; the text says who sent it and how to reply. */
	const deliverToMember = async (
		target: PersistedMember, text: string, mode: SteerMode | undefined, source: TeamActionSource, kind: TeamActionKind, inbox: { kind: "message" | "instruction"; from: string; fromId: string; text: string },
	): Promise<SteerResult> => {
		const worker = agents.find((a) => a.id === target.workerId);
		if (!worker || worker.isFinished() || worker.isStopping?.()) {
			// Still an audited attempt: the sender is told, and team_list shows it.
			const reason = `${target.role} (${target.workerId}) is no longer live`;
			teams.settleAction(teams.recordAction(target.workerId, kind, source, inbox.text), "failed", reason);
			scheduleRefresh();
			return { ok: false, reason };
		}
		const accepted = await steerWorker(worker, text, mode, undefined, source, kind);
		if (accepted.ok && memberTooling(target.backend) !== "none") {
			try {
				appendInbox(memberDir(teams.teamOf(target.workerId)!, target.workerId), { at: Date.now(), ...inbox });
			} catch {
				/* The inbox is a convenience copy; delivery already succeeded. */
			}
		}
		return accepted;
	};
	const handleMemberRequest = async (teamId: string, workerId: string, dir: string, request: MailboxRequest): Promise<void> => {
		const reply = (response: Omit<MailboxResponse, "version" | "id">) => {
			try {
				writeResponse(dir, { version: 1, id: request.id, ...response });
			} catch {
				/* The member directory is gone (shutdown or cleanup); nothing to answer. */
			}
		};
		const info = teams.memberInfo(workerId);
		const sender = agents.find((a) => a.id === workerId);
		if (!info || info.team.id !== teamId || !sender || sender.isFinished()) {
			reply({ ok: false, text: "Request ignored: the sender is not a live member of this session's teams." });
			return;
		}
		const me = info.member;
		const tag = `${me.role}${me.orchestrator ? ", orchestrator" : ""} (${me.workerId}), ${info.team.id}`;
		try {
			switch (request.type) {
				case "message": {
					if (!request.to || !request.message?.trim()) throw new Error("A message needs a recipient and non-blank text.");
					const broadcast = /^(all|\*)$/i.test(request.to);
					const targets = broadcast ? info.siblings : [teams.resolveSibling(workerId, request.to)];
					if (!targets.length) throw new Error("You have no teammates to message.");
					const outcomes = await Promise.all(targets.map(async (target) => {
						const text = [
							`[Team message from ${tag}${broadcast ? " to all members" : ""}]`,
							request.message!,
							replyHint(target, me.role),
						].join("\n");
						const accepted = await deliverToMember(target, text, target.backend === "pi" ? undefined : "followUp", "member", "message", { kind: "message", from: me.role, fromId: me.workerId, text: request.message! });
						return { to: target.role, workerId: target.workerId, ok: accepted.ok, ...(accepted.ok ? {} : { reason: accepted.reason }) };
					}));
					const lines = outcomes.map((o) => `${o.to} (${o.workerId}): ${o.ok ? "accepted or queued" : `failed — ${o.reason}`}`);
					const failed = outcomes.filter((o) => !o.ok);
					reply({
						ok: failed.length < outcomes.length,
						text: `${failed.length ? (failed.length === outcomes.length ? "Delivery failed.\n" : "Partially delivered.\n") : "Delivered (accepted or queued; not proof they acted).\n"}${lines.join("\n")}`,
						details: { deliveries: outcomes },
					});
					return;
				}
				case "steer": {
					if (!me.orchestrator) throw new Error("Only an orchestrator member can steer teammates; use team_msg, or team_ask to involve the operator.");
					if (!request.to || !request.message?.trim()) throw new Error("A steer needs one sibling and non-blank instructions.");
					if (/^(all|\*)$/i.test(request.to)) throw new Error("team_steer addresses one sibling at a time.");
					const target = teams.resolveSibling(workerId, request.to);
					const text = [`[Instruction from orchestrator ${me.role} (${me.workerId}), ${info.team.id}]`, request.message].join("\n");
					const accepted = await deliverToMember(target, text, request.mode, "orchestrator", request.mode ?? "steer", { kind: "instruction", from: me.role, fromId: me.workerId, text: request.message });
					if (!accepted.ok) throw new Error(`Cannot steer ${target.role} (${target.workerId}): ${accepted.reason}`);
					reply({ ok: true, text: `Accepted or queued for ${target.role} (${target.workerId}); this is not execution or completion. Verify with team_roster.`, details: { workerId: target.workerId, mode: request.mode ?? "default" } });
					return;
				}
				case "roster": {
					if (!me.orchestrator) throw new Error("team_roster is available to orchestrator members only.");
					reply({ ok: true, text: rosterText(info.team.id) });
					return;
				}
				case "question": {
					if (!request.message?.trim()) throw new Error("A question must not be blank.");
					const question = request.message.length > QUESTION_CHARS ? `${request.message.slice(0, QUESTION_CHARS)}\n[truncated]` : request.message;
					const action = teams.recordAction(workerId, "question", "member", request.message);
					if (!activeCtx || !["tui", "rpc"].includes(activeCtx.mode)) {
						teams.settleAction(action, "failed", "no interactive parent session");
						throw new Error("The operator cannot be reached from this parent session mode; report the question in your final answer.");
					}
					try {
						activeCtx.ui.notify(`Team question from ${me.role} (${me.workerId}).`, "info");
					} catch {
						/* Session replacement can invalidate the UI. */
					}
					pi.sendMessage(
						{
							customType: "team-question",
							display: true,
							content: [
								`[Team question from ${tag} — ${info.team.name}]`,
								question,
								"",
								`Answer with agent_steer { id: "${me.workerId}", message: "<answer>" }; the member continues (or resumes, if idle) from your message. If only the user can decide, ask them and relay their answer the same way.`,
							].join("\n"),
						},
						{ deliverAs: "followUp", triggerTurn: true },
					);
					teams.settleAction(action, "accepted-or-queued");
					scheduleRefresh();
					reply({ ok: true, text: "Question surfaced to the operator; it starts a parent turn if the parent is idle. The answer arrives as a new message in your session — continue with independent work or end your turn." });
					return;
				}
			}
		} catch (error) {
			reply({ ok: false, text: String(error instanceof Error ? error.message : error) });
		}
	};
	/** Exact-ID lookup among retained workers only; never falls back to names. */
	const observeWorker = (id: string): WorkerObservation | undefined => {
		const a = agents.find((worker) => worker.id === id);
		return a && {
			status: a.status,
			taskOutcome: a.taskOutcome,
			error: a.error,
			processAlive: a.processAlive,
			settled: a.isSettled(),
			finished: a.isFinished(),
			model: a.model,
		};
	};
	/** Detached team views for tools now and the team workspace/widget later. */
	const teamViews = (): TeamView[] => teams.views(observeWorker);
	pi.registerTool({
		name: "agent_models",
		label: "Subagent Models",
		description: "Discover loaded worker backends and their exact model IDs. Pi models come from this session's active registry, including extension/cloud providers; Claude models come from its CLI. Search natural names such as 'deepseek 4.1 flash'. No model task is started. Returns up to limit matches and backend discovery errors explicitly. Rows marked 'vision' accept image input; a worker on a model without that marker cannot look at images.",
		promptSnippet: "Discover subagent backends, model IDs, and Claude effort options",
		promptGuidelines: ["Use agent_models to resolve requested subagent model names; do not guess IDs or search a separate Pi CLI registry."],
		parameters: Type.Object({ query: Type.Optional(Type.String()), backend: Type.Optional(Nonempty), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
		async execute(_id, params, signal, _update, ctx) {
			context(ctx);
			const catalog = await modelCatalog(ctx, params.backend, signal);
			const matches = matchingModels(catalog.models, params.query);
			const selected = matches.slice(0, params.limit ?? 30);
			return result([
				`Loaded backends: ${catalog.backends.join(", ")}`,
				...selected.map(model => `${model.backend} · ${model.id} · ${model.name}${model.efforts?.length ? ` · effort: ${model.efforts.join(", ")}` : ""}${model.vision ? " · vision" : ""}`),
				selected.length ? `${selected.length} of ${matches.length} matches.` : "No matching models. Try a broader query or check discovery errors below.",
				...catalog.errors.map(error => `${error.backend}: ${error.error}`),
			].join("\n"), { models: selected, totalMatches: matches.length, backends: catalog.backends, errors: catalog.errors });
		},
	});
	pi.registerTool({
		name: "agent_spawn",
		label: "Spawn Subagents",
		description:
			"Start independent background agents (backend defaults to pi; claude-code uses the installed Claude extension); returns IDs without waiting for tasks. Use agent_list/agent_transcript to inspect, agent_steer to redirect or queue follow-ups, agent_kill to stop, agent_wait when results are needed. Settled workers wake you when idle (wake=true, default). Workers share the filesystem. Pi-only: fork=true copies conversation history; extensions loads listed Pi extensions. Claude starts fresh and uses backendOptions for permission/settings policy.",
		promptSnippet: "Spawn background subagents (non-blocking) and manage them by id",
		promptGuidelines: [
			"Use agent_spawn to parallelise independent work; it returns immediately and does not block you.",
			"Use agent_models to find requested worker models by name before spawning when the exact ID is unknown; it uses this session's registry, not a separate CLI search.",
			"Use agent_wait only when you genuinely need a subagent's result before continuing; by default a finished subagent wakes you with its result when you are idle.",
			"For Pi workers, pass extensions: [\"npm:pi-web-access\"] for web tools or fork: true for conversation history; these options are not supported by Claude workers.",
			"Use agent_spawn with backend: \"claude-code\" to delegate to Claude Code when its extension is installed. Claude uses its own model IDs (e.g. sonnet, opus), native tools, and backendOptions permission/settings policy; it does not inherit Pi's model, effort, tools, or history.",
			"Claude workers default to bypassPermissions (no permission prompts); set backendOptions.permissionMode to acceptEdits, manual, dontAsk, or plan for a restrictive policy. Do not assume a queued follow-up has executed; inspect agent_list or agent_transcript.",
		],
		parameters: Type.Object(
			{
				...AgentSpec.properties,
				prompt: Type.Optional(Nonempty),
				agents: Type.Optional(Type.Array(AgentSpec, { minItems: 1, maxItems: MAX_BATCH })),
				groupLabel: Type.Optional(Nonempty),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, signal, _update, ctx) {
			context(ctx);
			signal?.throwIfAborted();
			if (Boolean(params.agents) === Boolean(params.prompt))
				throw new Error("Provide exactly one of agents or prompt.");
			if (
				params.agents &&
				[
					params.name,
					params.backend,
					params.backendOptions,
					params.count,
					params.model,
					params.effort,
					params.tools,
					params.systemPrompt,
					params.agentType,
					params.cwd,
					params.wake,
					params.extensions,
					params.fork,
				].some((x) => x !== undefined)
			) {
				throw new Error("Shorthand options cannot be combined with agents; put them inside each agent spec.");
			}
			const specs: Spec[] = params.agents ?? [{ ...params, prompt: params.prompt! }];
			const group = await spawnBatch(ctx, { specs, groupLabel: params.groupLabel }, signal);
			const { id: groupId, label } = group;
			return result(
				[
					`Started ${group.agents.length} background subagent(s) in ${groupId} (${label}). Task acceptance is asynchronous; inspect status for startup failures.`,
					...group.agents.map(
						(a) =>
							`${a.id}  ${a.name}  ${a.status}  backend=${a.backend ?? "pi"}  model=${a.model ?? "child default"}  effort=${a.effort ?? "default"}${a.forked ? "  forked" : ""}${a.extensions.length ? `  extensions=${a.extensions.join(",")}` : ""}${a.wake ? "" : "  wake=false"}`,
					),
					"You are not blocked. Inspect with agent_list/agent_transcript; /agents opens the monitor.",
					group.agents.some((a) => a.wake)
						? "Workers with wake (the default) start a turn for you when they settle while you are idle, so you can simply end this turn."
						: "wake=false: results arrive with your next turn; use agent_wait if you need them sooner.",
				].join("\n"),
				{ groupId, label, spawned: group.agents.map((a) => ({ id: a.id, name: a.name, backend: a.backend ?? "pi", model: a.model })) },
			);
		},
	});

	pi.registerTool({
		name: "agent_list",
		label: "List Subagents",
		description:
			"List subagents grouped by run, with status, model and usage. Output capped at 50KB/2000 lines with full snapshot path.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _update, ctx) {
			context(ctx);
			return result(
				[retentionNotice(), groups.length
					? groups
							.map((g) =>
								[
									`${g.id} — ${g.label}`,
									...g.agents.map(
										(a) =>
											`  ${a.id} ${a.name} [${a.backend ?? "pi"}] ${a.status}${a.taskOutcome ? `/${a.taskOutcome}` : ""} ${a.model ?? "child default"} · ${a.usage.turns} turns · ↑${a.usage.input} ↓${a.usage.output}${a.error ? ` · error: ${a.error}` : ""}`,
									),
								].join("\n"),
							)
							.join("\n\n") +
							"\n\nwaiting = idle and steerable (check task outcome); stopping = terminating; done/killed = process ended; error = failure (cleanup may still be in progress)."
					: "No subagents have been spawned."].filter(Boolean).join("\n\n"),
				{
					agents: agents.map((a) => ({
						id: a.id,
						groupId: a.groupId,
						name: a.name,
						backend: a.backend ?? "pi",
						status: a.status,
						taskOutcome: a.taskOutcome,
						processAlive: a.processAlive,
						settled: a.isSettled(),
						model: a.model,
						sessionFile: a.sessionFile,
						sessionId: a.sessionId,
						error: a.error,
						usage: { ...a.usage },
					})),
				},
			);
		},
	});
	pi.registerTool({
		name: "agent_transcript",
		label: "Read Subagent",
		description:
			"Read current-task output, or retained in-memory transcript with full=true (not necessarily complete history). Output capped at 50KB/2000 lines with snapshot path. sessionFile identifies canonical history when available; otherwise sessionId identifies the backend session.",
		parameters: Type.Object({ id: Nonempty, full: Type.Optional(Type.Boolean()) }),
		async execute(_id, params, _signal, _update, ctx) {
			context(ctx);
			const a = findAgent(params.id);
			return result(
				params.full
					? `${a.id} (${a.name}) — ${a.status}\nSession: ${a.sessionFile ?? a.sessionId ?? "unavailable"}\n${a.transcriptOmitted?.items ? `[Retained transcript: ${a.transcriptOmitted.items} earlier item(s) omitted, approximately ${a.transcriptOmitted.approxBytes} bytes.]\n` : ""}\n${a.transcript.map((t) => `[${t.kind}${t.toolName ? `:${t.toolName}` : ""}] ${t.text}`).join("\n")}`
					: summary(a),
				{
					id: a.id,
					backend: a.backend ?? "pi",
					status: a.status,
					taskOutcome: a.taskOutcome,
					error: a.error,
					sessionFile: a.sessionFile,
					sessionId: a.sessionId,
					transcriptOmitted: a.transcriptOmitted ? { ...a.transcriptOmitted } : undefined,
					usage: { ...a.usage },
				},
			);
		},
	});
	pi.registerTool({
		name: "agent_steer",
		label: "Steer Subagent",
		description:
			"Send instructions to a live worker. mode=redirect changes the current task (Pi's normal steering; Claude interrupts then resumes). mode=followUp queues work after the current task. Omitted mode preserves backend default steering. Idle workers start a fresh task. Acknowledgment means accepted or queued, not executed or completed; Claude follow-ups may only be queued locally. Cancelling acceptance waiting does not stop the worker and may leave delivery unknown; inspect status/transcript before retrying.",
		parameters: Type.Object({ id: Nonempty, message: Nonempty, mode: Type.Optional(StringEnum(["redirect", "followUp"] as const)) }),
		async execute(_id, params, signal, _update, ctx) {
			context(ctx);
			signal?.throwIfAborted();
			if (!params.message.trim()) throw new Error("Instructions must not be blank.");
			const a = findAgent(params.id);
			const accepted = await steerWorker(a, params.message, params.mode, signal, "parent");
			if (!accepted.ok) throw new Error(`Cannot steer ${a.id}: ${accepted.reason}`);
			return result(`Accepted or queued new instructions for ${a.id} (${a.name}); this does not confirm execution or completion.`, { id: a.id, steerCount: a.steerCount });
		},
	});
	pi.registerTool({
		name: "agent_kill",
		label: "Kill Subagent",
		description: "Stop one subagent, one run, or all live subagents. Waits for child termination.",
		parameters: Type.Object({
			id: Type.Optional(Nonempty),
			group: Type.Optional(Nonempty),
			all: Type.Optional(Type.Boolean()),
			reason: Type.Optional(Type.String()),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			context(ctx);
			if ([Boolean(params.id), Boolean(params.group), params.all === true].filter(Boolean).length !== 1)
				throw new Error("Provide exactly one of id, group, or all:true.");
			// Only published workers are targets. Unpublished rollback workers (IDs
			// never returned by a failed agent_spawn) already have termination in
			// progress; they are reported, not listed, and shutdown still owns them.
			const targets = params.id
				? [findAgent(params.id)]
				: params.group
					? [...findGroup(params.group).agents]
					: agents.filter((a) => !a.isFinished());
			await Promise.all(targets.map((a) => killWorker(a, params.reason ?? "stopped by the main agent", "parent")));
			refresh();
			const rollbackPending = [...rollingBack].filter((a) => !a.isFinished()).length;
			return result(
				[
					targets.map((a) => `${a.id} (${a.name}) — ${a.status}`).join("\n") || "No live subagents.",
					params.all && rollbackPending
						? `${rollbackPending} unpublished worker(s) from a failed spawn are still terminating; they are not listed and still count toward the live cap until termination is confirmed.`
						: "",
				].filter(Boolean).join("\n"),
				{ killed: targets.map((a) => a.id), ...(params.all ? { rollbackPending } : {}) },
			);
		},
	});
	pi.registerTool({
		name: "agent_wait",
		label: "Wait For Subagents",
		description:
			"Wait for current tasks, not child process exits. Failed tasks also settle; inspect each error. Timeout/cancellation does not stop workers. Output capped at 50KB/2000 lines with full snapshot path.",
		parameters: Type.Object({
			ids: Type.Optional(Type.Array(Nonempty, { minItems: 1 })),
			group: Type.Optional(Nonempty),
			timeoutSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: 3600, default: 600 })),
		}),
		async execute(_id, params, signal, update, ctx) {
			context(ctx);
			if (params.ids && params.group) throw new Error("Provide ids or group, not both.");
			const targets = params.ids
				? [...new Set(params.ids.map(findAgent))]
				: params.group
					? [...findGroup(params.group).agents]
					: agents.filter((a) => !a.isSettled());
			if (!targets.length) return result("Nothing to wait for — all current tasks have settled.");
			const timeout = params.timeoutSeconds ?? 600;
			if (!Number.isFinite(timeout) || timeout < 0 || timeout > 3600)
				throw new Error("timeoutSeconds must be between 0 and 3600.");
			const deadline = Date.now() + timeout * 1000;
			while (!signal?.aborted && Date.now() < deadline && targets.some((a) => !a.isSettled())) {
				update?.(
					result(
						`Waiting: ${targets
							.filter((a) => !a.isSettled())
							.map((a) => a.id)
							.join(", ")}`,
					),
				);
				await new Promise<void>((resolve) => {
					const finish = () => {
						clearTimeout(timer);
						signal?.removeEventListener("abort", finish);
						resolve();
					};
					const timer = setTimeout(finish, Math.min(500, Math.max(0, deadline - Date.now())));
					signal?.addEventListener("abort", finish, { once: true });
					if (signal?.aborted) finish();
				});
			}
			const outstanding = targets.filter((a) => !a.isSettled());
			const headline = signal?.aborted
				? "Cancelled wait; workers were not stopped."
				: outstanding.length
					? `Timed out; still working: ${outstanding.map((a) => a.id).join(", ")}`
					: "All requested tasks settled (not necessarily successfully).";
			return result([headline, ...targets.map(summary)].join("\n\n"), {
				cancelled: Boolean(signal?.aborted),
				timedOut: !signal?.aborted && outstanding.length > 0,
				waited: targets.map((a) => ({ id: a.id, status: a.status, taskOutcome: a.taskOutcome, error: a.error })),
			});
		},
	});

	const TEAM_NOTES = [
		"Declared ownership is advisory, not a lock; members share the filesystem.",
		"Members have team_msg/team_inbox/team_ask (messages to teammates are delivered by this extension; questions arrive here as team-question messages — answer them with agent_steer on that worker ID). An orchestrator member also has team_roster/team_steer over its own team. Claude members get the same tools from an MCP server (mcp__team__<tool>).",
		"Steer or stop members with agent_steer/agent_kill using exact worker IDs; team_list shows roles beside actual status. No member can spawn, add or stop workers.",
		"Members are session-scoped: reload, session switch or quit stops them.",
	];
	/** Runs inside spawnBatch before publication, so a failure rolls the batch back. */
	const memberRecords = (members: readonly { role: string; ownedPaths: string[]; orchestrator: boolean }[], group: AgentGroup, addedAt: number): PersistedMember[] =>
		group.agents.map((a, i) => ({
			workerId: a.id,
			role: members[i].role,
			ownedPaths: [...members[i].ownedPaths],
			...(members[i].orchestrator ? { orchestrator: true } : {}),
			backend: a.backend ?? "pi",
			...(a.model === undefined ? {} : { model: a.model }),
			groupId: group.id,
			addedAt,
		}));
	/** Membership for spawnBatch; creating the mailbox root here keeps ad hoc workers free of it. */
	const teamRequest = (teamId: string, teamName: string, members: readonly { role: string; orchestrator: boolean }[]): NonNullable<BatchRequest["team"]> => {
		ensureMailbox();
		return { teamId, teamName, members: members.map((m) => ({ role: m.role, orchestrator: m.orchestrator })) };
	};
	const teamSpawnResult = (headline: string, teamId: string, group: AgentGroup, members: readonly PersistedMember[]) => result(
		[
			headline,
			...group.agents.map((a, i) =>
				`${a.id}  ${members[i].role}${members[i].orchestrator ? " (orchestrator)" : ""}  ${a.status}  backend=${a.backend ?? "pi"}  model=${a.model ?? "child default"}  effort=${a.effort ?? "default"}  owns=${members[i].ownedPaths.join(",") || "none declared"}${a.wake ? "" : "  wake=false"}`,
			),
			...TEAM_NOTES,
			group.agents.some((a) => a.wake)
				? "Each member with wake (the default) starts a turn for you when it settles while you are idle, so you can simply end this turn."
				: "wake=false: results arrive with your next turn; use agent_wait if you need them sooner.",
		].join("\n"),
		{ teamId, groupId: group.id, members: group.agents.map((a, i) => ({ workerId: a.id, role: members[i].role, backend: a.backend ?? "pi", model: a.model, ...(members[i].orchestrator ? { orchestrator: true } : {}) })) },
	);
	pi.registerTool({
		name: "team_create",
		label: "Create Team",
		description:
			"Create a named team of background workers with one unique role each, a shared objective and declared (advisory) ownership. Each member's prompt gets a fixed team header prepended. Members get team tools: team_msg (message a teammate by role; delivered by this extension), team_inbox, team_ask (question to you/the user, surfaced as a team-question message that starts your turn when idle; answer with agent_steer). A member with orchestrator: true also gets team_roster and team_steer over its own team only; no member can spawn, add or stop workers. pi members load them as a Pi extension, Claude members as MCP tools (mcp__team__<tool>). Starts all members through the same path as agent_spawn (validated before any start, rolled back together on failure) and returns exact worker IDs without waiting. Members default to the pi backend unless defaults.backend or the member sets another.",
		promptSnippet: "Create a team of role-based background workers with declared ownership",
		promptGuidelines: [
			"Use team_create when the user wants a coordinated team with distinct roles and ownership; use agent_spawn for ad hoc independent workers.",
			"team_create ownership is advisory: members share the filesystem, and each settled member with wake=true starts a parent turn. Members (pi or Claude) can message teammates (team_msg) and ask you questions (team_ask); answer a team-question message with agent_steer on that worker ID.",
			"Set orchestrator: true on one member (pi or claude-code) when the team should coordinate itself: it can see the roster and steer siblings by role, but never spawn or stop anyone; you keep the authority to add/stop members.",
			"Use team_add to extend a team created in this session and team_list to see roles beside actual worker status; steer and stop members with agent_steer and agent_kill by exact worker ID.",
		],
		parameters: Type.Object(
			{
				name: Type.String({ minLength: 1, maxLength: MAX_LABEL_CHARS, description: "Unique team name (trimmed, case-insensitive)." }),
				objective: Type.String({ minLength: 1, maxLength: MAX_OBJECTIVE_CHARS }),
				defaults: Type.Optional(TeamDefaultsSpec),
				members: TeamMembers,
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, signal, _update, ctx) {
			context(ctx);
			signal?.throwIfAborted();
			checkTeamKeys(params.members, params.defaults);
			const prepared = teams.prepareCreate(params);
			try {
				const createdAt = Date.now();
				let members: PersistedMember[] = [];
				const group = await spawnBatch(ctx, {
					specs: prepared.members.map((m) => m.spec as Spec),
					groupLabel: `${prepared.teamId} · ${prepared.name}`,
					team: teamRequest(prepared.teamId, prepared.name, prepared.members),
					beforeCommit: (group) => {
						members = memberRecords(prepared.members, group, createdAt);
						pi.appendEntry(TEAM_ENTRY_TYPE, teams.createEntry(prepared, createdAt, members));
						teams.commitCreate(prepared, createdAt, members);
					},
				}, signal);
				return teamSpawnResult(
					`Created ${prepared.teamId} (${prepared.name}) with ${group.agents.length} member(s) in ${group.id}. Task acceptance is asynchronous; inspect status for startup failures.`,
					prepared.teamId, group, members,
				);
			} finally {
				prepared.release();
			}
		},
	});
	pi.registerTool({
		name: "team_add",
		label: "Add Team Members",
		description:
			"Add members (one new unique role each) to a team created in this session, by exact team ID or unique name. New members see the current roster in their header; existing members are not told automatically (team_msg or agent_steer can inform them). orchestrator: true is accepted for pi and claude-code members. Teams restored from history are read-only. Same validation and rollback as agent_spawn; the team's create-time defaults apply.",
		parameters: Type.Object(
			{ team: Type.String({ minLength: 1, description: "Team ID (team_NN) or unique team name." }), members: TeamMembers },
			{ additionalProperties: false },
		),
		async execute(_id, params, signal, _update, ctx) {
			context(ctx);
			signal?.throwIfAborted();
			checkTeamKeys(params.members);
			const prepared = teams.prepareAdd(params.team, params.members);
			try {
				const addedAt = Date.now();
				let members: PersistedMember[] = [];
				const group = await spawnBatch(ctx, {
					specs: prepared.members.map((m) => m.spec as Spec),
					groupLabel: `${prepared.teamId} · ${prepared.name}`,
					team: teamRequest(prepared.teamId, prepared.name, prepared.members),
					beforeCommit: (group) => {
						members = memberRecords(prepared.members, group, addedAt);
						pi.appendEntry(TEAM_ENTRY_TYPE, teams.addEntry(prepared, members));
						teams.commitAdd(prepared, members);
					},
				}, signal);
				return teamSpawnResult(
					`Added ${group.agents.length} member(s) to ${prepared.teamId} (${prepared.name}) in ${group.id}. Task acceptance is asynchronous; inspect status for startup failures.`,
					prepared.teamId, group, members,
				);
			} finally {
				prepared.release();
			}
		},
	});
	pi.registerTool({
		name: "team_list",
		label: "List Teams",
		description:
			"List teams with each member's role (orchestrators marked), declared ownership, exact worker ID and actual status, plus recent control actions including member messages, orchestrator steers and operator questions (requested, accepted-or-queued, failed, unknown; never proof of execution). Pruned members and teams from earlier sessions are shown as unavailable with a reason. Output capped at 50KB/2000 lines with full snapshot path.",
		parameters: Type.Object({ team: Type.Optional(Type.String({ minLength: 1, description: "Team ID or unique name." })) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			context(ctx);
			const views = teamViews();
			const selected = params.team === undefined ? views : [views.find((t) => t.id === teams.find(params.team!).id)!];
			const text = selected.map((t) => [
				`${t.id} — ${t.name} [${t.origin === "history" ? "history, read-only" : "this session"}] · ${(["working", "idle", "failed", "done", "stopping", "stopped", "unavailable"] as const).filter((k) => t.counts[k]).map((k) => `${t.counts[k]} ${k}`).join(" · ") || "no members"}`,
				`Objective: ${t.objective}`,
				...t.members.map((m) =>
					`  ${m.workerId} ${m.role}${m.orchestrator ? " (orchestrator)" : ""} [${m.backend}] ${m.state}${m.status ? ` (${m.status}${m.taskOutcome ? `/${m.taskOutcome}` : ""})` : ""} · owns: ${m.ownedPaths.join(", ") || "none declared"}${m.error ? ` · error: ${m.error}` : ""}${m.available ? "" : ` · unavailable: ${m.reason}`}`,
				),
				...(t.actions.length ? ["  Recent actions:", ...t.actions.slice(-10).map((a) => `    #${a.seq} ${a.source} ${a.kind} → ${a.workerId} (${a.role}): ${a.state}${a.reason ? ` — ${a.reason}` : ""}`)] : []),
			].join("\n"));
			return result(
				[retentionNotice(), text.length ? `${text.join("\n\n")}\n\n${TEAM_NOTES.join(" ")}` : "No teams in this session or on this branch."].filter(Boolean).join("\n\n"),
				{ teams: selected },
			);
		},
	});

	/**
	 * Open the single workspace overlay. A second workspace of another kind is
	 * refused with a notice. Owns overlay handle, hide/restore state and cleanup.
	 */
	async function openWorkspace(
		ctx: ExtensionContext,
		kind: WorkspaceKind,
		create: (tui: { requestRender(): void }, theme: any) => WorkspaceView,
	) {
		context(ctx);
		if (ctx.mode !== "tui") {
			if (ctx.hasUI) ctx.ui.notify(`The ${kind === "agents" ? "monitor" : "team workspace"} requires Pi's interactive TUI.`, "warning");
			return;
		}
		if (workspaceKind) {
			if (workspaceKind !== kind) ctx.ui.notify(`Close the /${workspaceKind} workspace before opening /${kind}; only one workspace can be open at a time.`, "info");
			return;
		}
		workspaceKind = kind;
		overlayHidden = false;
		try {
			await ctx.ui.custom<null>(
				(tui, theme, _keys, done) => {
					closeWorkspace = () => done(null);
					renderWorkspace = () => tui.requestRender();
					const view = create(tui, theme);
					workspaceView = view;
					syncOverlayVisibility();
					return view as any;
				},
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "94%", maxHeight: "90%" },
					onHandle: (handle) => { overlayHandle = handle; syncOverlayVisibility(); },
				},
			);
		} finally {
			workspaceView?.dispose();
			workspaceKind = undefined;
			workspaceView = undefined;
			renderWorkspace = undefined;
			closeWorkspace = undefined;
			overlayHandle = undefined;
			overlayHidden = false;
			composingEditor = false;
		}
	}
	/**
	 * Hide the open workspace while a temporary editor composes, so it never covers
	 * the editor; restore only if the same view is still open afterwards.
	 */
	async function composeInWorkspace(ctx: ExtensionContext, view: WorkspaceView, title: string): Promise<string | undefined> {
		composingEditor = true;
		syncOverlayVisibility();
		syncTeamWidget();
		try {
			return await ctx.ui.editor(title);
		} finally {
			// Delivery may take time; keep kill/close controls available while it waits.
			if (workspaceView === view) {
				composingEditor = false;
				syncOverlayVisibility();
				syncTeamWidget();
			}
		}
	}
	const openModal = (ctx: ExtensionContext) => {
		let composing = false;
		return openWorkspace(ctx, "agents", (tui, theme) => {
			const view: AgentsModal = new AgentsModal(tui as any, theme, {
				getGroups: () => groups,
				requestRender: () => renderWorkspace?.(),
				close: () => closeWorkspace?.(),
				steerAgent: async (id, mode) => {
					if (composing || shuttingDown) return;
					composing = true;
					try {
						const a = findAgent(id);
						// Preserve monitor state, but do not cover the temporary editor.
						const message = await composeInWorkspace(ctx, view, `${mode === "followUp" ? "Follow up" : "Redirect"}: ${a.name}`);
						if (!message?.trim() || shuttingDown) return;
						const accepted = await steerWorker(a, message, mode, undefined, "user");
						if (!accepted.ok && !shuttingDown) ctx.ui.notify(`Cannot steer ${id}: ${accepted.reason}`, "warning");
					} catch (error) {
						if (!shuttingDown) ctx.ui.notify(String(error), "error");
					} finally {
						composing = false;
						if (!shuttingDown && workspaceView === view) refresh();
					}
				},
				killAgent: (id) => {
					void killWorker(findAgent(id), "stopped from monitor", "user").catch(() => scheduleRefresh());
				},
				killGroup: (id) => {
					void Promise.all(findGroup(id).agents.map((a) => killWorker(a, "run stopped from monitor", "user"))).catch(() =>
						scheduleRefresh(),
					);
				},
			});
			return view;
		});
	};
	/**
	 * Team workspace wiring: same single-overlay slot, editor hiding and shared
	 * control seams as the monitor, but members are addressed by exact worker ID
	 * from team views and every control writes the team's bounded action record.
	 */
	const openTeam = (ctx: ExtensionContext) => {
		let composing = false;
		return openWorkspace(ctx, "team", (tui, theme) => {
			const view: TeamModal = new TeamModal(tui as any, theme, {
				getTeams: () => teamViews(),
				getWorker: (workerId) => agents.find((a) => a.id === workerId),
				requestRender: () => renderWorkspace?.(),
				close: () => closeWorkspace?.(),
				steerMember: async (id, mode) => {
					if (composing || shuttingDown) return;
					composing = true;
					try {
						const a = findAgent(id);
						// A redirect interrupts the current task (on Claude: interrupt,
						// settle, then replacement) — the title must say so; it is not
						// a chat box. Preserve workspace state, but never cover the
						// temporary editor.
						const title =
							mode === "followUp"
								? `Follow up: ${a.name} (${a.id})`
								: `Redirect: ${a.name} (${a.id}) — interrupts current task`;
						const message = await composeInWorkspace(ctx, view, title);
						if (!message?.trim() || shuttingDown) return;
						const accepted = await steerWorker(a, message, mode, undefined, "user");
						if (!accepted.ok && !shuttingDown) ctx.ui.notify(`Cannot steer ${id}: ${accepted.reason}`, "warning");
					} catch (error) {
						if (!shuttingDown) ctx.ui.notify(String(error), "error");
					} finally {
						composing = false;
						if (!shuttingDown && workspaceView === view) refresh();
					}
				},
				stopMember: (id) => {
					void killWorker(findAgent(id), "stopped from team workspace", "user").catch(() => scheduleRefresh());
				},
			});
			return view;
		});
	};
	const command = async (args: string, ctx: ExtensionContext) => {
		if (!args.trim()) return openModal(ctx);
		if (!/^models(?:\s|$)/.test(args.trim())) {
			ctx.ui.notify("Usage: /subagents or /subagents models [search]", "info");
			return;
		}
		context(ctx);
		const catalog = await modelCatalog(ctx);
		if (shuttingDown) return;
		for (const error of catalog.errors) ctx.ui.notify(`${error.backend}: ${error.error}`, "warning");
		const matches = matchingModels(catalog.models, args.trim().slice(6).trim());
		if (!matches.length) { ctx.ui.notify("No matching subagent models.", "warning"); return; }
		const labels = matches.map(model => `[${model.backend}] ${model.id} — ${model.name}`);
		const choice = await ctx.ui.select("Choose a subagent model", labels);
		if (choice === undefined || shuttingDown) return;
		const selected = matches[labels.indexOf(choice)];
		if (selected) ctx.ui.setEditorText(`Use a ${selected.backend} subagent with model ${selected.id} to `);
	};
	for (const name of ["agents", "subagents"]) pi.registerCommand(name, {
		description: "Open the subagent monitor, or models [search] to choose a worker model",
		getArgumentCompletions: (prefix) => "models".startsWith(prefix) ? [{ value: "models", label: "models", description: "Discover and choose a worker model" }] : null,
		handler: command,
	});
	// `/team <objective>` planning request: one extension-origin message
	// (customType "team-plan", displayed) telling the parent agent to plan and
	// create the team with the team tools. Never a user message: the request
	// must be visibly extension-origin and must not masquerade as user input.
	const teamPlanMessage = (objective: string): string =>
		[
			"[Team planning requested by the user with /team]",
			`Objective: ${objective}`,
			"",
			"Plan and create a team for this objective with the team tools, then coordinate it:",
			"- Use team_create with a short unique name, this objective, and members that each have one explicit unique role, a self-contained prompt and declared ownedPaths (advisory coordination, not a lock). Extend later with team_add; inspect with team_list; steer or stop members with agent_steer/agent_kill by exact worker ID.",
			"- Obey the team tool descriptions, schemas and limits. All members share one filesystem; ownership does not protect files.",
			"- Members can message teammates with team_msg (this extension delivers it) and ask you questions with team_ask (they arrive as team-question messages; answer with agent_steer on that worker ID); Claude members have the same tools through an MCP server. Give one member (pi or claude-code) orchestrator: true if the team should coordinate itself: it can see the roster and steer siblings by role but never spawn or stop anyone. You remain the authority, and each member's final answer is its report.",
			"- When you present the plan, report the defaults and their cost: members default to the pi backend inheriting the parent model/effort (agent_models resolves exact IDs, including Claude's), and every member with wake=true (the default) starts a parent turn — which costs tokens on the parent model — when it settles. State how many wakes this team will cause, or propose wake: false to batch results into your next turn.",
			"Do not start the objective's work yourself before the team exists; the /team workspace and team_list show the roster.",
		].join("\n");
	/** Objective text for a planning message: bounded, control-free (newlines/tabs kept). */
	const planObjective = (args: string): string => {
		const cleaned = args.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, " ").trim();
		if (!cleaned) return "";
		return cleaned.length > MAX_OBJECTIVE_CHARS
			? `${cleaned.slice(0, MAX_OBJECTIVE_CHARS)}\u2026 [truncated to the ${MAX_OBJECTIVE_CHARS}-character team objective limit]`
			: cleaned;
	};
	// `/team` opens the team workspace through the shared single-overlay slot;
	// it never sends anything or starts a model turn on its own.
	// `/team <objective>` sends ONE extension-origin planning message as a
	// followUp (queueable while streaming, so it cannot throw on a busy
	// parent); triggerTurn starts the planning turn only when the parent is
	// idle. The workspace stays strictly opt-in (bare /team).
	pi.registerCommand("team", {
		description:
			"Open the team workspace, or /team <objective> to ask the parent agent to plan and create the team with team_create/team_add",
		handler: async (args: string, ctx: ExtensionContext) => {
			const objective = planObjective(args);
			if (!objective) return openTeam(ctx);
			const idle = typeof (ctx as { isIdle?: () => boolean }).isIdle === "function" ? ctx.isIdle() : true;
			try {
				pi.sendMessage(
					{ customType: "team-plan", display: true, content: teamPlanMessage(objective) },
					{ deliverAs: "followUp", triggerTurn: true },
				);
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify(`Could not queue team planning: ${String(error)}`, "error");
				return;
			}
			if (ctx.hasUI) {
				ctx.ui.notify(
					idle
						? "Team planning sent to the parent agent (displayed as a team-plan message); it will plan the team with team_create/team_add now."
						: "The parent agent is busy; team planning was queued as a follow-up and runs when the current work finishes.",
					"info",
				);
			}
		},
	});
	/**
	 * Re-adopt this owner session's detached workers (hosting.ts): a living host
	 * is attached and its whole output replayed through a runner in adopt mode;
	 * a dead host's log is replayed and the worker finalized (state "lost" if it
	 * died mid-turn; its backend session id stays in the registry for a manual
	 * resume, never an automatic one). Completions after the earlier manager's
	 * consumed offset notify and wake exactly like live ones.
	 */
	let adopting: Promise<void> | undefined;
	const adoptWorkers = (ctx: ExtensionContext): Promise<void> => {
		if (!hosting.active()) return Promise.resolve();
		adopting ??= (async () => {
			try {
				for (const { dir, meta } of hosting.candidates()) {
					if (shuttingDown) return;
					if (agents.some((a) => a.id === meta.id)) continue;
					const backend = meta.backend === "pi" ? undefined : backends.get(meta.backend);
					if (meta.backend !== "pi" && !backend) continue; // Its extension is not loaded (yet); stays detached.
					let prepared: Record<string, unknown> = {};
					try {
						// Permission policy and handlers; nothing is spawned.
						prepared = backend?.prepare?.({ ...meta.spec }, ctx) ?? {};
					} catch {
						prepared = {};
					}
					const adoption = await hosting.adopt(dir, meta);
					if (!adoption) continue;
					if (shuttingDown) { hosting.abandon(meta.id); return; }
					let worker: Worker;
					try {
						worker = (backend?.create ?? createRunner)(
							{
								model: meta.spec.model,
								effort: meta.spec.effort,
								tools: meta.spec.tools,
								extensions: meta.spec.extensions,
								...prepared,
								...adoption.options,
								backend: meta.backend,
								id: meta.id,
								groupId: meta.groupId,
								name: meta.name,
								task: meta.spec.prompt,
								cwd: meta.spec.cwd,
								wake: meta.spec.wake,
							},
							{ onChange: scheduleRefresh, onSettled, onExit },
						);
					} catch {
						hosting.abandon(meta.id);
						continue;
					}
					hosting.bind(meta.id, worker);
					let group = groups.find((g) => g.id === meta.groupId);
					if (!group) {
						group = { id: meta.groupId, label: meta.groupLabel ?? `${meta.groupId} · re-adopted`, createdAt: meta.createdAt, agents: [] };
						groups.push(group);
					}
					group.agents.push(worker);
					agents.push(worker);
					registry.resume(worker);
					if (meta.team && teams.adoptHistoryTeam(meta.team.teamId)) ensureMailbox();
				}
			} finally {
				adopting = undefined;
				refresh();
			}
		})();
		return adopting;
	};
	const unregisterAdoptListener = pi.events?.on(WORKERS_ADOPT_EVENT, (data: unknown) => {
		if (shuttingDown || !activeCtx || (data as { version?: unknown } | null)?.version !== 1) return;
		void adoptWorkers(activeCtx);
	});
	pi.on("session_start", (_event, ctx) => {
		activeCtx = ctx;
		discoverBackends();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "subagents-counters-v2") {
				const data = entry.data as { agentCounter?: number; groupCounter?: number } | undefined;
				if (Number.isSafeInteger(data?.agentCounter)) counter = Math.max(counter, data!.agentCounter!);
				if (Number.isSafeInteger(data?.groupCounter)) groupCounter = Math.max(groupCounter, data!.groupCounter!);
			}
			// Migrate IDs from the previous extension's persisted spawn results too.
			if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "agent_spawn") {
				const data = entry.message.details as { groupId?: string; spawned?: { id?: string }[] } | undefined;
				const groupMatch = typeof data?.groupId === "string" ? /^run_(\d+)$/.exec(data.groupId) : null;
				if (groupMatch) groupCounter = Math.max(groupCounter, Number(groupMatch[1]));
				if (Array.isArray(data?.spawned))
					for (const item of data.spawned) {
						const match = typeof item?.id === "string" ? /^ag_(\d+)$/.exec(item.id) : null;
						if (match) counter = Math.max(counter, Number(match[1]));
					}
			}
		}
		// IDs are reserved across every branch; displayed history only from the active one.
		teams.reserveCounter(ctx.sessionManager.getEntries());
		teams.restoreHistory(ctx.sessionManager.getBranch?.() ?? []);
		hosting.setOwner(ctx.sessionManager.getSessionId?.(), ctx.sessionManager.getSessionFile?.());
		if (hosting.active()) {
			try {
				hosting.reap();
			} catch {
				/* Archiving stale entries is best effort. */
			}
			// Asynchronous: pings and replays must not block session startup.
			void adoptWorkers(ctx);
		}
		refresh();
	});
	pi.on("session_tree", (_event, ctx) => {
		if (shuttingDown) return;
		// Live members stay session-owned; only read-only history follows the branch.
		teams.restoreHistory(ctx.sessionManager.getBranch?.() ?? []);
		refresh();
	});
	pi.on("session_shutdown", async () => {
		// Read at dispose time: the embedding process sets it only when it is going away.
		const detach = detachRequested();
		shuttingDown = true;
		unregisterWorkersListener?.();
		unregisterAdoptListener?.();
		publishWorkers();
		unregisterBackendListener?.();
		unregisterDialogListener?.();
		backends.clear();
		activeCtx = undefined;
		if (refreshTimer) clearTimeout(refreshTimer);
		if (mailboxTimer) clearInterval(mailboxTimer);
		mailboxTimer = undefined;
		try {
			teamWidget?.clear();
		} catch {
			/* The UI may already be gone. */
		}
		teamWidget = undefined;
		teamWidgetUi = undefined;
		teamWidgetSuppressed = false;
		try {
			closeWorkspace?.();
		} catch {
			/* Already closed. */
		}
		workspaceView?.dispose();
		workspaceKind = undefined;
		workspaceView = undefined;
		renderWorkspace = undefined;
		closeWorkspace = undefined;
		overlayHandle = undefined;
		backendDialogs.clear();
		composingEditor = false;
		// Detach leaves hosted workers running for the next manager; anything
		// whose teardown already began (agent_kill, failed spawn) still finishes.
		const detached = detach
			? hosting.detachAll((a) => !rollingBack.has(a) && !a.isFinished() && !a.isStopping?.())
			: new Set<string>();
		await Promise.all([...agents, ...rollingBack].filter((a) => rollingBack.has(a) || !detached.has(a.id)).map((a) => a.dispose()));
		hosting.clear();
		rollingBack.clear();
		agents.length = 0;
		groups.length = 0;
		finished.clear();
		teams.clear();
		registry.clear();
		// Only a root this instance created is removed; an injected root is the caller's.
		// A registry mailbox goes only once no worker of this owner remains to use it.
		if (mailboxRoot && (mailboxOwned || (!options.mailboxRoot && !detached.size && hosting.ownerEmpty()))) {
			try {
				fs.rmSync(mailboxRoot, { recursive: true, force: true });
			} catch {
				/* Temp cleanup is best effort. */
			}
		}
		mailboxRoot = undefined;
		mailboxOwned = false;
	});
}

export default function subagentsExtension(pi: ExtensionAPI): void {
	registerSubagents(pi);
}
