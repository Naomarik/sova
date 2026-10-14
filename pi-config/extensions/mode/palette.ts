/** Rows for the ctrl+p "Mode" category. Pure: the palette type is imported as a type only. */
import type { MenuItem } from "../command-palette/contracts.ts";
import { MINOR_DESCRIPTIONS, MINOR_MODES, MINOR_SURFACES, type MinorMode } from "./minor.ts";
import { hasMinor, MODE_DESCRIPTIONS, MODES, type Mode, type ModeState } from "./state.ts";

export interface ModeActions {
	setMode(next: Mode): void | Promise<void>;
	setMinor(minor: MinorMode, on: boolean): void;
	/** Open the read-only alignments viewer (align minor mode). */
	openAlignViewer(): void | Promise<void>;
	/** Write this session's mode, strict flag and minor modes to mode.json as the default for new sessions. */
	saveDefault(): void | Promise<void>;
	/** This chat's project modes (§chat.mode-menu/project-modes): rows after the built-in minors. */
	projectRows?(): ProjectPaletteRow[];
	/** The checkout's name, for the rows' group label. */
	projectGroup?(): string;
	setProject?(id: string, on: boolean): void;
	/** Say why a broken row can't be turned on. */
	notify?(text: string): void;
}

/** One project mode as the palette lists it (index.ts ProjectModeRow). */
export interface ProjectPaletteRow {
	id: string;
	description: string;
	on: boolean;
	problem?: string;
	removed?: boolean;
	changed?: boolean;
	needsApproval?: boolean;
}

/** A project row's description: its own, then its state. */
export function projectRowDescription(row: ProjectPaletteRow, group: string): string {
	const state = row.removed
		? "Removed from the project; turn it off to drop it"
		: row.problem !== undefined && !row.on
			? `Broken: ${row.problem}`
			: row.changed
				? "Changed since turned on"
				: row.needsApproval
					? "Needs approval in a Sova chat's mode menu"
					: undefined;
	return [`This project · ${group}`, row.description, state].filter(Boolean).join(" — ");
}

export const MODE_CATEGORY_ID = "mode";

/**
 * Major modes pick-and-close (radio, current ✓); minor modes toggle in place with a live marker;
 * then the align viewer, then "save as default". Everything above the last row is this session only.
 */
export function modeCategoryItems(getState: () => Pick<ModeState, "mode" | "minorModes">, actions: ModeActions): MenuItem[] {
	const current = getState().mode;
	const majors: MenuItem[] = MODES.map((mode) => ({
		id: `mode:${mode}`,
		label: `${mode === current ? "✓" : " "} ${mode}`,
		description: MODE_DESCRIPTIONS[mode],
		run: () => actions.setMode(mode),
	}));
	// A web-only mode (memory) is turned on from Sova's menu alone: no row here.
	const minors: MenuItem[] = MINOR_MODES.filter((minor) => MINOR_SURFACES[minor] !== "web").map((minor) => ({
		id: `mode:minor:${minor}`,
		label: minor,
		description: MINOR_DESCRIPTIONS[minor],
		toggle: {
			isOn: () => hasMinor(getState(), minor),
			toggle: () => actions.setMinor(minor, !hasMinor(getState(), minor)),
		},
	}));
	const viewer: MenuItem = {
		id: "mode:align:view",
		label: "align: open viewer",
		description: "Read this session's alignments (questions, decisions, findings, approach)",
		run: () => actions.openAlignViewer(),
	};
	const saveDefault: MenuItem = {
		id: "mode:default:save",
		label: "save as default",
		description: "New sessions start in this session's mode, strict flag and minor modes",
		run: () => actions.saveDefault(),
	};
	// Project modes: a broken one runs (says why), every other toggles; a removed one only turns off.
	const group = actions.projectGroup?.() ?? "";
	const projects: MenuItem[] = (actions.projectRows?.() ?? []).map((row) => {
		const base = { id: `mode:project:${row.id}`, label: row.id, description: projectRowDescription(row, group) };
		if (!row.on && (row.problem !== undefined || row.removed)) return { ...base, run: () => actions.notify?.(`${row.id} can't be turned on: ${row.problem ?? "removed from the project"}`) };
		const isOn = () => actions.projectRows?.().find((r) => r.id === row.id)?.on ?? false;
		return { ...base, toggle: { isOn, toggle: () => actions.setProject?.(row.id, !isOn()) } };
	});
	return [...majors, ...minors, ...projects, viewer, saveDefault];
}
