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
 * hands a queued prompt off synchronously on that session event. Compacting
 * first would abort or refuse that prompt; deferring lets it start, and the
 * idle/pending re-check below then leaves the session alone.
 */
export function registerAutoCompact(pi: ExtensionAPI, providerId: string, enabled: () => boolean): void {
	/** Leaves a compaction was already requested for, per pi session. */
	const requested = new Map<string, string>();
	/** The fold size a compaction last failed at, per pi session. */
	const failedAt = new Map<string, number>();

	const check = (ctx: ExtensionContext): void => {
		if (!enabled() || ctx.model?.provider !== providerId) return;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
		const sessions = ctx.sessionManager;
		const sessionId = sessions.getSessionId();
		const leaf = sessions.getLeafId();
		if (!leaf || requested.get(sessionId) === leaf) return;
		if (justCompacted(ctx)) return;

		const pressure = foldPressure(pi, ctx, convertToLlm(sessions.buildSessionProjection().messages));
		if (!pressure || pressure.size <= pressure.budget) return;
		const failed = failedAt.get(sessionId);
		if (failed !== undefined && pressure.size < failed * RETRY_GROWTH) return;

		requested.set(sessionId, leaf);
		ctx.compact({
			onComplete: () => { failedAt.delete(sessionId); },
			onError: (error) => {
				failedAt.set(sessionId, pressure.size);
				ctx.ui?.notify?.(`Automatic compaction failed: ${error.message}`, "warning");
			},
		});
	};

	pi.on("agent_settled", (_event, ctx) => {
		if (!enabled() || ctx.model?.provider !== providerId) return;
		setTimeout(() => {
			// A context whose session was replaced in the meantime throws when used.
			try { check(ctx); } catch { /* the session moved on; nothing to compact */ }
		}, 0);
	});
}
