/**
 * The spec minor mode's writer: which worker (backend · model · effort) writes draft claims and
 * records evidence while spec is on. Pure: node builtins and sibling mode files only, no pi imports
 * — unit-testable with node --test, and imported by Sova's server beside delegate.ts.
 *
 * One JSON file, `~/.pi/agent/mode-spec.json`, separate from mode.json for the same reason as
 * mode-delegate.json (normalizeState rebuilds mode.json from known fields only). Global, never
 * snapshotted into a session: a session with spec on re-reads it (one stat) at every turn boundary,
 * under either major mode.
 *
 *     { "version": 1, "writer": { "primary":  {"backend":"claude-code","model":"opus[1m]","effort":"medium"},
 *                                 "fallback": null } }
 *
 * `writer: null` (the default, and what a missing file reads as) means no writer: the session
 * writes the spec itself. `fallback: null` means none — an unavailable primary makes the session
 * ask the user rather than pick a model. A tuple is exactly Delegate's (delegate.ts WorkerChoice).
 */
import { readFileSync } from "node:fs";
import { parseChoice, sameChoice, statCachedReader, writeJsonAtomic, type DelegateBackend, type WorkerChoice } from "./delegate.ts";

export const SPEC_FILE_NAME = "mode-spec.json";

export interface SpecWriter {
	primary: WorkerChoice;
	/** Used, and disclosed, only when the primary is unavailable. null: none — ask the user. */
	fallback: WorkerChoice | null;
}

export interface SpecSettings {
	version: 1;
	/** null: no writer, the session writes the spec itself. */
	writer: SpecWriter | null;
}

export const SPEC_WRITER_LABEL = "Spec writer";
export const SPEC_WRITER_DESCRIPTION = "Writes draft claims and records evidence, under .sova/spec/drafts/ only";

export function specDefaults(): SpecSettings {
	return { version: 1, writer: null };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Tolerant read of the file's content. There is no default worker to fall back to, so a primary
 * that does not parse means no writer at all; a fallback that does not parse, or repeats the
 * primary, means no fallback. An unknown `version` reads as the defaults.
 */
export function normalizeSpec(value: unknown): SpecSettings {
	const settings = specDefaults();
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.writer)) return settings;
	const primary = parseChoice(value.writer.primary);
	if ("error" in primary) return settings;
	const fallback = value.writer.fallback == null ? null : parseChoice(value.writer.fallback);
	settings.writer = { primary, fallback: fallback === null || "error" in fallback || sameChoice(fallback, primary) ? null : fallback };
	return settings;
}

/** Strict parse of a whole replacement (Sova's PUT). The error names the slot, in the screen's words. */
export function parseSpec(value: unknown): SpecSettings | { error: string } {
	if (!isRecord(value)) return { error: "Expected { version: 1, writer: { primary, fallback } | null }" };
	if (value.version !== 1) return { error: "version must be 1" };
	if (value.writer === null) return specDefaults();
	if (!isRecord(value.writer)) return { error: "writer must be { primary, fallback } or null" };
	const primary = parseChoice(value.writer.primary);
	if ("error" in primary) return { error: `${SPEC_WRITER_LABEL} primary: ${primary.error}` };
	let fallback: WorkerChoice | null = null;
	if (value.writer.fallback !== null) {
		const parsed = parseChoice(value.writer.fallback);
		if ("error" in parsed) return { error: `${SPEC_WRITER_LABEL} fallback: ${parsed.error} (or null for none)` };
		if (sameChoice(parsed, primary)) return { error: `${SPEC_WRITER_LABEL} fallback: the same worker as the primary; choose another, or none` };
		fallback = parsed;
	}
	return { version: 1, writer: { primary, fallback } };
}

/** Read the file; missing or corrupt reads as the defaults (no writer). Never throws. */
export function loadSpec(path: string): SpecSettings {
	try {
		return normalizeSpec(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return specDefaults();
	}
}

/** Atomic write (tmp + rename), canonical shape. Sova's settings screen is the writer. */
export function saveSpec(path: string, settings: SpecSettings): void {
	writeJsonAtomic(path, normalizeSpec(settings));
}

/** Identity of a writer setting: equal keys, equal routing. */
export const specKey = (settings: SpecSettings): string =>
	JSON.stringify(settings.writer ? [settings.writer.primary, settings.writer.fallback] : null);

/** The backends the writer names, primary and fallback alike: what a probe has to discover. */
export function specBackends(settings: SpecSettings): DelegateBackend[] {
	if (!settings.writer) return [];
	const set = new Set<DelegateBackend>([settings.writer.primary.backend]);
	if (settings.writer.fallback) set.add(settings.writer.fallback.backend);
	return [...set];
}

/** The writer setting as a turn boundary reads it: one stat, re-parsed only on change. */
export const specReader = (path: string): (() => SpecSettings) => statCachedReader(path, loadSpec, specDefaults);
