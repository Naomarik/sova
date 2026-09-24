/**
 * Which worker each Delegate profile actually uses this turn. Pure: no pi imports, unit-testable.
 *
 * The rule: the primary when it may run; else the profile's configured fallback, disclosed; else
 * nobody — the orchestrator asks the user. It never picks a model of its own. Two things are kept
 * apart on purpose:
 * - Discovery that FAILED (CLI missing, timeout, unauthenticated) says nothing about a model, so
 *   the tuple stays in use as "unverified"; only a successful discovery that does not list the
 *   model, or lists it without that effort, makes it unavailable. One exception, claude-code: the
 *   CLI's initialize model list is remote and account-gated, and alternates within minutes between
 *   a shape that carries the `[1m]` aliases and one that does not, while the CLI accepts a valid
 *   alias at runtime either way. So a shape-valid Claude alias missing from a successful list is
 *   weak evidence: "unverified", used as is, never "absent". pi's registry is local and reliable:
 *   there a missing model stays absent.
 * - The model policy (model-policy.json) is still enforced by subagents at spawn. Here it only
 *   decides that a denied tuple is not the one to name, and the denial is carried through to the
 *   status and the prompt so the reroute is never silent.
 */
import type { SpecSettings } from "./spec.ts";
import { DELEGATE_PROFILE_INFO, DELEGATE_PROFILES, effectiveEfforts, modelShapeError, type DelegateBackend, type DelegateProfileId, type DelegateSettings, type WorkerChoice } from "./delegate.ts";

/** One backend's discovery: the models it offers (efforts when it reports them), or why it could not say. */
export type Discovery =
	| { models: readonly { id: string; efforts?: readonly string[] }[] }
	| { error: string; missing?: boolean };

/** A backend's model list as routing reads it: ids, and efforts where the backend reports them. */
export function fromBackendModels(models: readonly { id: string; efforts?: readonly string[] }[]): Discovery {
	return { models: models.map((model) => ({ id: model.id, ...(model.efforts ? { efforts: [...model.efforts] } : {}) })) };
}

export type Availability =
	/** Discovered, and the effort is one the model supports. */
	| "ok"
	/** Not discovered yet, or discovery failed: kept in use, spawn has the final word. */
	| "unverified"
	/** The backend answered and does not offer this model — or the backend is not loaded at all. */
	| "absent"
	/** The model is offered, but not at this effort. */
	| "effort"
	/** The model policy forbids it for subagents. */
	| "denied";

export interface ChoiceStatus {
	choice: WorkerChoice;
	availability: Availability;
	/** Human reason for anything but "ok". */
	reason?: string;
}

export const usable = (status: ChoiceStatus): boolean => status.availability === "ok" || status.availability === "unverified";

/**
 * Assess one tuple. `discovery` undefined = not probed yet. `denial` is the subagent policy's
 * message for this backend/model, or null.
 */
export function assess(choice: WorkerChoice, discovery: Discovery | undefined, denial: string | null): ChoiceStatus {
	if (denial) return { choice, availability: "denied", reason: denial };
	if (discovery === undefined) return { choice, availability: "unverified", reason: `${choice.backend} models not checked yet` };
	if ("error" in discovery) {
		if (discovery.missing) return { choice, availability: "absent", reason: discovery.error };
		return { choice, availability: "unverified", reason: `${choice.backend} discovery failed: ${discovery.error}` };
	}
	const model = discovery.models.find((m) => m.id === choice.model);
	if (!model && choice.backend === "claude-code" && modelShapeError(choice.backend, choice.model) === null)
		return { choice, availability: "unverified", reason: `${choice.model} is not in the Claude Code CLI's current model list (the list varies; the CLI accepts a valid alias at runtime)` };
	if (!model) return { choice, availability: "absent", reason: `${choice.model} is not offered by ${choice.backend}` };
	const efforts = effectiveEfforts(choice.backend, model.efforts);
	if (!efforts.includes(choice.effort))
		return { choice, availability: "effort", reason: `${choice.model} does not support effort "${choice.effort}" (supports: ${efforts.join(", ")})` };
	return { choice, availability: "ok" };
}

/** Which worker one primary/fallback pair uses: the primary, else its fallback, else nobody. */
export interface SlotRoute {
	/** The worker to name, or null: ask the user. */
	use: WorkerChoice | null;
	via: "primary" | "fallback" | "none";
	primary: ChoiceStatus;
	fallback: ChoiceStatus | null;
}

export interface ProfileRoute extends SlotRoute {
	profile: DelegateProfileId;
}

export type Assessor = (choice: WorkerChoice) => ChoiceStatus;

export function routeSlot(slot: { primary: WorkerChoice; fallback: WorkerChoice | null }, assessChoice: Assessor): SlotRoute {
	const primaryStatus = assessChoice(slot.primary);
	const fallbackStatus = slot.fallback ? assessChoice(slot.fallback) : null;
	if (usable(primaryStatus)) return { use: slot.primary, via: "primary", primary: primaryStatus, fallback: fallbackStatus };
	if (fallbackStatus && usable(fallbackStatus)) return { use: fallbackStatus.choice, via: "fallback", primary: primaryStatus, fallback: fallbackStatus };
	return { use: null, via: "none", primary: primaryStatus, fallback: fallbackStatus };
}

export function routeProfile(profile: DelegateProfileId, settings: DelegateSettings, assessChoice: Assessor): ProfileRoute {
	return { profile, ...routeSlot(settings.profiles[profile], assessChoice) };
}

/** Every profile, canonical order, assessed against per-backend discovery and the policy. */
export function routeAll(
	settings: DelegateSettings,
	discoveries: Partial<Record<DelegateBackend, Discovery>>,
	denial: (choice: WorkerChoice) => string | null,
): ProfileRoute[] {
	const assessChoice: Assessor = (choice) => assess(choice, discoveries[choice.backend], denial(choice));
	return DELEGATE_PROFILES.map((profile) => routeProfile(profile, settings, assessChoice));
}

/**
 * The spec writer (spec.ts), assessed exactly like a Delegate profile; null when none is set (the
 * session writes the spec itself).
 */
export function routeWriter(
	settings: SpecSettings,
	discoveries: Partial<Record<DelegateBackend, Discovery>>,
	denial: (choice: WorkerChoice) => string | null,
): SlotRoute | null {
	if (!settings.writer) return null;
	return routeSlot(settings.writer, (choice) => assess(choice, discoveries[choice.backend], denial(choice)));
}

/** The backends a routing names, primary and fallback alike: what a probe has to discover. */
export function backendsOf(settings: DelegateSettings): DelegateBackend[] {
	const set = new Set<DelegateBackend>();
	for (const profile of DELEGATE_PROFILES) {
		set.add(settings.profiles[profile].primary.backend);
		const fallback = settings.profiles[profile].fallback;
		if (fallback) set.add(fallback.backend);
	}
	return [...set];
}

export const describeChoice = (choice: WorkerChoice): string => `${choice.backend} · ${choice.model} · ${choice.effort}`;

/** One line per profile (or the spec writer) that is not on its primary, for notifications and /mode status. */
export function routeNotice(route: ProfileRoute): string | undefined {
	return slotNotice(DELEGATE_PROFILE_INFO[route.profile].label, route);
}

export function slotNotice(label: string, route: SlotRoute, asker = "the orchestrator"): string | undefined {
	if (route.via === "fallback") return `${label}: fallback ${describeChoice(route.use!)} (${route.primary.reason ?? "primary unavailable"})`;
	if (route.via === "none") {
		const why = [route.primary.reason, route.fallback?.reason].filter(Boolean).join("; ");
		return `${label}: no available worker — ${why || "primary unavailable"}${route.fallback ? "" : ", and no fallback is set"}; ${asker} will ask before routing this work`;
	}
	return undefined;
}
