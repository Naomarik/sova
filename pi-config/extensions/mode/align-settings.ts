/**
 * The align minor mode's settings: its Eagerness, writing style and Visuals (§chat.alignment/settings-file).
 * Pure: node builtins and sibling mode files only, no pi imports — unit-testable with node --test,
 * and imported by Sova's server (Settings → Alignment, the mesh registration, a chat's start-time
 * Visuals) beside spec.ts.
 *
 * One JSON file, `~/.pi/agent/mode-align.json`, separate from mode.json for the same reason as
 * mode-spec.json (normalizeState rebuilds mode.json from known fields only). Global: the style and
 * Eagerness are re-read (one stat) at every turn boundary, Visuals at each session start.
 *
 *     { "version": 1, "style": "pm", "visuals": true, "eagerness": "careful" }
 *
 * `style` is "pm" (Project manager), "simplified" or "default" (shown as Technical: the files, code
 * and technical trade-offs, no added text; stored as "default", never migrated). A missing or
 * malformed file reads as Project manager with Visuals off and Eager. `eagerness` is "careful" or
 * absent (Eager, §chat.alignment/eagerness; "eager" written by hand reads the same): the writer stores
 * it only for Careful, so a file saved with Eager is the same bytes an older device already accepts.
 * A subagent profile may override any field (AlignOverride, carried by subagent-profiles.ts);
 * resolveAlign applies it.
 */
import { readFileSync } from "node:fs";
import { statCachedReader, writeJsonAtomic } from "./delegate.ts";

export const ALIGN_SETTINGS_FILE = "mode-align.json";

export type AlignStyle = "default" | "simplified" | "pm";
/** The styles, in the order Settings lists them (Technical last). */
export const ALIGN_STYLES: readonly AlignStyle[] = ["pm", "simplified", "default"];
/** Each style as the user reads it (Settings, the card's meta mark, the notes). */
export const ALIGN_STYLE_LABELS: Record<AlignStyle, string> = { default: "Technical", simplified: "Simplified", pm: "Project manager" };

export const isAlignStyle = (value: unknown): value is AlignStyle => typeof value === "string" && (ALIGN_STYLES as readonly string[]).includes(value);

/** How readily an alignment opens (§chat.alignment/eagerness). Eager is the default. */
export type AlignEagerness = "eager" | "careful";
/** The choices, in the order every surface lists them. */
export const ALIGN_EAGERNESSES: readonly AlignEagerness[] = ["eager", "careful"];
export const ALIGN_EAGERNESS_LABELS: Record<AlignEagerness, string> = { eager: "Eager", careful: "Careful" };
export const isAlignEagerness = (value: unknown): value is AlignEagerness => typeof value === "string" && (ALIGN_EAGERNESSES as readonly string[]).includes(value);

export interface AlignSettings {
	version: 1;
	style: AlignStyle;
	visuals: boolean;
	/** Absent: Eager. A parse keeps only "careful"; the writer stores nothing else. */
	eagerness?: AlignEagerness;
}

/** A subagent profile's override: each field present only when the profile sets it. */
export interface AlignOverride {
	eagerness?: AlignEagerness;
	style?: AlignStyle;
	visuals?: boolean;
}

/** What a chat's align mode uses: the host's file with its profile's override on top. */
export interface AlignResolved {
	eagerness: AlignEagerness;
	style: AlignStyle;
	visuals: boolean;
}

export function alignSettingsDefaults(): AlignSettings {
	return { version: 1, style: "pm", visuals: false };
}

/** The file's Eagerness as a chat reads it: absent is Eager. */
export const eagernessOf = (settings: Pick<AlignSettings, "eagerness">): AlignEagerness => settings.eagerness ?? "eager";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

const KEYS = ["version", "style", "visuals", "eagerness"];

/**
 * Strict parse of a whole file (Sova's PUT, the mesh): style and visuals, an optional eagerness, nothing
 * unknown. The error names the field. Eager comes back with no `eagerness`, so the shape stays canonical.
 */
export function parseAlignSettings(value: unknown): AlignSettings | { error: string } {
	if (!isRecord(value)) return { error: 'Expected { version: 1, style: "pm" | "simplified" | "default", visuals: boolean, eagerness?: "eager" | "careful" }' };
	if (value.version !== 1) return { error: "version must be 1" };
	const unknown = Object.keys(value).find((key) => !KEYS.includes(key));
	if (unknown !== undefined) return { error: `unknown field "${unknown}"` };
	if (!isAlignStyle(value.style)) return { error: `style must be one of ${ALIGN_STYLES.join(", ")}` };
	if (typeof value.visuals !== "boolean") return { error: "visuals must be true or false" };
	if (value.eagerness !== undefined && !isAlignEagerness(value.eagerness)) return { error: `eagerness must be one of ${ALIGN_EAGERNESSES.join(", ")}` };
	return { version: 1, style: value.style, visuals: value.visuals, ...(value.eagerness === "careful" ? { eagerness: "careful" as const } : {}) };
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

/** Read the file; missing or malformed reads as the defaults (Project manager, Visuals off, Eager). Never throws. */
export function loadAlignSettings(path: string): AlignSettings {
	try {
		const parsed = parseAlignSettings(JSON.parse(readFileSync(path, "utf8")));
		return "error" in parsed ? alignSettingsDefaults() : parsed;
	} catch {
		return alignSettingsDefaults();
	}
}

/**
 * Atomic write (tmp + rename), canonical shape. Settings → Alignment is the writer. `eagerness` only for
 * Careful: an Eager file is byte for byte what it was before the field existed.
 */
export function saveAlignSettings(path: string, settings: AlignSettings): void {
	writeJsonAtomic(path, { version: 1, style: settings.style, visuals: settings.visuals, ...(settings.eagerness === "careful" ? { eagerness: "careful" } : {}) });
}

/** The settings as a turn boundary reads them: one stat, re-parsed only on change. */
export const alignSettingsReader = (path: string): (() => AlignSettings) => statCachedReader(path, loadAlignSettings, alignSettingsDefaults);

/**
 * A profile's `alignment` as stored: an object with `eagerness`, `style` and/or `visuals`, nothing else,
 * and at least one of them (an empty override is a mistake, never written). Errors name the field under `where`.
 */
export function parseAlignOverride(value: unknown, where: string): AlignOverride | { error: string } {
	if (!isRecord(value)) return { error: `${where} must be an object { eagerness?, style?, visuals? }` };
	const unknown = Object.keys(value).find((key) => key !== "eagerness" && key !== "style" && key !== "visuals");
	if (unknown !== undefined) return { error: `${where}: unknown field "${unknown}"` };
	if (value.eagerness === undefined && value.style === undefined && value.visuals === undefined) return { error: `${where} must set eagerness, style or visuals (omit it to use the host default)` };
	const out: AlignOverride = {};
	if (value.eagerness !== undefined) {
		if (!isAlignEagerness(value.eagerness)) return { error: `${where}.eagerness must be one of ${ALIGN_EAGERNESSES.join(", ")}` };
		out.eagerness = value.eagerness;
	}
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
export function resolveAlign(host: Pick<AlignSettings, "style" | "visuals" | "eagerness">, override: AlignOverride | null | undefined): AlignResolved {
	return { eagerness: override?.eagerness ?? eagernessOf(host), style: override?.style ?? host.style, visuals: override?.visuals ?? host.visuals };
}
