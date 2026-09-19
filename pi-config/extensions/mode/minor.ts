/** Minor modes: independently toggleable prompt biases on top of the major mode. No imports: unit-testable. */

export type MinorMode = "align";

/** Registry order: the canonical order for state, status, and prompt composition. */
export const MINOR_MODES: readonly MinorMode[] = ["align"];

export function isMinorMode(value: unknown): value is MinorMode {
	return typeof value === "string" && (MINOR_MODES as readonly string[]).includes(value);
}

export const MINOR_DESCRIPTIONS: Record<MinorMode, string> = {
	align: "Align with the user on what to build (architecture, UX, scope) before building",
};

export const ALIGN_INSTRUCTIONS = `# Minor mode: align

Before building anything non-trivial, align with the user on what to build. Do not edit files or spawn implementation workers until the user has confirmed a plan.

On any prompt that implies work (a feature, an investigated fix, a refactor, a migration, new files, or any multi-step change), do this first:
1. Investigate the codebase and context behind the ask. In claude-heavy mode delegate this to a planning worker that does not edit; otherwise investigate yourself. Find the real constraints, existing patterns, and affected surfaces.
2. Reply with what you found in a few lines, the approach you would take, and numbered open questions on architecture, UX, scope, and trade-offs, including alternatives you rejected and why. Ask only what would materially change the work; do not pad with obvious questions.
3. Stop and wait. Build only after the user confirms or answers, and then do not re-ask points already settled.

Exempt: questions and explanations, explicit commands to run, trivial one-line changes the user pointed at, follow-ups that are plainly a confirmation, and prompts where the user says to skip alignment. When the ask already looks fully specified, still confirm your reading of it in one short message before building. Bias heavily toward asking.`;

const MINOR_INSTRUCTIONS: Record<MinorMode, string> = {
	align: ALIGN_INSTRUCTIONS,
};

export function buildMinorPrompt(mode: MinorMode): string {
	return MINOR_INSTRUCTIONS[mode];
}

/** Canonical order, deduped, unknown names dropped. */
export function normalizeMinorModes(value: unknown): MinorMode[] {
	if (!Array.isArray(value)) return [];
	return MINOR_MODES.filter((mode) => value.includes(mode));
}

/** "align,foo" → { minorModes: ["align"], unknown: ["foo"] }; "none" → empty; undefined when not a string. */
export function parseMinorFlag(value: unknown): { minorModes: MinorMode[]; unknown: string[] } | undefined {
	if (typeof value !== "string") return undefined;
	const names = value
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name !== "" && name !== "none");
	return {
		minorModes: normalizeMinorModes(names),
		unknown: [...new Set(names.filter((name) => !isMinorMode(name)))],
	};
}
