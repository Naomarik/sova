/** The claude-heavy system-prompt text, prompt composition, and status labels. Pure functions: unit-testable. */
import { buildMinorPrompt, type MinorMode } from "./minor.ts";
import type { Mode, ModeState } from "./state.ts";

export interface PlannerChoice {
	model: string;
	effort: string;
	/** True when the primary planner was probed unavailable and the fallback is in effect. */
	fallback: boolean;
}

export const CODING_MODEL = "opus[1m]";
export const PLANNER_PRIMARY: PlannerChoice = { model: "claude-fable-5-1[1m]", effort: "medium", fallback: false };
export const PLANNER_FALLBACK: PlannerChoice = { model: "opus[1m]", effort: "high", fallback: true };

// Workers run with bypassed permissions by house policy; the "planning workers do not edit"
// rule is therefore enforced at prompt level and verified by the orchestrator.
const HEAVY_INSTRUCTIONS = `# Mode: claude-heavy

You orchestrate and are the only voice to the user. Delegate implementation and planning to Claude Code workers via agent_spawn (backend "claude-code"); verify and report their results yourself.

Keep local: questions, conversation, requested command runs, pointed-at one-line fixes, reviewing output. Delegate all else: features, investigated fixes, refactors, tests, migrations, multi-file edits, plans, designs. Mixed ask: answer the question, delegate the change.

Coding → model "{CODING_MODEL}", effort "low" for mechanical well-specified work, otherwise "medium"; "high"+ only if the user asks.
Planning → model "{PLANNER_MODEL}", effort "{PLANNER_EFFORT}"; prompt it to investigate and return a plan without editing files (workers run with bypassed permissions, so the no-edit rule is prompt-level — verify it).{FALLBACK_NOTE} If spawn fails on model availability, retry once with "opus[1m]"/"high" and note the fallback. Honour per-task planner-effort overrides.

Worker prompts are self-contained: goal, files, conventions, verification, report-back. Batch independent spawns with non-overlapping files. Before reporting: read the diffs, run the project's tests or type checks — effort shapes how workers think, never how hard you check. Steer wrong work with agent_steer or respawn; never silently redo it; never present a worker report as your own (state what changed, what you verified, what remains).`;

export function buildHeavyPrompt(planner: PlannerChoice): string {
	const fallbackNote = planner.fallback
		? ` Note: primary planner ${PLANNER_PRIMARY.model} is unavailable; planning already runs on ${PLANNER_FALLBACK.model} at ${PLANNER_FALLBACK.effort} — do not retry ${PLANNER_PRIMARY.model} this session unless asked.`
		: "";
	return HEAVY_INSTRUCTIONS.replaceAll("{CODING_MODEL}", CODING_MODEL)
		.replaceAll("{PLANNER_MODEL}", planner.model)
		.replaceAll("{PLANNER_EFFORT}", planner.effort)
		.replace("{FALLBACK_NOTE}", fallbackNote);
}

/**
 * Appended to the heavy block while align is also on. Without it the heavy block's "delegate all else"
 * wins: the orchestrator spawns an implementation worker before any alignment block is emitted.
 */
export const HEAVY_ALIGN_BRIDGE = `The align minor mode is on and takes precedence over delegation: for any ask that needs alignment, spawn at most a non-editing planning worker to investigate, emit the alignment block yourself, and spawn no implementation worker until the user has confirmed.`;

/** Everything to append to this turn's system prompt: heavy block first, then minor blocks in registry order. */
export function composePrompt(state: ModeState, planner: PlannerChoice): string | undefined {
	const blocks: string[] = [];
	if (state.mode === "claude-heavy") {
		const heavy = buildHeavyPrompt(planner);
		blocks.push(state.minorModes.includes("align") ? `${heavy}\n\n${HEAVY_ALIGN_BRIDGE}` : heavy);
	}
	for (const minor of state.minorModes) blocks.push(buildMinorPrompt(minor));
	return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

export type StatusTone = "dim" | "accent" | "warning";

export function statusLabel(
	mode: Mode,
	planner: PlannerChoice,
	strict: boolean,
	minorModes: readonly MinorMode[],
): { text: string; tone: StatusTone } {
	const extras: string[] = [];
	if (mode === "claude-heavy") {
		if (planner.fallback) extras.push("plan:opus");
		if (strict) extras.push("strict");
	}
	extras.push(...minorModes);
	const fallback = mode === "claude-heavy" && planner.fallback;
	return {
		text: [mode, ...extras].join(" · "),
		tone: fallback ? "warning" : mode === "claude-heavy" || minorModes.length > 0 ? "accent" : "dim",
	};
}
