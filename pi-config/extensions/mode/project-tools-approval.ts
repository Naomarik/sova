/**
 * The approval store of project mode tools: which exact tool sets the user approved, per checkout and
 * mode. One per-user file in Sova's state root, outside every repository, so a project can never
 * approve its own tools:
 *
 *   <state root>/project-mode-approvals.json
 *   { "version": 1, "approvals": { "<real path of the checkout root>": { "<mode id>": [ { "hash", "by", "at" } ] } } }
 *
 * The hash is the mode's `toolsHash` (project-discovery.ts `toolsHashOf`): its declared tools plus the
 * bytes of every file in the mode folder except MODE.md (helpers a tool sources or imports, and
 * reference files, included). A changed declaration or any such file is a new hash, which no approval
 * covers until the user approves it, or the Overseer turns the mode on (that counts as approval). A mode
 * with no tools ("" hash) never needs one. Each key keeps its last APPROVALS_KEPT hashes, newest first,
 * so switching a worktree's branch back and forth doesn't re-ask for a set already approved.
 *
 * Node builtins only: the mode extension checks it when a mode with tools is turned on; Sova's server
 * reads it for the menu and records approvals (server/project-mode-approvals.ts). Writes re-read the
 * file, merge and replace it atomically; a damaged file reads as no approvals and is replaced by the
 * next approval.
 */
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const APPROVALS_FILE_NAME = "project-mode-approvals.json";
export const APPROVALS_KEPT = 8;

/**
 * Who approved: `user` (the operator, on Sova's own page), `overseer` (an Overseer turn-on, q7), or `caller`
 * (any other caller of the approval route: a chat's terminal, a script, an extension, a mesh peer). Tools and
 * commands run on any of them; hooks only on `user` (isApprovedByUser).
 */
export type ApprovalBy = "user" | "overseer" | "caller";

export interface ApprovalRecord {
	hash: string;
	by: ApprovalBy;
	/** ISO time of the approval. */
	at: string;
}

export interface ApprovalsData {
	version: 1;
	approvals: Record<string, Record<string, ApprovalRecord[]>>;
}

/** pi's agent dir as pi resolves it: $PI_CODING_AGENT_DIR (a leading ~ expanded), else ~/.pi/agent. */
export function agentDirOf(env: NodeJS.ProcessEnv = process.env): string {
	const dir = env.PI_CODING_AGENT_DIR;
	if (!dir) return join(homedir(), ".pi", "agent");
	if (dir === "~") return homedir();
	if (dir.startsWith("~/")) return join(homedir(), dir.slice(2));
	return resolve(dir);
}

/**
 * The store's file: under the state root of the server that started this chat (`SOVA_CHAT_STATE_ROOT`,
 * set when a worker runs on another agent dir), else `<agent dir>/sova`. Read per call.
 */
export function approvalsFile(env: NodeJS.ProcessEnv = process.env, agentDir: string = agentDirOf(env)): string {
	return join(env.SOVA_CHAT_STATE_ROOT || join(agentDir, "sova"), APPROVALS_FILE_NAME);
}

/** The key of a checkout: its real path, so a symlinked path approves the same checkout. */
export function projectKey(root: string): string {
	try {
		return realpathSync(resolve(root));
	} catch {
		return resolve(root);
	}
}

const HASH = /^[0-9a-f]{64}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The whole store; well-formed records only. Missing or damaged reads as empty. */
export function readApprovals(file: string = approvalsFile()): ApprovalsData {
	const out: ApprovalsData = { version: 1, approvals: {} };
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return out;
	}
	if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.approvals)) return out;
	for (const [root, modes] of Object.entries(raw.approvals)) {
		if (!isRecord(modes)) continue;
		const kept: Record<string, ApprovalRecord[]> = {};
		for (const [id, list] of Object.entries(modes)) {
			if (!Array.isArray(list)) continue;
			const records = list.filter(
				(r): r is ApprovalRecord => isRecord(r) && typeof r.hash === "string" && HASH.test(r.hash) && (r.by === "user" || r.by === "overseer" || r.by === "caller") && typeof r.at === "string",
			);
			if (records.length) kept[id] = records.slice(0, APPROVALS_KEPT).map((r) => ({ hash: r.hash, by: r.by, at: r.at }));
		}
		if (Object.keys(kept).length) out.approvals[root] = kept;
	}
	return out;
}

/** Whether this exact tool set of a checkout's mode is approved. A mode with no tools ("") always is. */
export function isApproved(root: string, modeId: string, hash: string, file: string = approvalsFile()): boolean {
	if (hash === "") return true;
	return readApprovals(file).approvals[projectKey(root)]?.[modeId]?.some((r) => r.hash === hash) ?? false;
}

/**
 * Whether the USER (never the Overseer) approved this exact set of a checkout's mode: what a mode's hooks need
 * (§chat.mode-menu/project-mode-hooks). Always for a mode that runs nothing ("").
 */
export function isApprovedByUser(root: string, modeId: string, hash: string, file: string = approvalsFile()): boolean {
	if (hash === "") return true;
	return readApprovals(file).approvals[projectKey(root)]?.[modeId]?.some((r) => r.hash === hash && r.by === "user") ?? false;
}

/**
 * Record that `by` approved this tool set of a checkout's mode. Idempotent: an approved hash moves to the
 * front with the new time, and with the new `by`, except that the Overseer (or any other caller) recording a hash the user
 * already approved keeps it the user's (hooks run only on the user's approval; today's Overseer turn-on records only a
 * hash not yet approved, so this changes nothing it does). Nothing to record for a mode with no tools. Throws on a malformed
 * hash or a failed write: an approval that wasn't stored must not let the mode go on.
 */
export function recordApproval(root: string, modeId: string, hash: string, by: ApprovalBy, file: string = approvalsFile(), now: Date = new Date()): void {
	if (hash === "") return;
	if (!HASH.test(hash)) throw new Error(`not a tools hash: ${JSON.stringify(hash)}`);
	const data = readApprovals(file);
	const modes = (data.approvals[projectKey(root)] ??= {});
	const had = (modes[modeId] ?? []).find((r) => r.hash === hash);
	const rest = (modes[modeId] ?? []).filter((r) => r.hash !== hash);
	modes[modeId] = [{ hash, by: had?.by === "user" ? "user" : by, at: now.toISOString() }, ...rest].slice(0, APPROVALS_KEPT);
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${now.getTime()}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, file);
}
