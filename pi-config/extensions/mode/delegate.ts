/**
 * Delegate mode's routing preferences: which worker (backend · model · effort) each kind of work
 * goes to. Pure: node:fs/node:path only, no pi imports — unit-testable with node --test, and
 * imported by Sova's server beside state.ts and minor.ts, so it must stay runtime-free.
 *
 * One JSON file, `~/.pi/agent/mode-delegate.json`, separate from mode.json on purpose: mode.json's
 * normalizeState rebuilds that file from known fields only, so anything stored there would be
 * stripped by the next `/mode default`. This file is global (every session, TUI and Sova alike),
 * holds no per-session state, and is never snapshotted into a transcript: a Delegate session
 * re-reads it at every turn boundary, so an edit reaches sessions already in Delegate from their
 * next prompt. Normal mode never reads it.
 *
 *     { "version": 1, "profiles": {
 *         "planning": { "primary":  {"backend":"claude-code","model":"claude-fable-5-1[1m]","effort":"medium"},
 *                       "fallback": {"backend":"claude-code","model":"opus[1m]","effort":"high"} },
 *         "investigation": { "primary": {...}, "fallback": null }, "routine": {...}, "complex": {...} } }
 *
 * `fallback: null` means "no fallback": when the primary is unavailable the orchestrator asks the
 * user rather than picking a model itself. A missing file, a missing profile, or an unreadable slot
 * reads as that slot's default; an unknown `version` reads as all defaults (a newer schema is never
 * half-read).
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DELEGATE_FILE_NAME = "mode-delegate.json";

export type DelegateProfileId = "planning" | "investigation" | "routine" | "complex";

/** Canonical order: the file, the prompt, the status line and the settings screen all use it. */
export const DELEGATE_PROFILES: readonly DelegateProfileId[] = ["planning", "investigation", "routine", "complex"];

export const DELEGATE_PROFILE_INFO: Record<DelegateProfileId, { label: string; short: string; description: string }> = {
	planning: {
		label: "Planning & specs",
		short: "plan",
		description: "Non-editing design: plans, specs, architecture, and any investigation that feeds a design decision",
	},
	investigation: {
		label: "Investigation",
		short: "investigate",
		description: "Focused read-only research or diagnosis of a specific question, with no design to settle",
	},
	routine: {
		label: "Routine implementation",
		short: "routine",
		description: "Mechanical, well-specified, low-risk changes",
	},
	complex: {
		label: "Complex implementation",
		short: "complex",
		description: "Ambiguous, cross-cutting, or high-risk changes (concurrency, migrations, public interfaces, security)",
	},
};

/** The worker backends a profile may name: the ones with model discovery the settings can offer. */
export type DelegateBackend = "pi" | "claude-code";
export const DELEGATE_BACKENDS: readonly DelegateBackend[] = ["pi", "claude-code"];

/** pi's thinking-level ladder (what a pi worker's `effort` is). A model may support fewer. */
export const PI_EFFORTS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** What the claude-code backend accepts at all (claude-code/policy.ts validateClaudeEffort). */
export const CLAUDE_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

export const backendEfforts = (backend: DelegateBackend): readonly string[] => (backend === "pi" ? PI_EFFORTS : CLAUDE_EFFORTS);

/**
 * The efforts a discovered model takes, as everything here reads them (routing, Sova's options and
 * save check, and so its form): what the backend reported, cut to what the backend accepts at all.
 * Nothing usable reported — absent, `[]`, or only efforts the backend would refuse — means the
 * backend didn't constrain it, so every effort the backend accepts. Never empty.
 */
export function effectiveEfforts(backend: DelegateBackend, reported: readonly string[] | undefined): string[] {
	const accepted = backendEfforts(backend);
	const known = (reported ?? []).filter((effort) => accepted.includes(effort));
	return known.length > 0 ? [...new Set(known)] : [...accepted];
}

/** One worker: exactly what agent_spawn receives as backend, model and effort. */
export interface WorkerChoice {
	backend: DelegateBackend;
	/** pi: "provider/modelId"; claude-code: the CLI's own alias or id (no "/"). */
	model: string;
	effort: string;
}

export interface DelegateProfile {
	primary: WorkerChoice;
	/** Used, and disclosed, only when the primary is unavailable. null: none — ask the user. */
	fallback: WorkerChoice | null;
}

export interface DelegateSettings {
	version: 1;
	profiles: Record<DelegateProfileId, DelegateProfile>;
}

const claude = (model: string, effort: string): WorkerChoice => ({ backend: "claude-code", model, effort });

/**
 * The built-in routing. Planning is fable at medium with an opus/high fallback; Routine and Complex
 * are opus low for mechanical work, medium where precision matters.
 * Investigation is new and deliberately conservative: opus at low — read-only work on the same
 * model the implementation profiles use, at their cheapest effort. None but Planning has a
 * fallback, as before: an unavailable model makes the orchestrator ask.
 */
export function delegateDefaults(): DelegateSettings {
	return {
		version: 1,
		profiles: {
			planning: { primary: claude("claude-fable-5-1[1m]", "medium"), fallback: claude("opus[1m]", "high") },
			investigation: { primary: claude("opus[1m]", "low"), fallback: null },
			routine: { primary: claude("opus[1m]", "low"), fallback: null },
			complex: { primary: claude("opus[1m]", "medium"), fallback: null },
		},
	};
}

export function isDelegateProfile(value: unknown): value is DelegateProfileId {
	return typeof value === "string" && (DELEGATE_PROFILES as readonly string[]).includes(value);
}

export function isDelegateBackend(value: unknown): value is DelegateBackend {
	return typeof value === "string" && (DELEGATE_BACKENDS as readonly string[]).includes(value);
}

/**
 * Why a model id can't be one for this backend, or null. Shape only — whether the backend offers
 * it is discovery's question. pi refs are "provider/modelId" (subagents look them up that way);
 * Claude ids are CLI aliases and must not look like a pi ref or a flag (claude-code's validator).
 */
export function modelShapeError(backend: DelegateBackend, model: string): string | null {
	if (model.trim() !== model || model === "") return "model must be a non-empty id without surrounding spaces";
	if (/[\s\0]/.test(model)) return "model must not contain whitespace";
	if (backend === "pi") {
		const slash = model.indexOf("/");
		return slash > 0 && slash < model.length - 1 ? null : 'a pi model is "provider/modelId"';
	}
	if (model.startsWith("-") || model.includes("/")) return "a Claude Code model is a CLI alias or id, not a pi provider/model ref";
	return null;
}

/** A worker tuple, or the reason it isn't one. Strict: every field present and valid for its backend. */
export function parseChoice(value: unknown): WorkerChoice | { error: string } {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return { error: "expected { backend, model, effort }" };
	const record = value as Record<string, unknown>;
	if (!isDelegateBackend(record.backend)) return { error: `backend must be one of: ${DELEGATE_BACKENDS.join(", ")}` };
	if (typeof record.model !== "string") return { error: "model must be a string" };
	const shape = modelShapeError(record.backend, record.model);
	if (shape) return { error: shape };
	const efforts = backendEfforts(record.backend);
	if (typeof record.effort !== "string" || !efforts.includes(record.effort))
		return { error: `effort for ${record.backend} must be one of: ${efforts.join(", ")}` };
	return { backend: record.backend, model: record.model, effort: record.effort };
}

export function sameChoice(a: WorkerChoice | null | undefined, b: WorkerChoice | null | undefined): boolean {
	if (!a || !b) return !a && !b;
	return a.backend === b.backend && a.model === b.model && a.effort === b.effort;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Tolerant read of the file's content: a slot that is missing or does not parse takes its default,
 * so one bad hand edit costs that slot, never the rest. An explicit `"fallback": null` is kept.
 */
export function normalizeDelegate(value: unknown): DelegateSettings {
	const settings = delegateDefaults();
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.profiles)) return settings;
	const profiles = value.profiles;
	for (const id of DELEGATE_PROFILES) {
		const raw = profiles[id];
		if (!isRecord(raw)) continue;
		const primary = parseChoice(raw.primary);
		if (!("error" in primary)) settings.profiles[id].primary = primary;
		if (raw.fallback === null) settings.profiles[id].fallback = null;
		else if (raw.fallback !== undefined) {
			const fallback = parseChoice(raw.fallback);
			if (!("error" in fallback)) settings.profiles[id].fallback = fallback;
		}
	}
	return settings;
}

/**
 * Strict parse of a whole replacement (Sova's PUT): every profile, both slots, each tuple valid,
 * and a fallback that differs from its primary. The error names the slot, in the screen's words.
 */
export function parseDelegate(value: unknown): DelegateSettings | { error: string } {
	if (!isRecord(value)) return { error: "Expected { version: 1, profiles: { planning, investigation, routine, complex } }" };
	if (value.version !== 1) return { error: "version must be 1" };
	if (!isRecord(value.profiles)) return { error: "profiles must be an object" };
	const unknown = Object.keys(value.profiles).filter((key) => !isDelegateProfile(key));
	if (unknown.length > 0) return { error: `Unknown profile: ${unknown.join(", ")} (known: ${DELEGATE_PROFILES.join(", ")})` };
	const settings = delegateDefaults();
	for (const id of DELEGATE_PROFILES) {
		const label = DELEGATE_PROFILE_INFO[id].label;
		const raw = value.profiles[id];
		if (!isRecord(raw)) return { error: `${label}: missing` };
		const primary = parseChoice(raw.primary);
		if ("error" in primary) return { error: `${label} primary: ${primary.error}` };
		let fallback: WorkerChoice | null = null;
		if (raw.fallback !== null) {
			const parsed = parseChoice(raw.fallback);
			if ("error" in parsed) return { error: `${label} fallback: ${parsed.error} (or null for none)` };
			if (sameChoice(parsed, primary)) return { error: `${label} fallback: the same worker as the primary; choose another, or none` };
			fallback = parsed;
		}
		settings.profiles[id] = { primary, fallback };
	}
	return settings;
}

/** Read the file; missing or corrupt reads as the defaults. Never throws. */
export function loadDelegate(path: string): DelegateSettings {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return delegateDefaults();
	}
	try {
		return normalizeDelegate(JSON.parse(raw));
	} catch {
		return delegateDefaults();
	}
}

/** Write JSON atomically (tmp + rename), so a reader never sees half a file. */
export function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(temporary, path);
}

/** Atomic write (tmp + rename), canonical shape. Sova's settings screen is the writer. */
export function saveDelegate(path: string, settings: DelegateSettings): void {
	writeJsonAtomic(path, normalizeDelegate(settings));
}

/** Identity of a routing: two settings with the same key route every profile identically. */
export const delegateKey = (settings: DelegateSettings): string =>
	JSON.stringify(DELEGATE_PROFILES.map((id) => [settings.profiles[id].primary, settings.profiles[id].fallback]));

/**
 * A reader that re-parses only when the file's stat (mtime, size, inode — an atomic rename is a new
 * inode) changes — what a turn boundary calls, so a per-turn re-read costs one stat. A missing
 * file is not negatively cached: it reads as `missing()` every time.
 */
export function statCachedReader<T>(path: string, load: (path: string) => T, missing: () => T): () => T {
	let cache: { stamp: string; value: T } | undefined;
	return () => {
		let stamp: string;
		try {
			const stat = statSync(path);
			stamp = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
		} catch {
			cache = undefined;
			return missing();
		}
		if (cache?.stamp !== stamp) cache = { stamp, value: load(path) };
		return cache.value;
	};
}

/** The Delegate routing as a turn boundary reads it (statCachedReader). */
export const delegateReader = (path: string): (() => DelegateSettings) => statCachedReader(path, loadDelegate, delegateDefaults);
