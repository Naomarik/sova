/**
 * The scope a worker that is not a pi worker would be confined under: `workerLaunch` (index.ts)
 * answers such a backend `{kind: "confine", scope}`, the parent's scope as a pi worker in the same
 * cwd gets it. Nothing launches one today (the subagents extension refuses any backend but pi
 * while the sandbox is on or the start is worktree-confined), so the answer only says what it
 * would be.
 *
 * Node builtins only (with policy.ts), no pi imports.
 */
import { isAbsolute } from "node:path";
import { type ParentScope, parseParentScope } from "./policy.ts";

/** The decoded `scope` (callers treat the string as opaque). */
export interface LaunchScope {
	v: 1;
	/** The parent's agent dir: its policy file is the one read. */
	agentDir: string;
	/** The parent session id: the default tmp lives under its sandbox dir. */
	sessionId: string;
	/** `WorkerLaunchRequest.owner`. */
	owner: string;
	/** The parent's scope as a pi worker gets it (full, narrowed, or write-only). */
	parent: ParentScope;
}

/** A worker id as it may name a directory and a socket. */
export const OWNER_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function encodeLaunchScope(scope: LaunchScope): string {
	return JSON.stringify(scope);
}

export function decodeLaunchScope(scope: string): { ok: true; value: LaunchScope } | { ok: false; error: string } {
	let raw: unknown;
	try {
		raw = JSON.parse(scope);
	} catch {
		return { ok: false, error: "the launch scope is not valid JSON" };
	}
	const r = raw as Partial<Record<keyof LaunchScope, unknown>> | null;
	if (!r || typeof r !== "object" || r.v !== 1 || typeof r.agentDir !== "string" || !isAbsolute(r.agentDir) || typeof r.sessionId !== "string" || typeof r.owner !== "string" || !OWNER_ID.test(r.owner) || r.owner === "." || r.owner === "..") {
		return { ok: false, error: "the launch scope is malformed" };
	}
	const parent = parseParentScope(r.parent);
	if (!parent.ok) return { ok: false, error: `the launch scope is malformed: ${parent.error}` };
	return { ok: true, value: { v: 1, agentDir: r.agentDir, sessionId: r.sessionId, owner: r.owner, parent: parent.value } };
}
