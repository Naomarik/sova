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
	awaitResponse,
	decodeMemberContext,
	readInbox,
	requestId,
	writeRequest,
	type MailboxRequest,
	type MemberContext,
} from "./mailbox.ts";

/** Member-safe tool names; the parent's spawn/kill/agent tools are never among them. */
export const MEMBER_TOOLS = ["team_msg", "team_inbox", "team_ask"] as const;
export const ORCHESTRATOR_TOOLS = ["team_roster", "team_steer"] as const;

export interface MemberToolOptions {
	/** How long a tool waits for the parent's response; the parent's own deadlines are shorter. */
	timeoutMs?: number;
	pollMs?: number;
}
const DEFAULT_TIMEOUT_MS = 45_000;
const Nonempty = Type.String({ minLength: 1 });
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
	const who = `${me.role} (${me.workerId}) in ${me.teamId}`;
	pi.registerTool({
		name: "team_msg",
		label: "Message Team Member",
		description:
			`Send a message to another member of your team (${me.teamId}) by role or worker ID, or to "all" for every live sibling. The parent session delivers it as a new message in their session (they see it at their next step, or it starts a task if they are idle). Returns per-recipient delivery acceptance, not proof they acted. You cannot message yourself or workers outside your team.`,
		promptSnippet: "Message a teammate by role (delivered by the parent session)",
		parameters: Type.Object(
			{ to: Type.String({ minLength: 1, description: "Recipient role, worker ID (ag_NN), or \"all\"." }), message: Message },
			{ additionalProperties: false },
		),
		async execute(_id, params, signal) {
			if (!params.message.trim()) throw new Error("Message must not be blank.");
			return send({ type: "message", to: params.to.trim(), message: params.message }, signal);
		},
	});
	pi.registerTool({
		name: "team_inbox",
		label: "Team Inbox",
		description:
			"List messages and orchestrator instructions delivered to you so far (newest last). Deliveries also arrive as messages in your session; use this to re-read them.",
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
	pi.registerTool({
		name: "team_ask",
		label: "Ask the Operator",
		description:
			"Raise a question to the operator (the parent Pi session and its user). It is surfaced there and starts a parent turn if it is idle; the answer comes back later as a new message in your session. This does not block: continue with work that does not depend on the answer, or end your turn and you will be resumed with the answer.",
		promptSnippet: "Ask the operator (parent session/user) a question; the answer arrives as a later message",
		parameters: Type.Object({ question: Message }, { additionalProperties: false }),
		async execute(_id, params, signal) {
			if (!params.question.trim()) throw new Error("Question must not be blank.");
			return send({ type: "question", message: params.question }, signal);
		},
	});
	if (!me.orchestrator) return;
	pi.registerTool({
		name: "team_roster",
		label: "Team Roster",
		description:
			`Live roster of your team (${me.teamId}): each member's role, worker ID, backend, model, state, task outcome and declared ownership, plus recent control actions. Read-only; you are ${who}.`,
		promptSnippet: "Show your team's live roster and member states",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_id, _params, signal) {
			return send({ type: "roster" }, signal);
		},
	});
	pi.registerTool({
		name: "team_steer",
		label: "Steer Team Member",
		description:
			"Orchestrator only: send instructions to one sibling in your team by role or worker ID. mode=followUp queues after their current task; mode=redirect changes their current task; omitted uses the backend's normal steering. An idle sibling starts a fresh task. Acceptance is not execution; check team_roster. You cannot start, add or stop members; ask the operator with team_ask for that.",
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
}

export default function teamMemberExtension(pi: ExtensionAPI): void {
	const me = decodeMemberContext(process.env[MEMBER_ENV]);
	if (!me) return; // Not a team member child: inert by design.
	registerMemberTools(pi, me);
}
