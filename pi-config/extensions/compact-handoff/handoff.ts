/**
 * The pure half of /compact-handoff: the instruction, finding the note in the handoff reply, the
 * note file and its session entry, and the hidden message that brings it back after a compaction.
 * Builtins only; index.ts wires these into pi.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The session's custom entry holding the newest note on its branch (not model context). */
export const HANDOFF_ENTRY = "compact-handoff";
/** The hidden custom message that starts the handoff turn. */
export const REQUEST_MESSAGE = "compact-handoff-request";
/** The hidden custom message that puts the note back after a compaction. */
export const NOTE_MESSAGE = "compact-handoff-note";
/** Directory under the agent dir, one `<session id>.md` per session. */
export const HANDOFF_DIR = "compact-handoffs";

/** `{v: 1, path, note, at, leafId}`: where the note was saved, its text, when (ISO) and the leaf it was written at. */
export interface HandoffEntryData {
	v: 1;
	path: string;
	note: string;
	at: string;
	leafId: string | null;
}

/** `PI_CODING_AGENT_DIR` (a leading `~` expanded) when set, else `~/.pi/agent` — as pi's getAgentDir() resolves it. */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	const raw = env.PI_CODING_AGENT_DIR;
	if (!raw) return path.join(os.homedir(), ".pi", "agent");
	if (raw === "~") return os.homedir();
	return raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
}

/** The note file for a session; a session id that could leave the directory is refused. */
export function handoffPath(dir: string, sessionId: string): string {
	if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId.startsWith(".")) throw new Error(`Unusable session id for a handoff file: ${JSON.stringify(sessionId)}`);
	return path.join(dir, HANDOFF_DIR, `${sessionId}.md`);
}

/** The hidden instruction that starts the handoff turn. */
export function requestInstruction(focus: string): string {
	const lines = [
		"The user ran /compact-handoff: this session is about to be compacted, and the summary will lose detail. Before it does:",
		"",
		"1. Persist anything durable to its usual place with your normal tools (alignments, plans, memory, notes). Do not compact or start other work.",
		"2. End your reply with a handoff note for yourself inside <handoff>…</handoff>: what must survive the compaction that a summary would flatten (decisions and why, the user's preferences and corrections, open questions, exact current state, next steps), and the exact files, ids and commands to re-read before continuing.",
		"",
		"The note is saved and added back right after the summary. Keep it self-contained and specific; do not repeat what the files already say.",
	];
	if (focus) lines.push("", `The user's focus for this handoff and the summary: ${focus}`, "Include that focus in the note.");
	return lines.join("\n");
}

const BLOCK = /<handoff>([\s\S]*?)<\/handoff>/g;

/** The last non-empty `<handoff>` block in a text, trimmed. */
export function extractHandoff(text: string): string | undefined {
	let found: string | undefined;
	for (const match of text.matchAll(BLOCK)) {
		const body = match[1]!.trim();
		if (body) found = body;
	}
	return found;
}

/** The visible text of an assistant message (thinking and tool calls left out). */
export function assistantText(message: unknown): string {
	const content = (message as { content?: unknown })?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text as string).join("\n");
}

/** A session entry, as much of it as this extension reads. */
export interface BranchEntry {
	type: string;
	id: string;
	customType?: string;
	details?: unknown;
	data?: unknown;
	message?: { role?: string; stopReason?: string; content?: unknown };
}

export type Capture =
	| { kind: "missing" }
	| { kind: "stopped" }
	| { kind: "failed"; error?: string }
	| { kind: "no-note" }
	| { kind: "note"; note: string };

/**
 * What the handoff turn left on this branch: after the request message with this id, the newest
 * `<handoff>` block in an assistant reply (a follow-up reply in the same run may carry it). A run
 * whose last reply was stopped or failed yields no note, even if an earlier reply had one.
 */
export function captureHandoff(branch: readonly BranchEntry[], requestId: string): Capture {
	const start = branch.findIndex((e) => e.type === "custom_message" && e.customType === REQUEST_MESSAGE && (e.details as { id?: unknown })?.id === requestId);
	if (start < 0) return { kind: "missing" };
	let note: string | undefined;
	let last: BranchEntry["message"] | undefined;
	for (const entry of branch.slice(start + 1)) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		last = entry.message;
		note = extractHandoff(assistantText(entry.message)) ?? note;
	}
	if (last?.stopReason === "aborted") return { kind: "stopped" };
	if (last?.stopReason === "error") return { kind: "failed", error: (last as { errorMessage?: string }).errorMessage };
	return note ? { kind: "note", note } : { kind: "no-note" };
}

/** The note file: a header naming the session, then the note. */
export function noteFile(fields: { sessionId: string; cwd: string; at: string; leafId: string | null; focus: string }, note: string): string {
	return [
		"# Compact handoff",
		"",
		`- session: ${fields.sessionId}`,
		`- cwd: ${fields.cwd}`,
		`- written: ${fields.at}`,
		`- leaf: ${fields.leafId ?? "(none)"}`,
		`- focus: ${fields.focus || "(none)"}`,
		"",
		note,
		"",
	].join("\n");
}

/** Write the file atomically: directory 0700, file 0600, a temp file renamed over the old one. */
export function writeNoteFile(file: string, content: string): void {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.chmodSync(dir, 0o700);
	const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	try {
		fs.writeFileSync(tmp, content, { mode: 0o600 });
		fs.renameSync(tmp, file);
	} catch (error) {
		try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
		throw error;
	}
}

/** The entry's data, or undefined when it is not one this version wrote. */
export function readEntryData(data: unknown): HandoffEntryData | undefined {
	const d = data as Partial<HandoffEntryData> | undefined;
	if (!d || d.v !== 1 || typeof d.path !== "string" || typeof d.note !== "string" || !d.note || typeof d.at !== "string") return undefined;
	return { v: 1, path: d.path, note: d.note, at: d.at, leafId: typeof d.leafId === "string" ? d.leafId : null };
}

/** The newest readable `compact-handoff` entry on the branch. */
export function latestHandoff(branch: readonly BranchEntry[]): HandoffEntryData | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type !== "custom" || entry.customType !== HANDOFF_ENTRY) continue;
		const data = readEntryData(entry.data);
		if (data) return data;
	}
	return undefined;
}

/**
 * Whether a reply still in the kept part of the history (from `firstKeptEntryId` up to the
 * compaction) carries this exact note, so the model reads it there already.
 */
export function noteInKeptTail(branch: readonly BranchEntry[], firstKeptEntryId: string | null | undefined, compactionId: string, note: string): boolean {
	if (!firstKeptEntryId) return false;
	const start = branch.findIndex((e) => e.id === firstKeptEntryId);
	const end = branch.findIndex((e) => e.id === compactionId);
	if (start < 0) return false;
	for (const entry of branch.slice(start, end < 0 ? undefined : end)) {
		if (entry.type === "message" && entry.message?.role === "assistant" && extractHandoff(assistantText(entry.message)) === note) return true;
	}
	return false;
}

/** "3 minutes ago", "2 hours ago", "4 days ago"; "just now" under a minute. */
export function ago(fromMs: number, nowMs: number): string {
	const seconds = Math.max(0, Math.round((nowMs - fromMs) / 1000));
	if (seconds < 60) return "just now";
	const [n, unit] = seconds < 3600 ? [Math.floor(seconds / 60), "minute"] : seconds < 86_400 ? [Math.floor(seconds / 3600), "hour"] : [Math.floor(seconds / 86_400), "day"];
	return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/** The hidden message that brings the note back after a compaction. */
export function restoreText(data: HandoffEntryData, nowMs: number, inKeptTail: boolean): string {
	const written = Date.parse(data.at);
	const when = Number.isNaN(written) ? data.at : `${data.at} (${ago(written, nowMs)})`;
	const lines = [
		`[compact-handoff] Your own handoff note, written ${when} just before a compaction, saved at ${data.path}.`,
		"Check it against the summary above: where they disagree, the note is the more exact record of what you knew then, but anything after it is newer. Re-read the files it names before acting on the next request.",
	];
	if (inKeptTail) {
		lines.push("The reply that wrote it is still in the history above, inside <handoff>…</handoff>.");
		return lines.join("\n");
	}
	return [...lines, "", "<handoff>", data.note, "</handoff>"].join("\n");
}
