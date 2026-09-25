/**
 * File mailbox between the parent extension and its team members. The parent
 * owns a private root (one directory per team member); a member's tools write
 * request files into its own directory and wait for the parent's response file.
 * The parent derives the sender from the directory, never from file contents,
 * and performs every delivery itself (steer, question surfacing), so members
 * hold no channel into each other's processes.
 *
 * No process, UI or manager dependency: index.ts (parent) and member.ts (child)
 * both import this file; member.ts must never import index.ts.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const MEMBER_ENV = "PI_SUBAGENTS_TEAM_MEMBER";
export const MAX_MESSAGE_CHARS = 8000;
export const MAX_INBOX_RECORDS = 200;
const MAX_REF_CHARS = 64;
// Single-line fields (recipient, role, team name): no control characters at all, newline included.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const REQUEST_ID = /^[a-z0-9]{6,32}$/;
const REQUEST_TYPES = new Set(["message", "steer", "roster", "question", "report", "succeed", "ready", "nudge"]);
const STEER_MODES = new Set(["redirect", "followUp"]);
const NOTICES = new Set(["wrap-up", "pause", "resume"]);
const NUDGE_ACTIONS = new Set(["schedule", "list", "cancel"]);
const MAX_NUDGE_FIELD_CHARS = 500;

/** Passed to a member child through MEMBER_ENV as JSON; the child trusts only its own dir. */
export interface MemberContext {
	version: 1;
	teamId: string;
	teamName: string;
	workerId: string;
	role: string;
	orchestrator: boolean;
	/** This member's private mailbox directory, created by the parent. */
	dir: string;
	/** A standing role from team defaults: the team's coordinator, or its monitor. */
	duty?: MemberDuty;
	/** A member of a team with a coordinator: its questions and completions go there, not to the operator. */
	coordinated?: boolean;
	/** The role this member succeeds (team_succeed); only a successor has team_ready. */
	successorOf?: string;
}
export type MemberDuty = "coordinator" | "monitor";
export type RequestType = "message" | "steer" | "roster" | "question" | "report" | "succeed" | "ready" | "nudge";
export type MonitorNotice = "wrap-up" | "pause" | "resume";
/** team_report's optional kind; Sova shows it on the report. */
export const REPORT_KINDS = ["milestone", "concern"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export interface NudgeRequest {
	action: "schedule" | "list" | "cancel";
	delay?: string;
	/** Absolute ISO-8601 fire time. */
	at?: string;
	reason?: string;
	id?: string;
}
export interface MailboxRequest {
	version: 1;
	id: string;
	type: RequestType;
	at: number;
	/** Recipient role, worker ID, or "all" (message only). */
	to?: string;
	message?: string;
	mode?: "redirect" | "followUp";
	/** Monitor only (team_msg): what the message asks for, recorded as a team action of that kind. */
	notice?: MonitorNotice;
	/** team_report only: what the report is. */
	reportKind?: ReportKind;
	/** wake_nudge (monitor only). */
	nudge?: NudgeRequest;
}
export interface MailboxResponse {
	version: 1;
	id: string;
	ok: boolean;
	text: string;
	details?: unknown;
}
export interface InboxRecord {
	at: number;
	kind: "message" | "instruction";
	from: string;
	fromId: string;
	text: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isLine = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max && !CONTROL.test(value);

/** Member-safe tool names; the parent's spawn/kill/agent tools are never among them. */
export const MEMBER_TOOLS = ["team_msg", "team_inbox", "team_ask"] as const;
export const ORCHESTRATOR_TOOLS = ["team_roster", "team_steer"] as const;
export const COORDINATOR_TOOLS = ["team_report", "team_succeed"] as const;
export const MONITOR_TOOLS = ["team_msg", "team_inbox", "team_roster", "wake_nudge"] as const;
export const SUCCESSOR_TOOLS = ["team_ready"] as const;

/**
 * The one list of member tools a member really has, shared by member.ts, member-mcp.ts and the
 * team header. A monitor has MONITOR_TOOLS (no team_ask: it never reaches the operator);
 * everyone else has MEMBER_TOOLS, plus the orchestrator pair and the coordinator pair. Any
 * successor, a monitor's included, also has team_ready.
 */
export function memberToolNames(me: { orchestrator?: boolean; duty?: MemberDuty; successorOf?: string }): string[] {
	if (me.duty === "monitor") return [...MONITOR_TOOLS, ...(me.successorOf ? SUCCESSOR_TOOLS : [])];
	return [
		...(me.orchestrator ? ORCHESTRATOR_TOOLS : []),
		...MEMBER_TOOLS,
		...(me.duty === "coordinator" ? COORDINATOR_TOOLS : []),
		...(me.successorOf ? SUCCESSOR_TOOLS : []),
	];
}

/** Tool texts shared with member-mcp.ts, so a pi member and a Claude member read the same contract. */
export const memberToolText = (me: MemberContext) => {
	const who = `${me.role} (${me.workerId}) in ${me.teamId}`;
	return {
		team_msg: me.duty === "monitor"
			? `Send a message to another member of your team (${me.teamId}) by role or worker ID, or to "all". Set notice to wrap-up (a member over the context threshold must write its handover note and end its turn), pause (usage is at the limit: the team must wrap up and go idle) or resume (usage has reset: the team may continue); a notice is recorded in the team's action history. You cannot reach the operator.`
			: `Send a message to another member of your team (${me.teamId}) by role or worker ID, or to "all" for every live sibling. The parent session delivers it as a new message in their session (they see it at their next step, or it starts a task if they are idle). Returns per-recipient delivery acceptance, not proof they acted. You cannot message yourself or workers outside your team.`,
		team_inbox: "List messages and orchestrator instructions delivered to you so far (newest last). Deliveries also arrive as messages in your session; use this to re-read them.",
		team_ask: me.coordinated
			? "Raise a question to your team's coordinator (not the operator: in this team only the coordinator talks to the operator). The answer comes back later as a new message in your session. This does not block: continue with work that does not depend on the answer, or end your turn and you will be resumed with the answer."
			: "Raise a question to the operator (the parent Pi session and its user). It is surfaced there and starts a parent turn if it is idle; the answer comes back later as a new message in your session. This does not block: continue with work that does not depend on the answer, or end your turn and you will be resumed with the answer.",
		team_roster: me.duty === "monitor"
			? `Read-only live roster of your team (${me.teamId}): each member's role, worker ID, backend, state and context (tokens/window/%), the current monitor thresholds from team defaults, and the provider usage windows the team's models spend from. You are ${who}.`
			: `Live roster of your team (${me.teamId}): each member's role, worker ID, backend, model, state, context (tokens/window/%), task outcome and declared ownership, plus recent control actions. Read-only; you are ${who}.`,
		team_steer: "Orchestrator only: send instructions to one sibling in your team by role or worker ID. mode=followUp queues after their current task; mode=redirect changes their current task; omitted uses the backend's normal steering. An idle sibling starts a fresh task. Acceptance is not execution; check team_roster. You cannot start, add or stop members; ask the operator with team_ask for that.",
		team_report: "Coordinator only: report a milestone or a concern to the operator; set kind to milestone or concern. It is shown to them as a team-report message and does NOT start a turn or ask for action; use team_ask for a question or a decision you need.",
		team_succeed: "Coordinator only: replace a member whose context is running out (the monitor tells you) with a fresh successor on the same backend, model and effort, named <role>-<n+1>. A working member is first told to write its handover note and end its turn; its successor starts once the note exists and that turn has ended (or at the handover timeout), and you get a message naming it. A monitor has no note: its successor starts at once and is briefed over team_msg. The old member is retired when the successor confirms with team_ready, or after the handover timeout. You can start nothing else and stop no one.",
		team_ready: me.duty === "monitor"
			? "Successor only: confirm you have taken over from the monitor you succeed (it briefed you over team_msg). The parent then retires that monitor, with its pending nudges; you continue the standing instruction."
			: "Successor only: confirm you have taken over from the member you succeed (you read its handover note and asked what you needed). The parent then retires that member; you continue its work.",
		wake_nudge: "Monitor only: schedule a wakeup. At the fire time the parent session delivers a [wake_nudge <id>] message that starts a new task for you, even while idle. action schedule needs delay (e.g. 30s, 5m, 1h30m) or at (ISO-8601); at least 10s and at most 24h ahead; at most 5 pending. list shows pending nudges; cancel takes id. After scheduling, end your turn; never sleep in a shell.",
	};
};

export const memberPaths = (dir: string) => ({
	requests: path.join(dir, "requests"),
	responses: path.join(dir, "responses"),
	inbox: path.join(dir, "inbox.jsonl"),
});

/** Private directories; the parent calls this before starting the member. */
export function initMemberDir(dir: string): void {
	const p = memberPaths(dir);
	fs.mkdirSync(p.requests, { recursive: true, mode: 0o700 });
	fs.mkdirSync(p.responses, { recursive: true, mode: 0o700 });
}

export function requestId(): string {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Write-then-rename so a reader never observes a partial file. */
function writeAtomic(file: string, data: string): void {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, data, { encoding: "utf8", mode: 0o600 });
	fs.renameSync(tmp, file);
}

export function encodeMemberContext(ctx: MemberContext): string {
	return JSON.stringify(ctx);
}

/** Strict: anything malformed yields undefined, so a child never runs with guessed identity. */
export function decodeMemberContext(raw: string | undefined): MemberContext | undefined {
	if (!raw) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(value) || value.version !== 1) return undefined;
	const { teamId, teamName, workerId, role, orchestrator, dir, duty, coordinated, successorOf } = value;
	if (typeof teamId !== "string" || !/^team_\d+$/.test(teamId)) return undefined;
	if (typeof workerId !== "string" || !/^ag_\d+$/.test(workerId)) return undefined;
	if (!isLine(teamName, MAX_REF_CHARS) || !isLine(role, MAX_REF_CHARS)) return undefined;
	if (typeof orchestrator !== "boolean") return undefined;
	if (typeof dir !== "string" || !path.isAbsolute(dir)) return undefined;
	if (duty !== undefined && duty !== "coordinator" && duty !== "monitor") return undefined;
	if (coordinated !== undefined && typeof coordinated !== "boolean") return undefined;
	if (successorOf !== undefined && !isLine(successorOf, MAX_REF_CHARS)) return undefined;
	return {
		version: 1, teamId, teamName, workerId, role, orchestrator, dir,
		...(duty === undefined ? {} : { duty }), ...(coordinated ? { coordinated: true } : {}), ...(successorOf === undefined ? {} : { successorOf }),
	};
}

export function decodeRequest(value: unknown): MailboxRequest | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	const { id, type, at, to, message, mode, notice, reportKind, nudge } = value;
	if (typeof id !== "string" || !REQUEST_ID.test(id)) return undefined;
	if (typeof type !== "string" || !REQUEST_TYPES.has(type)) return undefined;
	if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
	if (to !== undefined && !isLine(to, MAX_REF_CHARS)) return undefined;
	if (message !== undefined && (typeof message !== "string" || message.length > MAX_MESSAGE_CHARS)) return undefined;
	if (mode !== undefined && (typeof mode !== "string" || !STEER_MODES.has(mode))) return undefined;
	if (notice !== undefined && (typeof notice !== "string" || !NOTICES.has(notice))) return undefined;
	if (reportKind !== undefined && !REPORT_KINDS.includes(reportKind as ReportKind)) return undefined;
	let decodedNudge: NudgeRequest | undefined;
	if (nudge !== undefined) {
		decodedNudge = decodeNudge(nudge);
		if (!decodedNudge) return undefined;
	}
	const out: MailboxRequest = { version: 1, id, type: type as RequestType, at };
	if (to !== undefined) out.to = to.trim();
	if (message !== undefined) out.message = message;
	if (mode !== undefined) out.mode = mode as MailboxRequest["mode"];
	if (notice !== undefined) out.notice = notice as MonitorNotice;
	if (reportKind !== undefined) out.reportKind = reportKind as ReportKind;
	if (decodedNudge) out.nudge = decodedNudge;
	return out;
}

function decodeNudge(value: unknown): NudgeRequest | undefined {
	if (!isRecord(value)) return undefined;
	const { action, delay, at, reason, id } = value;
	if (typeof action !== "string" || !NUDGE_ACTIONS.has(action)) return undefined;
	const field = (v: unknown) => v === undefined || (typeof v === "string" && v.length <= MAX_NUDGE_FIELD_CHARS && !CONTROL.test(v));
	if (![delay, at, reason, id].every(field)) return undefined;
	return {
		action: action as NudgeRequest["action"],
		...(typeof delay === "string" ? { delay } : {}), ...(typeof at === "string" ? { at } : {}),
		...(typeof reason === "string" ? { reason } : {}), ...(typeof id === "string" ? { id } : {}),
	};
}

export function decodeResponse(value: unknown): MailboxResponse | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	const { id, ok, text, details } = value;
	if (typeof id !== "string" || !REQUEST_ID.test(id) || typeof ok !== "boolean" || typeof text !== "string") return undefined;
	return { version: 1, id, ok, text, ...(details === undefined ? {} : { details }) };
}

/** Child side: enqueue one request in this member's own directory. */
export function writeRequest(dir: string, request: MailboxRequest): void {
	writeAtomic(path.join(memberPaths(dir).requests, `${request.id}.json`), JSON.stringify(request));
}

/**
 * Parent side: take every pending request out of a member directory. Files are
 * removed as they are read, so a request is handled at most once; malformed
 * files are removed and reported as such.
 */
export function takeRequests(dir: string): { request?: MailboxRequest; file: string }[] {
	const requests = memberPaths(dir).requests;
	let names: string[];
	try {
		names = fs.readdirSync(requests).filter((n) => n.endsWith(".json")).sort();
	} catch {
		return [];
	}
	const out: { request?: MailboxRequest; file: string }[] = [];
	for (const name of names) {
		const file = path.join(requests, name);
		let raw: string;
		try {
			raw = fs.readFileSync(file, "utf8");
			fs.unlinkSync(file);
		} catch {
			continue; // Taken concurrently or vanished; nothing to answer.
		}
		let request: MailboxRequest | undefined;
		try {
			request = decodeRequest(JSON.parse(raw));
		} catch {
			request = undefined;
		}
		out.push({ request, file });
	}
	return out;
}

export function writeResponse(dir: string, response: MailboxResponse): void {
	writeAtomic(path.join(memberPaths(dir).responses, `${response.id}.json`), JSON.stringify(response));
}

/** Child side: read and remove the response for a request, if it has arrived. */
export function takeResponse(dir: string, id: string): MailboxResponse | undefined {
	const file = path.join(memberPaths(dir).responses, `${id}.json`);
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
	try {
		fs.unlinkSync(file);
	} catch {
		/* Already gone. */
	}
	try {
		return decodeResponse(JSON.parse(raw));
	} catch {
		return undefined;
	}
}

/** Poll for the parent's response; undefined on timeout or abort (the request may still be handled). */
export async function awaitResponse(dir: string, id: string, timeoutMs: number, signal?: AbortSignal, pollMs = 100): Promise<MailboxResponse | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (!signal?.aborted) {
		const response = takeResponse(dir, id);
		if (response) return response;
		if (Date.now() >= deadline) return undefined;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(finish, Math.min(pollMs, Math.max(0, deadline - Date.now())));
			function finish() {
				clearTimeout(timer);
				signal?.removeEventListener("abort", finish);
				resolve();
			}
			signal?.addEventListener("abort", finish, { once: true });
			if (signal?.aborted) finish();
		});
	}
	return undefined;
}

/** Parent side: record a delivery in the recipient's inbox (read by team_inbox). */
export function appendInbox(dir: string, record: InboxRecord): void {
	fs.appendFileSync(memberPaths(dir).inbox, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function readInbox(dir: string, limit = MAX_INBOX_RECORDS): InboxRecord[] {
	let raw: string;
	try {
		raw = fs.readFileSync(memberPaths(dir).inbox, "utf8");
	} catch {
		return [];
	}
	const out: InboxRecord[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value = JSON.parse(line);
			if (isRecord(value) && typeof value.at === "number" && (value.kind === "message" || value.kind === "instruction")
				&& typeof value.from === "string" && typeof value.fromId === "string" && typeof value.text === "string")
				out.push({ at: value.at, kind: value.kind, from: value.from, fromId: value.fromId, text: value.text });
		} catch {
			/* Skip a torn line. */
		}
	}
	return out.slice(-limit);
}

/**
 * Parent side: every pending request under the root, keyed by the directory
 * that produced it (`<root>/<teamId>/<workerId>`). Sender identity comes from
 * the path; the request body is never trusted for it.
 */
export function scanMailboxRoot(root: string): { teamId: string; workerId: string; dir: string; request?: MailboxRequest; file: string }[] {
	const out: { teamId: string; workerId: string; dir: string; request?: MailboxRequest; file: string }[] = [];
	let teams: string[];
	try {
		teams = fs.readdirSync(root).filter((n) => /^team_\d+$/.test(n));
	} catch {
		return out;
	}
	for (const teamId of teams) {
		let members: string[];
		try {
			members = fs.readdirSync(path.join(root, teamId)).filter((n) => /^ag_\d+$/.test(n));
		} catch {
			continue;
		}
		for (const workerId of members) {
			const dir = path.join(root, teamId, workerId);
			for (const taken of takeRequests(dir)) out.push({ teamId, workerId, dir, ...taken });
		}
	}
	return out;
}
