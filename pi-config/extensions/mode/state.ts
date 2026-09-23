/**
 * Pure mode-state handling for the mode switcher. No pi imports: unit-testable with node --test,
 * and imported by pi-web's server, so this file must stay runtime-free.
 *
 * Two shapes live here. `ModeState` is the file at ~/.pi/agent/mode.json: the shortcuts, plus the
 * mode/strict/minorModes triple that is now only the **default for new sessions**. `ModeActive` is
 * that triple as one session's own active state, carried in the session's `mode` custom entries.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MINOR_MODES, normalizeMinorModes, type MinorMode } from "./minor.ts";

export type Mode = "normal" | "delegate";

/** Canonical modes, in menu order. Only these are ever written. */
export const MODES: readonly Mode[] = ["normal", "delegate"];

/** One line per mode: the palette rows and Sova's mode menu both show it. */
export const MODE_DESCRIPTIONS: Record<Mode, string> = {
	normal: "Pi as usual",
	delegate: "Orchestrate: route planning, investigation and implementation to workers by profile",
};

/**
 * Names a mode was once written under. Read everywhere a mode is parsed — mode.json, session
 * snapshots, launch flags, /mode arguments, Sova's API — and never written: "claude-heavy" is
 * what Delegate was called until 2026-09, and transcripts and files carrying it are never
 * rewritten, so this alias is permanent.
 */
export const LEGACY_MODE_ALIASES: Readonly<Record<string, Mode>> = { "claude-heavy": "delegate" };

export interface ModeState {
	version: 1;
	/** The major mode new sessions start in. A session's own mode lives in its `mode` entries (see ModeActive). */
	mode: Mode;
	/** Strict mode additionally removes the edit/write tools from the orchestrator while in delegate. Default for new sessions; off by default. */
	strict: boolean;
	/** Optional override of the toggle shortcut (a pi-tui KeyId, for example "alt+h"). Default: alt+m. Global. */
	shortcut?: string;
	/** Minor modes new sessions start with, canonical order. Absent in older files: loads as empty. */
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

/** A canonical mode name. Legacy names are not modes; `parseMode` reads them. */
export function isMode(value: unknown): value is Mode {
	return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

/** The mode a stored or typed name means: canonical names as is, legacy aliases mapped, else undefined. */
export function parseMode(value: unknown): Mode | undefined {
	if (isMode(value)) return value;
	if (typeof value !== "string" || !Object.hasOwn(LEGACY_MODE_ALIASES, value)) return undefined;
	return LEGACY_MODE_ALIASES[value];
}

export function toggleMode(mode: Mode): Mode {
	return mode === "normal" ? "delegate" : "normal";
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
	const mode = parseMode(record.mode);
	if (mode !== undefined) state.mode = mode;
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

export function hasMinor(state: Pick<ModeState, "minorModes">, mode: MinorMode): boolean {
	return state.minorModes.includes(mode);
}

/** New state with the minor mode on or off, canonical order. Never mutates the input. */
export function withMinor<T extends { minorModes: MinorMode[] }>(state: T, mode: MinorMode, on: boolean): T {
	const others = state.minorModes.filter((active) => active !== mode);
	return { ...state, minorModes: normalizeMinorModes(on ? [...others, mode] : others) };
}

// ── Per-session active state ─────────────────────────────────────────────────

/** The custom-entry type the extension appends on every switch; also the carrier of the snapshot below. */
export const MODE_ENTRY_TYPE = "mode";

/** One session's active mode, snapshotted into every `mode` entry so it restores with the transcript. */
export interface ModeActive {
	version: 1;
	mode: Mode;
	strict: boolean;
	minorModes: MinorMode[];
}

/** The session-scoped triple of a state or another active snapshot, copied (never aliased). */
export function activeOf(state: Pick<ModeState, "mode" | "strict" | "minorModes">): ModeActive {
	return { version: 1, mode: state.mode, strict: state.strict, minorModes: [...state.minorModes] };
}

/**
 * A stored snapshot, or undefined for anything this version does not understand: a legacy delta
 * marker with no snapshot, a newer `version`, or a malformed payload. Never throws.
 */
export function normalizeActive(value: unknown): ModeActive | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const mode = parseMode(record.mode);
	if (record.version !== 1 || mode === undefined) return undefined;
	return {
		version: 1,
		mode,
		strict: record.strict === true,
		minorModes: normalizeMinorModes(record.minorModes),
	};
}

/**
 * The newest usable snapshot on a session branch, or undefined when the session never switched
 * anything (only legacy markers, or no `mode` entry at all) — the caller then uses the default.
 * Shared with pi-web so the server and the extension restore by the same rule. Never throws.
 */
export function restoreActive(entries: readonly { type: string; customType?: string; data?: unknown }[]): ModeActive | undefined {
	if (!Array.isArray(entries)) return undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || entry.type !== "custom" || entry.customType !== MODE_ENTRY_TYPE) continue;
		const data = entry.data;
		if (data === null || typeof data !== "object" || Array.isArray(data)) continue;
		const active = normalizeActive((data as Record<string, unknown>).active);
		if (active) return active;
	}
	return undefined;
}

/** Read the defaults file; missing or corrupt files fall back to built-in defaults. Never throws. */
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

/** Atomic write so a crash cannot corrupt the defaults file. Only `/mode default` and pi-web write it. */
export function saveState(path: string, state: ModeState): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
	renameSync(temporary, path);
}
