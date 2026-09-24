/** The delegate system-prompt text, prompt composition, and status labels. Pure functions: unit-testable. */
import { DELEGATE_PROFILE_INFO, DELEGATE_PROFILES, delegateDefaults, type DelegateProfileId, type WorkerChoice } from "./delegate.ts";
import { buildMinorPrompt, type MinorMode } from "./minor.ts";
import { routeAll, usable, type ProfileRoute, type SlotRoute } from "./routing.ts";
import type { Mode, ModeState } from "./state.ts";

/** Before any probe: every profile on its primary, unverified. What a fresh Delegate session starts from. */
export const DEFAULT_ROUTES: readonly ProfileRoute[] = routeAll(delegateDefaults(), {}, () => null);

const spawnArgs = (choice: WorkerChoice): string => `backend "${choice.backend}", model "${choice.model}", effort "${choice.effort}"`;

/**
 * What follows "→" for one routed slot: the exact worker to spawn and its retry, the disclosed
 * fallback, or that there is none. `work` names what waits on asking ("delegating this kind of work").
 */
function routeTarget(route: SlotRoute, work: string): string {
	if (route.via === "primary") {
		// Only a fallback that can run is offered for the retry; one that can't is named with its
		// reason, so a failed primary leads to asking, never to a retry that is known to fail.
		const fallback = !route.fallback
			? "; no fallback — if it fails, ask the user"
			: usable(route.fallback)
				? `; fallback ${spawnArgs(route.fallback.choice)}`
				: `; its configured fallback (${spawnArgs(route.fallback.choice)}) can't run — ${route.fallback.reason} — so if the primary fails, ask the user`;
		return `${spawnArgs(route.use!)}${fallback}.`;
	}
	if (route.via === "fallback") {
		return `${spawnArgs(route.use!)}. This is the configured FALLBACK: the primary (${spawnArgs(route.primary.choice)}) is unavailable — ${route.primary.reason}. Tell the user the first time you use it; do not retry the primary unless asked.`;
	}
	const reasons = [route.primary.reason, route.fallback?.reason].filter(Boolean).join("; ");
	return `NO AVAILABLE WORKER (${reasons}${route.fallback ? "" : "; no fallback is set"}). Before ${work}, tell the user and ask which model to use; do not choose one yourself.`;
}

/** One bullet per profile: what it covers, and the exact worker to spawn — or that there is none. */
function profileLine(route: ProfileRoute): string {
	const info = DELEGATE_PROFILE_INFO[route.profile];
	return `- ${info.label} (${info.description.charAt(0).toLowerCase()}${info.description.slice(1)}) → ${routeTarget(route, "delegating this kind of work")}`;
}

const DELEGATE_INSTRUCTIONS = `# Mode: delegate

You orchestrate and are the only voice to the user. Delegate work to background workers via agent_spawn, routed by the profiles below; verify and report their results yourself.

Keep local: questions, conversation, requested command runs, pointed-at one-line fixes, reviewing output. Delegate all else: features, investigated fixes, refactors, tests, migrations, multi-file edits, plans, designs, diagnosis. Mixed ask: answer the question, delegate the change.

Profiles — pass the backend, model and effort exactly as written:
{PROFILES}

Pick by the work, not the cost: investigation that feeds a design or plan is Planning & specs, not Investigation; unsure between Routine and Complex, choose Complex. Planning & specs and Investigation workers must not edit files: say so in their prompt. Workers keep their usual permissions, so that rule is prompt-level — check the worktree is unchanged after them.
If a spawn fails because its model is unavailable, retry once with that profile's fallback only if one is listed above as its fallback, and say so; otherwise, or if the fallback fails too, ask the user which model to use, with the reason — never substitute one of your own. When the user names a backend, model or effort for a task, that choice wins over the profile; the user's model settings still apply at spawn, and a spawn they refuse is reported to the user, not rerouted.

Worker prompts are self-contained: goal, files, conventions, verification, report-back. Batch independent spawns with non-overlapping files. Before reporting: read the diffs, run the project's tests or type checks — effort shapes how workers think, never how hard you check. Steer wrong work with agent_steer or respawn; never silently redo it; never present a worker report as your own (state what changed, what you verified, what remains).`;

export function buildDelegatePrompt(routes: readonly ProfileRoute[]): string {
	const byProfile = new Map(routes.map((route) => [route.profile, route]));
	const lines = DELEGATE_PROFILES.map((profile) => byProfile.get(profile)).filter((route): route is ProfileRoute => route !== undefined).map(profileLine);
	return DELEGATE_INSTRUCTIONS.replace("{PROFILES}", lines.join("\n"));
}

/**
 * Appended to the delegate block while align is also on. Without it the delegate block's "delegate all
 * else" wins: the orchestrator spawns an implementation worker before any alignment block is emitted.
 */
export const DELEGATE_ALIGN_BRIDGE = `The align minor mode is on and takes precedence over delegation: for any ask that needs alignment, spawn at most a non-editing Planning & specs worker to investigate (never the Investigation profile for this — it is design work), emit the alignment block yourself, and spawn no implementation worker until the user has confirmed.`;

/**
 * Appended to the spec block while a spec writer is set (spec.ts, mode-spec.json), under either major
 * mode: the writing goes to that one worker, the checking and promoting stay with the session. With
 * no writer there is no paragraph, and the session writes the spec itself.
 */
export function buildSpecWriterPrompt(route: SlotRoute): string {
	const retry =
		route.via === "primary"
			? " If its spawn fails because its model is unavailable, retry once with the fallback only if one is listed above, and say so; otherwise ask the user which model to use — never substitute one of your own."
			: "";
	return `Spec writer: draft claims and evidence records are written by one worker, spawned with agent_spawn on exactly this backend, model and effort → ${routeTarget(route, "handing off spec writing")} Give it the relevant spec passages quoted literally, the files the task changed, and the verification you did. It writes only under \`.sova/spec/drafts/\`, never current \`claims/\` or \`manifest.json\`; you check its draft, run the checks and the census, and promote yourself.${retry}`;
}

/**
 * Everything to append to this turn's system prompt: delegate block first, then minor blocks in
 * registry order. Takes just the session-scoped triple, so a `ModeActive` satisfies it too.
 * `writer` is the routed spec writer, or null when none is set.
 */
export function composePrompt(
	state: Pick<ModeState, "mode" | "strict" | "minorModes">,
	routes: readonly ProfileRoute[],
	writer: SlotRoute | null = null,
): string | undefined {
	const blocks: string[] = [];
	if (state.mode === "delegate") {
		const delegate = buildDelegatePrompt(routes);
		blocks.push(state.minorModes.includes("align") ? `${delegate}\n\n${DELEGATE_ALIGN_BRIDGE}` : delegate);
	}
	for (const minor of state.minorModes) {
		const block = buildMinorPrompt(minor);
		blocks.push(minor === "spec" && writer ? `${block}\n\n${buildSpecWriterPrompt(writer)}` : block);
	}
	return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

/**
 * The system-prompt section the mode blocks are delivered in on pi >= 0.86. Pi wraps the
 * content as `<mode>...</mode>` and diffs it against the section the model already has,
 * so a toggle costs one small patch instead of a whole new prompt.
 */
export const MODE_SECTION = "mode";

/**
 * Write this turn's blocks into a host's mutable prompt sections. No block means no mode is
 * on, and the section must go: leaving it would keep the instruction live in the replayed
 * prompt state after switching back to normal.
 */
export function applyModeSection(sections: Record<string, string>, block: string | undefined): void {
	if (block === undefined) delete sections[MODE_SECTION];
	else sections[MODE_SECTION] = block;
}

export type StatusTone = "dim" | "accent" | "warning";

const shortNames = (routes: readonly ProfileRoute[], via: ProfileRoute["via"]): DelegateProfileId[] =>
	routes.filter((route) => route.via === via).map((route) => route.profile);

export function statusLabel(
	mode: Mode,
	routes: readonly ProfileRoute[],
	strict: boolean,
	minorModes: readonly MinorMode[],
	/** The routed spec writer while spec is on; off its primary it reads `writer:fallback` / `writer:ask`. */
	writer: SlotRoute | null = null,
): { text: string; tone: StatusTone } {
	const extras: string[] = [];
	let degraded = false;
	if (mode === "delegate") {
		const fallback = shortNames(routes, "fallback");
		const none = shortNames(routes, "none");
		if (fallback.length > 0) extras.push(`fallback:${fallback.map((p) => DELEGATE_PROFILE_INFO[p].short).join(",")}`);
		if (none.length > 0) extras.push(`ask:${none.map((p) => DELEGATE_PROFILE_INFO[p].short).join(",")}`);
		degraded = fallback.length + none.length > 0;
		if (strict) extras.push("strict");
	}
	extras.push(...minorModes);
	if (writer && writer.via !== "primary" && minorModes.includes("spec")) {
		extras.push(writer.via === "fallback" ? "writer:fallback" : "writer:ask");
		degraded = true;
	}
	return {
		text: [mode, ...extras].join(" · "),
		tone: degraded ? "warning" : mode === "delegate" || minorModes.length > 0 ? "accent" : "dim",
	};
}
