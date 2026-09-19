/** Pure mode-state handling for the mode switcher. No pi imports: unit-testable with node --test. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MINOR_MODES, normalizeMinorModes, type MinorMode } from "./minor.ts";

export type Mode = "normal" | "claude-heavy";

export interface ModeState {
	version: 1;
	mode: Mode;
	/** Strict mode additionally removes the edit/write tools from the orchestrator while heavy. Advisory only; default off. */
	strict: boolean;
	/** Optional override of the toggle shortcut (a pi-tui KeyId, for example "alt+h"). Default: alt+m. */
	shortcut?: string;
	/** Active minor modes, canonical order. Absent in older files: loads as empty. */
	minorModes: MinorMode[];
	/** Optional per-minor-mode toggle shortcuts (pi-tui KeyIds). None by default. */
	minorShortcuts?: Partial<Record<MinorMode, string>>;
	/** Optional override of the alignment-doc viewer shortcut (a pi-tui KeyId). Default: alt+a. */
	viewerShortcut?: string;
}

export const DEFAULT_MODE_SHORTCUT = "alt+m";
export const DEFAULT_ALIGN_VIEWER_SHORTCUT = "alt+a";

export function defaults(): ModeState {
	return { version: 1, mode: "normal", strict: false, minorModes: [] };
}

export function isMode(value: unknown): value is Mode {
	return value === "normal" || value === "claude-heavy";
}

export function toggleMode(mode: Mode): Mode {
	return mode === "normal" ? "claude-heavy" : "normal";
}

// Matches the single-chord KeyId grammar pi-tui parses; double-tap/leader chords are not supported by pi.
const MODIFIER = "(?:ctrl\\+|shift\\+|alt\\+|super\\+){1,3}";
const KEY = "(?:[a-z0-9`\\-=\\[\\]\\\\;',./]|f(?:[1-9]|1[0-2])|tab|space|enter|backspace|escape|delete|insert|home|end|pageUp|pageDown|up|down|left|right)";
const SHORTCUT_PATTERN = new RegExp(`^${MODIFIER}${KEY}$`);

export function parseShortcut(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return SHORTCUT_PATTERN.test(trimmed) ? trimmed : undefined;
}

/** Fill defaults, drop unknown fields, and reject invalid values so a hand-edited file can never break loading. */
export function normalizeState(value: unknown): ModeState {
	const state = defaults();
	if (value === null || typeof value !== "object" || Array.isArray(value)) return state;
	const record = value as Record<string, unknown>;
	if (isMode(record.mode)) state.mode = record.mode;
	if (typeof record.strict === "boolean") state.strict = record.strict;
	const shortcut = parseShortcut(record.shortcut);
	if (shortcut !== undefined) state.shortcut = shortcut;
	const viewerShortcut = parseShortcut(record.viewerShortcut);
	if (viewerShortcut !== undefined) state.viewerShortcut = viewerShortcut;
	state.minorModes = normalizeMinorModes(record.minorModes);
	const rawMinorShortcuts = record.minorShortcuts;
	if (rawMinorShortcuts !== null && typeof rawMinorShortcuts === "object" && !Array.isArray(rawMinorShortcuts)) {
		const minorShortcuts: Partial<Record<MinorMode, string>> = {};
		for (const mode of MINOR_MODES) {
			const key = parseShortcut((rawMinorShortcuts as Record<string, unknown>)[mode]);
			if (key !== undefined) minorShortcuts[mode] = key;
		}
		if (Object.keys(minorShortcuts).length > 0) state.minorShortcuts = minorShortcuts;
	}
	return state;
}

export function hasMinor(state: ModeState, mode: MinorMode): boolean {
	return state.minorModes.includes(mode);
}

/** New state with the minor mode on or off, canonical order. Never mutates the input. */
export function withMinor(state: ModeState, mode: MinorMode, on: boolean): ModeState {
	const others = state.minorModes.filter((active) => active !== mode);
	return { ...state, minorModes: normalizeMinorModes(on ? [...others, mode] : others) };
}

/** Read the global state file; missing or corrupt files fall back to defaults. Never throws. */
export function loadState(path: string): ModeState {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return defaults();
	}
	try {
		return normalizeState(JSON.parse(raw));
	} catch {
		return defaults();
	}
}

/** Atomic write so a crash mid-toggle cannot corrupt the only global mode record. */
export function saveState(path: string, state: ModeState): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
	renameSync(temporary, path);
}
