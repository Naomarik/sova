/**
 * Choosing which model looks at an image.
 *
 * Pure: the caller supplies the model resolver and the parsed usage cache, so
 * the policy is testable without a registry or a filesystem.
 *
 * Usage comes from the shared cache ../usage-status/ writes
 * (~/.pi/agent/cache/usage-status.json). It is up to ~3 minutes stale and may be
 * absent entirely; unknown usage never blocks a candidate, it only fails to
 * rescue one. Providers outside the map (fireworks, opencode, local ollama, ...)
 * have no subscription limit we can see and are always treated as available.
 */

import { readJsonObject } from "./settings.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import type { VisionSettings } from "./settings.ts";

/** Just enough of pi-ai's Model to choose one. */
export interface PickableModel {
	provider: string;
	id: string;
	name?: string;
	input?: readonly string[];
}

export type ResolveModel = (provider: string, id: string) => PickableModel | undefined;

export interface SkippedCandidate {
	ref: string;
	reason: string;
}

export interface VisionPick {
	model: PickableModel;
	ref: string;
	/** Usage bucket percentage at pick time, when the provider reports one. */
	usedPct?: number;
	/** Every candidate was exhausted and this one was used anyway. */
	overBudget: boolean;
	skipped: SkippedCandidate[];
}

/** A miss keeps the union shape so callers can read any field before narrowing. */
export type PickResult = VisionPick | { model?: undefined; ref?: undefined; usedPct?: undefined; overBudget?: undefined; skipped: SkippedCandidate[] };

/** Provider ids whose subscription usage the usage-status cache tracks. */
export const PROVIDER_BUCKETS: Record<string, "claude" | "openai" | "zai" | "ollama"> = {
	anthropic: "claude",
	"openai-codex": "openai",
	zai: "zai",
	"ollama-cloud": "ollama",
};

/** "zai/glm-5.3-flash" and "fireworks/accounts/fireworks/models/x" both split at the first slash. */
export function parseRef(ref: string): { provider: string; id: string } | undefined {
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

export function hasVision(model: PickableModel): boolean {
	return Boolean(model.input?.includes("image"));
}

export const USAGE_CACHE = join(homedir(), ".pi/agent/cache/usage-status.json");

/** Re-read at every pick: the cache is refreshed out-of-band by usage-status. */
export function readUsage(cacheFile = USAGE_CACHE): Record<string, unknown> | undefined {
	return readJsonObject(cacheFile);
}

function pct(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function maxPct(values: (number | undefined)[]): number | undefined {
	const known = values.filter((value): value is number => value !== undefined);
	return known.length ? Math.max(...known) : undefined;
}

/**
 * Worst reported window for a provider, or undefined when usage is unknown.
 * Every window counts, not only the one the provider flags as binding: a 7d
 * window at 95% still means the next request may be refused.
 */
export function bucketUsedPct(usage: Record<string, unknown> | undefined, provider: string): number | undefined {
	const bucket = PROVIDER_BUCKETS[provider];
	if (!usage || !bucket) return undefined;
	const data = usage[bucket] as Record<string, any> | undefined;
	if (!data || data.state !== "ok") return undefined;
	switch (bucket) {
		case "ollama":
			return pct(data.usedPct);
		case "zai":
			return pct(data.fiveHour?.pct);
		case "openai":
			// An explicit limitReached outranks the windows it was not derived from.
			if (data.limitReached === true) return 100;
			return maxPct((Array.isArray(data.windows) ? data.windows : []).map((w: any) => pct(w?.pct)));
		case "claude":
			return Array.isArray(data.limits) && data.limits.length
				? maxPct(data.limits.map((limit: any) => pct(limit?.pct)))
				: maxPct([pct(data.fiveHour?.pct), pct(data.sevenDay?.pct), pct(data.sevenDayOpus?.pct)]);
	}
}

/**
 * First fallback that resolves, accepts images and is not exhausted. When every
 * vision-capable candidate is exhausted the first one is returned anyway with
 * overBudget set: a degraded answer beats no answer, and the caller says so.
 */
export function pickVisionModel(settings: VisionSettings, resolve: ResolveModel, usage: Record<string, unknown> | undefined): PickResult {
	const skipped: SkippedCandidate[] = [];
	let firstExhausted: VisionPick | undefined;
	for (const ref of settings.fallbacks) {
		const parsed = parseRef(ref);
		if (!parsed) {
			skipped.push({ ref, reason: "not a provider/model reference" });
			continue;
		}
		const model = resolve(parsed.provider, parsed.id);
		if (!model) {
			skipped.push({ ref, reason: "not in this session's model registry" });
			continue;
		}
		if (!hasVision(model)) {
			skipped.push({ ref, reason: "does not accept image input" });
			continue;
		}
		const usedPct = bucketUsedPct(usage, model.provider);
		if (usedPct !== undefined && usedPct >= settings.exhaustedAbovePct) {
			skipped.push({ ref, reason: `subscription usage at ${usedPct}%` });
			firstExhausted ??= { model, ref, usedPct, overBudget: true, skipped };
			continue;
		}
		return { model, ref, usedPct, overBudget: false, skipped };
	}
	return firstExhausted ?? { skipped };
}

export function describeSkipped(skipped: SkippedCandidate[]): string {
	return skipped.map(({ ref, reason }) => `${ref} (${reason})`).join(", ");
}
