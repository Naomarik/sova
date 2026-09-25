/**
 * Team member tools, loaded ONLY into team member children (`-e member.ts` on
 * top of `--no-extensions`). Every tool writes a request into this member's own
 * mailbox directory and waits for the parent extension's response; the parent
 * performs the delivery, steer or question surfacing. Nothing here can spawn,
 * add or stop workers, and nothing here reaches another member's process.
 *
 * Without a valid MEMBER_ENV identity (issued by the parent at spawn) this file
 * registers nothing, so loading it elsewhere is inert. It must never import
 * index.ts: a child that loaded the manager could delegate recursively.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	MAX_MESSAGE_CHARS,
	MEMBER_ENV,
	REPORT_KINDS,
	awaitResponse,
	decodeMemberContext,
	memberToolNames,
	memberToolText,
	readInbox,
	requestId,
	writeRequest,
	type MailboxRequest,
	type MemberContext,
} from "./mailbox.ts";

export { MEMBER_TOOLS, ORCHESTRATOR_TOOLS, COORDINATOR_TOOLS, MONITOR_TOOLS, SUCCESSOR_TOOLS } from "./mailbox.ts";

export interface MemberToolOptions {
	/** How long a tool waits for the parent's response; the parent's own deadlines are shorter. */
	timeoutMs?: number;
	pollMs?: number;
}
const DEFAULT_TIMEOUT_MS = 45_000;
const Message = Type.String({ minLength: 1, maxLength: MAX_MESSAGE_CHARS });

const toolResult = (text: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text }], details });

export function registerMemberTools(pi: ExtensionAPI, me: MemberContext, options: MemberToolOptions = {}): void {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const send = async (request: Omit<MailboxRequest, "version" | "id" | "at">, signal?: AbortSignal) => {
		signal?.throwIfAborted();
		const full: MailboxRequest = { version: 1, id: requestId(), at: Date.now(), ...request };
		writeRequest(me.dir, full);
		const response = await awaitResponse(me.dir, full.id, timeoutMs, signal, options.pollMs);
		if (!response) {
			throw new Error(signal?.aborted
				? "Cancelled while waiting for the parent session; the request may still be handled."
				: `No response from the parent session within ${Math.round(timeoutMs / 1000)}s; it may be shutting down. The request may still be handled; check team_inbox or retry once.`);
		}
		if (!response.ok) throw new Error(response.text);
		return toolResult(response.text, { request: full.type, ...(response.details && typeof response.details === "object" ? response.details as Record<string, unknown> : {}) });
	};
	const text = memberToolText(me);
	const tools = new Set(memberToolNames(me));
	if (tools.has("team_msg")) pi.registerTool({
		name: "team_msg",
		label: "Message Team Member",
		description: text.team_msg,
		promptSnippet: "Message a teammate by role (delivered by the parent session)",
		parameters: Type.Object(
			{
				to: Type.String({ minLength: 1, description: "Recipient role, worker ID (ag_NN), or \"all\"." }),
				message: Message,
				...(me.duty === "monitor" ? { notice: Type.Optional(StringEnum(["wrap-up", "pause", "resume"] as const)) } : {}),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params: { to: string; message: string; notice?: "wrap-up" | "pause" | "resume" }, signal) {
			if (!params.message.trim()) throw new Error("Message must not be blank.");
			return send({ type: "message", to: params.to.trim(), message: params.message, ...(params.notice ? { notice: params.notice } : {}) }, signal);
		},
	});
	if (tools.has("team_inbox")) pi.registerTool({
		name: "team_inbox",
		label: "Team Inbox",
		description: text.team_inbox,
		parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })) }, { additionalProperties: false }),
		async execute(_id, params) {
			const records = readInbox(me.dir, params.limit ?? 50);
			return toolResult(
				records.length
					? records.map((r) => `[${new Date(r.at).toISOString()}] ${r.kind} from ${r.from} (${r.fromId}):\n${r.text}`).join("\n\n")
					: "No messages delivered to you yet.",
				{ count: records.length, records },
			);
		},
	});
	if (tools.has("team_ask")) pi.registerTool({
		name: "team_ask",
		label: me.coordinated ? "Ask the Coordinator" : "Ask the Operator",
		description: text.team_ask,
		promptSnippet: me.coordinated
			? "Ask your team's coordinator a question; the answer arrives as a later message"
			: "Ask the operator (parent session/user) a question; the answer arrives as a later message",
		parameters: Type.Object({ question: Message }, { additionalProperties: false }),
		async execute(_id, params, signal) {
			if (!params.question.trim()) throw new Error("Question must not be blank.");
			return send({ type: "question", message: params.question }, signal);
		},
	});
	if (tools.has("team_roster")) pi.registerTool({
		name: "team_roster",
		label: "Team Roster",
		description: text.team_roster,
		promptSnippet: "Show your team's live roster, member states and context sizes",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, signal) {
			return send({ type: "roster" }, signal);
		},
	});
	if (tools.has("team_steer")) pi.registerTool({
		name: "team_steer",
		label: "Steer Team Member",
		description: text.team_steer,
		promptSnippet: "Orchestrator: redirect or queue follow-up instructions for a teammate",
		parameters: Type.Object(
			{ to: Type.String({ minLength: 1, description: "Sibling role or worker ID (not yourself, not \"all\")." }), message: Message, mode: Type.Optional(StringEnum(["redirect", "followUp"] as const)) },
			{ additionalProperties: false },
		),
		async execute(_id, params, signal) {
			if (!params.message.trim()) throw new Error("Instructions must not be blank.");
			return send({ type: "steer", to: params.to.trim(), message: params.message, ...(params.mode ? { mode: params.mode } : {}) }, signal);
		},
	});
	if (tools.has("team_report")) pi.registerTool({
		name: "team_report",
		label: "Report to the Operator",
		description: text.team_report,
		promptSnippet: "Coordinator: report a milestone or concern to the operator (no action requested)",
		parameters: Type.Object(
			{ report: Message, kind: Type.Optional(StringEnum(REPORT_KINDS, { description: "milestone or concern" })) },
			{ additionalProperties: false },
		),
		async execute(_id, params, signal) {
			if (!params.report.trim()) throw new Error("Report must not be blank.");
			return send({ type: "report", message: params.report, ...(params.kind ? { reportKind: params.kind } : {}) }, signal);
		},
	});
	if (tools.has("team_succeed")) pi.registerTool({
		name: "team_succeed",
		label: "Start a Successor",
		description: text.team_succeed,
		promptSnippet: "Coordinator: replace a member running out of context with a successor",
		parameters: Type.Object({ role: Type.String({ minLength: 1, description: "Role (or worker ID) of the member to succeed." }) }, { additionalProperties: false }),
		async execute(_id, params, signal) {
			return send({ type: "succeed", to: params.role.trim() }, signal);
		},
	});
	if (tools.has("team_ready")) pi.registerTool({
		name: "team_ready",
		label: "Confirm Takeover",
		description: text.team_ready,
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, signal) {
			return send({ type: "ready" }, signal);
		},
	});
	if (tools.has("wake_nudge")) pi.registerTool({
		name: "wake_nudge",
		label: "Wake nudge",
		description: text.wake_nudge,
		promptSnippet: "wake_nudge: schedule/list/cancel a one-shot wakeup that starts a new task later",
		parameters: Type.Object(
			{
				action: StringEnum(["schedule", "list", "cancel"] as const, { description: "What to do" }),
				delay: Type.Optional(Type.String({ description: "Relative delay, e.g. 5m" })),
				at: Type.Optional(Type.String({ description: "Absolute ISO-8601 fire time" })),
				reason: Type.Optional(Type.String({ description: "What to do on wake" })),
				id: Type.Optional(Type.String({ description: "Nudge id to cancel" })),
			},
			{ additionalProperties: false },
		),
		async execute(_id, params, signal) {
			const { action, delay, at, reason, id } = params;
			return send({ type: "nudge", nudge: { action, ...(delay ? { delay } : {}), ...(at ? { at } : {}), ...(reason ? { reason } : {}), ...(id ? { id } : {}) } }, signal);
		},
	});
}

export default function teamMemberExtension(pi: ExtensionAPI): void {
	const me = decodeMemberContext(process.env[MEMBER_ENV]);
	if (!me) return; // Not a team member child: inert by design.
	registerMemberTools(pi, me);
}
