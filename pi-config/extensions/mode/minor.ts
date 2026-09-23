/** Minor modes: independently toggleable prompt biases on top of the major mode. Node builtins only: unit-testable. */

import { readFileSync } from "node:fs";

export type MinorMode = "align" | "spec";

/** Registry order: the canonical order for state, status, and prompt composition. */
export const MINOR_MODES: readonly MinorMode[] = ["align", "spec"];

export function isMinorMode(value: unknown): value is MinorMode {
	return typeof value === "string" && (MINOR_MODES as readonly string[]).includes(value);
}

export const MINOR_DESCRIPTIONS: Record<MinorMode, string> = {
	align: "Align with the user on what to build (architecture, UX, scope) before building",
	spec: "Scope work from the project's .sova/spec documentation, propose changes in drafts, and promote them once implemented",
};

export const ALIGN_INSTRUCTIONS = `# Minor mode: align

Before building anything non-trivial, align with the user on what to build. Do not edit files or spawn implementation workers until the user has confirmed a plan.

On any prompt that implies work (a feature, an investigated fix, a refactor, a migration, new files, or any multi-step change), do this first:
1. Investigate the codebase and context behind the ask. In delegate mode give this to a non-editing Planning & specs worker (investigation that feeds a design is planning, not the Investigation profile); otherwise investigate yourself. Find the real constraints, existing patterns, and affected surfaces.
2. Reply with an alignment block in exactly this markdown shape (surrounding prose may be brief; the block is captured into a viewer the user reads, so keep it self-contained):

## Alignment: <short title>
### Findings
A few lines on what you found.
### Approach
What you would do, in order.
### Open questions
- [ ] **1. Topic:** Question on architecture, UX, scope, or trade-offs, with your recommendation.
- [ ] **2. Topic:** Next question.
### Rejected
- Alternative — why not.
### Status
aligning

   Number each question INSIDE the checkbox label — \`- [ ] **1. Topic:** …\`, \`- [ ] **2. Topic:** …\` — never as a markdown list number (\`1. [ ] …\`): the viewer renders the checkbox as a glyph and drops list numbering, so a number outside the label is lost and the user cannot answer "2". Keep each question's number and topic stable across re-emits, so "1" means the same question all the way through. Ask only what would materially change the work; do not pad with obvious questions. Use real markdown headings, not bold look-alikes: the \`## Alignment: <title>\` anchor carries the title into the viewer, and bold pseudo-headings are only a tolerated fallback (they parse with an empty title; other shapes are dropped with a warning).
3. Stop and wait. Build only after the user confirms or answers, and then do not re-ask points already settled.

Whenever anything in the block changes (the user answers, scope moves, you learn something), re-emit the whole block, updated: mark settled questions \`[x]\` and append the decision after an em dash (\`- [x] **1. Topic:** … — decision\`), keep unsettled ones \`[ ]\`, and keep every question's number and topic unchanged. When the user confirms, re-emit it once more with Status \`confirmed\`; when you begin building, Status \`implementing\`. If the user says to go ahead while questions are still open, treat that as confirmation: set Status \`implementing\`, keep those questions \`[ ]\`, and proceed with your recommendation. Keep the headings verbatim so the block can be parsed.

Exempt: questions and explanations, explicit commands to run, trivial one-line changes the user pointed at, follow-ups that are plainly a confirmation, and prompts where the user says to skip alignment. When the ask already looks fully specified, still confirm your reading of it in one short alignment block before building. Bias heavily toward asking.`;

/**
 * The spec mode's text is spec-mode.md beside this module, read once at load: the injected block is that file
 * byte for byte, minus trailing whitespace (trimEnd). It is the one copy of the discipline; a project's own
 * instructions may point agents at the same file.
 */
export const SPEC_INSTRUCTIONS = readFileSync(new URL("./spec-mode.md", import.meta.url), "utf8").trimEnd();

/**
 * Shell prefix that sets `$core` to the trusted spec tools: the directory install.sh links into the agent dir
 * (pi-config/extensions/spec/core/). It is the single line of the one ```sh block in spec-mode.md, so the
 * prompt and this export can't disagree; a missing, repeated or multi-line block fails at load. Same rule as
 * pi's getAgentDir(): only an exact "~" or a leading "~/" in PI_CODING_AGENT_DIR is home ("~other" stays
 * literal). Pi's bash tool always runs bash, and each call is a fresh shell.
 */
export const SPEC_CORE_SHELL = specCoreShell(SPEC_INSTRUCTIONS);

function specCoreShell(text: string): string {
	const fences = text.match(/^```sh$/gm)?.length ?? 0;
	const shell = /^```sh\n([^\n]+)\n```$/m.exec(text)?.[1];
	if (fences !== 1 || shell === undefined) throw new Error(`spec-mode.md: expected exactly one single-line \`\`\`sh block (the shell prefix), found ${fences}`);
	if (text.split(shell).length !== 2) throw new Error("spec-mode.md: the shell prefix must appear only in its ```sh block");
	return shell;
}

const MINOR_INSTRUCTIONS: Record<MinorMode, string> = {
	align: ALIGN_INSTRUCTIONS,
	spec: SPEC_INSTRUCTIONS,
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
