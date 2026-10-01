/** Minor modes: independently toggleable prompt biases on top of the major mode. Node builtins only: unit-testable. */

import { readdirSync, readFileSync } from "node:fs";

export type MinorMode = "align" | "spec" | "vis";

/** Registry order: the canonical order for state, status, and prompt composition. */
export const MINOR_MODES: readonly MinorMode[] = ["align", "spec", "vis"];

export function isMinorMode(value: unknown): value is MinorMode {
	return typeof value === "string" && (MINOR_MODES as readonly string[]).includes(value);
}

export const MINOR_DESCRIPTIONS: Record<MinorMode, string> = {
	align: "Align with the user on what to build (architecture, UX, scope) before building",
	spec: "Scope work from the project's .sova/spec documentation, propose changes in drafts, and promote them once implemented",
	vis: "Draw small inline visuals (vis fences: flow, sequence, tree, timeline, chart, …) when a picture explains faster than prose",
};

/**
 * Whether each minor mode reaches the workers a session starts (§chat.mode-menu/workers). A record over
 * the union, so a new minor mode cannot compile without deciding. align is a conversation with the user,
 * which a worker doesn't have; spec is a discipline a worker's edits need too; vis draws for the user, and a
 * worker's replies are read by its parent session, not rendered for the user. Major modes never reach a
 * worker: workers spawn no workers, so Delegate has nothing to route there.
 */
export const MINOR_WORKER: Record<MinorMode, boolean> = {
	align: false,
	spec: true,
	vis: false,
};

/** The worker-scope subset of `minorModes`, in registry order. */
export function workerMinorModes(minorModes: readonly MinorMode[]): MinorMode[] {
	return MINOR_MODES.filter((mode) => MINOR_WORKER[mode] && minorModes.includes(mode));
}

export const ALIGN_INSTRUCTIONS = `# Minor mode: align

Before building anything non-trivial, align with the user on what to build, and record every alignment with the \`align\` tool. Do not edit files or spawn implementation workers until the user has confirmed a plan.

On any prompt that implies work (a feature, an investigated fix, a refactor, a migration, new files, or any multi-step change), do this first:
1. Investigate the codebase and context behind the ask. In delegate mode give this to a non-editing Planning & specs worker (investigation that feeds a design is planning, not the Investigation profile); otherwise investigate yourself. Find the real constraints, existing patterns, and affected surfaces.
2. Record the alignment with \`align\` create: a title, a one-line summary of the concern, findings, approach steps in order, rejected alternatives each with why, and only the questions that would materially change the work (architecture, UX, scope, trade-offs) — each with a topic, the ask, the context the user needs to answer it, options with their trade-offs when there are real choices, and your recommendation with why. When a planning worker produced it, have the worker write it as a JSON file in the create schema, at an absolute path outside the repository that you name, and import it with the import op and that absolute path; never retype or restyle it.
3. Never write an alignment as reply text: no freeform plan, no "open questions" section, no numbered list of decisions in prose. The user reads the alignment card. Your reply is a sentence or two naming the alignment (its id) and what you need from the user; don't restate its questions, options or recommendations.
4. Stop and wait. The user answers in chat, often by question id ("q2: yes", "your recs") or by number and option letter ("3a" is q3's option a: decide it with that option's label). Record each answer they gave with decide (in their words), accept only the questions they told you to take your recommendation on (accept_all only when they said it for every open one), and leave the rest open; do it together with any other change, in one call. Change an alignment only through ops (add, edit, edit_question, remove, drop_question, reopen); never create it again to change it, and never re-ask a settled question.
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

/**
 * The vis mode's guide is the vis/ directory beside this module, read once at load. overview.md is the
 * prompt: when to draw, and one line per kind. shared.md holds the rules every kind shares, and each other
 * file one kind (html-svg.md both free-form words); the `vis_guide` tool (vis-guide-tool.ts) returns
 * shared.md then the asked kind's file. A kind file carrying the stub marker (a kind not drawn yet) is
 * never taught: its overview line is dropped and vis_guide refuses it. HTML comments (owner notes) never
 * reach the model. The model gets exactly the formats Sova's `vis` fence renderer draws.
 */
const VIS_DIR = new URL("./vis/", import.meta.url);
const VIS_STUB = "<!-- stub -->";

/** Every file in vis/ by its name without `.md`, as written (owner notes and stub markers included). */
export const VIS_FILES: Readonly<Record<string, string>> = Object.fromEntries(
	readdirSync(VIS_DIR)
		.filter((name) => name.endsWith(".md"))
		.sort()
		.map((name) => [name.slice(0, -3), readFileSync(new URL(name, VIS_DIR), "utf8")]),
);

/** Each kind word → its file in vis/: every file but overview and shared is a kind, and html-svg is two. */
export const VIS_KIND_FILES: Readonly<Record<string, string>> = Object.fromEntries(
	Object.keys(VIS_FILES)
		.filter((name) => name !== "overview" && name !== "shared")
		.flatMap((name) => name.split("-").map((word) => [word, name])),
);

/** Owner notes out, ends trimmed: the text the model reads. */
export function stripVisComments(md: string): string {
	return md.replace(/<!--[\s\S]*?-->\n?/g, "").trim();
}

const isTaught = (word: string): boolean => Object.hasOwn(VIS_KIND_FILES, word) && !VIS_FILES[VIS_KIND_FILES[word]!]!.includes(VIS_STUB);
/** An overview list line, `- flow: …` or `- html / svg: …`; group 1 is its kind words. */
const KIND_LINE = /^- ([a-z]+(?: \/ [a-z]+)*): /;

/** The overview as the model reads it: a line naming a kind that isn't taught (a stub, or no file) is dropped. */
export function visOverview(md: string, taught: (word: string) => boolean = isTaught): string {
	return stripVisComments(
		md
			.split("\n")
			.filter((line) => KIND_LINE.exec(line)?.[1]?.split(" / ").every(taught) ?? true)
			.join("\n"),
	);
}

export const VIS_INSTRUCTIONS = visOverview(VIS_FILES.overview ?? "");

/** The kinds the prompt lists, in its order: exactly the words `vis_guide` takes. */
export const VIS_KINDS: readonly string[] = VIS_INSTRUCTIONS.split("\n").flatMap((line) => KIND_LINE.exec(line)?.[1]?.split(" / ") ?? []);

/** What `vis_guide {kind}` returns: the shared rules, then that kind's file, owner notes stripped. */
export function visGuide(kind: string): string {
	if (!VIS_KINDS.includes(kind)) throw new Error(`No vis kind "${kind}" to look up. Kinds: ${VIS_KINDS.join(", ")}.`);
	return `${stripVisComments(VIS_FILES.shared ?? "")}\n\n${stripVisComments(VIS_FILES[VIS_KIND_FILES[kind]!]!)}`;
}

const MINOR_INSTRUCTIONS: Record<MinorMode, string> = {
	align: ALIGN_INSTRUCTIONS,
	spec: SPEC_INSTRUCTIONS,
	vis: VIS_INSTRUCTIONS,
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
