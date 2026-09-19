/** Rows for the ctrl+p "Mode" category. Pure: the palette type is imported as a type only. */
import type { MenuItem } from "../command-palette/contracts.ts";
import { MINOR_DESCRIPTIONS, MINOR_MODES, type MinorMode } from "./minor.ts";
import { hasMinor, type Mode, type ModeState } from "./state.ts";

export interface ModeActions {
	setMode(next: Mode): void | Promise<void>;
	setMinor(minor: MinorMode, on: boolean): void;
}

export const MODE_CATEGORY_ID = "mode";

const MODE_DESCRIPTIONS: Record<Mode, string> = {
	normal: "Pi as usual",
	"claude-heavy": "Orchestrate: delegate coding and planning to Claude Code workers",
};

/** Major modes pick-and-close (radio, current ✓); minor modes toggle in place with a live marker. */
export function modeCategoryItems(getState: () => ModeState, actions: ModeActions): MenuItem[] {
	const current = getState().mode;
	const majors: MenuItem[] = (["normal", "claude-heavy"] as const).map((mode) => ({
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
	return [...majors, ...minors];
}
