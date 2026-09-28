/** The delegate system-prompt text, prompt composition, and status labels. Pure functions: unit-testable. */
import { DELEGATE_PROFILE_INFO, DELEGATE_PROFILES, delegateDefaults, type DelegateProfileId, type WorkerChoice } from "./delegate.ts";
import { ALIGN_FILE_SCHEMA } from "./align.ts";
import { buildMinorPrompt, MINOR_MODES, type MinorMode } from "./minor.ts";
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

Pick by the work, not the cost: investigation that feeds a design or plan is Planning & specs, not Investigation; unsure between Routine and Complex, choose Complex. Planning & specs and Investigation workers must not edit files: say so in their prompt. Workers keep their usual permissions, so that rule is prompt-level — check the worktree is unchanged after them. The one exception is a planning worker's alignment JSON (align on), written outside the repository.
If a spawn fails because its model is unavailable, retry once with that profile's fallback only if one is listed above as its fallback, and say so; otherwise, or if the fallback fails too, ask the user which model to use, with the reason — never substitute one of your own. When the user names a backend, model or effort for a task, that choice wins over the profile; the user's model settings still apply at spawn, and a spawn they refuse is reported to the user, not rerouted.

Worker prompts are self-contained: goal, files, conventions, verification, report-back. Batch independent spawns with non-overlapping files. Before reporting: read the diffs, run the project's tests or type checks — effort shapes how workers think, never how hard you check. Steer wrong work with agent_steer or respawn; never silently redo it; never present a worker report as your own (state what changed, what you verified, what remains).`;

export function buildDelegatePrompt(routes: readonly ProfileRoute[]): string {
	const byProfile = new Map(routes.map((route) => [route.profile, route]));
	const lines = DELEGATE_PROFILES.map((profile) => byProfile.get(profile)).filter((route): route is ProfileRoute => route !== undefined).map(profileLine);
	return DELEGATE_INSTRUCTIONS.replace("{PROFILES}", lines.join("\n"));
}

/**
 * Appended to the delegate block while align is also on. Without it the delegate block's "delegate all
 * else" wins: the orchestrator spawns an implementation worker before any alignment is recorded, or
 * relays a planning worker's report as a freeform plan.
 */
export const DELEGATE_ALIGN_BRIDGE = `The align minor mode is on and takes precedence over delegation: for any ask that needs alignment, spawn at most a non-editing Planning & specs worker to investigate (never the Investigation profile for this — it is design work). Workers have no align tool: tell the planning worker that its one permitted write is the alignment JSON (${ALIGN_FILE_SCHEMA}), at an absolute path outside the repository that you name in its prompt (e.g. /tmp/align-<topic>-<n>.json), so the worktree stays unchanged; then import it with align {op: "import", path: that same absolute path} — never relay or retype its plan as reply text. In a remote session (tools on a target) import is refused: have the worker put the JSON in its report and pass its fields to align create inline. Spawn no implementation worker until the user has confirmed and the alignment's status is implementing, and give implementation workers the decided questions (align get).`;

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
 * `writer` is the routed spec writer, or null when none is set. `headMinors` is the set of minor
 * modes the session's prompt was built with (the head, see index.ts), when it differs from the
 * active one: their blocks are the ones written, while the delegate block's align bridge follows the
 * active align (turning align on changes the tool set anyway, so it can't keep the prefix).
 */
export function composePrompt(
	state: Pick<ModeState, "mode" | "strict" | "minorModes">,
	routes: readonly ProfileRoute[],
	writer: SlotRoute | null = null,
	headMinors: readonly MinorMode[] = state.minorModes,
): string | undefined {
	const blocks: string[] = [];
	if (state.mode === "delegate") {
		const delegate = buildDelegatePrompt(routes);
		blocks.push(state.minorModes.includes("align") ? `${delegate}\n\n${DELEGATE_ALIGN_BRIDGE}` : delegate);
	}
	for (const minor of headMinors) blocks.push(minorBlock(minor, writer));
	return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

/** One minor mode's block exactly as the prompt carries it: spec gains the writer paragraph while a writer is set. */
function minorBlock(minor: MinorMode, writer: SlotRoute | null): string {
	const block = buildMinorPrompt(minor);
	return minor === "spec" && writer ? `${block}\n\n${buildSpecWriterPrompt(writer)}` : block;
}

/**
 * The hidden note that tells the model about minor modes switched after its prompt was built,
 * from `told` (what it was last told) to `now`. A mode turned on gets its whole block, the same text
 * the prompt would have carried, unless that block is already in context: in the prompt (`head`) or
 * in an earlier note since the last compaction (`guides`), when a pointer to it is enough. A mode
 * turned off gets a line saying its instructions no longer apply. Undefined when nothing changed.
 * `guides` in the result: the modes whose whole block this note carries.
 */
export function buildModeNote(
	told: readonly MinorMode[],
	now: readonly MinorMode[],
	known: { head: readonly MinorMode[]; guides: readonly MinorMode[] },
	writer: SlotRoute | null = null,
): { text: string; guides: MinorMode[] } | undefined {
	const where = (minor: MinorMode) => (known.head.includes(minor) ? "in your system prompt" : "given earlier in this conversation");
	const parts: string[] = [];
	const guides: MinorMode[] = [];
	for (const minor of MINOR_MODES) {
		if (told.includes(minor) && !now.includes(minor)) {
			parts.push(`Mode change: the user turned the ${minor} minor mode off. Its instructions (the "# Minor mode: ${minor}" block ${where(minor)}) no longer apply; do not follow them unless a later note turns it back on.`);
		}
	}
	for (const minor of MINOR_MODES) {
		if (now.includes(minor) && !told.includes(minor)) {
			if (known.head.includes(minor) || known.guides.includes(minor)) {
				parts.push(`Mode change: the user turned the ${minor} minor mode back on. Its instructions (the "# Minor mode: ${minor}" block ${where(minor)}) apply again from now on.`);
			} else {
				guides.push(minor);
				parts.push(`Mode change: the user turned the ${minor} minor mode on. Its instructions follow and apply from now on, as if they were part of your system prompt.\n\n${minorBlock(minor, writer)}`);
			}
		}
	}
	return parts.length > 0 ? { text: parts.join("\n\n"), guides } : undefined;
}

/**
 * The system-prompt section the mode blocks are delivered in on pi >= 0.86. Pi wraps the
 * content as `<mode>...</mode>` and diffs it against the section the model already has. A
 * minor-mode toggle leaves it alone (its minor blocks are the head's, see buildModeNote): any
 * change here rewrites the head on providers without mid-conversation system messages and
 * restarts a Claude Code CLI. It moves on a major-mode switch, a Delegate or spec-writer routing
 * change, align in delegate (the bridge), and at the first prompt after a compaction.
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
