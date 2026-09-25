/**
 * Pure team state: declared roles/ownership over exact worker IDs, bounded action
 * history, prompt headers and session-entry encoding. No process or UI dependency;
 * the manager in index.ts owns all worker creation and control.
 */
import { MCP_SERVER_NAME } from "./member-mcp.ts";
import type { AgentStatus, TaskOutcome } from "./runner.ts";

export const TEAM_ENTRY_TYPE = "subagents-team-v1";
export const MAX_SESSION_TEAMS = 16;
export const MAX_HISTORY_TEAMS = 16;
export const MAX_TEAM_MEMBERS = 24;
export const MAX_TEAM_ACTIONS = 50;
export const MAX_LABEL_CHARS = 64;
export const MAX_OBJECTIVE_CHARS = 4000;
export const MAX_OWNED_PATHS = 32;
export const MAX_PATH_CHARS = 512;
const ACTION_PREVIEW_CHARS = 200;
const ERROR_CHARS = 500;
const TEAM_ID = /^team_(\d+)$/;
const WORKER_ID = /^ag_\d+$/;
const RUN_ID = /^run_\d+$/;
// C0/C1 controls would corrupt single-line UI rows and the prompt header.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CONTROL_EXCEPT_NEWLINE_TAB = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

export interface TeamDefaults {
	backend?: string;
	model?: string;
	effort?: string;
	backendOptions?: Record<string, unknown>;
}
/** One member as accepted by team_create/team_add (one role, no count/fork/extensions/agentType). */
export interface TeamMemberInput {
	role: string;
	prompt: string;
	ownedPaths?: string[];
	/** Coordinates its siblings with team_roster/team_steer; pi backend only. Never spawns. */
	orchestrator?: boolean;
	backend?: string;
	model?: string;
	effort?: string;
	tools?: string[];
	systemPrompt?: string;
	cwd?: string;
	wake?: boolean;
	backendOptions?: Record<string, unknown>;
}
/** A spawn spec for the shared manager path; `prompt` already carries the team header. */
export interface ComposedMemberSpec {
	name: string;
	prompt: string;
	backend: string;
	model?: string;
	effort?: string;
	tools?: string[];
	systemPrompt?: string;
	cwd?: string;
	wake?: boolean;
	backendOptions?: Record<string, unknown>;
}
export interface PersistedMember {
	workerId: string;
	role: string;
	ownedPaths: string[];
	orchestrator?: boolean;
	backend: string;
	model?: string;
	groupId: string;
	addedAt: number;
}
export type TeamEntryData =
	| { version: 1; op: "create"; team: { id: string; name: string; objective: string; createdAt: number }; members: PersistedMember[] }
	| { version: 1; op: "add"; teamId: string; members: PersistedMember[] }
	/** The member no longer holds a seat; its role stays reserved. */
	| { version: 1; op: "eject"; teamId: string; workerId: string; at: number };

/** Last state observed before retention removed the worker from the manager. */
export interface MemberSnapshot {
	status: AgentStatus;
	taskOutcome?: TaskOutcome;
	error?: string;
}
interface MemberRecord extends PersistedMember {
	last?: MemberSnapshot;
	/** Released its seat (team_eject or a system eject). Never cleared. */
	ejectedAt?: number;
}
export type TeamOrigin = "session" | "history";
interface TeamRecord {
	id: string;
	name: string;
	objective: string;
	createdAt: number;
	origin: TeamOrigin;
	/** Create-time defaults, applied again by team_add. In memory only. */
	defaults?: TeamDefaults;
	members: MemberRecord[];
	actions: TeamAction[];
}

/** Human/parent-origin control requests. States never claim delivery or execution. */
export type TeamActionState = "requested" | "accepted-or-queued" | "failed" | "unknown";
export type TeamActionKind = "followUp" | "redirect" | "steer" | "stop" | "message" | "question" | "eject";
/** member = a sibling's team_msg/team_ask; orchestrator = a sibling orchestrator's team_steer. */
export type TeamActionSource = "parent" | "user" | "member" | "orchestrator";
export interface TeamAction {
	seq: number;
	at: number;
	workerId: string;
	role: string;
	kind: TeamActionKind;
	source: TeamActionSource;
	state: TeamActionState;
	reason?: string;
	preview?: string;
}

/** What the manager can currently observe for a retained worker. */
export interface WorkerObservation {
	status: AgentStatus;
	taskOutcome?: TaskOutcome;
	error?: string;
	processAlive: boolean;
	settled: boolean;
	finished: boolean;
	model?: string;
}
export type MemberState = "working" | "idle" | "failed" | "done" | "stopping" | "stopped" | "unavailable";
export type MemberAvailability = "retained" | "pruned" | "previous-session";
export interface TeamMemberView {
	workerId: string;
	role: string;
	ownedPaths: readonly string[];
	orchestrator: boolean;
	backend: string;
	model?: string;
	groupId: string;
	addedAt: number;
	/** True only for a worker the manager still retains in this session. */
	available: boolean;
	availability: MemberAvailability;
	reason?: string;
	state: MemberState;
	/** Live status when retained; last known status when pruned; absent for previous sessions. */
	status?: AgentStatus;
	taskOutcome?: TaskOutcome;
	error?: string;
	processAlive?: boolean;
	/** When the member released its seat; it is then left out of `counts`. */
	ejectedAt?: number;
}
export interface TeamView {
	id: string;
	name: string;
	objective: string;
	createdAt: number;
	origin: TeamOrigin;
	members: TeamMemberView[];
	actions: TeamAction[];
	/** Seated members by state; ejected members are counted only in `ejected`. */
	counts: Record<MemberState, number>;
	ejected: number;
}

export const PRUNED_REASON = "Removed from the manager by finished-worker retention; last known status shown.";
export const HISTORY_REASON = "Recorded in an earlier session or before reload; its workers were stopped. agent_resume brings a member back idle, which makes the team live again.";

/** Display/comparison normalization for names and roles: trimmed, internal whitespace collapsed. */
export function normalizeLabel(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}
const labelKey = (value: string) => normalizeLabel(value).toLowerCase();

function checkLabel(kind: string, value: unknown): string {
	if (typeof value !== "string") throw new Error(`Team ${kind} must be a string.`);
	const label = normalizeLabel(value);
	if (!label) throw new Error(`Team ${kind} must not be blank.`);
	if (label.length > MAX_LABEL_CHARS) throw new Error(`Team ${kind} "${label.slice(0, 20)}…" exceeds ${MAX_LABEL_CHARS} characters.`);
	if (CONTROL.test(label)) throw new Error(`Team ${kind} must be a single line without control characters.`);
	return label;
}

function checkObjective(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) throw new Error("Team objective must not be blank.");
	const objective = value.trim();
	if (objective.length > MAX_OBJECTIVE_CHARS) throw new Error(`Team objective exceeds ${MAX_OBJECTIVE_CHARS} characters; put detail in a file and reference it.`);
	if (CONTROL_EXCEPT_NEWLINE_TAB.test(objective)) throw new Error("Team objective must not contain control characters.");
	return objective;
}

function checkPaths(role: string, paths: unknown): string[] {
	if (paths === undefined) return [];
	if (!Array.isArray(paths)) throw new Error(`ownedPaths for ${role} must be an array.`);
	if (paths.length > MAX_OWNED_PATHS) throw new Error(`ownedPaths for ${role} exceeds ${MAX_OWNED_PATHS} entries.`);
	const out: string[] = [];
	for (const raw of paths) {
		if (typeof raw !== "string" || !raw.trim()) throw new Error(`ownedPaths for ${role} must not contain blank entries.`);
		const p = raw.trim();
		if (p.length > MAX_PATH_CHARS || CONTROL.test(p)) throw new Error(`ownedPaths entry for ${role} must be one line of at most ${MAX_PATH_CHARS} characters.`);
		if (!out.includes(p)) out.push(p);
	}
	return out;
}

const ownership = (paths: readonly string[]) => (paths.length ? paths.join(", ") : "none declared");
/**
 * Which member tools the worker will actually have: pi members load member.ts;
 * claude-code members get the same tools from the member MCP server (member-mcp.ts,
 * seen as mcp__team__<tool>); any other backend loads nothing.
 */
export type MemberTooling = "pi" | "mcp" | "none";
export const memberTooling = (backend: string): MemberTooling => (backend === "pi" ? "pi" : backend === "claude-code" ? "mcp" : "none");
export interface HeaderMember { role: string; ownedPaths: readonly string[]; orchestrator?: boolean }

const OWNERSHIP_LINE =
	"Declared ownership is advisory coordination, not a lock: all members share one filesystem, so avoid editing paths another member owns unless your task says to.";
const COMMON_TOOLS =
	"team_msg sends a message to a teammate by role or worker ID (or \"all\"); the parent session delivers it into their session, so they see it at their next step or wake up if idle. team_inbox re-reads what was delivered to you. team_ask sends a question to the operator (the parent session and its user); the answer arrives later as a new message in your session, so keep working on what does not depend on it or end your turn.";
/** A long final answer is cut in the parent's completion message and in a Claude parent's history; a file survives both. */
export const LONG_REPORT_LINE =
	"If your final answer would run past about 3,500 characters, write the full report to a file and make your final message that file's path plus a short summary.";
const NO_SPAWN = "You cannot spawn, add or stop workers, and nothing you do reaches outside this team; the parent session remains the authority.";
const mcpName = (tool: string) => `mcp__${MCP_SERVER_NAME}__${tool}`;
/** Claude sees MCP tools under the server prefix; the header spells out the exact call names once. */
const mcpNamesLine = (orchestrator: boolean) =>
	`Your team tools come from the "${MCP_SERVER_NAME}" MCP server, so call them as ${[...(orchestrator ? ["team_roster", "team_steer"] : []), "team_msg", "team_inbox", "team_ask"].map(mcpName).join(", ")}; below they are named without the mcp__${MCP_SERVER_NAME}__ prefix.`;
function coordinationLines(member: HeaderMember, tooling: MemberTooling): string[] {
	if (tooling === "none") {
		return [
			"Messages from teammates, an orchestrator or the parent session can arrive as new instructions in your session. You have no tool to reply to teammates directly, so put anything meant for them in your final answer; the parent session coordinates, and your final answer is your report.",
		];
	}
	const prefix = tooling === "mcp" ? [mcpNamesLine(member.orchestrator === true)] : [];
	if (member.orchestrator) {
		return [
			...prefix,
			`You are this team's orchestrator: coordinate your teammates toward the objective. team_roster shows their live state and ownership; team_steer sends instructions to one teammate by role (mode followUp queues after their current task, redirect replaces it). ${COMMON_TOOLS}`,
			`${NO_SPAWN} Acceptance of a steer or message is not execution: verify with team_roster. Your final answer is your report of the team's outcome.`,
		];
	}
	return [
		...prefix,
		`Team tools: ${COMMON_TOOLS}`,
		`${NO_SPAWN} Your final answer is your report.`,
	];
}

/**
 * Deterministic header prepended to each member's task before backend validation, so
 * length limits apply to exactly what the worker receives. Existing workers are
 * never told about later additions. `tooling` states what the worker will really
 * have: pi members load member.ts, claude-code members the member MCP server.
 */
export function composeMemberPrompt(
	team: { id: string; name: string; objective: string },
	member: HeaderMember,
	others: readonly HeaderMember[],
	task: string,
	joining: "creation" | "addition",
	tooling: MemberTooling = "none",
): string {
	return [
		"[Team assignment from the parent Pi session]",
		`Team: ${team.name} (${team.id})`,
		`Objective: ${team.objective}`,
		`Your role: ${member.role}${member.orchestrator ? " (orchestrator)" : ""}`,
		`Your declared ownership: ${ownership(member.ownedPaths)}`,
		`Other members ${joining === "creation" ? "at team creation" : "when you joined"}:`,
		...(others.length ? others.map((o) => `- ${o.role}${o.orchestrator ? " (orchestrator)" : ""}: ${ownership(o.ownedPaths)}`) : ["- none"]),
		OWNERSHIP_LINE,
		...coordinationLines(member, tooling),
		LONG_REPORT_LINE,
		"",
		"[Your task]",
		task,
	].join("\n");
}

/** Backend a member will run on, before spec resolution: member field, then team defaults, then pi. */
export const memberBackend = (member: { backend?: string }, defaults: TeamDefaults | undefined): string => member.backend ?? defaults?.backend ?? "pi";

/** Defaults apply only to members whose resolved backend matches the defaults' backend. */
export function resolveMemberSpec(member: TeamMemberInput, role: string, prompt: string, defaults: TeamDefaults | undefined): ComposedMemberSpec {
	const defaultBackend = defaults?.backend ?? "pi";
	const backend = member.backend ?? defaultBackend;
	const inherit = defaults && backend === defaultBackend ? defaults : undefined;
	const backendOptions = inherit?.backendOptions || member.backendOptions
		? { ...inherit?.backendOptions, ...member.backendOptions }
		: undefined;
	const spec: ComposedMemberSpec = { name: role, prompt, backend };
	const model = member.model ?? inherit?.model;
	const effort = member.effort ?? inherit?.effort;
	if (model !== undefined) spec.model = model;
	if (effort !== undefined) spec.effort = effort;
	if (backendOptions !== undefined) spec.backendOptions = backendOptions;
	if (member.tools !== undefined) spec.tools = member.tools;
	if (member.systemPrompt !== undefined) spec.systemPrompt = member.systemPrompt;
	if (member.cwd !== undefined) spec.cwd = member.cwd;
	if (member.wake !== undefined) spec.wake = member.wake;
	return spec;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeMember(value: unknown): PersistedMember | undefined {
	if (!isRecord(value)) return undefined;
	const { workerId, role, ownedPaths, backend, model, groupId, addedAt, orchestrator } = value;
	if (orchestrator !== undefined && typeof orchestrator !== "boolean") return undefined;
	if (typeof workerId !== "string" || !WORKER_ID.test(workerId)) return undefined;
	if (typeof groupId !== "string" || !RUN_ID.test(groupId)) return undefined;
	if (typeof backend !== "string" || !backend || backend.length > MAX_LABEL_CHARS || CONTROL.test(backend)) return undefined;
	if (model !== undefined && (typeof model !== "string" || model.length > 200 || CONTROL.test(model))) return undefined;
	if (typeof addedAt !== "number" || !Number.isFinite(addedAt)) return undefined;
	try {
		return {
			workerId, role: checkLabel("role", role), ownedPaths: checkPaths("member", ownedPaths), backend,
			...(model === undefined ? {} : { model }), groupId, addedAt, ...(orchestrator ? { orchestrator: true } : {}),
		};
	} catch {
		return undefined;
	}
}

/** Strict decoder for persisted entries; anything malformed is ignored, never partially adopted. */
export function decodeTeamEntry(data: unknown): TeamEntryData | undefined {
	if (!isRecord(data) || data.version !== 1) return undefined;
	if (data.op === "eject") {
		const { teamId, workerId, at } = data;
		if (typeof teamId !== "string" || !TEAM_ID.test(teamId) || typeof workerId !== "string" || !WORKER_ID.test(workerId)) return undefined;
		if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
		return { version: 1, op: "eject", teamId, workerId, at };
	}
	if (!Array.isArray(data.members)) return undefined;
	if (data.members.length > MAX_TEAM_MEMBERS) return undefined;
	const members = data.members.map(decodeMember);
	if (members.some((m) => !m)) return undefined;
	const valid = members as PersistedMember[];
	if (new Set(valid.map((m) => labelKey(m.role))).size !== valid.length) return undefined;
	if (data.op === "create" && isRecord(data.team)) {
		const { id, name, objective, createdAt } = data.team;
		if (typeof id !== "string" || !TEAM_ID.test(id) || typeof createdAt !== "number" || !Number.isFinite(createdAt)) return undefined;
		try {
			return { version: 1, op: "create", team: { id, name: checkLabel("name", name), objective: checkObjective(objective), createdAt }, members: valid };
		} catch {
			return undefined;
		}
	}
	if (data.op === "add" && typeof data.teamId === "string" && TEAM_ID.test(data.teamId)) {
		return { version: 1, op: "add", teamId: data.teamId, members: valid };
	}
	return undefined;
}

interface EntryLike { type?: unknown; customType?: unknown; data?: unknown }
const teamEntries = (entries: readonly unknown[]) =>
	entries.flatMap((entry) => {
		const e = entry as EntryLike | null;
		if (!e || e.type !== "custom" || e.customType !== TEAM_ENTRY_TYPE) return [];
		const decoded = decodeTeamEntry(e.data);
		return decoded ? [decoded] : [];
	});

/** Members holding a seat: everyone recorded except ejected members. */
const seated = (team: { members: readonly MemberRecord[] }) => team.members.filter((m) => m.ejectedAt === undefined).length;
/** UTC second precision, for tool text the model reads. */
export const ejectedStamp = (at: number) => new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
const historyRefusal = (team: { id: string; name: string }) =>
	`Team ${team.id} (${team.name}) is history from an earlier session; its workers are gone. Create a new team with team_create.`;
/** States in which a member still occupies its worker; team_eject refuses these. */
const BUSY_STATES: ReadonlySet<MemberState> = new Set(["working", "idle", "stopping"]);

function emptyCounts(): Record<MemberState, number> {
	return { working: 0, idle: 0, failed: 0, done: 0, stopping: 0, stopped: 0, unavailable: 0 };
}

export function memberState(observed: WorkerObservation | undefined): MemberState {
	if (!observed) return "unavailable";
	// Rebuilt after a restart, no process: not a member anyone can reach until agent_resume.
	if (observed.status === "restored") return "unavailable";
	if (observed.status === "killed") return "stopped";
	if (observed.status === "stopping") return "stopping";
	if (!observed.settled && !observed.finished) return "working";
	if (observed.status === "error" || observed.taskOutcome === "error" || observed.taskOutcome === "aborted" || observed.error) return "failed";
	return observed.status === "waiting" ? "idle" : "done";
}

export interface PreparedCreate {
	teamId: string;
	name: string;
	objective: string;
	defaults?: TeamDefaults;
	members: PreparedMember[];
	release(): void;
}
export interface PreparedAdd {
	teamId: string;
	name: string;
	members: PreparedMember[];
	release(): void;
}
export interface PreparedMember { role: string; ownedPaths: string[]; orchestrator: boolean; spec: ComposedMemberSpec }
/** A session team member as the parent needs it for mediation: who they are and who their siblings are. */
export interface MemberInfo {
	team: { id: string; name: string };
	member: PersistedMember;
	siblings: PersistedMember[];
}

/**
 * Bounded team registry. Session teams reference workers created in this extension
 * instance; history teams come only from the active branch and are never matched to
 * live workers. Reservations cover the async gap between validation and commit.
 */
export class TeamStore {
	private session: TeamRecord[] = [];
	private history: TeamRecord[] = [];
	private counter = 0;
	private actionSeq = 0;
	private pendingNames = new Set<string>();
	private pendingRoles = new Map<string, Set<string>>();
	private pendingTeams = 0;

	get teamCounter(): number { return this.counter; }

	/** Reserve IDs from every entry in the session, including abandoned branches. */
	reserveCounter(entries: readonly unknown[]): void {
		for (const entry of teamEntries(entries)) {
			const match = TEAM_ID.exec(entry.op === "create" ? entry.team.id : entry.teamId);
			if (match) this.counter = Math.max(this.counter, Number(match[1]));
		}
	}

	/** Replace history with teams recorded on the active branch. Session teams are untouched. */
	restoreHistory(branch: readonly unknown[]): void {
		const restored: TeamRecord[] = [];
		const byId = new Map<string, TeamRecord>();
		const liveIds = new Set(this.session.map((t) => t.id));
		for (const entry of teamEntries(branch)) {
			if (entry.op === "create") {
				if (byId.has(entry.team.id) || liveIds.has(entry.team.id)) continue;
				const team: TeamRecord = { ...entry.team, origin: "history", members: [], actions: [] };
				byId.set(team.id, team);
				restored.push(team);
				this.addMembers(team, entry.members);
			} else if (entry.op === "add") {
				const team = byId.get(entry.teamId);
				if (team) this.addMembers(team, entry.members);
			} else {
				const member = byId.get(entry.teamId)?.members.find((m) => m.workerId === entry.workerId);
				if (member && member.ejectedAt === undefined) member.ejectedAt = entry.at;
			}
		}
		this.history = restored.slice(-MAX_HISTORY_TEAMS);
	}

	/**
	 * A history team whose workers were re-adopted from detached hosts is live
	 * again: it moves to the session teams (create-time defaults are not
	 * persisted, so team_add then applies none). True if the team is live now.
	 */
	adoptHistoryTeam(teamId: string): boolean {
		const index = this.history.findIndex((t) => t.id === teamId);
		if (index === -1) return this.session.some((t) => t.id === teamId);
		const [team] = this.history.splice(index, 1);
		team.origin = "session";
		this.session.push(team);
		return true;
	}

	private addMembers(team: TeamRecord, members: readonly PersistedMember[]): void {
		for (const m of members) {
			if (seated(team) >= MAX_TEAM_MEMBERS) return;
			if (team.members.some((x) => x.workerId === m.workerId || labelKey(x.role) === labelKey(m.role))) continue;
			team.members.push({ ...m, ownedPaths: [...m.ownedPaths] });
		}
	}

	private all(): TeamRecord[] { return [...this.history, ...this.session]; }

	/** Exact team IDs win; a `team_NN` reference never falls back to a name. */
	find(ref: string): TeamRecord {
		const exact = this.all().find((t) => t.id === ref);
		if (exact) return exact;
		if (TEAM_ID.test(ref.trim())) throw new Error(`No such team: ${ref}.`);
		const named = this.all().filter((t) => labelKey(t.name) === labelKey(ref));
		if (named.length !== 1) throw new Error(`${named.length ? "Ambiguous" : "No such"} team: ${ref}; use its team ID.`);
		return named[0];
	}

	private checkMembers(members: readonly TeamMemberInput[], taken: Set<string>, defaults: TeamDefaults | undefined): { role: string; ownedPaths: string[]; orchestrator: boolean; input: TeamMemberInput }[] {
		if (!Array.isArray(members) || !members.length) throw new Error("Provide at least one team member.");
		const seen = new Set<string>();
		return members.map((input) => {
			const role = checkLabel("role", input.role);
			if (WORKER_ID.test(role)) throw new Error(`Role ${role} looks like a worker ID; choose a descriptive role.`);
			const key = labelKey(role);
			if (seen.has(key)) throw new Error(`Duplicate role in request: ${role}. Each member needs a unique role.`);
			if (taken.has(key)) throw new Error(`Role ${role} already exists in this team (or is being added concurrently); roles are unique per team.`);
			seen.add(key);
			if (typeof input.prompt !== "string" || !input.prompt.trim()) throw new Error(`Task for ${role} must not be blank.`);
			if (input.orchestrator !== undefined && typeof input.orchestrator !== "boolean") throw new Error(`orchestrator for ${role} must be a boolean.`);
			const orchestrator = input.orchestrator === true;
			if (orchestrator && memberTooling(memberBackend(input, defaults)) === "none")
				throw new Error(`Orchestrator ${role} must use the pi or claude-code backend: team_roster/team_steer are team member tools that a ${memberBackend(input, defaults)} worker cannot load.`);
			return { role, ownedPaths: checkPaths(role, input.ownedPaths), orchestrator, input };
		});
	}

	/** Validate and reserve a new team. Call release() in finally, whether or not it committed. */
	prepareCreate(input: { name: string; objective: string; defaults?: TeamDefaults; members: TeamMemberInput[] }): PreparedCreate {
		const name = checkLabel("name", input.name);
		if (TEAM_ID.test(name)) throw new Error(`Team name ${name} looks like a team ID; choose a descriptive name.`);
		const objective = checkObjective(input.objective);
		const key = labelKey(name);
		if (this.all().some((t) => labelKey(t.name) === key) || this.pendingNames.has(key))
			throw new Error(`A team named ${name} already exists in this session history or is being created; team names are unique.`);
		if (this.session.length + this.pendingTeams >= MAX_SESSION_TEAMS)
			throw new Error(`Team limit reached (${MAX_SESSION_TEAMS} per session). Use team_add on an existing team.`);
		const checked = this.checkMembers(input.members, new Set(), input.defaults);
		const teamId = `team_${String(++this.counter).padStart(2, "0")}`;
		const team = { id: teamId, name, objective };
		const members = checked.map((m): PreparedMember => ({
			role: m.role,
			ownedPaths: m.ownedPaths,
			orchestrator: m.orchestrator,
			spec: resolveMemberSpec(
				m.input, m.role,
				composeMemberPrompt(team, m, checked.filter((o) => o !== m), m.input.prompt, "creation", memberTooling(memberBackend(m.input, input.defaults))),
				input.defaults,
			),
		}));
		this.pendingNames.add(key);
		this.pendingTeams++;
		let released = false;
		return {
			teamId, name, objective, defaults: input.defaults, members,
			release: () => {
				if (released) return;
				released = true;
				this.pendingNames.delete(key);
				this.pendingTeams--;
			},
		};
	}

	/** Validate and reserve roles on an existing session team. History teams are read-only. */
	/**
	 * Validate and reserve roles on an existing session team. History teams are read-only.
	 * Ejected members keep their roles reserved but hold no seat. `observe` (exact IDs
	 * among retained workers) only names the ejectable members in the cap error.
	 */
	prepareAdd(ref: string, members: TeamMemberInput[], observe?: (workerId: string) => WorkerObservation | undefined): PreparedAdd {
		const team = this.find(ref);
		if (team.origin === "history") throw new Error(historyRefusal(team));
		const pending = this.pendingRoles.get(team.id) ?? new Set<string>();
		const taken = new Set([...team.members.map((m) => labelKey(m.role)), ...pending]);
		const checked = this.checkMembers(members, taken, team.defaults);
		if (seated(team) + pending.size + checked.length > MAX_TEAM_MEMBERS) {
			const ejectable = team.members.filter((m) => m.ejectedAt === undefined && !BUSY_STATES.has(memberState(observe?.(m.workerId))));
			throw new Error(
				`Team ${team.id} would exceed ${MAX_TEAM_MEMBERS} members (counting every member not ejected, finished ones included, and pending additions). ` +
				(ejectable.length
					? `Ended members you can release with team_eject: ${ejectable.map((m) => `${m.workerId} (${m.role})`).join(", ")}.`
					: "No member has ended; stop one with agent_kill, then release its seat with team_eject."),
			);
		}
		const existing = team.members.filter((m) => m.ejectedAt === undefined).map((m): HeaderMember => ({ role: m.role, ownedPaths: m.ownedPaths, orchestrator: m.orchestrator === true }));
		const composed = checked.map((m): PreparedMember => ({
			role: m.role,
			ownedPaths: m.ownedPaths,
			orchestrator: m.orchestrator,
			spec: resolveMemberSpec(
				m.input, m.role,
				composeMemberPrompt(team, m, [...existing, ...checked.filter((o) => o !== m)], m.input.prompt, "addition", memberTooling(memberBackend(m.input, team.defaults))),
				team.defaults,
			),
		}));
		const keys = checked.map((m) => labelKey(m.role));
		for (const key of keys) pending.add(key);
		this.pendingRoles.set(team.id, pending);
		let released = false;
		return {
			teamId: team.id,
			name: team.name,
			members: composed,
			release: () => {
				if (released) return;
				released = true;
				for (const key of keys) pending.delete(key);
				if (!pending.size && this.pendingRoles.get(team.id) === pending) this.pendingRoles.delete(team.id);
			},
		};
	}

	/** Entry data for a successful create; persist it before commitCreate. */
	createEntry(prepared: PreparedCreate, createdAt: number, members: PersistedMember[]): TeamEntryData {
		return { version: 1, op: "create", team: { id: prepared.teamId, name: prepared.name, objective: prepared.objective, createdAt }, members };
	}

	addEntry(prepared: PreparedAdd, members: PersistedMember[]): TeamEntryData {
		return { version: 1, op: "add", teamId: prepared.teamId, members };
	}

	/** Cannot throw for a prepared create; call only after the entry was persisted. */
	commitCreate(prepared: PreparedCreate, createdAt: number, members: PersistedMember[]): void {
		this.session.push({
			id: prepared.teamId, name: prepared.name, objective: prepared.objective, createdAt, origin: "session",
			defaults: prepared.defaults, members: members.map((m) => ({ ...m, ownedPaths: [...m.ownedPaths] })), actions: [],
		});
	}

	commitAdd(prepared: PreparedAdd, members: PersistedMember[]): void {
		const team = this.session.find((t) => t.id === prepared.teamId);
		if (team) for (const m of members) team.members.push({ ...m, ownedPaths: [...m.ownedPaths] });
	}

	private sessionMember(workerId: string): { team: TeamRecord; member: MemberRecord } | undefined {
		for (const team of this.session) {
			const member = team.members.find((m) => m.workerId === workerId);
			if (member) return { team, member };
		}
		return undefined;
	}

	/** Team ID for a worker created by this session's team tools, if any. */
	teamOf(workerId: string): string | undefined { return this.sessionMember(workerId)?.team.id; }

	/** Session-team membership by exact worker ID (never by name); undefined for non-members and history. */
	memberInfo(workerId: string): MemberInfo | undefined {
		const found = this.sessionMember(workerId);
		if (!found) return undefined;
		const copy = (m: MemberRecord): PersistedMember => ({
			workerId: m.workerId, role: m.role, ownedPaths: [...m.ownedPaths], backend: m.backend, groupId: m.groupId, addedAt: m.addedAt,
			...(m.model === undefined ? {} : { model: m.model }), ...(m.orchestrator ? { orchestrator: true } : {}),
		});
		return {
			team: { id: found.team.id, name: found.team.name },
			member: copy(found.member),
			siblings: found.team.members.filter((m) => m !== found.member && m.ejectedAt === undefined).map(copy),
		};
	}

	/**
	 * Resolve a sibling reference (role, case/whitespace-insensitive, or exact
	 * worker ID) within the sender's own team. Never the sender itself, never a
	 * worker outside the team.
	 */
	resolveSibling(senderId: string, ref: string): PersistedMember {
		const info = this.memberInfo(senderId);
		if (!info) throw new Error(`${senderId} is not a member of a session team.`);
		const trimmed = ref.trim();
		if (trimmed === senderId || labelKey(trimmed) === labelKey(info.member.role)) throw new Error("You cannot address yourself.");
		const ejected = this.sessionMember(senderId)!.team.members.find((m) =>
			m.ejectedAt !== undefined && (WORKER_ID.test(trimmed) ? m.workerId === trimmed : labelKey(m.role) === labelKey(trimmed)));
		if (ejected) throw new Error(`${ejected.role} (${ejected.workerId}) was ejected from ${info.team.id} at ${ejectedStamp(ejected.ejectedAt!)}; it no longer receives team messages.`);
		const byId = WORKER_ID.test(trimmed) ? info.siblings.find((m) => m.workerId === trimmed) : undefined;
		if (byId) return byId;
		if (WORKER_ID.test(trimmed)) throw new Error(`${trimmed} is not a member of ${info.team.id}; use team_roster or your header's roles.`);
		const byRole = info.siblings.find((m) => labelKey(m.role) === labelKey(trimmed));
		if (!byRole) throw new Error(`No member with role ${trimmed} in ${info.team.id}. Known roles: ${info.siblings.map((m) => m.role).join(", ") || "none"}.`);
		return byRole;
	}

	/** Record a control request against a session team member; undefined for non-members. */
	recordAction(workerId: string, kind: TeamActionKind, source: TeamActionSource, message?: string): TeamAction | undefined {
		const found = this.sessionMember(workerId);
		if (!found) return undefined;
		const action: TeamAction = {
			seq: ++this.actionSeq, at: Date.now(), workerId, role: found.member.role, kind, source, state: "requested",
			...(message === undefined ? {} : { preview: message.length > ACTION_PREVIEW_CHARS ? `${message.slice(0, ACTION_PREVIEW_CHARS)}…` : message }),
		};
		found.team.actions.push(action);
		if (found.team.actions.length > MAX_TEAM_ACTIONS) found.team.actions.splice(0, found.team.actions.length - MAX_TEAM_ACTIONS);
		return action;
	}

	settleAction(action: TeamAction | undefined, state: Exclude<TeamActionState, "requested">, reason?: string): void {
		if (!action || action.state !== "requested") return;
		action.state = state;
		if (reason) action.reason = reason.length > ERROR_CHARS ? `${reason.slice(0, ERROR_CHARS)}…` : reason;
	}

	/** Keep the last observed state for a member the manager is about to evict. */
	recordEviction(workerId: string, snapshot: MemberSnapshot): void {
		const found = this.sessionMember(workerId);
		if (!found) return;
		found.member.last = {
			status: snapshot.status,
			...(snapshot.taskOutcome === undefined ? {} : { taskOutcome: snapshot.taskOutcome }),
			...(snapshot.error ? { error: snapshot.error.slice(0, ERROR_CHARS) } : {}),
		};
	}

	/**
	 * Validate a seat release on a session team. `member` is an exact worker ID or a
	 * role. Refuses history teams, unknown or already-ejected members, and members
	 * whose worker is still working, idle or stopping. Nothing changes here: persist
	 * ejectEntry(), then commitEject().
	 */
	checkEject(ref: string, member: string, observe: (workerId: string) => WorkerObservation | undefined): { teamId: string; workerId: string; role: string } {
		const team = this.find(ref);
		if (team.origin === "history") throw new Error(historyRefusal(team));
		const trimmed = member.trim();
		const found = WORKER_ID.test(trimmed)
			? team.members.find((m) => m.workerId === trimmed)
			: team.members.find((m) => labelKey(m.role) === labelKey(trimmed));
		if (!found) throw new Error(`No member ${trimmed} in ${team.id}. Members: ${team.members.map((m) => `${m.workerId} (${m.role})`).join(", ") || "none"}.`);
		if (found.ejectedAt !== undefined) throw new Error(`${found.role} (${found.workerId}) was already ejected from ${team.id} at ${ejectedStamp(found.ejectedAt)}.`);
		const state = memberState(observe(found.workerId));
		if (BUSY_STATES.has(state))
			throw new Error(`${found.role} (${found.workerId}) is still ${state}; stop it with agent_kill first, then team_eject it.`);
		return { teamId: team.id, workerId: found.workerId, role: found.role };
	}

	ejectEntry(teamId: string, workerId: string, at: number): TeamEntryData {
		return { version: 1, op: "eject", teamId, workerId, at };
	}

	/** Mark the member ejected and record one action row; call only after the entry was persisted. */
	commitEject(teamId: string, workerId: string, at: number, source: TeamActionSource): TeamAction | undefined {
		const member = this.session.find((t) => t.id === teamId)?.members.find((m) => m.workerId === workerId);
		if (!member || member.ejectedAt !== undefined) return undefined;
		member.ejectedAt = at;
		const action = this.recordAction(workerId, "eject", source);
		this.settleAction(action, "accepted-or-queued");
		return action;
	}

	/** When a member of any known team (session or history) was ejected, if it was. */
	ejectedAt(workerId: string): number | undefined {
		for (const team of this.all()) {
			const member = team.members.find((m) => m.workerId === workerId);
			if (member?.ejectedAt !== undefined) return member.ejectedAt;
		}
		return undefined;
	}

	/**
	 * Fresh, detached views. `observe` must look up exact IDs among retained workers
	 * only; it is never consulted for history teams.
	 */
	views(observe: (workerId: string) => WorkerObservation | undefined): TeamView[] {
		return this.all().map((team) => {
			const counts = emptyCounts();
			let ejected = 0;
			const members = team.members.map((m): TeamMemberView => {
				const base = { workerId: m.workerId, role: m.role, ownedPaths: [...m.ownedPaths], orchestrator: m.orchestrator === true, backend: m.backend, groupId: m.groupId, addedAt: m.addedAt };
				let view: TeamMemberView;
				const observed = team.origin === "session" ? observe(m.workerId) : undefined;
				if (observed) {
					view = {
						...base, model: observed.model ?? m.model, available: true, availability: "retained", state: memberState(observed),
						status: observed.status, processAlive: observed.processAlive,
						...(observed.taskOutcome === undefined ? {} : { taskOutcome: observed.taskOutcome }),
						...(observed.error ? { error: observed.error.slice(0, ERROR_CHARS) } : {}),
					};
				} else {
					view = {
						...base, ...(m.model === undefined ? {} : { model: m.model }), available: false,
						availability: team.origin === "session" ? "pruned" : "previous-session",
						reason: team.origin === "session" ? PRUNED_REASON : HISTORY_REASON, state: "unavailable",
						...(team.origin === "session" && m.last ? { ...m.last } : {}),
					};
				}
				if (m.ejectedAt === undefined) counts[view.state]++;
				else {
					view.ejectedAt = m.ejectedAt;
					ejected++;
				}
				return view;
			});
			return {
				id: team.id, name: team.name, objective: team.objective, createdAt: team.createdAt, origin: team.origin,
				members, actions: team.actions.map((a) => ({ ...a })), counts, ejected,
			};
		});
	}

	clear(): void {
		this.session = [];
		this.history = [];
		this.pendingNames.clear();
		this.pendingRoles.clear();
		this.pendingTeams = 0;
	}
}
