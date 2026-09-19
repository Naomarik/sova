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
const REQUEST_TYPES = new Set(["message", "steer", "roster", "question"]);
const STEER_MODES = new Set(["redirect", "followUp"]);

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
}
export type RequestType = "message" | "steer" | "roster" | "question";
export interface MailboxRequest {
	version: 1;
	id: string;
	type: RequestType;
	at: number;
	/** Recipient role, worker ID, or "all" (message only). */
	to?: string;
	message?: string;
	mode?: "redirect" | "followUp";
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
	const { teamId, teamName, workerId, role, orchestrator, dir } = value;
	if (typeof teamId !== "string" || !/^team_\d+$/.test(teamId)) return undefined;
	if (typeof workerId !== "string" || !/^ag_\d+$/.test(workerId)) return undefined;
	if (!isLine(teamName, MAX_REF_CHARS) || !isLine(role, MAX_REF_CHARS)) return undefined;
	if (typeof orchestrator !== "boolean") return undefined;
	if (typeof dir !== "string" || !path.isAbsolute(dir)) return undefined;
	return { version: 1, teamId, teamName, workerId, role, orchestrator, dir };
}

export function decodeRequest(value: unknown): MailboxRequest | undefined {
	if (!isRecord(value) || value.version !== 1) return undefined;
	const { id, type, at, to, message, mode } = value;
	if (typeof id !== "string" || !REQUEST_ID.test(id)) return undefined;
	if (typeof type !== "string" || !REQUEST_TYPES.has(type)) return undefined;
	if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
	if (to !== undefined && !isLine(to, MAX_REF_CHARS)) return undefined;
	if (message !== undefined && (typeof message !== "string" || message.length > MAX_MESSAGE_CHARS)) return undefined;
	if (mode !== undefined && (typeof mode !== "string" || !STEER_MODES.has(mode))) return undefined;
	const out: MailboxRequest = { version: 1, id, type: type as RequestType, at };
	if (to !== undefined) out.to = to.trim();
	if (message !== undefined) out.message = message;
	if (mode !== undefined) out.mode = mode as MailboxRequest["mode"];
	return out;
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
