/**
 * The align minor mode's settings: its writing style and Visuals (§chat.alignment/settings-file).
 * Pure: node builtins and sibling mode files only, no pi imports — unit-testable with node --test,
 * and imported by Sova's server (Settings → Alignment, the mesh registration, a chat's start-time
 * Visuals) beside spec.ts.
 *
 * One JSON file, `~/.pi/agent/mode-align.json`, separate from mode.json for the same reason as
 * mode-spec.json (normalizeState rebuilds mode.json from known fields only). Global: the style is
 * re-read (one stat) at every turn boundary, Visuals at each session start.
 *
 *     { "version": 1, "style": "pm", "visuals": true }
 *
 * `style` is "default" (today's alignments, no added text), "simplified" or "pm" (Project manager).
 * A missing or malformed file reads as Default with Visuals off. A subagent profile may override
 * either field (AlignOverride, carried by subagent-profiles.ts); resolveAlign applies it.
 */
import { readFileSync } from "node:fs";
import { statCachedReader, writeJsonAtomic } from "./delegate.ts";

export const ALIGN_SETTINGS_FILE = "mode-align.json";

export type AlignStyle = "default" | "simplified" | "pm";
/** The styles, in the order Settings lists them. */
export const ALIGN_STYLES: readonly AlignStyle[] = ["default", "simplified", "pm"];
/** Each style as the user reads it (Settings, the card's meta mark, the notes). */
export const ALIGN_STYLE_LABELS: Record<AlignStyle, string> = { default: "Default", simplified: "Simplified", pm: "Project manager" };

export const isAlignStyle = (value: unknown): value is AlignStyle => typeof value === "string" && (ALIGN_STYLES as readonly string[]).includes(value);

export interface AlignSettings {
	version: 1;
	style: AlignStyle;
	visuals: boolean;
}

/** A subagent profile's override: each field present only when the profile sets it. */
export interface AlignOverride {
	style?: AlignStyle;
	visuals?: boolean;
}

/** What a chat's align mode uses: the host's file with its profile's override on top. */
export interface AlignResolved {
	style: AlignStyle;
	visuals: boolean;
}

export function alignSettingsDefaults(): AlignSettings {
	return { version: 1, style: "default", visuals: false };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const KEYS = ["version", "style", "visuals"];

/** Strict parse of a whole file (Sova's PUT, the mesh): both fields, nothing unknown. The error names the field. */
export function parseAlignSettings(value: unknown): AlignSettings | { error: string } {
	if (!isRecord(value)) return { error: 'Expected { version: 1, style: "default" | "simplified" | "pm", visuals: boolean }' };
	if (value.version !== 1) return { error: "version must be 1" };
	const unknown = Object.keys(value).find((key) => !KEYS.includes(key));
	if (unknown !== undefined) return { error: `unknown field "${unknown}"` };
	if (!isAlignStyle(value.style)) return { error: `style must be one of ${ALIGN_STYLES.join(", ")}` };
	if (typeof value.visuals !== "boolean") return { error: "visuals must be true or false" };
	return { version: 1, style: value.style, visuals: value.visuals };
}

/** The file's text as the mesh checks it before writing: the strict parse of its JSON. */
export function parseAlignSettingsText(text: string): { ok: true; value: AlignSettings } | { ok: false; error: string } {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return { ok: false, error: "not valid JSON" };
	}
	const parsed = parseAlignSettings(json);
	return "error" in parsed ? { ok: false, error: parsed.error } : { ok: true, value: parsed };
}

/** Read the file; missing or malformed reads as the defaults (Default, Visuals off). Never throws. */
export function loadAlignSettings(path: string): AlignSettings {
	try {
		const parsed = parseAlignSettings(JSON.parse(readFileSync(path, "utf8")));
		return "error" in parsed ? alignSettingsDefaults() : parsed;
	} catch {
		return alignSettingsDefaults();
	}
}

/** Atomic write (tmp + rename), canonical shape. Settings → Alignment is the writer. */
export function saveAlignSettings(path: string, settings: AlignSettings): void {
	writeJsonAtomic(path, { version: 1, style: settings.style, visuals: settings.visuals });
}

/** The settings as a turn boundary reads them: one stat, re-parsed only on change. */
export const alignSettingsReader = (path: string): (() => AlignSettings) => statCachedReader(path, loadAlignSettings, alignSettingsDefaults);

/**
 * A profile's `alignment` as stored: an object with `style` and/or `visuals`, nothing else, and at
 * least one of them (an empty override is a mistake, never written). Errors name the field under `where`.
 */
export function parseAlignOverride(value: unknown, where: string): AlignOverride | { error: string } {
	if (!isRecord(value)) return { error: `${where} must be an object { style?, visuals? }` };
	const unknown = Object.keys(value).find((key) => key !== "style" && key !== "visuals");
	if (unknown !== undefined) return { error: `${where}: unknown field "${unknown}"` };
	if (value.style === undefined && value.visuals === undefined) return { error: `${where} must set style or visuals (omit it to use the host default)` };
	const out: AlignOverride = {};
	if (value.style !== undefined) {
		if (!isAlignStyle(value.style)) return { error: `${where}.style must be one of ${ALIGN_STYLES.join(", ")}` };
		out.style = value.style;
	}
	if (value.visuals !== undefined) {
		if (typeof value.visuals !== "boolean") return { error: `${where}.visuals must be true or false` };
		out.visuals = value.visuals;
	}
	return out;
}

/** The chat's align settings: its profile's override, field by field, else the host's file. */
export function resolveAlign(host: Pick<AlignSettings, "style" | "visuals">, override: AlignOverride | null | undefined): AlignResolved {
	return { style: override?.style ?? host.style, visuals: override?.visuals ?? host.visuals };
}
