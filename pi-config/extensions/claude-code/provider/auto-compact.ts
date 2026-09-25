/**
 * Ask pi to compact a claude-code-cli session before its history outgrows
 * what a restarted CLI child can be handed.
 *
 * pi's own threshold is `contextWindow - reserveTokens`, about 984K tokens
 * for the `[1m]` models, while a restart folds at most MAX_FOLD_CHARS of
 * history into one message. Between the two, every restart clipped history pi
 * still held in full. This hook closes that gap: once the fold a restart
 * would send exceeds the budget session-bridge.ts sizes from the model's
 * window, pi compacts, and the next turn restarts onto summary + kept tail.
 *
 * pi-runtime code: registered from provider/index.ts, never imported by Sova.
 */
import { convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { foldBudgetChars, foldSizeEstimate } from "./session-bridge.ts";
import { dropLeadingUntaggedSection } from "./stream.ts";

/** What pi's compact() throws when an extension or an abort (a user's Stop) cancels it. */
const CANCELLED = "Compaction cancelled";

/** How much a failed compaction's fold must grow before the next attempt. */
const RETRY_GROWTH = 1.25;

/** Session entries that change what the model is sent; labels, usage and model changes do not. */
const CONTEXT_ENTRIES = new Set(["message", "custom_message", "compaction", "branch_summary", "context_edit"]);

/** Whether the newest context-changing entry on the branch is a compaction: nothing to gain from another. */
function justCompacted(ctx: ExtensionContext): boolean {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const type = branch[i]!.type;
		if (CONTEXT_ENTRIES.has(type)) return type === "compaction";
	}
	return false;
}

export interface FoldPressure {
	/** Characters a restart would fold the transcript into, unclipped. */
	size: number;
	/** Characters the model's window leaves for the fold. */
	budget: number;
}

/** The fold a restart would send for this session now, against its budget. */
export function foldPressure(pi: ExtensionAPI, ctx: ExtensionContext, messages: Message[]): FoldPressure | undefined {
	const model = ctx.model;
	if (!model) return undefined;
	const active = new Set(pi.getActiveTools());
	const tools = pi.getAllTools().filter((tool) => active.has(tool.name));
	return {
		size: foldSizeEstimate(messages),
		budget: foldBudgetChars({
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			// What the provider sends: pi's preamble is dropped (stream.ts).
			systemPrompt: dropLeadingUntaggedSection(ctx.getSystemPrompt()),
			tools,
		}),
	};
}

/**
 * Register the `agent_settled` trigger. `agent_settled`, not `agent_end`:
 * `ctx.compact()` aborts the agent first, and at `agent_end` the run is
 * still active (pi has yet to retry an errored message, drain queued
 * follow-ups or run its own compaction check), so the abort would cancel
 * all of those. At `agent_settled` the run is over and the abort is a no-op.
 *
 * The check itself is deferred a tick: pi emits the extension's
 * `agent_settled` before its session listeners hear it, and a host (Sova)
 * hands a queued prompt off on that session event; pi runs it right after the
 * emission. Compacting first would abort or refuse that prompt.
 *
 * `isIdle()` alone cannot see such a prompt in time: `prompt()` passes its
 * compaction check, then awaits input handlers, auth, pi's own compaction
 * check and `before_agent_start` handlers before the run counts as active.
 * So every prompt also bumps a per-session counter (`input`,
 * `before_agent_start`, `agent_start`), and a compaction goes ahead only if
 * the counter has not moved: at the deferred check, and again when pi asks
 * `session_before_compact`, where a moved counter cancels the compaction
 * this hook started. A cancel of our own is not a failure; the next settle
 * may try again.
 */
export function registerAutoCompact(pi: ExtensionAPI, providerId: string, enabled: () => boolean): void {
	/** Leaves a compaction was already requested for, per pi session. */
	const requested = new Map<string, string>();
	/** The fold size a compaction last failed at, per pi session. */
	const failedAt = new Map<string, number>();
	/** Prompts seen, per pi session: any movement means a turn is on its way. */
	const prompts = new Map<string, number>();
	/** The prompt count a compaction of ours was started at, until pi asks before compacting. */
	const started = new Map<string, number>();
	/** Sessions whose compaction we cancelled ourselves. */
	const vetoed = new Set<string>();

	const idOf = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();
	const promptsOf = (sessionId: string): number => prompts.get(sessionId) ?? 0;
	const bump = (_event: unknown, ctx: ExtensionContext): void => {
		try { const id = idOf(ctx); prompts.set(id, promptsOf(id) + 1); } catch { /* no session to count */ }
	};
	pi.on("input", (event, ctx) => { bump(event, ctx); return { action: "continue" }; });
	pi.on("before_agent_start", (event, ctx) => { bump(event, ctx); });
	pi.on("agent_start", bump);

	pi.on("session_before_compact", (event, ctx) => {
		const sessionId = idOf(ctx);
		const at = started.get(sessionId);
		if (at === undefined || event.reason !== "manual") return undefined;
		started.delete(sessionId);
		if (promptsOf(sessionId) === at) return undefined;
		vetoed.add(sessionId);
		return { cancel: true };
	});

	const check = (ctx: ExtensionContext, settledAt: number): void => {
		if (!enabled() || ctx.model?.provider !== providerId) return;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
		const sessions = ctx.sessionManager;
		const sessionId = sessions.getSessionId();
		if (promptsOf(sessionId) !== settledAt) return;
		const leaf = sessions.getLeafId();
		if (!leaf || requested.get(sessionId) === leaf) return;
		if (justCompacted(ctx)) return;

		const pressure = foldPressure(pi, ctx, convertToLlm(sessions.buildSessionProjection().messages));
		if (!pressure || pressure.size <= pressure.budget) return;
		const failed = failedAt.get(sessionId);
		if (failed !== undefined && pressure.size < failed * RETRY_GROWTH) return;

		requested.set(sessionId, leaf);
		started.set(sessionId, settledAt);
		ctx.compact({
			onComplete: () => { failedAt.delete(sessionId); started.delete(sessionId); },
			onError: (error) => {
				started.delete(sessionId);
				if (vetoed.delete(sessionId)) {
					// Ours, for a prompt that won the race: not a failure.
					requested.delete(sessionId);
					return;
				}
				// A failure, or the user stopping it (Sova's Stop aborts any
				// compaction): either way this history is not tried again until it
				// has grown. A stop is the user's choice, not news to report.
				failedAt.set(sessionId, pressure.size);
				if (error.message !== CANCELLED) ctx.ui?.notify?.(`Automatic compaction failed: ${error.message}`, "warning");
			},
		});
	};

	pi.on("agent_settled", (_event, ctx) => {
		if (!enabled() || ctx.model?.provider !== providerId) return;
		const settledAt = promptsOf(idOf(ctx));
		setTimeout(() => {
			// A context whose session was replaced in the meantime throws when used.
			try { check(ctx, settledAt); } catch { /* the session moved on; nothing to compact */ }
		}, 0);
	});
}
