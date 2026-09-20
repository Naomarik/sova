/**
 * Settings for vision-delegate. Global file only: ~/.pi/agent/vision-delegate.json
 * (a symlink into this repository, see install.sh). Every field is optional and a
 * malformed value falls back to its default rather than disabling the extension.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface VisionSettings {
	/** Ordered "provider/modelId" candidates. The first usable one wins. */
	fallbacks: string[];
	/** A usage window at or above this percentage counts as exhausted. */
	exhaustedAbovePct: number;
	/** Budget for the conversation excerpt sent with an explicit question. */
	contextChars: number;
}

/**
 * zai first: it carries the lowest subscription usage here and glm-5.3-flash is
 * the only zai model with image input. Anthropic's haiku is the backstop.
 */
export const DEFAULT_SETTINGS: VisionSettings = {
	fallbacks: ["zai/glm-5.3-flash", "anthropic/claude-haiku-4-5"],
	exhaustedAbovePct: 90,
	contextChars: 2000,
};

export const SETTINGS_FILE = "vision-delegate.json";

export function readJsonObject(path: string): Record<string, unknown> | undefined {
	try {
		if (!existsSync(path)) return undefined;
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

export function mergeSettings(raw: Record<string, unknown> | undefined): VisionSettings {
	const settings: VisionSettings = { ...DEFAULT_SETTINGS, fallbacks: [...DEFAULT_SETTINGS.fallbacks] };
	if (!raw) return settings;
	if (Array.isArray(raw.fallbacks)) {
		const refs = raw.fallbacks.filter((ref): ref is string => typeof ref === "string" && ref.includes("/"));
		// An empty or all-garbage list would leave nothing to delegate to; keep the defaults.
		if (refs.length) settings.fallbacks = refs;
	}
	if (typeof raw.exhaustedAbovePct === "number" && raw.exhaustedAbovePct > 0 && raw.exhaustedAbovePct <= 100) {
		settings.exhaustedAbovePct = raw.exhaustedAbovePct;
	}
	if (typeof raw.contextChars === "number" && raw.contextChars >= 0) settings.contextChars = raw.contextChars;
	return settings;
}

/** Missing, unreadable or malformed file → defaults. */
export function loadSettings(agentDir?: string): VisionSettings {
	return mergeSettings(readJsonObject(join(agentDir ?? join(homedir(), ".pi/agent"), SETTINGS_FILE)));
}
