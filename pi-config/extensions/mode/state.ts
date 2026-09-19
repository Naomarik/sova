/** Pure mode-state handling for the mode switcher. No pi imports: unit-testable with node --test. */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Mode = "normal" | "claude-heavy";

export interface ModeState {
	version: 1;
	mode: Mode;
	/** Strict mode additionally removes the edit/write tools from the orchestrator while heavy. Advisory only; default off. */
	strict: boolean;
	/** Optional override of the toggle shortcut (a pi-tui KeyId, for example "alt+h"). Default: alt+m. */
	shortcut?: string;
}

export const DEFAULT_MODE_SHORTCUT = "alt+m";

export function defaults(): ModeState {
	return { version: 1, mode: "normal", strict: false };
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
	return state;
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
