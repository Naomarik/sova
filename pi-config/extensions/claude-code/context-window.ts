/**
 * Claude Code context windows and the 1M-context list entries: the one copy of both rules.
 *
 * Imported by this extension's provider (the chat picker's models) and `agent_models`, by the
 * subagents extension (the team roster's context column and wrap-up events), and by Sova's server
 * (worker gauges, Settings model lists). Imports nothing: no pi runtime, no node builtins.
 *
 * The CLI's `initialize` model list says nothing about context size, so the window is a rule:
 * - a `[1m]`-suffixed id is the 1M-context variant;
 * - an id whose model is natively 1M is 1M bare too. The CLI's own catalog (claude 2.1.282,
 *   `context:{window:1e6, native_1m}`) names these, and its result `modelUsage.contextWindow`
 *   agrees wherever a worker ran one (bare `opus` and `sonnet` report 1,000,000);
 * - anything else, haiku and the 4.5/4.6 generation included, is 200k.
 * An alias is judged by the model it resolves to: the discovery entry's `resolvedModel` when the
 * caller has it, else the alias table below (as the CLI resolved them on 2026-09-27).
 */

export const CLAUDE_1M_WINDOW = 1_000_000;
export const CLAUDE_DEFAULT_WINDOW = 200_000;

/** Resolved model ids the CLI's catalog marks `native_1m`. */
const NATIVE_1M = new Set([
	"claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7",
	"claude-fable-5-1", "claude-fable-5",
	"claude-sonnet-5",
]);
/** CLI aliases → the model they resolve to, for callers without a `resolvedModel`. */
const ALIASES: Record<string, string> = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5" };

/** The context window of a Claude Code model id or alias (`resolvedModel`: what the CLI said it resolves to). */
export function claudeContextWindow(id: string, resolvedModel?: string): number {
	if (id.endsWith("[1m]")) return CLAUDE_1M_WINDOW;
	const bare = id.trim().toLowerCase();
	const model = resolvedModel?.trim().toLowerCase() || ALIASES[bare] || bare;
	return NATIVE_1M.has(model) ? CLAUDE_1M_WINDOW : CLAUDE_DEFAULT_WINDOW;
}

/**
 * Ids whose `[1m]` form the CLI has published in its model list (`opus[1m]`,
 * `claude-fable-5-1[1m]`, claude 2.1.278) and later stopped listing while still accepting them.
 */
export const LONG_CONTEXT_BASES: readonly string[] = ["opus", "claude-fable-5-1"];

/**
 * A discovered list with `<id>[1m]` added right after each listed LONG_CONTEXT_BASES id that
 * lacks it: the base's fields and efforts, named "<name> (1M context)". Never removes or reorders
 * anything; a list that already carries the `[1m]` form is returned as it is.
 */
export function withLongContextVariants<T extends { id: string; name: string; efforts?: string[] }>(models: readonly T[]): T[] {
	const ids = new Set(models.map((m) => m.id));
	const out: T[] = [];
	for (const model of models) {
		out.push(model);
		const id = `${model.id}[1m]`;
		if (!LONG_CONTEXT_BASES.includes(model.id) || ids.has(id)) continue;
		ids.add(id);
		out.push({ ...model, id, name: `${model.name} (1M context)`, ...(model.efforts ? { efforts: [...model.efforts] } : {}) });
	}
	return out;
}
