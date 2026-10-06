/**
 * Thinking levels for models pi has no catalog for (README.md). At session_start and before each
 * turn it applies the cached metadata (core.ts) to every models.json provider pi has no built-in
 * base for, and starts a background fetch when that metadata is over a day old; fresh metadata
 * applies as soon as it lands. With no metadata nothing is registered.
 *
 * Registration goes through pi.registerProvider(id, {models}), which merges with another
 * extension's registration of the same provider (provider-limits' {api, streamSimple}) and also
 * refreshes the session's current model.
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyModelLevels, onLevelsUpdated, refreshStale, type ComposedModel } from "./core.ts";

interface Registry {
	getAll(): ComposedModel[];
}

export default function modelLevelsExtension(pi: ExtensionAPI): void {
	let reapply: (() => void) | undefined;
	let unsubscribe: (() => void) | undefined;

	const apply = (ctx: ExtensionContext) => {
		const registry = ctx.modelRegistry as unknown as Registry;
		const run = () => {
			try {
				applyModelLevels(
					{
						models: () => registry.getAll(),
						register: (provider, models) => pi.registerProvider(provider, { models } as unknown as Parameters<ExtensionAPI["registerProvider"]>[1]),
					},
					{ agentDir: getAgentDir(), current: ctx.model as unknown as ComposedModel | undefined },
				);
			} catch {
				// Best effort: a provider left as models.json made it behaves as it always did.
			}
		};
		run();
		reapply = run;
		unsubscribe ??= onLevelsUpdated(() => reapply?.());
		void refreshStale({ agentDir: getAgentDir() });
	};

	pi.on("session_start", (_event, ctx) => apply(ctx));
	pi.on("before_agent_start", (_event, ctx) => apply(ctx));
	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
		reapply = undefined;
	});
}
