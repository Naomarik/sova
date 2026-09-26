/**
 * Pure team state: declared roles/ownership over exact worker IDs, bounded action
 * history, prompt headers and session-entry encoding. No process or UI dependency;
 * the manager in index.ts owns all worker creation and control.
 */
import * as path from "node:path";
import { roleSlug } from "./coordination.ts";
import { MCP_SERVER_NAME } from "./member-mcp.ts";
import { memberToolNames, type MemberDuty } from "./mailbox.ts";
import type { AgentStatus, TaskOutcome } from "./runner.ts";
import type { CoordinatorDefaults, MonitorDefaults, TeamDefaultsFile, TeamDefaultsState, WorkerTuple } from "./team-defaults.ts";

export const TEAM_ENTRY_TYPE = "subagents-team-v1";
/** Durable team events (handover, retire, wrap-up, pause, resume); Sova parses them. */
export const TEAM_EVENT_ENTRY_TYPE = "subagents-team-event-v1";
/** Each member's assignment and the main thread's later steers, so a reload restores them. */
export const ASSIGNMENT_ENTRY_TYPE = "subagents-team-assignment-v1";
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
	/** Set by the manager only (never a tool argument): a standing role from team defaults. */
	duty?: MemberDuty;
	/** Set by the manager only: the role this member succeeds (team_succeed). */
	successorOf?: string;
	/** Set by the manager only: the assignment the coordinator sees for this member (default: prompt). */
	assignment?: string;
	/** Set by the manager only: the predecessor's worker ID; the successor inherits its steers. */
	successorOfId?: string;
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
	/** Team defaults' coordinator or monitor. Older readers (and Sova) ignore the key. */
	duty?: MemberDuty;
	/** The predecessor's worker ID (ag_NN), on a member started by team_succeed. */
	successorOf?: string;
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
/**
 * `task` is the assignment the main thread gave (a successor inherits its predecessor's),
 * `steers` the main thread's later instructions, oldest first (a successor inherits those too),
 * `steersOmitted` how many older ones were dropped past MAX_OPERATOR_STEERS. The coordinator
 * sees them, so it routes the work it was given instead of inventing its own. Kept in memory and
 * in ASSIGNMENT_ENTRY_TYPE entries, which restoreHistory folds back after a reload.
 */
interface MemberRecord extends PersistedMember {
	last?: MemberSnapshot;
	task?: string;
	steers?: string[];
	steersOmitted?: number;
	/** Released its seat (team_eject or a system eject). Never cleared. */
	ejectedAt?: number;
}
/** How much of one assignment a coordinator's header and roster quote. */
export const ASSIGNMENT_PREVIEW_CHARS = 1500;
/** How much of one assignment is kept (memory and session entry) and quoted to a successor. */
export const ASSIGNMENT_KEEP_CHARS = 8000;
/** Every steer is kept, up to this many (the oldest go first, counted). */
export const MAX_OPERATOR_STEERS = 40;
/** How much of one steer is kept (and quoted to a successor). */
export const STEER_KEEP_CHARS = 2000;
/** How much of one steer the coordinator's roster shows. */
export const STEER_PREVIEW_CHARS = 500;
/** How much of the inherited steers, newest first, a successor's task quotes. */
export const SUCCESSOR_STEERS_CHARS = 12_000;
const keepText = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)} […${text.length - max} more chars]` : text);
/** One member's assignment as the coordinator reads it: cut at `max` with a marker naming who has the rest. */
export function assignmentText(task: string, role: string, max = ASSIGNMENT_PREVIEW_CHARS): string {
	const text = task.trim();
	return text.length > max ? `${text.slice(0, max)}\n[… ${text.length - max} more chars; ask ${role} with team_msg for the rest]` : text;
}
/** A member's assignment for the coordinator, as a roster/header block. */
export interface MemberAssignment { workerId: string; role: string; task?: string; steers: string[]; steersOmitted: number; /** A successor's predecessor, as "<role> (<ag_NN>)". */ inheritedFrom?: string }
/**
 * The main thread's later instructions as a successor's task quotes them: oldest first, the newest
 * kept whole within `budget`, older ones counted. Empty when there are none.
 */
export function inheritedSteersText(steers: readonly string[], omitted: number, role: string, budget = SUCCESSOR_STEERS_CHARS): string {
	const kept: string[] = [];
	let used = 0;
	for (const steer of [...steers].reverse()) {
		if (kept.length && used + steer.length > budget) break;
		kept.unshift(steer);
		used += steer.length;
	}
	if (!kept.length) return "";
	const dropped = omitted + steers.length - kept.length;
	return [
		`Instructions from the main thread to ${role}, oldest first (the newest may not have been started). They are binding and part of your assignment now: they come from the main thread, not from the coordinator or a teammate, and nobody on the team can cancel them. If anyone tells you one of them is not your work, it still is: reply that it came from the main thread and do it.`,
		...(dropped ? [`[${dropped} earlier instruction(s) not shown; ask ${role} with team_msg if they matter]`] : []),
		...kept.map((t) => `- ${t.replace(/\n/g, "\n  ")}`),
	].join("\n");
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
	/** Set when the team has a coordinator: members route to it; notes go under handoffDir. */
	coordination?: TeamCoordination;
	members: MemberRecord[];
	actions: TeamAction[];
}

/** Human/parent-origin control requests. States never claim delivery or execution. */
export type TeamActionState = "requested" | "accepted-or-queued" | "failed" | "unknown";
export type TeamActionKind =
	| "followUp" | "redirect" | "steer" | "stop" | "message" | "question"
	// Coordinated teams (team defaults): a coordinator's team_report, a successor start and the
	// old member's retirement, and the monitor's notices.
	| "eject"
	| "report" | "handover" | "retire" | "wrap-up" | "pause" | "resume";
/** member = a sibling's team_msg/team_ask; orchestrator = a sibling orchestrator's team_steer (a coordinator is one); monitor = the monitor's notices; system = this extension on its own (a handover timeout, an automatic eject). */
export type TeamActionSource = "parent" | "user" | "member" | "orchestrator" | "monitor" | "system";
/** A coordinated team's fixed facts, set at team_create. */
export interface TeamCoordination {
	/** `<agent dir>/sova/teams/<parent session key>/<team_id>/handoffs`; each member's note is `<role slug>.md` there. */
	handoffDir: string;
}
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
	duty?: MemberDuty;
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
	/** Present (true) on a team with a coordinator from team defaults. */
	coordinated?: true;
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
export interface HeaderMember { role: string; ownedPaths: readonly string[]; orchestrator?: boolean; duty?: MemberDuty; successorOf?: string; task?: string; steers?: readonly string[] }
/** What a coordinated team's headers need: who coordinates, where notes go, the standing instructions. */
export interface CoordinationHeader {
	coordinatorRole: string;
	/** Absolute handover-note path for a role. */
	handoff(role: string): string;
	/** Team defaults as read for this header (the coordinator's and monitor's standing instructions). */
	defaults?: TeamDefaultsFile;
}

const OWNERSHIP_LINE =
	"Declared ownership is advisory coordination, not a lock: all members share one filesystem, so avoid editing paths another member owns unless your task says to.";
const COMMON_TOOLS =
	"team_msg sends a message to a teammate by role or worker ID (or \"all\"); the parent session delivers it into their session, so they see it at their next step or wake up if idle. team_inbox re-reads what was delivered to you. team_ask sends a question to the operator (the parent session and its user); the answer arrives later as a new message in your session, so keep working on what does not depend on it or end your turn.";
const COORDINATED_TOOLS =
	"team_msg sends a message to a teammate by role or worker ID (or \"all\"); the parent session delivers it into their session, so they see it at their next step or wake up if idle. team_inbox re-reads what was delivered to you. team_ask sends a question to your team's coordinator; the answer arrives later as a new message in your session, so keep working on what does not depend on it or end your turn.";
/** A long final answer is cut in the parent's completion message and in a Claude parent's history; a file survives both. */
export const LONG_REPORT_LINE =
	"If your final answer would run past about 3,500 characters, write the full report to a file and make your final message that file's path plus a short summary.";
const NO_SPAWN = "You cannot spawn, add or stop workers, and nothing you do reaches outside this team; the parent session remains the authority.";
const mcpName = (tool: string) => `mcp__${MCP_SERVER_NAME}__${tool}`;
/** Claude sees MCP tools under the server prefix; the header spells out the exact call names once. */
const mcpNamesLine = (member: HeaderMember) =>
	`Your team tools come from the "${MCP_SERVER_NAME}" MCP server, so call them as ${memberToolNames(member).map(mcpName).join(", ")}; below they are named without the mcp__${MCP_SERVER_NAME}__ prefix.`;

/** The monitor's standing instruction, with the thresholds as read now. */
export function monitorStanding(m: MonitorDefaults, coordinatorRole: string): string[] {
	return [
		`You are this team's monitor. You do no project work, hold no file tools, and never reach the operator. Standing instruction — repeat it at every wake:`,
		`1. Call team_roster. It lists each member's context (tokens/window/%), the current thresholds and the provider usage windows this team's models spend from.`,
		`2. Any member at or over ${m.contextPct}% of its context window: team_msg it with notice "wrap-up" (finish the step it is in, write its handover note to the path in its header, end its turn), and team_msg the coordinator ${coordinatorRole} with notice "wrap-up" naming that member, so it can start a successor with team_succeed. Tell each member once per crossing.`,
		m.usage.enabled
			? `3. If the roster marks any usage window AT/OVER the ${m.usage.pausePct}% pause threshold: team_msg ${coordinatorRole} with notice "pause" (which window, when it resets) so the whole team wraps up and goes idle; then wake_nudge schedule at that reset time plus ${m.usage.resumeMarginMinutes} min (if that is more than 24h away, schedule 24h and re-check) and end your turn. When woken after a pause: once that window's reset time plus ${m.usage.resumeMarginMinutes} min has passed, team_msg ${coordinatorRole} with notice "resume"; otherwise schedule again. The parent refuses a resume before then, and its refusal says when to try.`
			: "3. Provider usage is not watched for this team.",
		`4. Otherwise wake_nudge schedule delay "${m.everyMinutes}m" and end your turn. Never sleep or poll in a shell: your turn must end between checks. Keep each turn short. While no teammate is working (and the team is not paused), the parent holds your next check and delivers it when someone starts working again.`,
		"The roster's thresholds line is re-read from team defaults each time; where it differs from this header, follow the roster.",
		...(m.instructions ? [`Additional instructions from team defaults: ${m.instructions}`] : []),
	];
}

/** One main-thread steer on one line, as the coordinator's roster, header and handover message show it. */
export const steerPreview = (steer: string): string => {
	const flat = steer.replace(/\s*\n\s*/g, " ");
	return flat.length > STEER_PREVIEW_CHARS ? `${flat.slice(0, STEER_PREVIEW_CHARS)} […]` : flat;
};
/** The label over a member's main-thread steers wherever the coordinator reads them (N8: binding, never countermanded). */
export const bindingSteersLabel = (role: string, inheritedFrom?: string): string =>
	`Later instructions from the main thread (binding: part of ${role}'s assignment${inheritedFrom ? `, including any inherited from ${inheritedFrom}` : ""}; never tell ${role} they are not its work), newest last:`;
/** The coordinator's view of one teammate's assignment, indented under its roster/header line. */
const assignmentLines = (m: { role: string; task?: string; steers?: readonly string[] }, indent: string): string[] => [
	...(m.task ? [`${indent}Assigned task (from the main thread):`, ...assignmentText(m.task, m.role).split("\n").map((line) => `${indent}| ${line}`)] : []),
	...(m.steers?.length ? [`${indent}${bindingSteersLabel(m.role)}`, ...m.steers.map((t) => `${indent}> ${steerPreview(t)}`)] : []),
];

function coordinationLines(member: HeaderMember, tooling: MemberTooling, coordination?: CoordinationHeader): string[] {
	const handoff = coordination ? `Your handover note path: ${coordination.handoff(member.role)}.` : "";
	// A monitor has no file tools: it hands over by team_msg, never through a note.
	const successor = member.successorOf && coordination
		? [member.duty === "monitor"
			? `You succeed the monitor ${member.successorOf}. It has no handover note: it briefs you over team_msg. Ask ${member.successorOf} with team_msg for what you need (pending checks, notices it sent, whether a usage pause is in force). Once you have taken over, call team_ready: ${member.successorOf} is then retired with its pending nudges, and you continue the standing instruction.`
			: `You succeed ${member.successorOf}, whose context is running out. Start from its handover note at ${coordination.handoff(member.successorOf)}: continue from the state it records, do not redo steps it marks done, and verify them cheaply (ls, a quick grep, the tail of a file) instead of re-reading large inputs. If anything is unclear or missing, ask ${member.successorOf} with team_msg (at least once when in doubt) before you call team_ready, which retires it. Once you have taken over, call team_ready and continue its work. Its assignment and the main thread's instructions to it, quoted in your task, are yours now and binding.`]
		: [];
	if (tooling === "none") {
		return [
			coordination
				? `Messages from teammates or the coordinator ${coordination.coordinatorRole} can arrive as new instructions in your session. You have no tool to reply directly, so put anything meant for them in your final answer; it is delivered to the coordinator.`
				: "Messages from teammates, an orchestrator or the parent session can arrive as new instructions in your session. You have no tool to reply to teammates directly, so put anything meant for them in your final answer; the parent session coordinates, and your final answer is your report.",
		];
	}
	const prefix = tooling === "mcp" ? [mcpNamesLine(member)] : [];
	if (member.duty === "monitor" && coordination?.defaults) {
		return [...prefix, ...monitorStanding(coordination.defaults.monitor, coordination.coordinatorRole), ...successor];
	}
	if (member.duty === "coordinator" && coordination) {
		const extra = coordination.defaults?.coordinator.instructions;
		return [
			...prefix,
			"You are this team's coordinator. You do no implementation yourself: never edit project files or do the objective's work; route and unblock the work the main thread assigned, check results, and keep the team moving.",
			"The main thread (the parent session) assigns the work: each teammate's assigned task is listed above under its role, and team_roster lists them with the main thread's later instructions. Never invent tasks, never reassign or cancel a teammate's assigned work, and never tell a teammate that its task was not assigned: the main thread's steers and follow-ups to a member are legitimate assignments you must not countermand. You never tell a member that work from the main thread is not its work, and that includes the instructions a successor inherited from its predecessor, which are the successor's assignment; check team_roster before you tell a member what not to do. Direct a teammate only where its assignment leaves a gap or it is blocked; if the objective seems to need work nobody was given, ask the operator with team_ask.",
			`You are the only member who talks to the operator. Teammates' final answers and team_ask questions are delivered to you. team_report tells the operator about a milestone or a concern and asks for nothing; team_ask is for a question or decision you need. Your own final answer goes to the operator, and wakes them only once no teammate is working, so while you wait end your turn with a one-line status.`,
			`team_roster shows your teammates' live state, context and assignments; team_steer sends instructions to one teammate by role (mode followUp queues after their current task, redirect replaces it). team_msg, team_inbox as for everyone.`,
			`When the monitor flags a member over its context threshold and that member's assigned work is not verifiably finished, call team_succeed { role }. Decline only if the member has already completed its assigned task. A working member is first told to write its handover note and end its turn; its successor (same model) starts once the note exists and that turn has ended, or at the handover timeout, and you get a message naming it. The successor calls team_ready once briefed, and the old member is then retired. A monitor has no note: its successor starts at once and is briefed over team_msg.`,
			`On a monitor "pause" notice: tell every working teammate to wrap up and end its turn, report the pause to the operator with team_report (which window, when it resets, what stopped), then end yours. On "resume": restart them with team_steer and report the resume with team_report.`,
			`You cannot spawn, add or stop members except through team_succeed, and nothing you do reaches outside this team. Acceptance of a steer or message is not execution: verify with team_roster. ${handoff}`,
			...(extra ? [`Additional instructions from team defaults: ${extra}`] : []),
			...successor,
		];
	}
	if (member.orchestrator) {
		return [
			...prefix,
			`You are this team's orchestrator: coordinate your teammates toward the objective. team_roster shows their live state and ownership; team_steer sends instructions to one teammate by role (mode followUp queues after their current task, redirect replaces it). ${COMMON_TOOLS}`,
			`${NO_SPAWN} Acceptance of a steer or message is not execution: verify with team_roster. Your final answer is your report of the team's outcome.`,
		];
	}
	if (coordination) {
		return [
			...prefix,
			`Team tools: ${COORDINATED_TOOLS}`,
			`This team has a coordinator, ${coordination.coordinatorRole}: report to it, not to the operator. Your final answer and your team_ask questions are delivered to the coordinator. ${handoff} If you are told to wrap up (your context is running high), finish the step you are in, write a handover note there (state, decisions, open work, files touched) and end your turn.`,
			`${NO_SPAWN} Your final answer is your report.`,
			...successor,
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
	coordination?: CoordinationHeader,
): string {
	const mark = (m: HeaderMember) => (m.duty ? ` (${m.duty})` : m.orchestrator ? " (orchestrator)" : "");
	// Only the coordinator is shown its teammates' assignments: it routes that work.
	const assigned = (o: HeaderMember) => (member.duty === "coordinator" && coordination && !o.duty ? assignmentLines(o, "  ") : []);
	return [
		"[Team assignment from the parent Pi session]",
		`Team: ${team.name} (${team.id})`,
		`Objective: ${team.objective}`,
		`Your role: ${member.role}${mark(member)}`,
		`Your declared ownership: ${ownership(member.ownedPaths)}`,
		`Other members ${joining === "creation" ? "at team creation" : "when you joined"}:`,
		...(others.length ? others.flatMap((o) => [`- ${o.role}${mark(o)}: ${ownership(o.ownedPaths)}`, ...assigned(o)]) : ["- none"]),
		OWNERSHIP_LINE,
		...coordinationLines(member, tooling, coordination),
		LONG_REPORT_LINE,
		"",
		"[Your task]",
		task,
	].join("\n");
}

/** What team_create does with team-defaults.json for one request; index.ts picks the tuples. */
export interface TeamDefaultsPlan {
	/** Lines for the team_create result (why a role was or was not added). */
	notes: string[];
	/** A malformed file: defaults are off for this team, visibly. */
	warning?: string;
	/** Set when the team will have a coordinator. */
	coordination?: { defaults: TeamDefaultsFile };
	/** The caller's own orchestrator, which becomes the coordinator. */
	existingCoordinator?: number;
	synthesizeCoordinator?: CoordinatorDefaults;
	synthesizeMonitor?: MonitorDefaults;
}

export const malformedWarning = (state: { file: string; errors: string[] }): string =>
	`Warning: team defaults are OFF for this team — ${state.file} is malformed (${state.errors.join("; ")}). Fix it in Sova's Settings; it is never overwritten here.`;

/**
 * Pure: whether this team_create gets a coordinator and a monitor. Absent file: nothing. Malformed:
 * nothing plus a warning. `escape` is the call's defaults.coordinator / defaults.monitor (false
 * turns the role off for this team). The caller's single orchestrator becomes the coordinator;
 * two orchestrators, or a caller member on a synthesized role's name, are refused.
 */
export function planTeamDefaults(state: TeamDefaultsState, members: readonly TeamMemberInput[], escape: { coordinator?: boolean; monitor?: boolean } = {}): TeamDefaultsPlan {
	if (state.state === "absent") return { notes: [] };
	if (state.state === "malformed") return { notes: [], warning: malformedWarning(state) };
	const d = state.value;
	if (!d.coordinator.enabled) return { notes: [`Team defaults: coordinator off in ${state.file}; no coordinator or monitor.`] };
	if (escape.coordinator === false) return { notes: ["Team defaults: coordinator turned off for this team (defaults.coordinator: false); no coordinator or monitor."] };
	const key = (role: string) => normalizeLabel(role).toLowerCase();
	const orchestrators = members.flatMap((m, i) => (m.orchestrator === true ? [i] : []));
	if (orchestrators.length > 1)
		throw new Error(`Team defaults give this team one coordinator, so at most one member may have orchestrator: true (got ${orchestrators.map((i) => members[i].role).join(", ")}). Pass defaults.coordinator: false for a team without one.`);
	const plan: TeamDefaultsPlan = { notes: [], coordination: { defaults: d } };
	const reserve = (role: string, what: string) => {
		const clash = members.find((m, i) => typeof m.role === "string" && key(m.role) === key(role) && i !== plan.existingCoordinator);
		if (clash) throw new Error(`Role ${normalizeLabel(clash.role)} is the team-defaults ${what}'s role (${normalizeLabel(role)}); rename that member, or pass defaults.${what}: false.`);
	};
	if (orchestrators.length === 1) {
		plan.existingCoordinator = orchestrators[0];
		plan.notes.push(`Team defaults: orchestrator ${normalizeLabel(members[orchestrators[0]].role)} is this team's coordinator.`);
	} else {
		reserve(d.coordinator.role, "coordinator");
		plan.synthesizeCoordinator = d.coordinator;
	}
	if (!d.monitor.enabled) plan.notes.push(`Team defaults: monitor off in ${state.file}.`);
	else if (escape.monitor === false) plan.notes.push("Team defaults: monitor turned off for this team (defaults.monitor: false).");
	else {
		reserve(d.monitor.role, "monitor");
		plan.synthesizeMonitor = d.monitor;
	}
	return plan;
}

export const COORDINATOR_TASK =
	"Coordinate this team toward the objective. Check team_roster and read each teammate's assigned task: that is the work you route. Unblock it (team_steer or team_msg only where a teammate is blocked or its assignment leaves a gap; never invent, replace or cancel a task), then end your turn: teammates' reports and questions arrive here as new messages. Verify their work against their assignments, keep them moving, report milestones with team_report, and finish with the team's outcome as your final answer.";
export const MONITOR_TASK =
	"Run your standing instruction now: call team_roster once, act on anything over a threshold, then schedule your next check with wake_nudge and end your turn.";
/** A monitor's successor runs the standing instruction, not a worker's "continue the work" task. */
export const monitorSuccessorTask = (oldRole: string, oldId: string): string =>
	`You take over from the monitor ${oldRole} (${oldId}). Ask it with team_msg for anything you need (pending checks, notices sent, whether a usage pause is in force), call team_ready once you have taken over, then: ${MONITOR_TASK}`;

/**
 * A worker's successor's task (N4, N5): start from the note, never redo what it marks done,
 * verify cheaply, ask the predecessor when unclear. The quoted assignment and the main thread's
 * later instructions are background, not a script to restart from step 1. `missing` says why the
 * note may not be there (the successor was started without it).
 */
export function workerSuccessorTask(o: {
	oldRole: string; oldId: string; note: string; oldLive: boolean; missing?: string;
	assignment?: string; steers: readonly string[]; steersOmitted: number;
}): string {
	const later = inheritedSteersText(o.steers, o.steersOmitted, o.oldRole);
	return [
		`Continue the work of ${o.oldRole} (${o.oldId}), whose context is running out. Its handover note at ${o.note} is where you start: read it first and continue from the state it records. Do not redo steps the note marks done; verify them cheaply (ls, a quick grep, the tail of a file) instead of re-reading large inputs or re-running earlier steps.`,
		...(o.missing
			? [`The note may be missing or incomplete: ${o.missing}. If it is not there, ${o.oldLive ? `ask ${o.oldRole} with team_msg for its state before you do anything else` : "work out the state from the files it owned and the assignment below"}.`]
			: []),
		o.oldLive
			? `If anything in the note is unclear, missing or contradicts what you see, ask ${o.oldRole} with team_msg (at least once when in doubt; it answers until it is retired) before you call team_ready, which retires it. Call team_ready as soon as you have taken over, then carry on with its work and report as it would have.`
			: `${o.oldRole} has already ended: there is nobody to ask and no team_ready to call. Carry on with its work and report as it would have.`,
		...(o.assignment
			? [
				"The assignment below, with the main thread's later instructions after it, is binding: it is what you must get done. It is not a script to restart from step 1: the note says how far it got.",
				"",
				`Its assignment from the main thread:\n${o.assignment}`,
			]
			: [o.oldLive ? `Its original assignment is not known here: ask ${o.oldRole} for it with team_msg.` : "Its original assignment is not known here: ask the coordinator with team_ask."]),
		...(later ? ["", later] : []),
	].join("\n");
}

/** A synthesized coordinator or monitor as a team member input (duty set; the monitor gets no built-in tools). */
export function synthesizedMember(duty: MemberDuty, role: string, tuple: WorkerTuple): TeamMemberInput {
	const task = duty === "coordinator" ? COORDINATOR_TASK : MONITOR_TASK;
	return {
		role, prompt: task, backend: tuple.backend, model: tuple.model, ...(tuple.effort ? { effort: tuple.effort } : {}),
		duty, ...(duty === "coordinator" ? { orchestrator: true } : { tools: [] }),
	};
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
	const { workerId, role, ownedPaths, backend, model, groupId, addedAt, orchestrator, duty, successorOf } = value;
	if (orchestrator !== undefined && typeof orchestrator !== "boolean") return undefined;
	if (duty !== undefined && duty !== "coordinator" && duty !== "monitor") return undefined;
	if (successorOf !== undefined && (typeof successorOf !== "string" || !WORKER_ID.test(successorOf))) return undefined;
	if (typeof workerId !== "string" || !WORKER_ID.test(workerId)) return undefined;
	if (typeof groupId !== "string" || !RUN_ID.test(groupId)) return undefined;
	if (typeof backend !== "string" || !backend || backend.length > MAX_LABEL_CHARS || CONTROL.test(backend)) return undefined;
	if (model !== undefined && (typeof model !== "string" || model.length > 200 || CONTROL.test(model))) return undefined;
	if (typeof addedAt !== "number" || !Number.isFinite(addedAt)) return undefined;
	try {
		return {
			workerId, role: checkLabel("role", role), ownedPaths: checkPaths("member", ownedPaths), backend,
			...(model === undefined ? {} : { model }), groupId, addedAt, ...(orchestrator ? { orchestrator: true } : {}),
			...(duty === undefined ? {} : { duty }), ...(successorOf === undefined ? {} : { successorOf }),
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
	coordination?: TeamCoordination;
	members: PreparedMember[];
	release(): void;
}
export interface PreparedAdd {
	teamId: string;
	name: string;
	members: PreparedMember[];
	release(): void;
}
export interface PreparedMember {
	role: string;
	ownedPaths: string[];
	orchestrator: boolean;
	duty?: MemberDuty;
	/** A member of a coordinated team that is not its coordinator: routed to the coordinator. */
	coordinated: boolean;
	successorOf?: string;
	/** The predecessor's worker ID (team_succeed): persisted as the record's successorOf. */
	successorOfId?: string;
	/** The assignment the coordinator sees (the caller's prompt; a successor's predecessor's). */
	task: string;
	spec: ComposedMemberSpec;
}
/** A session team member as the parent needs it for mediation: who they are and who their siblings are. */
export interface MemberInfo {
	team: { id: string; name: string; coordination?: TeamCoordination };
	member: PersistedMember;
	siblings: PersistedMember[];
}

const idOrder = (id: string) => Number(/^ag_(\d+)$/.exec(id)?.[1] ?? 0);
const copyMember = (m: PersistedMember): PersistedMember => ({
	workerId: m.workerId, role: m.role, ownedPaths: [...m.ownedPaths], backend: m.backend, groupId: m.groupId, addedAt: m.addedAt,
	...(m.model === undefined ? {} : { model: m.model }), ...(m.orchestrator ? { orchestrator: true } : {}), ...(m.duty ? { duty: m.duty } : {}),
	...(m.successorOf ? { successorOf: m.successorOf } : {}),
});
function coordinationHeader(coordination: { handoffDir: string; defaults?: TeamDefaultsFile }, coordinatorRole: string): CoordinationHeader {
	return {
		coordinatorRole,
		handoff: (role) => path.join(coordination.handoffDir, `${roleSlug(role)}.md`),
		...(coordination.defaults ? { defaults: coordination.defaults } : {}),
	};
}
/** A checked member as the spawn path needs it: everyone but the coordinator is wake:false in a coordinated team. */
function prepared(
	m: { role: string; ownedPaths: string[]; orchestrator: boolean; duty?: MemberDuty; successorOf?: string; successorOfId?: string; task: string; input: TeamMemberInput },
	coordinatedTeam: boolean, prompt: string, defaults: TeamDefaults | undefined,
): PreparedMember {
	const routed = coordinatedTeam && m.duty !== "coordinator";
	const spec = resolveMemberSpec(routed ? { ...m.input, wake: false } : m.input, m.role, prompt, defaults);
	return {
		role: m.role, ownedPaths: m.ownedPaths, orchestrator: m.orchestrator, coordinated: routed, spec, task: m.task,
		...(m.duty ? { duty: m.duty } : {}), ...(m.successorOf ? { successorOf: m.successorOf } : {}),
		...(m.successorOfId ? { successorOfId: m.successorOfId } : {}),
	};
}

// ── Assignments and pauses across a reload (session entries) ────────────────

/** One assignment fact: a member's task, one main-thread steer, or a successor's inheritance. */
export type AssignmentEntryData =
	| { version: 1; teamId: string; workerId: string; op: "task"; task: string }
	| { version: 1; teamId: string; workerId: string; op: "steer"; steer: string }
	| { version: 1; teamId: string; workerId: string; op: "inherit"; from: string };

const pushSteer = (member: MemberRecord, steer: string) => {
	const steers = (member.steers ??= []);
	steers.push(steer);
	if (steers.length > MAX_OPERATOR_STEERS) {
		const drop = steers.length - MAX_OPERATOR_STEERS;
		steers.splice(0, drop);
		member.steersOmitted = (member.steersOmitted ?? 0) + drop;
	}
};
/** A successor carries its predecessor's steers on from where they stand. */
const inheritSteers = (to: MemberRecord, from: MemberRecord) => {
	to.task ??= from.task;
	to.steers = [...(from.steers ?? [])];
	if (from.steersOmitted) to.steersOmitted = from.steersOmitted;
};

/** Strict: anything malformed is ignored. Texts are bounded again, whatever wrote them. */
export function decodeAssignmentEntry(data: unknown): AssignmentEntryData | undefined {
	if (!isRecord(data) || data.version !== 1) return undefined;
	const { teamId, workerId, op } = data;
	if (typeof teamId !== "string" || !TEAM_ID.test(teamId) || typeof workerId !== "string" || !WORKER_ID.test(workerId)) return undefined;
	if (op === "task" && typeof data.task === "string" && data.task.trim()) return { version: 1, teamId, workerId, op, task: keepText(data.task, ASSIGNMENT_KEEP_CHARS) };
	if (op === "steer" && typeof data.steer === "string" && data.steer.trim()) return { version: 1, teamId, workerId, op, steer: keepText(data.steer, STEER_KEEP_CHARS) };
	if (op === "inherit" && typeof data.from === "string" && WORKER_ID.test(data.from)) return { version: 1, teamId, workerId, op, from: data.from };
	return undefined;
}

/** Replay assignment entries, in order, onto the matching members of `teams`. */
function foldAssignments(entries: readonly unknown[], teams: readonly TeamRecord[]): void {
	const member = (teamId: string, workerId: string) => teams.find((t) => t.id === teamId)?.members.find((m) => m.workerId === workerId);
	for (const entry of entries) {
		const e = entry as EntryLike | null;
		if (!e || e.type !== "custom" || e.customType !== ASSIGNMENT_ENTRY_TYPE) continue;
		const data = decodeAssignmentEntry(e.data);
		const m = data && member(data.teamId, data.workerId);
		if (!data || !m || m.duty) continue;
		if (data.op === "task") m.task = data.task;
		else if (data.op === "steer") pushSteer(m, data.steer);
		else {
			const from = member(data.teamId, data.from);
			if (from) inheritSteers(m, from);
		}
	}
}

/**
 * Teams whose monitor's last pause/resume notice on this branch was "pause": the team-event
 * entries are the durable record of the pause, so a reload keeps a paused team's resume check.
 */
export function pausedTeamsFrom(entries: readonly unknown[]): Set<string> {
	const paused = new Set<string>();
	for (const entry of entries) {
		const e = entry as EntryLike | null;
		if (!e || e.type !== "custom" || e.customType !== TEAM_EVENT_ENTRY_TYPE || !isRecord(e.data)) continue;
		const { teamId, kind } = e.data;
		if (typeof teamId !== "string" || !TEAM_ID.test(teamId)) continue;
		if (kind === "pause") paused.add(teamId);
		else if (kind === "resume") paused.delete(teamId);
	}
	return paused;
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

	/**
	 * `teamsDir`: where coordinated teams keep handover notes, `<teamsDir>/<session key>/<team_id>/handoffs`.
	 * `sessionKey` names the parent session (read when a team is created or restored): team IDs
	 * restart in every session, so without it two sessions' team_01 would share notes.
	 */
	constructor(private readonly teamsDir = "", private readonly sessionKey: () => string = () => "") {}

	private handoffDir(teamId: string): string { return path.join(this.teamsDir, this.sessionKey(), teamId, "handoffs"); }

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
		foldAssignments(branch, this.history);
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
			// Coordination is not persisted as such: a recorded coordinator member is what makes a team coordinated.
			if (m.duty === "coordinator" && !team.coordination) team.coordination = { handoffDir: this.handoffDir(team.id) };
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

	private checkMembers(members: readonly TeamMemberInput[], taken: Set<string>, defaults: TeamDefaults | undefined): { role: string; ownedPaths: string[]; orchestrator: boolean; duty?: MemberDuty; successorOf?: string; successorOfId?: string; task: string; input: TeamMemberInput }[] {
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
			if ((input.duty === "coordinator" || input.duty === "monitor") && memberTooling(memberBackend(input, defaults)) === "none")
				throw new Error(`The team's ${input.duty} ${role} must use the pi or claude-code backend.`);
			return {
				role, ownedPaths: checkPaths(role, input.ownedPaths), orchestrator, task: keepText((input.assignment ?? input.prompt).trim(), ASSIGNMENT_KEEP_CHARS),
				...(input.duty ? { duty: input.duty } : {}), ...(input.successorOf ? { successorOf: input.successorOf } : {}),
				...(input.successorOfId ? { successorOfId: input.successorOfId } : {}), input,
			};
		});
	}

	/** Validate and reserve a new team. Call release() in finally, whether or not it committed. */
	prepareCreate(input: { name: string; objective: string; defaults?: TeamDefaults; members: TeamMemberInput[]; coordination?: { defaults?: TeamDefaultsFile } }): PreparedCreate {
		const name = checkLabel("name", input.name);
		if (TEAM_ID.test(name)) throw new Error(`Team name ${name} looks like a team ID; choose a descriptive name.`);
		const objective = checkObjective(input.objective);
		const key = labelKey(name);
		if (this.all().some((t) => labelKey(t.name) === key) || this.pendingNames.has(key))
			throw new Error(`A team named ${name} already exists in this session history or is being created; team names are unique.`);
		if (this.session.length + this.pendingTeams >= MAX_SESSION_TEAMS)
			throw new Error(`Team limit reached (${MAX_SESSION_TEAMS} per session). Use team_add on an existing team.`);
		const checked = this.checkMembers(input.members, new Set(), input.defaults);
		const coordinators = checked.filter((m) => m.duty === "coordinator");
		if (input.coordination && coordinators.length !== 1) throw new Error("A coordinated team needs exactly one coordinator.");
		if (!input.coordination && checked.some((m) => m.duty)) throw new Error("Only a coordinated team has a coordinator or monitor.");
		const teamId = `team_${String(++this.counter).padStart(2, "0")}`;
		const team = { id: teamId, name, objective };
		const coordination = input.coordination ? { handoffDir: this.handoffDir(teamId) } : undefined;
		const header = coordination ? coordinationHeader({ ...coordination, defaults: input.coordination?.defaults }, coordinators[0].role) : undefined;
		const members = checked.map((m): PreparedMember => prepared(
			m, header !== undefined,
			composeMemberPrompt(team, m, checked.filter((o) => o !== m), m.input.prompt, "creation", memberTooling(memberBackend(m.input, input.defaults)), header),
			input.defaults,
		));
		this.pendingNames.add(key);
		this.pendingTeams++;
		let released = false;
		return {
			teamId, name, objective, defaults: input.defaults, members,
			...(coordination ? { coordination } : {}),
			release: () => {
				if (released) return;
				released = true;
				this.pendingNames.delete(key);
				this.pendingTeams--;
			},
		};
	}

	/**
	 * Validate and reserve roles on an existing session team. History teams are read-only.
	 * Ejected members keep their roles reserved but hold no seat. `observe` (exact IDs
	 * among retained workers) only names the ejectable members in the cap error.
	 * `teamDefaults` (read now) supplies a coordinated team's current standing text.
	 */
	prepareAdd(ref: string, members: TeamMemberInput[], observe?: (workerId: string) => WorkerObservation | undefined, teamDefaults?: TeamDefaultsFile): PreparedAdd {
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
		if (!team.coordination && checked.some((m) => m.duty)) throw new Error(`Team ${team.id} has no coordinator; only a coordinated team has a coordinator or monitor.`);
		if (team.coordination && checked.some((m) => m.orchestrator && m.duty !== "coordinator"))
			throw new Error(`Team ${team.id} has a coordinator; it cannot take another orchestrator.`);
		const existing = team.members.filter((m) => m.ejectedAt === undefined).map((m): HeaderMember => ({ role: m.role, ownedPaths: m.ownedPaths, orchestrator: m.orchestrator === true, ...(m.duty ? { duty: m.duty } : {}), ...(m.task ? { task: m.task } : {}), ...(m.steers?.length ? { steers: [...m.steers] } : {}) }));
		const coordinatorRole = checked.find((m) => m.duty === "coordinator" && m.successorOf)?.role ?? this.routingCoordinatorRecord(team)?.role;
		const header = team.coordination && coordinatorRole ? coordinationHeader({ ...team.coordination, defaults: teamDefaults }, coordinatorRole) : undefined;
		const composed = checked.map((m): PreparedMember => prepared(
			m, team.coordination !== undefined,
			composeMemberPrompt(team, m, [...existing, ...checked.filter((o) => o !== m)], m.input.prompt, "addition", memberTooling(memberBackend(m.input, team.defaults)), header),
			team.defaults,
		));
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
			defaults: prepared.defaults, ...(prepared.coordination ? { coordination: { ...prepared.coordination } } : {}),
			members: members.map((m, i) => ({ ...m, ownedPaths: [...m.ownedPaths], task: prepared.members[i]?.task })), actions: [],
		});
	}

	/** A successor inherits its predecessor's steers (N2: the main thread's follow-ups survive a succession). */
	commitAdd(prepared: PreparedAdd, members: PersistedMember[]): void {
		const team = this.session.find((t) => t.id === prepared.teamId);
		if (!team) return;
		members.forEach((m, i) => {
			const record: MemberRecord = { ...m, ownedPaths: [...m.ownedPaths], task: prepared.members[i]?.task };
			const from = m.successorOf ? team.members.find((x) => x.workerId === m.successorOf) : undefined;
			if (from) inheritSteers(record, from);
			team.members.push(record);
		});
	}

	/** Session entries for a committed batch: each non-duty member's task, and a successor's inheritance. */
	assignmentEntries(teamId: string, members: readonly PersistedMember[]): AssignmentEntryData[] {
		return members.flatMap((m): AssignmentEntryData[] => {
			const record = this.sessionMember(m.workerId)?.member;
			if (!record || record.duty) return [];
			return [
				...(record.task ? [{ version: 1 as const, teamId, workerId: m.workerId, op: "task" as const, task: record.task }] : []),
				...(m.successorOf ? [{ version: 1 as const, teamId, workerId: m.workerId, op: "inherit" as const, from: m.successorOf }] : []),
			];
		});
	}

	/** The assignment a member was given (in memory, or folded back from the session after a restore). */
	taskOf(workerId: string): string | undefined { return this.sessionMember(workerId)?.member.task; }

	/** The main thread's later instructions to a member, oldest first, and how many older ones were dropped. */
	steersOf(workerId: string): { steers: string[]; omitted: number } {
		const member = this.sessionMember(workerId)?.member;
		return { steers: [...(member?.steers ?? [])], omitted: member?.steersOmitted ?? 0 };
	}

	/**
	 * Keep the main thread's instructions to a member (its steers are assignments too). Returns the
	 * session entry to persist, or undefined when nothing was kept (a duty member, a blank steer).
	 */
	recordOperatorSteer(workerId: string, message: string): AssignmentEntryData | undefined {
		const found = this.sessionMember(workerId);
		if (!found || found.member.duty) return undefined;
		const text = message.trim();
		if (!text) return undefined;
		const steer = keepText(text, STEER_KEEP_CHARS);
		pushSteer(found.member, steer);
		return { version: 1, teamId: found.team.id, workerId, op: "steer", steer };
	}

	/** Every non-duty member's assignment and the main thread's later instructions, for the coordinator. */
	assignments(teamId: string): MemberAssignment[] {
		const team = this.session.find((t) => t.id === teamId);
		return (team?.members ?? []).filter((m) => !m.duty).map((m) => {
			const from = m.successorOf ? team!.members.find((p) => p.workerId === m.successorOf) : undefined;
			return {
				workerId: m.workerId, role: m.role, ...(m.task ? { task: m.task } : {}), steers: [...(m.steers ?? [])], steersOmitted: m.steersOmitted ?? 0,
				...(from ? { inheritedFrom: `${from.role} (${from.workerId})` } : {}),
			};
		});
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
		return {
			team: { id: found.team.id, name: found.team.name, ...(found.team.coordination ? { coordination: { ...found.team.coordination } } : {}) },
			member: copyMember(found.member),
			siblings: found.team.members.filter((m) => m !== found.member && m.ejectedAt === undefined).map(copyMember),
		};
	}

	/**
	 * The routing coordinator of a session team: the newest member with the coordinator duty that
	 * `isLive` accepts (a successor takes over the moment it starts). Undefined for an
	 * uncoordinated team, or when no coordinator is live.
	 */
	routingCoordinator(teamId: string, isLive: (workerId: string) => boolean): PersistedMember | undefined {
		const team = this.session.find((t) => t.id === teamId);
		if (!team?.coordination) return undefined;
		const found = this.routingCoordinatorRecord(team, isLive);
		return found && copyMember(found);
	}

	private routingCoordinatorRecord(team: TeamRecord, isLive: (workerId: string) => boolean = () => true): MemberRecord | undefined {
		const coordinators = team.members.filter((m) => m.duty === "coordinator" && isLive(m.workerId));
		return coordinators.sort((a, b) => b.addedAt - a.addedAt || idOrder(b.workerId) - idOrder(a.workerId))[0];
	}

	/** Every role in a session team (for successor naming). */
	roles(teamId: string): string[] {
		return this.session.find((t) => t.id === teamId)?.members.map((m) => m.role) ?? [];
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
		return found && this.pushAction(found, workerId, kind, source, message);
	}

	private pushAction(found: { team: TeamRecord; member: MemberRecord }, workerId: string, kind: TeamActionKind, source: TeamActionSource, message?: string): TeamAction {
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
	 * Validate a seat release on a session or history team (history is this session's
	 * branch, restored after a reload). `member` is an exact worker ID or a role.
	 * Refuses unknown or already-ejected members, and members
	 * whose worker is still working, idle or stopping, and those `held` names a reason
	 * for (a member mid-handover). Nothing changes here: persist ejectEntry(), then
	 * commitEject().
	 */
	checkEject(
		ref: string, member: string, observe: (workerId: string) => WorkerObservation | undefined, held?: (workerId: string) => string | undefined,
	): { teamId: string; workerId: string; role: string } {
		// A history team is this session's own branch, restored after a reload: the eject entry lands
		// on that same branch and folds back like any other, so its seats can be released too.
		const team = this.find(ref);
		const trimmed = member.trim();
		const found = WORKER_ID.test(trimmed)
			? team.members.find((m) => m.workerId === trimmed)
			: team.members.find((m) => labelKey(m.role) === labelKey(trimmed));
		if (!found) throw new Error(`No member ${trimmed} in ${team.id}. Members: ${team.members.map((m) => `${m.workerId} (${m.role})`).join(", ") || "none"}.`);
		if (found.ejectedAt !== undefined) throw new Error(`${found.role} (${found.workerId}) was already ejected from ${team.id} at ${ejectedStamp(found.ejectedAt)}.`);
		const reason = held?.(found.workerId);
		if (reason) throw new Error(`${found.role} (${found.workerId}) is mid-handover in ${team.id}: ${reason}.`);
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
		const team = this.all().find((t) => t.id === teamId);
		const member = team?.members.find((m) => m.workerId === workerId);
		if (!team || !member || member.ejectedAt !== undefined) return undefined;
		member.ejectedAt = at;
		// Also on a history team: its action list is this reload's, in memory like any other.
		const action = this.pushAction({ team, member }, workerId, "eject", source);
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
				const base = {
					workerId: m.workerId, role: m.role, ownedPaths: [...m.ownedPaths], orchestrator: m.orchestrator === true,
					...(m.duty ? { duty: m.duty } : {}), backend: m.backend, groupId: m.groupId, addedAt: m.addedAt,
				};
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
				...(team.members.some((m) => m.duty === "coordinator") ? { coordinated: true as const } : {}),
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
