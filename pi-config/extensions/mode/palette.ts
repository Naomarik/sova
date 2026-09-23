/** Rows for the ctrl+p "Mode" category. Pure: the palette type is imported as a type only. */
import type { MenuItem } from "../command-palette/contracts.ts";
import { MINOR_DESCRIPTIONS, MINOR_MODES, type MinorMode } from "./minor.ts";
import { hasMinor, MODE_DESCRIPTIONS, MODES, type Mode, type ModeState } from "./state.ts";

export interface ModeActions {
	setMode(next: Mode): void | Promise<void>;
	setMinor(minor: MinorMode, on: boolean): void;
	/** Open the read-only alignment-doc viewer (align minor mode). */
	openAlignViewer(): void | Promise<void>;
	/** Write this session's mode, strict flag and minor modes to mode.json as the default for new sessions. */
	saveDefault(): void | Promise<void>;
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
	const minors: MenuItem[] = MINOR_MODES.map((minor) => ({
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
		description: "Read the accumulated alignment doc (findings, approach, open questions)",
		run: () => actions.openAlignViewer(),
	};
	const saveDefault: MenuItem = {
		id: "mode:default:save",
		label: "save as default",
		description: "New sessions start in this session's mode, strict flag and minor modes",
		run: () => actions.saveDefault(),
	};
	return [...majors, ...minors, viewer, saveDefault];
}
