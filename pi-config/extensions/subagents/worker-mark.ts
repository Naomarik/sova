/**
 * Worker session marker, loaded FIRST into every pi worker child (`-e worker-mark.ts` on top of
 * `--no-extensions`). Its main job: one `subagents-worker-session` custom entry in the worker's
 * OWN session, so Sova can keep worker sessions out of its session list. The entry name and its
 * `v: 1` data are a contract with Sova (server/worker-sessions.ts, SessionSummary.workerSession).
 *
 * pi refuses actions while extensions load, so the append runs at session_start — the earliest
 * point it can. No tools, no UI, no timers; without a session file, or when the append is missing
 * or throws, nothing happens. It must never import index.ts (a child must not load the manager).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MEMBER_ENV, decodeMemberContext } from "./mailbox.ts";
import { WORKER_ROLE_DISCOVER_EVENT, WORKER_ROLE_EVENT, type WorkerRoleEvent } from "../mode/events.ts";

export const WORKER_SESSION_ENTRY = "subagents-worker-session";

/**
 * Its second job: turn on the built-in tools the spawn asked for. A worker always loads this
 * extension, so the runner restricts built-ins by `--exclude-tools` (an allowlist would strip
 * extension tools), and exclusion only narrows pi's DEFAULT active set (read, bash, edit, write):
 * `tools: ["read", "grep", "find", "ls"]` would leave the child with `read` alone. The runner puts
 * the requested built-ins in this variable; at session_start they are activated. Excluded tools
 * are not registered at all, so nothing outside the request can be turned on this way.
 */
export const WORKER_TOOLS_ENV = "PI_SUBAGENT_BUILTIN_TOOLS";

/** The requested built-in tool names, or none. */
export function requestedTools(env: NodeJS.ProcessEnv = process.env): string[] {
	return (env[WORKER_TOOLS_ENV] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
}

export interface WorkerSessionMarker {
	v: 1;
	workerId?: string;
	teamId?: string;
	role?: string;
}

/** What the child knows about itself: a team member's identity, else presence only. */
export function workerSessionMarker(env: NodeJS.ProcessEnv = process.env): WorkerSessionMarker {
	const me = decodeMemberContext(env[MEMBER_ENV]);
	return me ? { v: 1, workerId: me.workerId, teamId: me.teamId, role: me.role } : { v: 1 };
}

/** Activate the requested built-ins the default set lacks (see WORKER_TOOLS_ENV). */
function activateRequested(pi: ExtensionAPI): void {
	const wanted = requestedTools();
	if (!wanted.length) return;
	const active = pi.getActiveTools();
	const available = new Set(pi.getAllTools().map((t) => t.name));
	const add = wanted.filter((t) => available.has(t) && !active.includes(t));
	if (add.length) pi.setActiveTools([...active, ...add]);
}

/**
 * Its third job: tell a mode extension loaded into this worker (a worker on its worktree's own agent
 * dir) that it runs as a worker (mode/events.ts). Said at load, and again to anyone who asks: this
 * extension loads first, so a later extension's question is what usually gets the answer.
 */
function announceWorker(pi: ExtensionAPI): void {
	const events = pi.events;
	if (!events) return;
	const role: WorkerRoleEvent = { version: 1 };
	events.on(WORKER_ROLE_DISCOVER_EVENT, (data: unknown) => {
		if ((data as { version?: unknown } | null)?.version === 1) events.emit(WORKER_ROLE_EVENT, role);
	});
	events.emit(WORKER_ROLE_EVENT, role);
}

export default function workerMarkExtension(pi: ExtensionAPI): void {
	try {
		announceWorker(pi);
	} catch {
		// No event bus: a mode extension here runs as a session of its own.
	}
	try {
		pi.on("session_start", (_event, ctx) => {
			try {
				activateRequested(pi);
			} catch {
				// Best-effort: the worker keeps pi's default set, minus the exclusions.
			}
			try {
				const session = ctx.sessionManager;
				if (!session.getSessionFile()) return;
				// A resumed worker session is already marked; one entry per session.
				if (session.getEntries().some((e) => e.type === "custom" && e.customType === WORKER_SESSION_ENTRY)) return;
				pi.appendEntry<WorkerSessionMarker>(WORKER_SESSION_ENTRY, workerSessionMarker());
			} catch {
				// Best-effort: an unmarked worker session only shows up in Sova's list.
			}
		});
	} catch {
		// No event API here: inert.
	}
}
