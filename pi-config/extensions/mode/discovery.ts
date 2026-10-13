/** Worker-model discovery for Delegate routing, through the same sources agent_spawn validates against. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { claudeOffer } from "../claude-code/catalog.ts";
import { BACKEND_DISCOVER_EVENT, BACKEND_REGISTER_EVENT, type BackendRegistration } from "../subagents/contracts.ts";
import type { DelegateBackend } from "./delegate.ts";
import { fromBackendModels, type Discovery } from "./routing.ts";

const PROBE_TIMEOUT_MS = 15000;

/** The Claude models a claude-code worker may run on, with the efforts each takes (`[]`: no effort control). */
export type ClaudeModelSource = () => readonly { id: string; efforts: readonly string[] }[] | Promise<readonly { id: string; efforts: readonly string[] }[]>;

/**
 * Discovers what each worker backend offers, without starting a worker. pi: this session's model
 * registry (what `agent_models` lists and a pi spawn is checked against), with each model's
 * supported thinking levels. claude-code: built into the subagents extension, so always there and
 * never registered; its models are Sova's Claude catalog (`claudeOffer()`, the list `agent_models`
 * gives), with no `claude` process. Any other backend: its `listModels` through the
 * `subagents:backend-discover` / `-register` contract, where an unregistered one is missing.
 * Subscribes at construction and re-discovers on every probe, so either extension load order and
 * /reload are both safe. Never throws: a failure is a `Discovery` error.
 */
export class WorkerProbe {
	private readonly pi: ExtensionAPI;
	private readonly claudeModels: ClaudeModelSource;
	private readonly backends = new Map<string, BackendRegistration>();

	/** `claudeModels` replaces the catalog for tests only. */
	constructor(pi: ExtensionAPI, claudeModels: ClaudeModelSource = claudeOffer) {
		this.pi = pi;
		this.claudeModels = claudeModels;
		this.pi.events.on(BACKEND_REGISTER_EVENT, (registration: unknown) => {
			const candidate = registration as BackendRegistration | undefined;
			if (candidate?.version === 1 && typeof candidate.id === "string") this.backends.set(candidate.id, candidate);
		});
	}

	async discover(ctx: ExtensionContext, backend: DelegateBackend): Promise<Discovery> {
		if (backend === "pi") {
			try {
				return {
					models: ctx.modelRegistry.getAvailable().map((model) => ({
						id: `${model.provider}/${model.id}`,
						efforts: [...getSupportedThinkingLevels(model)],
					})),
				};
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
		}
		if (backend === "claude-code") {
			try {
				// The same mapping as agent_models: a model with no effort control reports none.
				return fromBackendModels((await this.claudeModels()).map((m) => ({ id: m.id, ...(m.efforts.length ? { efforts: m.efforts } : {}) })));
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
		}
		return this.discoverRegistered(ctx, backend);
	}

	/** A backend that registers itself on the event bus (none of the Delegate backends today). */
	private async discoverRegistered(ctx: ExtensionContext, backend: string): Promise<Discovery> {
		this.pi.events.emit(BACKEND_DISCOVER_EVENT, { version: 1 });
		// Registration answers synchronously per the contract, but give an
		// asynchronous implementation one tick before concluding it is absent.
		if (!this.backends.has(backend)) await new Promise((resolve) => setTimeout(resolve, 25));
		const registration = this.backends.get(backend);
		// Not loaded at all: agent_spawn would refuse the backend outright, so this one is authoritative.
		if (!registration) return { error: `the ${backend} backend is not loaded`, missing: true };
		if (!registration.listModels) return { error: `the ${backend} backend does not expose model discovery` };
		try {
			return fromBackendModels(await registration.listModels.call(registration, ctx, AbortSignal.timeout(PROBE_TIMEOUT_MS)));
		} catch (error) {
			// Missing CLI, unauthenticated, timed out: not evidence that any model is absent.
			return { error: error instanceof Error ? error.message : String(error) };
		}
	}
}
