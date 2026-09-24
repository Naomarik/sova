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
import { BUILTIN_TOOLS as BUILTIN_TOOL_NAMES, claudeCodeProviderLoad, SubagentRunner } from "./runner.ts";
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
import { WorkerRegistryRecorder, type WorkerLaunchSpec } from "./registry.ts";
import { readWorkerManifests, resolvedModel, viewWorker, type FoldedWorkerManifest, type WorkerTranscriptView } from "./worker-transcript.ts";
import { defaultWorkerTranscriptAdapters } from "./adapters/index.ts";
import { RestoredWorker, isRestored } from "./restored.ts";
import { WorkerHosting, detachRequested, type HostingOptions } from "./hosting.ts";
import { placeholderDir, placeholderRoot, toRemotePath } from "../remote/argv.ts";
import {
	REMOTE_DISCOVER_EVENT,
	REMOTE_MCP_ENV,
	REMOTE_MCP_SERVER_NAME,
	REMOTE_SESSION_EVENT,
	encodeRemoteMcpIdentity,
	remoteWorkerInstructions,
	type RemoteSessionEvent,
} from "../remote/workers.ts";
import { SANDBOX_DISCOVER_EVENT, SANDBOX_STATE_EVENT, type SandboxStateEvent } from "../sandbox/state.ts";

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
/* Busy-worker activity tail (see recentActivity): a tool-heavy run must not read
 * as "no output" while the only missing thing is final prose. */
const WORKER_ACTIVITY_ITEMS = 6;
const WORKER_ACTIVITY_ITEM_CHARS = 160;
const WORKER_ACTIVITY_TOTAL_CHARS = 1400;
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
 * The other file under SELF_DIR a child loads, first, in every pi worker (plain, member, remote;
 * inline or hosted): one `subagents-worker-session` entry in the worker's own session so Sova can
 * tell it from a user session (see worker-mark.ts). Never user-facing, like MEMBER_EXTENSION.
 */
export const MARKER_EXTENSION = path.join(SELF_DIR, "worker-mark.ts");
/** The spawn summary names the extensions a worker was given; the marker is plumbing, not one of them. */
const listedExtensions = (worker: Worker): string[] => worker.extensions.filter((source) => source !== MARKER_EXTENSION);
/**
 * The same member tools as a stdio MCP server for claude-code members (the CLI
 * launches it from a per-worker mcp.json; Claude sees mcp__team__<tool>). It is
 * run under the current runtime, which executes .ts files directly.
 */
export const MEMBER_MCP = path.join(SELF_DIR, "member-mcp.ts");
/**
 * The remote extension (a sibling directory, never under SELF_DIR). A pi worker of a remote
 * session loads it with `-e` and `--target <name>`, so its bash/read/write/edit/ls/find/grep run
 * on the target exactly as the parent's do; a claude-code worker gets the same through the
 * `remote` stdio MCP server (mcp-server.ts, tools mcp__remote__remote_*) and no local tools.
 */
const REMOTE_DIR = realpathOr(path.join(SELF_DIR, "..", "remote"));
export const REMOTE_EXTENSION = path.join(REMOTE_DIR, "index.ts");
export const REMOTE_MCP = path.join(REMOTE_DIR, "mcp-server.ts");
/**
 * The claude-code extension (runner.ts claudeCodeProviderLoad): a pi worker on a
 * `claude-code-cli/<id>` model loads it with `-e` and `--claude-code-provider`.
 */
export { CLAUDE_CODE_EXTENSION } from "./runner.ts";
/**
 * claude bounds every MCP tool call with MCP_TOOL_TIMEOUT (ms) read from ITS OWN process env
 * (a per-server env in mcp.json is ignored; default 60 s, too short for a remote build).
 * remote_bash's 600 s maximum plus margin; the server enforces its own per-tool deadlines below it.
 */
export const REMOTE_MCP_TOOL_TIMEOUT_MS = 630_000;

/** Whether an `-e` source is the extension directory `dir` (the directory or its index.ts). */
function sameExtension(source: string, dir: string): boolean {
	const real = realpathOr(source);
	return real === dir || real === path.join(dir, "index.ts");
}
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
	/**
	 * agent_resume: start the ONE spec as this existing worker again, reopening its own backend
	 * session idle (SpawnOptions.resume). Its id and group are kept, no ID is reserved, it is never
	 * hosted, and its durable record is written only once it is up (resumeWorker).
	 */
	resume?: { id: string; groupId: string; groupLabel: string; sessionId?: string; sessionFile?: string };
}
/** @internal Test seams for the member mailbox. */
export interface SubagentsOptions {
	mailboxRoot?: string;
	mailboxPollMs?: number;
	/** Detachable workers (hosting.ts): registry root, forced enablement, host timings. */
	hosting?: HostingOptions;
	/** Model policy file override (policy.ts); the real one is shared with Sova. */
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

/**
 * The remote session a placeholder cwd stands for: <agentDir>/sova/targets/<name>/<far/abs/path>
 * (server/targets.ts opens remote sessions there). Undefined for any other directory.
 */
function remoteOfPlaceholder(cwd: string): RemoteSessionEvent | undefined {
	const root = path.dirname(placeholderRoot(getAgentDir(), "x"));
	if (!cwd.startsWith(root + path.sep)) return undefined;
	const name = cwd.slice(root.length + 1).split(path.sep)[0];
	if (!name || !/^(?!\.+$)[A-Za-z0-9._-]+$/.test(name)) return undefined;
	return { version: 1, target: name, farCwd: toRemotePath(cwd, placeholderRoot(getAgentDir(), name)) };
}

/** A worker's far working directory in a remote session: the spec's cwd (absolute, or relative to the session's far cwd), else the session's. */
function remoteFarCwd(specCwd: string | undefined, sessionFarCwd: string): string {
	if (specCwd === undefined) return sessionFarCwd;
	const raw = specCwd.startsWith("@") ? specCwd.slice(1) : specCwd;
	if (raw === "~" || raw.startsWith("~/")) throw new Error(`In a remote session a worker cwd must be an absolute path on the target (got ${specCwd}); ~ is the target's home, which the parent does not know here.`);
	return path.posix.normalize(raw.startsWith("/") ? raw : path.posix.join(sessionFarCwd, raw));
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

/**
 * Every tool text stays under this many characters. The Claude Code CLI replaces any MCP tool
 * result over 50,000 characters with a 2 KB preview, so a Claude parent would otherwise lose
 * both the tail and the snapshot path. A byte cap at this value is also a character cap.
 */
export const TOOL_TEXT_MAX_CHARS = 47_000;
/** Default and maximum page of a final answer that agent_transcript returns per call. */
export const FINAL_ANSWER_PAGE_CHARS = 40_000;
/** Header lines (status, error, session) above a final-answer page are clipped to this. */
const TRANSCRIPT_HEADER_MAX_CHARS = 4_000;
/** The completion message quotes this much of the summary. */
const WAKE_PREVIEW_CHARS = 4_000;

/** A private copy of `text` in a fresh temporary directory; returns its path. */
function writeSnapshot(prefix: string, name: string, text: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const file = path.join(dir, name);
	fs.writeFileSync(file, text, { mode: 0o600 });
	return file;
}

const snapshotLine = (file: string) =>
	`[Output truncated at ${TOOL_TEXT_MAX_CHARS.toLocaleString("en-US")} bytes/2000 lines. Full snapshot: ${file}]`;

/** All tool text is capped; the caller can read the complete snapshot using read. */
export function boundedText(text: string): string {
	const truncated = truncateHead(text, { maxBytes: TOOL_TEXT_MAX_CHARS - 300, maxLines: 2000 });
	if (!truncated.truncated) return text;
	return `${truncated.content}\n\n${snapshotLine(writeSnapshot("pi-subagents-output-", "output.txt", text))}`;
}

const clipHeader = (text: string) =>
	text.length > TRANSCRIPT_HEADER_MAX_CHARS ? `${text.slice(0, TRANSCRIPT_HEADER_MAX_CHARS)}…` : text;
const count = (n: number) => n.toLocaleString("en-US");

/**
 * One page of a final answer: `header` (clipped), then a range line when the page is not the
 * whole answer or the caller asked for a range, then the page verbatim. Pages at consecutive
 * offsets concatenate to the answer exactly; the text never reaches TOOL_TEXT_MAX_CHARS.
 */
export function finalAnswerPage(
	id: string,
	header: string,
	answer: string,
	offset = 0,
	limit = FINAL_ANSWER_PAGE_CHARS,
	ranged = false,
): { text: string; page: { total: number; offset: number; end: number; nextOffset?: number } } {
	const start = Math.min(Math.max(0, Math.floor(offset)), answer.length);
	const size = Math.min(Math.max(1, Math.floor(limit)), FINAL_ANSWER_PAGE_CHARS);
	const end = Math.min(answer.length, start + size);
	const more = end < answer.length;
	const page = { total: answer.length, offset: start, end, ...(more ? { nextOffset: end } : {}) };
	const head = clipHeader(header);
	if (!ranged && start === 0 && !more) return { text: `${head}\n${answer}`, page };
	const range =
		`[Final answer: ${count(answer.length)} chars; this page is chars ${count(start)}–${count(end)}` +
		(more ? `; next page: agent_transcript {"id":"${id}","offset":${end}}.]` : "; end of answer.]");
	return { text: `${head}\n${range}\n${answer.slice(start, end)}`, page };
}

/**
 * The full:true text. The snapshot path (when anything is cut) comes first and the current
 * task's final answer comes before the retained items, so no downstream head cap can hide
 * either; the whole text stays under TOOL_TEXT_MAX_CHARS. The snapshot holds `header` plus
 * every retained item, uncut.
 */
export function fullTranscriptText(id: string, header: string, answer: string, items: string): string {
	const head = clipHeader(header);
	const answerBlock = !answer
		? ""
		: answer.length <= FINAL_ANSWER_PAGE_CHARS
			? `[Current task's final answer, ${count(answer.length)} chars:]\n${answer}\n[End of final answer.]`
			: `[Current task's final answer: ${count(answer.length)} chars, too long to include here; read it whole with agent_transcript {"id":"${id}","offset":0}, then each next offset it names.]`;
	const top = [head, answerBlock].filter(Boolean).join("\n\n");
	const whole = `${top}\n\n${items}`;
	if (whole.length < TOOL_TEXT_MAX_CHARS - 300 && whole.split("\n").length <= 2000) return whole;
	const file = writeSnapshot("pi-subagents-output-", "output.txt", `${header}\n\n${items}`);
	const first = snapshotLine(file);
	const room = TOOL_TEXT_MAX_CHARS - 300 - first.length - top.length;
	const kept = room > 0 ? truncateHead(items, { maxBytes: room, maxLines: 2000 }).content : "";
	return [first, top, kept ? `${kept}\n[Retained items cut here; the snapshot has the rest.]` : ""].filter(Boolean).join("\n\n");
}

const toolResult = (text: string, details: Record<string, unknown> = {}, bounded = false) => ({
	content: [{ type: "text" as const, text: bounded ? text : boundedText(text) }],
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
	// A remote session (pi-config's remote extension, `--target`): its workers must run on the
	// target too. The extension announces the session on the event bus (its flag is invisible
	// to other extensions); the placeholder cwd is the fallback for any load order.
	let remoteSession: RemoteSessionEvent | undefined;
	const unregisterRemoteListener = pi.events?.on(REMOTE_SESSION_EVENT, (data: unknown) => {
		const e = data as RemoteSessionEvent | undefined;
		if (!e || e.version !== 1 || typeof e.target !== "string" || !e.target.trim()) return;
		// A far cwd the extension has not resolved yet (before its preflight answers) is kept as
		// "remote, unresolved": spawns refuse until the next announcement carries it.
		if (e.farCwd !== undefined && (typeof e.farCwd !== "string" || !e.farCwd.startsWith("/"))) return;
		remoteSession = e;
	});
	pi.events?.emit(REMOTE_DISCOVER_EVENT, { version: 1 });
	// The parent's sandbox (pi-config's sandbox extension): announced on the bus like the remote
	// session. While it is on, every worker is checked by it and starts under it; nothing here
	// interprets the policy (workerFlags, the Claude settings and checkWorker are the extension's).
	let sandboxState: SandboxStateEvent | undefined;
	const unregisterSandboxListener = pi.events?.on(SANDBOX_STATE_EVENT, (data: unknown) => {
		const e = data as SandboxStateEvent | undefined;
		if (!e || e.version !== 1 || typeof e.on !== "boolean") return;
		if (e.on && (typeof e.extensionPath !== "string" || !e.extensionPath.startsWith("/"))) return;
		if (e.workerFlags !== undefined && (typeof e.workerFlags !== "object" || Object.values(e.workerFlags).some((v) => typeof v !== "string"))) return;
		sandboxState = e;
	});
	pi.events?.emit(SANDBOX_DISCOVER_EVENT, { version: 1 });
	const remoteSessionFor = (ctx: ExtensionContext): RemoteSessionEvent | undefined => remoteSession ?? remoteOfPlaceholder(ctx.cwd);
	/** One line in agent_spawn/agent_list output: the proof that this session's workers run on the target (absent in a local session). */
	const remoteNotice = (ctx: ExtensionContext): string => {
		const r = remoteSessionFor(ctx);
		if (!r) return "";
		if (r.error) return `Remote session: target ${r.target} could not be loaded (${r.error}); no worker can be spawned.`;
		return r.farCwd ? `Remote session: workers run on target ${r.target} in ${r.farCwd}.` : `Remote session: target ${r.target}, far working directory not resolved yet; spawns refuse until it is.`;
	};
	const groups: AgentGroup[] = [];
	const teams = new TeamStore();
	// Worker transcripts of every backend, read through one protocol (worker-transcript.ts);
	// a backend extension may register its own adapter with its registration.
	const adapters = defaultWorkerTranscriptAdapters();
	// A resumed worker's runner counts only what it spends from now on; what its earlier
	// processes spent is its base, so the lifetime Σ never drops on a resume.
	const usageBase = new WeakMap<Worker, UsageSum & { turns: number }>();
	// A backend whose figures cover its whole session (Worker.usageScope "session") already counts
	// that spend: its base only stands in until its first report, and its cumulative figures never
	// fall below it, so each field is the larger of the two, never their sum.
	const addWorkerUsage = (total: UsageSum, a: Worker): UsageSum => {
		const base = usageBase.get(a);
		if (!base) return addUsage(total, a);
		const cumulative = a.usageScope === "session";
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) {
			const own = amount(a.usage?.[key]);
			total[key] += cumulative ? Math.max(base[key], own) : base[key] + own;
		}
		return total;
	};
	const lifetimeUsage = (a: Worker) => {
		const base = usageBase.get(a)?.turns ?? 0;
		const own = amount(a.usage?.turns);
		return { ...addWorkerUsage(emptySum(), a), turns: a.usageScope === "session" ? Math.max(base, own) : base + own };
	};
	// The durable per-worker record in this (owner) session file, for every worker of every
	// backend and transport (registry.ts, worker-transcript.ts).
	const registry = new WorkerRegistryRecorder((customType, data) => pi.appendEntry(customType, data), lifetimeUsage);
	// Each published worker's launch spec, written once with its first record (resume needs it).
	const launches = new WeakMap<Worker, WorkerLaunchSpec>();
	// Workers of earlier processes, from the manifest fold at session_start: every branch's,
	// with their transcript view. Those on the active branch are listed as RestoredWorkers;
	// the rest only count toward the lifetime Σ. A resumed worker leaves this map.
	const restoredViews = new Map<string, { manifest: FoldedWorkerManifest; view: WorkerTranscriptView }>();
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
		// Restored workers are records, not retained runs: retention never evicts them.
		for (const a of agents) if (a.isFinished() && !a.processAlive && !isRestored(a)) finished.add(a);
		while (finished.size > MAX_FINISHED) {
			const a = finished.values().next().value!;
			finished.delete(a);
			teams.recordEviction(a.id, { status: a.status, taskOutcome: a.taskOutcome, error: a.error });
			addWorkerUsage(evictedUsage, a);
			agents.splice(agents.indexOf(a), 1);
			const group = groups.find(g => g.id === a.groupId);
			if (group) group.agents = group.agents.filter(worker => worker !== a);
			evictedWorkers++;
		}
		for (let i = groups.length - 1; i >= 0; i--) {
			if (!groups[i].agents.length) { groups.splice(i, 1); evictedRuns++; }
		}
	};
	const retention = () => ({ maxFinished: MAX_FINISHED, evictedWorkers, evictedRuns });
	const result = (text: string, details: Record<string, unknown> = {}) => toolResult(text, { ...details, retention: retention() });
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
	// Restored workers of earlier processes are in it exactly once: listed ones through `agents`,
	// those of other branches through restoredViews; a resumed one through its runner's base.
	const sessionUsage = () => {
		const total: UsageSum = { ...evictedUsage };
		let workers = agents.length + evictedWorkers;
		let restored = 0;
		// A Σ mixing snapshots is only true as of its stalest part: the OLDEST snapshot time.
		let asOf = Infinity;
		const stale = (at: number | undefined) => { if (at) asOf = Math.min(asOf, at); };
		for (const a of agents) {
			addWorkerUsage(total, a);
			if (isRestored(a)) { restored++; stale(a.usageAsOf); }
		}
		for (const { manifest, view } of restoredViews.values()) {
			if (agents.some((a) => a.id === manifest.workerId)) continue;
			const u = view.usage;
			total.input += u.input; total.output += u.output; total.cacheRead += u.cacheRead; total.cacheWrite += u.cacheWrite; total.cost += u.cost ?? 0;
			workers++; restored++;
			stale(u.source === "snapshot" ? u.asOf : u.costSource === "snapshot" ? u.costAsOf : undefined);
		}
		return { ...publicUsage(total), workers, ...(asOf !== Infinity ? { asOf } : {}), ...(restored ? { restored } : {}) };
	};
	const usageField = (a: Worker) => {
		const usage = addWorkerUsage(emptySum(), a);
		return spent(usage) ? { usage: publicUsage(usage) } : {};
	};
	/** A restored worker's public extras (sessions/schema.ts WorkerEntry). "none" usage is unavailable, never 0. */
	const restoredFields = (a: Worker) => isRestored(a)
		? {
			// Asked now, not at restore: a backend extension may have loaded since.
			restored: true as const, usageSource: a.usageSource, resumable: resumeRefusal(a.manifest) === undefined,
			...(a.usageAsOf ? { usageAsOf: a.usageAsOf } : {}),
			...(a.interruptedAt ? { interruptedAt: a.interruptedAt } : {}),
		}
		: {};
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
			...(isRestored(a) && a.usageSource === "none" ? {} : usageField(a)),
			...restoredFields(a),
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
		if (a.isFinished() && !a.processAlive && !isRestored(a)) finished.add(a);
		pruneFinished();
		scheduleRefresh();
	};
	/**
	 * Bounded tail of what a busy worker is doing right now. Tool-heavy runs
	 * (Claude opus routinely makes dozens of tool calls before any assistant
	 * text) would otherwise present as "(no output for this task)" while the
	 * retained transcript holds plenty of live activity. Each item is one
	 * clipped line and the whole section stays under ~1.5 KB.
	 */
	const recentActivity = (a: Worker): string => {
		if (!a.transcript.length) return "(no output yet — task in progress)";
		const items = a.transcript.slice(-WORKER_ACTIVITY_ITEMS);
		const lines: string[] = [];
		let used = 0;
		let more = false;
		for (const t of items) {
			const text = t.text.replace(/\s+/g, " ").trim() || "(no text)";
			const line = `[${t.kind}${t.toolName ? `:${t.toolName}` : ""}] ${
				text.length > WORKER_ACTIVITY_ITEM_CHARS ? `${text.slice(0, WORKER_ACTIVITY_ITEM_CHARS)}…` : text
			}`;
			if (used + line.length > WORKER_ACTIVITY_TOTAL_CHARS && lines.length) {
				more = true;
				break;
			}
			used += line.length;
			lines.push(line);
		}
		return [
			`Still working — no final answer yet. Recent activity (last ${lines.length} of ${a.transcript.length} retained item(s)${
				a.transcriptOmitted?.items ? `, ${a.transcriptOmitted.items} older trimmed` : ""
			}):`,
			...lines.map((line) => `  ${line}`),
			more ? "  …" : "",
			"Call agent_transcript with full: true for the retained transcript.",
		]
			.filter(Boolean)
			.join("\n");
	};
	const summaryHeader = (a: Worker) =>
		[
			`### ${a.id} (${a.name}) — ${a.status}${a.taskOutcome ? ` · task ${a.taskOutcome}` : ""}`,
			a.error ? `Error: ${a.error}` : "",
			a.sessionFile || a.sessionId ? `Session: ${a.sessionFile ?? a.sessionId}` : "",
			`Model: ${a.model ?? "child default"} · thinking: ${a.effort ?? "default"}${a.backend && a.backend !== "pi" ? ` · backend: ${a.backend}` : ""}`,
		]
			.filter(Boolean)
			.join("\n");
	const summary = (a: Worker) =>
		// Busy workers show live tool activity instead of a premature "no output";
		// settled ones keep the final-answer line the completion message quotes.
		`${summaryHeader(a)}\n${a.finalOutput() || (a.isSettled() ? "(no output for this task)" : recentActivity(a))}`;
	/**
	 * A cut completion message: the preview, one line naming the final answer's size and a
	 * private file holding it verbatim, then the trailer Sova's report parser anchors on
	 * (server/reports.ts), which must stay the last line.
	 */
	const completionPreview = (a: Worker, text: string): string => {
		const answer = a.finalOutput();
		let where: string;
		try {
			const file = writeSnapshot("pi-subagents-report-", `${a.id}-final-answer.md`, answer || text);
			where = `${answer ? "Final answer" : "Full message"}: ${count((answer || text).length)} chars, whole in ${file}; or page it with agent_transcript {"id":"${a.id}","offset":0}.`;
		} catch {
			where = `${answer ? "Final answer" : "Full message"}: ${count((answer || text).length)} chars; page it with agent_transcript {"id":"${a.id}","offset":0}.`;
		}
		return `${text.slice(0, WAKE_PREVIEW_CHARS)}\n[${where}]\n[Use agent_transcript for more.]`;
	};
	const onSettled = (a: Worker) => {
		if (shuttingDown || !agents.includes(a)) return;
		// Idle again: status, outcome and a usage snapshot in the durable record.
		registry.settled(a);
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
					content: text.length > WAKE_PREVIEW_CHARS ? completionPreview(a, text) : text,
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
		const remote = remoteSessionFor(ctx);
		if (remote?.error) throw new Error(`This session's remote target "${remote.target}" could not be loaded (${remote.error}); a worker would have no tools. Fix the target first.`);
		if (remote && !remote.farCwd) throw new Error(`This session runs on remote target "${remote.target}" but its far working directory is not known yet (the target's preflight has not answered); retry in a few seconds, or /remote check.`);
		// Local sessions only: a remote session's tools run on the target (the extension reports it off there).
		const sandbox = !remote && sandboxState?.on ? sandboxState : undefined;
		const prepared = specs.map((spec) => {
			if (!spec.prompt.trim()) throw new Error("Task must not be blank.");
			const backendId = spec.backend ?? "pi";
			// Remote session: the worker's cwd is a FAR path; its local cwd is the placeholder that
			// stands for it (created if the spec names another far directory), which exists but is
			// empty — the worker never gets local file tools for it.
			const farCwd = remote ? remoteFarCwd(spec.cwd, remote.farCwd!) : undefined;
			const cwd = remote ? (farCwd === remote.farCwd ? ctx.cwd : placeholderDir(getAgentDir(), remote.target, farCwd!)) : resolvePath(spec.cwd ?? ctx.cwd, ctx.cwd);
			if (remote && cwd !== ctx.cwd) fs.mkdirSync(cwd, { recursive: true });
			let cwdStat: fs.Stats;
			try { cwdStat = fs.statSync(cwd); }
			catch (error) { throw new Error(`Cannot access working directory ${cwd}: ${(error as Error).message}`); }
			if (!cwdStat.isDirectory()) throw new Error(`Not a directory: ${cwd}`);
			if (sandbox) {
				// Fail closed: an on state that cannot vouch for this worker refuses it.
				const refusal = sandbox.checkWorker ? sandbox.checkWorker({ cwd, backend: backendId }) : "This session's sandbox is on but gave no worker check; a worker cannot start sandboxed.";
				if (refusal) throw new Error(refusal);
			}
			// What a remote session's worker carries: pi loads the remote extension with the flag;
			// claude launches the `remote` MCP server, loses every built-in tool (`--tools ""`) and is
			// told so in its system prompt.
			const flags = remote ? { target: remote.target, ...(remote.channelOff ? { "no-channel": true as const } : {}) } : undefined;
			const remoteMcp = remote
				? {
					command: process.execPath,
					args: [REMOTE_MCP],
					env: { [REMOTE_MCP_ENV]: encodeRemoteMcpIdentity({ version: 1, target: remote.target, farCwd: farCwd!, agentDir: getAgentDir(), ...(remote.label ? { label: remote.label } : {}), ...(remote.channelOff ? { channel: false } : {}) }) },
				}
				: undefined;
			const remoteInstructions = remote ? remoteWorkerInstructions({ target: remote.target, farCwd: farCwd!, ...(remote.label ? { label: remote.label } : {}) }) : undefined;
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
				let prepared = backend.prepare?.({ ...spec, cwd }, ctx) ?? {};
				if (sandbox) {
					// The CLI's own sandbox, as the extension computed it; never bypassPermissions, and no
					// host prompt that could approve past the rules.
					if (backendId !== "claude-code") throw new Error(`Backend ${backendId} cannot run workers while this session's sandbox is on.`);
					if (sandbox.claudeRefusal) throw new Error(sandbox.claudeRefusal);
					if (!sandbox.claudeSettingsJson || !sandbox.claudePermissionMode) throw new Error("This session's sandbox is on but gave no Claude Code settings; a Claude Code worker cannot start sandboxed.");
					const confined = { settingsJson: sandbox.claudeSettingsJson, permissionMode: sandbox.claudePermissionMode, onPermission: undefined };
					prepared = { ...prepared, ...confined };
				}
				if (remote) {
					if (backendId !== "claude-code") throw new Error(`Backend ${backendId} cannot run workers of a remote session (only pi and claude-code have remote tooling).`);
					prepared = {
						...prepared,
						tools: [],
						systemPrompt: [prepared.systemPrompt ?? spec.systemPrompt, remoteInstructions].filter(Boolean).join("\n\n"),
						env: { MCP_TOOL_TIMEOUT: String(REMOTE_MCP_TOOL_TIMEOUT_MS) },
					};
				}
				return { spec, cwd, model: spec.model, tools: remote ? [] : spec.tools, systemPrompt: spec.systemPrompt,
					extensions: undefined, forkSession: undefined, backend, prepared, flags: undefined, remoteMcp };
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
			const own = request.team
				? [MEMBER_EXTENSION]
				: spec.extensions?.map((source) => resolveExtensionSource(source, ctx.cwd));
			// A claude-code-cli model: the provider's extension and switch, after the session's own
			// (remote sessions get both; the flags merge into the same argv).
			// A parent whose sandbox is on starts the worker under it, with the extension's own flags
			// (`--sandbox on`, which a worker cannot turn off, and the parent's scope); a spec that
			// names the extension itself does not load it twice.
			const sources = [MARKER_EXTENSION, ...(remote ? [REMOTE_EXTENSION] : []), ...(own ?? [])];
			if (sandbox && !sandbox.workerFlags) throw new Error("This session's sandbox is on but gave no worker flags; a worker cannot start sandboxed.");
			const { extensions, flags: piFlags } = sandbox
				? claudeCodeProviderLoad(model, [...sources.filter((source) => !sameExtension(source, sandbox.extensionPath)), sandbox.extensionPath], { ...flags, ...sandbox.workerFlags })
				: claudeCodeProviderLoad(model, sources, flags);
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
				flags: piFlags,
				remoteMcp: undefined,
			};
		});
		const resuming = request.resume;
		if (resuming && (specs.length !== 1 || total !== 1)) throw new Error("A resume starts exactly one worker.");
		const groupId = resuming ? resuming.groupId : `run_${String(++groupCounter).padStart(2, "0")}`;
		// Reserve IDs durably before starting processes. Reload must never reuse an
		// ID still present in the conversation for an unrelated new worker.
		if (!resuming) pi.appendEntry("subagents-counters-v2", { agentCounter: counter + total, groupCounter });
		const label = resuming ? resuming.groupLabel : request.groupLabel ?? `run ${groupCounter} · ${specs[0].name ?? specs[0].agentType ?? "agents"}`;
		const group: AgentGroup = { id: groupId, label, createdAt: Date.now(), agents: [] };
		let committed = false;
		let abandoned = false;
		const launched: string[] = [];
		const earlySettled = new Set<Worker>();
		try {
			for (const [index, { spec, cwd, model, tools, systemPrompt, extensions, forkSession, backend, prepared: backendPrepared, flags, remoteMcp }] of prepared.entries()) {
				for (let i = 0; i < (spec.count ?? 1); i++) {
					const base = spec.name ?? spec.agentType ?? "agent";
					const id = resuming ? resuming.id : `ag_${String(++counter).padStart(2, "0")}`;
					const teamMember = request.team?.members[index];
					// A member's identity and private mailbox exist before its process
					// does. Pi children read the identity from their environment
					// (member.ts); claude-code children get it through the member MCP
					// server's own environment, never the CLI's.
					const env = teamMember ? memberEnv(request.team!, teamMember, id) : undefined;
					const tooling = teamMember ? memberTooling(spec.backend ?? "pi") : "none";
					const name = (spec.count ?? 1) > 1 ? `${base}-${i + 1}` : base;
					// Hosted: the runner's spawnImpl starts a detached host instead of the worker itself.
					const hostedWorker = !resuming && hosting.active();
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
					// A claude worker's servers: the session's `remote` server (remote sessions), and the
					// member's `team` server (team members) — a member of a remote session gets both.
					const mcpServers = {
						...(remoteMcp ? { [REMOTE_MCP_SERVER_NAME]: remoteMcp } : {}),
						...(env && tooling === "mcp" ? { [MCP_SERVER_NAME]: { command: process.execPath, args: [MEMBER_MCP], env } } : {}),
					};
					const runner = (backend?.create ?? createRunner)(
						{
							model,
							effort: spec.effort ?? (backend ? undefined : ctx.thinkingLevel),
							tools,
							systemPrompt,
							extensions,
							forkSession,
							backendOptions: spec.backendOptions,
							...(flags ? { flags } : {}),
							...backendPrepared,
							backend: spec.backend ?? "pi",
							...(env && tooling === "pi" ? { env } : {}),
							...(Object.keys(mcpServers).length ? { mcpServers } : {}),
							...hosted,
							...(resuming ? { resume: { ...(resuming.sessionId ? { sessionId: resuming.sessionId } : {}), ...(resuming.sessionFile ? { sessionFile: resuming.sessionFile } : {}) } } : {}),
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
					// What resume needs to start it again: the raw spec (resolved again against the
					// session's state at resume time, like a spawn), with pi's inherited model written out.
					launches.set(runner, {
						backend: spec.backend ?? "pi",
						...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
						...(model === undefined ? {} : { model }),
						...(spec.effort === undefined ? {} : { effort: spec.effort }),
						...(spec.tools === undefined ? {} : { tools: [...spec.tools] }),
						...(spec.systemPrompt === undefined ? {} : { systemPrompt: spec.systemPrompt }),
						...(spec.agentType === undefined ? {} : { agentType: spec.agentType }),
						...(spec.extensions === undefined ? {} : { extensions: [...spec.extensions] }),
						...(spec.backendOptions === undefined ? {} : { backendOptions: spec.backendOptions }),
						...(teamMember?.orchestrator ? { orchestrator: true } : {}),
					});
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
		const existing = resuming && groups.find((g) => g.id === group.id);
		if (existing) existing.agents.push(...group.agents);
		else groups.push(group);
		agents.push(...group.agents);
		committed = true;
		// Team batches are one worker per member, in member order. Every worker of every
		// backend and transport gets its durable record; a resumed one once it is up.
		if (!resuming) group.agents.forEach((worker, i) => {
			const member = request.team?.members[i];
			registry.track(worker, member && { teamId: request.team!.teamId, role: member.role, ...(member.orchestrator ? { orchestrator: true } : {}) }, launches.get(worker));
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
	// ── Restore and resume ──────────────────────────────────────────────────
	// A worker's process never outlives its manager (a restart, reload or session switch
	// ends it), but its durable record (registry.ts) and its own backend session do. At
	// session_start every recorded worker that is not live comes back as a RestoredWorker:
	// listed, counted, read-only. agent_resume starts it again ON DEMAND, idle, in its own
	// backend session; nothing is ever resumed or continued automatically.
	/** Why a recorded worker cannot be resumed, or undefined. */
	const resumeRefusal = (m: FoldedWorkerManifest): string | undefined => {
		if (adapters.get(m.backend).capabilities().resume !== "native") return `backend ${m.backend} cannot resume workers (its transcript adapter declares resume: none)`;
		if (!m.ref) return "no backend session was recorded for it (it never got that far)";
		if (m.backend !== "pi" && !backends.has(m.backend)) return `backend ${m.backend} is not loaded`;
		return undefined;
	};
	const removeWorker = (a: Worker) => {
		const index = agents.indexOf(a);
		if (index !== -1) agents.splice(index, 1);
		finished.delete(a);
		const group = groups.find((g) => g.id === a.groupId);
		if (group) {
			group.agents = group.agents.filter((w) => w !== a);
			if (!group.agents.length) groups.splice(groups.indexOf(group), 1);
		}
	};
	const idNumber = (id: string) => Number(/^ag_(\d+)$/.exec(id)?.[1] ?? Number.MAX_SAFE_INTEGER);
	/** In ID order, so a worker listed again (branch switch, failed resume) keeps its place. */
	const insertWorker = (a: Worker, label: string) => {
		const ordered = (list: Worker[]) => {
			const at = list.findIndex((w) => idNumber(w.id) > idNumber(a.id));
			if (at === -1) list.push(a); else list.splice(at, 0, a);
		};
		let group = groups.find((g) => g.id === a.groupId);
		if (!group) {
			group = { id: a.groupId, label, createdAt: a.startedAt, agents: [] };
			groups.push(group);
		}
		ordered(group.agents);
		ordered(agents);
	};
	/** List the restored workers recorded on the active branch; the others only count toward the Σ. */
	const applyBranch = (ctx: ExtensionContext) => {
		if (shuttingDown) return;
		const branch = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
		const active = new Set(branch.map((e) => e.id).filter((id): id is string => typeof id === "string"));
		const { manifests } = readWorkerManifests(ctx.sessionManager.getEntries(), { activeEntryIds: active });
		for (const a of [...agents]) if (isRestored(a) && !manifests.get(a.id)?.onActiveBranch) removeWorker(a);
		const listed = [...restoredViews.values()]
			.filter(({ manifest }) => manifests.get(manifest.workerId)?.onActiveBranch && !agents.some((a) => a.id === manifest.workerId))
			.sort((x, y) => idNumber(x.manifest.workerId) - idNumber(y.manifest.workerId));
		for (const { manifest, view } of listed)
			insertWorker(new RestoredWorker(manifest, view, resumeRefusal(manifest)), `${manifest.groupId ?? "run_restored"} · restored`);
		refresh();
	};
	let restoreGeneration = 0;
	/** Rebuild earlier processes' workers from every branch's records and their transcripts. */
	const restoreWorkers = async (ctx: ExtensionContext): Promise<void> => {
		const generation = ++restoreGeneration;
		const { manifests } = readWorkerManifests(ctx.sessionManager.getEntries());
		const pending = [...manifests.values()].filter((m) => !agents.some((a) => a.id === m.workerId));
		// Reads are independent and never throw (viewWorker); the list appears once all are in.
		const views = await Promise.all(pending.map(async (manifest) => ({ manifest, view: await viewWorker(manifest, adapters, { items: "tail", limit: 40 }) })));
		if (shuttingDown || generation !== restoreGeneration) return;
		for (const entry of views) if (!agents.some((a) => a.id === entry.manifest.workerId)) restoredViews.set(entry.manifest.workerId, entry);
		applyBranch(ctx);
	};
	/** How long a resumed worker may take to come up idle (pi startup, Claude initialize). */
	const RESUME_READY_MS = 180_000;
	const resumingIds = new Set<string>();
	/**
	 * agent_resume and /agent-resume: start a recorded worker again in its own backend session,
	 * IDLE — no prompt is sent and no completion is announced; the next steer is its next task.
	 * The parent's CURRENT sandbox and remote state apply, exactly as at spawn (spawnBatch). A
	 * team member's history team becomes live again and gets a fresh mailbox. Resolves once the
	 * worker is waiting; on failure the earlier entry stays and the reason is thrown.
	 */
	const resumeWorker = async (ctx: ExtensionContext, rawId: string, signal?: AbortSignal): Promise<Worker> => {
		const id = rawId.trim();
		if (!/^ag_\d+$/.test(id)) throw new Error(`Resume takes one worker ID (ag_NN); got "${rawId.trim().slice(0, 80)}".`);
		if (resumingIds.has(id)) throw new Error(`${id} is already being resumed.`);
		const current = agents.find((a) => a.id === id);
		if (current && !current.isFinished()) throw new Error(`${id} is live (${current.status}); use agent_steer to give it work.`);
		const manifest = readWorkerManifests(ctx.sessionManager.getEntries()).manifests.get(id);
		if (!manifest) throw new Error(`No record of ${id} in this session; only workers recorded in this session file can be resumed.`);
		const refusal = resumeRefusal(manifest);
		if (refusal) throw new Error(`Cannot resume ${id}: ${refusal}.`);
		const launch = (manifest.launch ?? {}) as Partial<WorkerLaunchSpec>;
		const pick = <T,>(value: T | undefined, key: string) => (value === undefined ? {} : { [key]: value });
		const spec = {
			// The worker's own session holds its history; the task is only its label here.
			prompt: manifest.spec?.taskPreview?.trim() || `(resumed ${id})`,
			name: manifest.name ?? manifest.team?.role ?? id,
			...(manifest.backend === "pi" ? {} : { backend: manifest.backend }),
			...pick(launch.model ?? manifest.spec?.model, "model"),
			...pick(launch.effort ?? manifest.spec?.effort, "effort"),
			...pick(launch.tools ?? manifest.spec?.tools, "tools"),
			...pick(launch.systemPrompt, "systemPrompt"),
			...pick(launch.agentType, "agentType"),
			...pick(launch.cwd ?? manifest.spec?.cwd, "cwd"),
			wake: manifest.spec?.wake ?? true,
			...pick(launch.extensions, "extensions"),
			...pick(launch.backendOptions, "backendOptions"),
		} as Spec;
		const ref = manifest.ref!;
		const identity = ref.kind === "pi-session-file"
			? { sessionFile: ref.locator, ...(ref.sessionId ? { sessionId: ref.sessionId } : {}) }
			: { sessionId: ref.locator };
		// Team membership: its history team becomes live again (as when a hosted member is re-adopted).
		let team: BatchRequest["team"];
		if (manifest.team && teams.adoptHistoryTeam(manifest.team.teamId)) {
			const teamName = teamViews().find((t) => t.id === manifest.team!.teamId)?.name ?? manifest.team.teamId;
			team = { teamId: manifest.team.teamId, teamName, members: [{ role: manifest.team.role, orchestrator: manifest.team.orchestrator === true || launch.orchestrator === true }] };
			ensureMailbox();
		}
		// What it spent before: its listed entry's lifetime, or its off-branch view. An evicted
		// worker's usage is already in evictedUsage, so it carries no base.
		const view = restoredViews.get(id);
		const base = current
			? lifetimeUsage(current)
			: view ? { input: view.view.usage.input, output: view.view.usage.output, cacheRead: view.view.usage.cacheRead, cacheWrite: view.view.usage.cacheWrite, cost: view.view.usage.cost ?? 0, turns: view.view.usage.turns ?? 0 } : undefined;
		const groupLabel = current ? (groups.find((g) => g.id === current.groupId)?.label ?? `${current.groupId} · resumed`) : `${manifest.groupId ?? "run_restored"} · resumed`;
		resumingIds.add(id);
		// Never two entries with one ID (the live record refuses duplicate IDs): the earlier one
		// steps aside while the new process starts, and comes back if it fails.
		if (current) removeWorker(current);
		let worker: Worker | undefined;
		try {
			const group = await spawnBatch(ctx, {
				specs: [spec], team,
				resume: { id, groupId: manifest.groupId ?? current?.groupId ?? "run_restored", groupLabel, ...identity },
			}, signal);
			worker = group.agents[0];
			if (base) usageBase.set(worker, base);
			// The label it ran under (e.g. claude-haiku-4-5-…, not the spawn alias "haiku") until the
			// runner reports its own model: a Claude worker's first init comes with its next turn.
			// A listed entry already carries it (resolved at restore, or reported by its last runner).
			const model = current?.model ?? resolvedModel(manifest, view?.view);
			if (model) worker.model = model;
			const deadline = Date.now() + RESUME_READY_MS;
			while (worker.status !== "waiting" && !worker.isFinished() && Date.now() < deadline) {
				if (signal?.aborted) throw new Error(`Stopped waiting for ${id}; it is still starting (inspect with agent_list).`);
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			if (worker.status !== "waiting") {
				const reason = worker.error ?? (worker.isFinished() ? `it ended (${worker.status})` : `not ready within ${RESUME_READY_MS / 1000}s`);
				const failed = worker;
				worker = undefined;
				removeWorker(failed);
				if (!failed.isFinished()) void failed.kill("resume did not come up");
				throw new Error(`Could not resume ${id}: ${reason}`);
			}
			registry.resumed(worker);
			restoredViews.delete(id);
			return worker;
		} catch (error) {
			if (!worker && current && !agents.some((a) => a.id === id)) insertWorker(current, groupLabel);
			throw error;
		} finally {
			resumingIds.delete(id);
			refresh();
		}
	};
	const resumedText = (a: Worker) =>
		`Resumed ${a.id} (${a.name}) idle in its own ${a.backend ?? "pi"} session ${a.sessionFile ?? a.sessionId ?? ""}; nothing was sent to it. Give it work with agent_steer.`;
	pi.registerTool({
		name: "agent_resume",
		label: "Resume Subagent",
		description:
			"Bring back a worker listed as restored (its process ended with an earlier server, reload or session) by starting it again in its OWN backend session: pi reopens its session file, Claude resumes its session. It comes back idle (waiting) with its history; nothing is sent to it and no completion is reported, so use agent_steer to give it work. The session's current sandbox and remote state apply, as at spawn; a team member rejoins its team. Refused for a live worker, an unknown ID, or a backend that cannot resume.",
		promptSnippet: "Resume a restored subagent idle in its own session",
		parameters: Type.Object({ id: Type.String({ pattern: "^ag_\\d+$", description: "Exact worker ID (ag_NN)." }) }, { additionalProperties: false }),
		async execute(_id, params, signal, _update, ctx) {
			context(ctx);
			const a = await resumeWorker(ctx, params.id, signal);
			return result(resumedText(a), { id: a.id, backend: a.backend ?? "pi", status: a.status, sessionFile: a.sessionFile, sessionId: a.sessionId });
		},
	});
	// The same operation for Sova's Resume Worker button (POST /api/workers/resume calls this
	// handler directly): args "<ag_NN>"; resolves once the worker is idle, throws the reason.
	pi.registerCommand("agent-resume", {
		description: "Resume a restored subagent idle in its own session: /agent-resume ag_NN",
		handler: async (args: string, ctx: ExtensionContext) => {
			context(ctx);
			const a = await resumeWorker(ctx, args);
			if (ctx.hasUI) {
				try { ctx.ui.notify(resumedText(a), "info"); } catch { /* The UI may be gone. */ }
			}
		},
	});
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
			"Tell a worker whose report may run past about 3,500 characters to write it to a file and end with that file's path plus a short summary; the completion message quotes only the first 4,000 characters.",
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
					remoteNotice(ctx),
					...group.agents.map(
						(a) =>
							`${a.id}  ${a.name}  ${a.status}  backend=${a.backend ?? "pi"}  model=${a.model ?? "child default"}  effort=${a.effort ?? "default"}${a.forked ? "  forked" : ""}${listedExtensions(a).length ? `  extensions=${listedExtensions(a).join(",")}` : ""}${a.wake ? "" : "  wake=false"}`,
					),
					"You are not blocked. Inspect with agent_list/agent_transcript; /agents opens the monitor.",
					group.agents.some((a) => a.wake)
						? "Workers with wake (the default) start a turn for you when they settle while you are idle, so you can simply end this turn."
						: "wake=false: results arrive with your next turn; use agent_wait if you need them sooner.",
				].filter(Boolean).join("\n"),
				{ groupId, label, spawned: group.agents.map((a) => ({ id: a.id, name: a.name, backend: a.backend ?? "pi", model: a.model })) },
			);
		},
	});

	const listUsage = (a: Worker) => {
		if (isRestored(a) && a.usageSource === "none") return "usage unavailable";
		const u = lifetimeUsage(a);
		const asOf = isRestored(a) && a.usageAsOf ? ` (as of ${new Date(a.usageAsOf).toISOString().slice(11, 16)} UTC)` : "";
		return `${u.turns} turns · ↑${Math.round(u.input)} ↓${Math.round(u.output)}${asOf}`;
	};
	const restoredNote = (a: Worker) => {
		if (!isRestored(a)) return "";
		const refusal = resumeRefusal(a.manifest);
		return ` · restored after a restart${a.interruptedAt ? ", interrupted mid-task" : ""}; ${refusal ? `cannot resume: ${refusal}` : "agent_resume brings it back idle"}`;
	};
	pi.registerTool({
		name: "agent_list",
		label: "List Subagents",
		description:
			"List subagents grouped by run, with status, model and usage. Output capped at 47,000 bytes/2000 lines with full snapshot path.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _update, ctx) {
			context(ctx);
			return result(
				[retentionNotice(), remoteNotice(ctx), groups.length
					? groups
							.map((g) =>
								[
									`${g.id} — ${g.label}`,
									...g.agents.map(
										(a) =>
											`  ${a.id} ${a.name} [${a.backend ?? "pi"}] ${a.status}${a.taskOutcome ? `/${a.taskOutcome}` : ""} ${a.model ?? "child default"} · ${listUsage(a)}${a.error ? ` · error: ${a.error}` : ""}${restoredNote(a)}`,
									),
								].join("\n"),
							)
							.join("\n\n") +
							"\n\nwaiting = idle and steerable (check task outcome); stopping = terminating; done/killed = process ended; error = failure (cleanup may still be in progress); restored = no process since a restart (agent_resume)."
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
						// Lifetime: a resumed worker's earlier processes included.
						usage: { ...a.usage, ...lifetimeUsage(a) },
						...(isRestored(a) ? { restored: true, usageSource: a.usageSource, resumable: resumeRefusal(a.manifest) === undefined, ...(a.interruptedAt ? { interruptedAt: a.interruptedAt } : {}) } : {}),
					})),
				},
			);
		},
	});
	pi.registerTool({
		name: "agent_transcript",
		label: "Read Subagent",
		description:
			`Read current-task output, or retained in-memory transcript with full=true (not necessarily complete history). The current task's final answer is returned whole, in pages of up to ${FINAL_ANSWER_PAGE_CHARS} chars: a longer answer carries a header with its total size, this page's range and the next offset to pass. offset/limit (chars) select a page. While a worker is still working, returns bounded recent tool activity instead of a final answer. full=true puts any snapshot path first and the final answer (when it fits) before the retained items; every result stays under ${TOOL_TEXT_MAX_CHARS} chars. sessionFile identifies canonical history when available; otherwise sessionId identifies the backend session.`,
		parameters: Type.Object({
			id: Nonempty,
			full: Type.Optional(Type.Boolean()),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset into the current task's final answer (default 0). Ignored with full=true." })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: FINAL_ANSWER_PAGE_CHARS, description: `Characters of the final answer to return (default and maximum ${FINAL_ANSWER_PAGE_CHARS}). Ignored with full=true.` })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			context(ctx);
			const a = findAgent(params.id);
			const answer = a.finalOutput();
			const details = {
				id: a.id,
				backend: a.backend ?? "pi",
				status: a.status,
				taskOutcome: a.taskOutcome,
				error: a.error,
				sessionFile: a.sessionFile,
				sessionId: a.sessionId,
				transcriptOmitted: a.transcriptOmitted ? { ...a.transcriptOmitted } : undefined,
				usage: { ...a.usage },
			};
			if (params.full) {
				const header = `${a.id} (${a.name}) — ${a.status}\nSession: ${a.sessionFile ?? a.sessionId ?? "unavailable"}${a.transcriptOmitted?.items ? `\n[Retained transcript: ${a.transcriptOmitted.items} earlier item(s) omitted, approximately ${a.transcriptOmitted.approxBytes} bytes.]` : ""}`;
				const items = a.transcript.map((t) => `[${t.kind}${t.toolName ? `:${t.toolName}` : ""}] ${t.text}`).join("\n");
				return toolResult(fullTranscriptText(a.id, header, answer, items), { ...details, finalAnswerChars: answer.length, retention: retention() }, true);
			}
			// No answer yet: the bounded summary (recent activity or the no-output line).
			if (!answer) return result(summary(a), details);
			const { text, page } = finalAnswerPage(a.id, summaryHeader(a), answer, params.offset, params.limit, params.offset !== undefined || params.limit !== undefined);
			return toolResult(text, { ...details, finalAnswer: page, retention: retention() }, true);
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
			"Wait for current tasks, not child process exits. Failed tasks also settle; inspect each error. Timeout/cancellation does not stop workers. Output capped at 47,000 bytes/2000 lines with full snapshot path.",
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
		"Members are session-scoped: reload, session switch or quit stops them; agent_resume brings one back idle, rejoining its team.",
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
			"List teams with each member's role (orchestrators marked), declared ownership, exact worker ID and actual status, plus recent control actions including member messages, orchestrator steers and operator questions (requested, accepted-or-queued, failed, unknown; never proof of execution). Pruned members and teams from earlier sessions are shown as unavailable with a reason. Output capped at 47,000 bytes/2000 lines with full snapshot path.",
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
					if (agents.some((a) => a.id === meta.id && !isRestored(a))) continue;
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
					// Its host kept it running: the live worker replaces its restored entry (its
					// replayed log carries all its usage, so the restored view leaves the Σ).
					for (const ghost of agents.filter((a) => a.id === meta.id && isRestored(a))) removeWorker(ghost);
					restoredViews.delete(meta.id);
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
		// Asynchronous (transcript reads): earlier processes' workers appear once read.
		void restoreWorkers(ctx).catch(() => { /* Best effort: the records stay for the next start. */ });
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
		// Restored workers follow the branch like history does; the Σ does not.
		applyBranch(ctx);
	});
	pi.on("session_shutdown", async () => {
		// Read at dispose time: the embedding process sets it only when it is going away.
		const detach = detachRequested();
		shuttingDown = true;
		unregisterWorkersListener?.();
		unregisterAdoptListener?.();
		publishWorkers();
		unregisterBackendListener?.();
		unregisterRemoteListener?.();
		unregisterSandboxListener?.();
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
		restoredViews.clear();
		restoreGeneration++;
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
