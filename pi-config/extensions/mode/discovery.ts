/** Worker-model discovery for Delegate routing, through the same sources agent_spawn validates against. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { BACKEND_DISCOVER_EVENT, BACKEND_REGISTER_EVENT, type BackendRegistration } from "../subagents/contracts.ts";
import type { DelegateBackend } from "./delegate.ts";
import { fromBackendModels, type Discovery } from "./routing.ts";

const PROBE_TIMEOUT_MS = 15000;

/**
 * Discovers what each worker backend offers, without starting a worker. pi: this session's model
 * registry (what `agent_models` lists and a pi spawn is checked against), with each model's
 * supported thinking levels. claude-code: the backend's own `listModels` through the
 * `subagents:backend-discover` contract (a ~1–3 s `claude` initialize call, cached 60 s by the
 * backend). Subscribes at construction and re-discovers on every probe, so either extension load
 * order and /reload are both safe. Never throws: a failure is a `Discovery` error.
 */
export class WorkerProbe {
	private readonly pi: ExtensionAPI;
	private readonly backends = new Map<string, BackendRegistration>();

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
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
			// CLI missing, unauthenticated, timed out: not evidence that any model is absent.
			return { error: error instanceof Error ? error.message : String(error) };
		}
	}
}
