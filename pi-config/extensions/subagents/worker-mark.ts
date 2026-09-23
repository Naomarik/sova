/**
 * Worker session marker, loaded FIRST into every pi worker child (`-e worker-mark.ts` on top of
 * `--no-extensions`). Its only job: one `subagents-worker-session` custom entry in the worker's
 * OWN session, so Sova can keep worker sessions out of its session list. The entry name and its
 * `v: 1` data are a contract with Sova (server/worker-sessions.ts, SessionSummary.workerSession).
 *
 * pi refuses actions while extensions load, so the append runs at session_start — the earliest
 * point it can. No tools, no UI, no timers; without a session file, or when the append is missing
 * or throws, nothing happens. It must never import index.ts (a child must not load the manager).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MEMBER_ENV, decodeMemberContext } from "./mailbox.ts";

export const WORKER_SESSION_ENTRY = "subagents-worker-session";

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

export default function workerMarkExtension(pi: ExtensionAPI): void {
	try {
		pi.on("session_start", (_event, ctx) => {
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
