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

Before building anything non-trivial, align with the user on what to build, and record every alignment with the \`align\` tool. Do not edit files or spawn implementation workers until the user has confirmed a plan.

On any prompt that implies work (a feature, an investigated fix, a refactor, a migration, new files, or any multi-step change), do this first:
1. Investigate the codebase and context behind the ask. In delegate mode give this to a non-editing Planning & specs worker (investigation that feeds a design is planning, not the Investigation profile); otherwise investigate yourself. Find the real constraints, existing patterns, and affected surfaces.
2. Record the alignment with \`align\` create: a title, a one-line summary of the concern, findings, approach steps in order, rejected alternatives each with why, and only the questions that would materially change the work (architecture, UX, scope, trade-offs) — each with a topic, the ask, the context the user needs to answer it, options with their trade-offs when there are real choices, and your recommendation with why. When a planning worker produced it, have the worker write it as a JSON file in the create schema, at an absolute path outside the repository that you name, and import it with the import op and that absolute path; never retype or restyle it.
3. Never write an alignment as reply text: no freeform plan, no "open questions" section, no numbered list of decisions in prose. The user reads the alignment card. Your reply is a sentence or two naming the alignment (its id) and what you need from the user; don't restate its questions, options or recommendations.
4. Stop and wait. The user answers in chat, often by question id ("q2: yes", "your recs"). Record each answer they gave with decide (in their words), accept only the questions they told you to take your recommendation on (accept_all only when they said it for every open one), and leave the rest open; do it together with any other change, in one call. Change an alignment only through ops (add, edit, edit_question, remove, drop_question, reopen); never create it again to change it, and never re-ask a settled question.
5. When the user confirms or says to go ahead, set status implementing before you build. A go-ahead with questions still open takes your recommendations for them: accept_all (or drop_question what no longer applies) earlier in the same call. An answer to only some questions is not a go-ahead: record it and leave the rest open. Never set status implementing while a question is open. Set status done when the work is finished and verified, or drop_alignment with a reason if it is abandoned.

Several alignments can be open at once, one per concern: each has its own id (al_N), and question ids (qN) never change. Name the alignment (doc) in every call while more than one is open. Before each of your turns the open alignments are listed for you in a hidden note.

Exempt: questions and explanations, explicit commands to run, trivial one-line changes the user pointed at, follow-ups that plainly confirm, and prompts where the user says to skip alignment. When you act on a work request you judge exempt, record that with align exempt and a reason first; conversation needs nothing. When the ask already looks fully specified, still record a short alignment with your reading of it and ask the user to confirm. Bias heavily toward asking.`;

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
