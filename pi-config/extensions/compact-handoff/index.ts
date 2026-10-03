/**
 * /compact-handoff [focus]: the agent writes a handoff note, the note is saved, the session
 * compacts, and the note comes back hidden right after the summary — after this compaction and
 * every later one on the branch (plain /compact, threshold, overflow).
 *
 * The turn: the command sends a hidden instruction with triggerTurn and returns at once (pi's
 * prompt() awaits a command handler, so waiting here would hold the caller). The capture runs on
 * `agent_settled`, deferred a tick like claude-code's auto-compact (provider/auto-compact.ts): pi
 * emits the extension's `agent_settled` before its session listeners, and a host (Sova) hands a
 * queued prompt off on that session event. Every prompt bumps a per-session counter; a counter
 * that moved since the settle means a prompt won the race, so the note is saved but nothing is
 * compacted, and `session_before_compact` cancels our own compaction for the same reason.
 *
 * The note is written by this process with node fs, never by the agent's tools: a sandbox makes
 * the agent dir read-only to tools, and a remote session's tools write on the far host.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	agentDir as defaultAgentDir,
	type BranchEntry,
	captureHandoff,
	HANDOFF_ENTRY,
	type HandoffEntryData,
	handoffPath,
	latestHandoff,
	NOTE_MESSAGE,
	noteFile,
	noteInKeptTail,
	REQUEST_MESSAGE,
	requestInstruction,
	restoreText,
	writeNoteFile,
} from "./handoff.ts";

/** What pi's compact() throws when an extension or an abort (a user's Stop) cancels it. */
const CANCELLED = "Compaction cancelled";

export interface CompactHandoffOptions {
	/** The agent dir the note files go under; default PI_CODING_AGENT_DIR as pi resolves it. */
	agentDir?: () => string;
	now?: () => number;
}

interface Pending {
	id: string;
	focus: string;
}

export default function compactHandoff(pi: ExtensionAPI, options: CompactHandoffOptions = {}): void {
	const dirOf = options.agentDir ?? (() => defaultAgentDir());
	const now = options.now ?? Date.now;
	/** The handoff under way, per pi session: from the command until its capture. */
	const pending = new Map<string, Pending>();
	/** Prompts seen, per pi session: any movement means a turn is on its way. */
	const prompts = new Map<string, number>();
	/** The prompt count our compaction was started at, until pi asks before compacting. */
	const started = new Map<string, number>();
	/** Sessions whose compaction we cancelled ourselves. */
	const vetoed = new Set<string>();

	const idOf = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();
	const promptsOf = (sessionId: string): number => prompts.get(sessionId) ?? 0;
	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void => {
		ctx.ui?.notify?.(message, level);
	};
	const bump = (_event: unknown, ctx: ExtensionContext): void => {
		try { const id = idOf(ctx); prompts.set(id, promptsOf(id) + 1); } catch { /* no session to count */ }
	};
	pi.on("input", (event, ctx) => { bump(event, ctx); return { action: "continue" }; });
	pi.on("before_agent_start", (event, ctx) => { bump(event, ctx); });
	pi.on("agent_start", bump);

	pi.registerCommand("compact-handoff", {
		description: "Have the agent write a handoff note, compact, and add the note back after the summary",
		handler: async (args, ctx) => {
			const sessionId = idOf(ctx);
			if (pending.has(sessionId)) {
				notify(ctx, "A /compact-handoff is already under way in this session.", "warning");
				return;
			}
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				notify(ctx, "/compact-handoff waits for an idle session: let the turn, compaction or queued messages finish, then run it again.", "warning");
				return;
			}
			const focus = (args ?? "").trim();
			const request: Pending = { id: randomUUID(), focus };
			pending.set(sessionId, request);
			pi.sendMessage(
				{ customType: REQUEST_MESSAGE, display: false, content: requestInstruction(focus), details: { v: 1, id: request.id, focus } },
				{ triggerTurn: true },
			);
		},
	});

	pi.on("session_before_compact", (event, ctx) => {
		const sessionId = idOf(ctx);
		const at = started.get(sessionId);
		if (at === undefined || event.reason !== "manual") return undefined;
		started.delete(sessionId);
		if (promptsOf(sessionId) === at) return undefined;
		vetoed.add(sessionId);
		return { cancel: true };
	});

	/** Save the note: the file first, then the entry that carries it along the branch. */
	const save = (ctx: ExtensionContext, sessionId: string, request: Pending, note: string): HandoffEntryData | undefined => {
		const sessions = ctx.sessionManager;
		const at = new Date(now()).toISOString();
		const leafId = sessions.getLeafId();
		let file: string;
		try {
			file = handoffPath(dirOf(), sessionId);
			writeNoteFile(file, noteFile({ sessionId, cwd: ctx.cwd, at, leafId, focus: request.focus }, note));
		} catch (error) {
			notify(ctx, `/compact-handoff could not save the note, so nothing was compacted: ${(error as Error).message}`, "error");
			return undefined;
		}
		const data: HandoffEntryData = { v: 1, path: file, note, at, leafId };
		pi.appendEntry(HANDOFF_ENTRY, data);
		return data;
	};

	const capture = (ctx: ExtensionContext, settledAt: number): void => {
		const sessionId = idOf(ctx);
		const request = pending.get(sessionId);
		if (!request) return;
		const result = captureHandoff(ctx.sessionManager.getBranch() as BranchEntry[], request.id);
		if (result.kind === "missing") {
			// Not run yet (deferred behind a settle in progress): the next settle captures it.
			if (!ctx.isIdle()) return;
			pending.delete(sessionId);
			notify(ctx, "/compact-handoff could not start its turn; nothing was compacted.", "warning");
			return;
		}
		pending.delete(sessionId);
		if (result.kind === "stopped") return notify(ctx, "/compact-handoff stopped: nothing was saved or compacted.");
		if (result.kind === "failed") return notify(ctx, `/compact-handoff: the turn failed${result.error ? ` (${result.error})` : ""}, so nothing was saved or compacted.`, "warning");
		if (result.kind === "no-note") return notify(ctx, "/compact-handoff: the reply had no <handoff> note, so nothing was saved or compacted.", "warning");

		const raced = promptsOf(sessionId) !== settledAt || !ctx.isIdle() || ctx.hasPendingMessages();
		const data = save(ctx, sessionId, request, result.note);
		if (!data) return;
		if (raced) {
			notify(ctx, `A new prompt started first, so /compact-handoff did not compact. The note is saved at ${data.path} and comes back after the next compaction.`, "warning");
			return;
		}
		const instructions = [
			request.focus,
			`A handoff note written just before this compaction is saved at ${data.path} and is added back right after this summary.`,
		].filter(Boolean).join("\n\n");
		started.set(sessionId, settledAt);
		ctx.compact({
			customInstructions: instructions,
			onComplete: () => { started.delete(sessionId); },
			onError: (error) => {
				started.delete(sessionId);
				if (vetoed.delete(sessionId)) {
					notify(ctx, `A new prompt started first, so /compact-handoff did not compact. The note is saved at ${data.path} and comes back after the next compaction.`, "warning");
					return;
				}
				// The user's Stop is their choice, not news; the note stays saved either way.
				if (error.message !== CANCELLED) notify(ctx, `/compact-handoff: compaction failed (${error.message}). The note is saved at ${data.path}.`, "warning");
			},
		});
	};

	pi.on("agent_settled", (_event, ctx) => {
		let sessionId: string;
		try { sessionId = idOf(ctx); } catch { return; }
		if (!pending.has(sessionId)) return;
		const settledAt = promptsOf(sessionId);
		setTimeout(() => {
			// A context whose session was replaced in the meantime throws when used.
			try { capture(ctx, settledAt); } catch { /* the session moved on */ }
		}, 0);
	});

	// After any compaction: the newest note on this branch, hidden, right after the summary. No
	// turn: idle, it is appended at once; during a run pi appends it at the run's next turn boundary.
	pi.on("session_compact", (event, ctx) => {
		const branch = ctx.sessionManager.getBranch() as BranchEntry[];
		const data = latestHandoff(branch);
		if (!data) return;
		const kept = noteInKeptTail(branch, event.compactionEntry.firstKeptEntryId, event.compactionEntry.id, data.note);
		pi.sendMessage(
			{ customType: NOTE_MESSAGE, display: false, content: restoreText(data, now(), kept), details: { v: 1, path: data.path, at: data.at } },
			{ triggerTurn: false },
		);
	});
}
