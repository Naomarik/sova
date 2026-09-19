/** Planner availability probing through the shared subagents backend contract. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	BACKEND_DISCOVER_EVENT,
	BACKEND_REGISTER_EVENT,
	type BackendModel,
	type BackendRegistration,
} from "../subagents/contracts.ts";
import { PLANNER_FALLBACK, PLANNER_PRIMARY, type PlannerChoice } from "./prompt.ts";

export const CLAUDE_BACKEND_ID = "claude-code";
const PROBE_TIMEOUT_MS = 15000;

/** Pure choice from a discovered model list; unit-testable without pi. */
export function pickPlanner(models: BackendModel[] | undefined): PlannerChoice {
	if (!models) return PLANNER_FALLBACK;
	return models.some((model) => model.id === PLANNER_PRIMARY.model) ? PLANNER_PRIMARY : PLANNER_FALLBACK;
}

/**
 * Tracks the claude-code backend registration and answers "is the fable
 * planner offered on this account?" without starting a worker. Subscribes at
 * construction and re-discovers on every probe, so either extension load
 * order and /reload are both safe. A discovery round trip is ~1–3 s, cached
 * 60 s by the backend, and never blocks the caller's UI.
 */
export class PlannerProbe {
	private readonly pi: ExtensionAPI;
	private backend: BackendRegistration | undefined;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
		this.pi.events.on(BACKEND_REGISTER_EVENT, (registration: unknown) => {
			const candidate = registration as BackendRegistration | undefined;
			if (candidate?.id === CLAUDE_BACKEND_ID) this.backend = candidate;
		});
	}

	async probe(ctx: ExtensionContext): Promise<PlannerChoice> {
		this.pi.events.emit(BACKEND_DISCOVER_EVENT, { version: 1 });
		// Registration answers synchronously per the contract, but give an
		// asynchronous implementation one tick before concluding it is absent.
		if (!this.backend) await new Promise((resolve) => setTimeout(resolve, 25));
		const listModels = this.backend?.listModels;
		if (!listModels) return PLANNER_FALLBACK;
		try {
			return pickPlanner(await listModels.call(this.backend, ctx, AbortSignal.timeout(PROBE_TIMEOUT_MS)));
		} catch {
			// CLI missing, unauthenticated, timed out: plan on opus high instead of failing the mode.
			return PLANNER_FALLBACK;
		}
	}
}
