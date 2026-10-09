/** Minor modes: independently toggleable prompt biases on top of the major mode. Node builtins only: unit-testable. */

import { readdirSync, readFileSync } from "node:fs";
import type { AlignStyle } from "./align-settings.ts";

export type MinorMode = "align" | "spec" | "vis" | "codemode" | "memory";

/** Registry order: the canonical order for state, status, and prompt composition. */
export const MINOR_MODES: readonly MinorMode[] = ["align", "spec", "vis", "codemode", "memory"];

export function isMinorMode(value: unknown): value is MinorMode {
	return typeof value === "string" && (MINOR_MODES as readonly string[]).includes(value);
}

export const MINOR_DESCRIPTIONS: Record<MinorMode, string> = {
	align: "Align with the user on what to build (architecture, UX, scope) before building",
	spec: "Scope work from the project's .sova/spec documentation, propose changes in drafts, and promote them once implemented",
	vis: "Draw small inline visuals (vis fences: flow, sequence, tree, timeline, chart, …) when a picture explains faster than prose",
	codemode: "Let the model run JavaScript that calls tools in parallel and filters their output (pi's codemode tool)",
	memory: "Endless chat: the model works from a summary of the whole chat and opens any part of it word for word",
};

/** The tool the codemode minor mode puts in the loadout: pi's own `codemode` (builtin:codemode in the CLI). */
export const CODEMODE_TOOL = "codemode";

/** Tool exposures that only codemode scripts reach (pi's ToolExposure): while one is registered, codemode stays. */
export const SCRIPT_ONLY_EXPOSURES: ReadonlySet<string> = new Set(["codemode", "deferred"]);

/**
 * Whether each minor mode reaches the workers a session starts (§chat.mode-menu/workers). A record over
 * the union, so a new minor mode cannot compile without deciding. align is a conversation with the user,
 * which a worker doesn't have; spec is a discipline a worker's edits need too; vis draws for the user, and a
 * worker's replies are read by its parent session, not rendered for the user; codemode changes the chat's
 * own tool set, and a worker's tools are its brief's. Major modes never reach a worker: workers spawn no
 * workers, so Delegate has nothing to route there.
 */
export const MINOR_WORKER: Record<MinorMode, boolean> = {
	align: false,
	spec: true,
	vis: false,
	codemode: false,
	memory: false,
};

/**
 * Where each minor mode can be turned on (§chat.memory/where). `everywhere`: the terminal's /mode,
 * palette, shortcuts and --minor, Sova's menu, the Overseer's coding sessions and session profiles.
 * `web`: only Sova's own mode menu, for a mode whose engine runs inside Sova's server (memory): the
 * extension takes `/mode <minor> on` only while the server is applying a switch for that very session
 * (WEB_MINOR_HOOK), never typed by hand or from --minor, and lists no palette row or shortcut for it.
 * Turning one off is never refused. A record over the union, like MINOR_WORKER.
 */
export const MINOR_SURFACES: Record<MinorMode, "everywhere" | "web"> = {
	align: "everywhere",
	spec: "everywhere",
	vis: "everywhere",
	codemode: "everywhere",
	memory: "web",
};

/** The minor modes only Sova's menu turns on, in registry order. */
export const WEB_ONLY_MINOR_MODES: readonly MinorMode[] = MINOR_MODES.filter((mode) => MINOR_SURFACES[mode] === "web");

/**
 * The server's hook (globalThis, Symbol.for): `(sessionId, minor) => boolean`, true only while Sova's server
 * applies a switch that turns `minor` on in that session (server/memory/permit.ts). Unset (a terminal, a
 * worker), nothing web-only can be turned on.
 */
export const WEB_MINOR_HOOK = Symbol.for("sova:web-minor");

/** Why turning `minor` on is refused in `sessionId` here, or undefined when it may be. */
export function webMinorRefusal(minor: MinorMode, sessionId: string | undefined): string | undefined {
	if (MINOR_SURFACES[minor] !== "web") return undefined;
	const hook = (globalThis as Record<symbol, unknown>)[WEB_MINOR_HOOK];
	if (typeof hook === "function" && sessionId !== undefined) {
		try {
			if ((hook as (sessionId: string, minor: MinorMode) => unknown)(sessionId, minor) === true) return undefined;
		} catch {
			// A failing hook permits nothing.
		}
	}
	return `${minor} is turned on from a Sova chat's mode menu`;
}

/**
 * Minor modes with no prompt block and no mode note (§chat.mode-menu/codemode): the tool they put in the
 * loadout is the whole mode, and its own description is the guide. A record over the union, like MINOR_WORKER.
 */
export const MINOR_PROMPTLESS: Record<MinorMode, boolean> = {
	align: false,
	spec: false,
	vis: false,
	codemode: true,
	// Its guide rides its own view message (Sova's memory engine), never the mode section or a note.
	memory: true,
};

/** The minor modes of `minorModes` that carry a prompt block, in their order. */
export function promptedMinorModes(minorModes: readonly MinorMode[]): MinorMode[] {
	return minorModes.filter((mode) => !MINOR_PROMPTLESS[mode]);
}

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
 * The writing style's paragraph after the align block (§chat.alignment/style): none for Default, so a
 * Default session's block is exactly ALIGN_INSTRUCTIONS. Keyed by align-settings.ts's AlignStyle.
 */
export const ALIGN_STYLE_PARAGRAPHS: Record<AlignStyle, string | undefined> = {
	default: undefined,
	simplified: `Writing style: Simplified. Write every field of an alignment the user reads (title, summary, findings, approach, rejected alternatives, and each question's topic, ask, context, options and recommendation) in short sentences and everyday words. Keep it small: about 5 findings and 6 approach steps at most. Name a file only when the user must recognise it. In each question's context, say what changes for the user with each answer. Put any technical detail the plan still needs in the alignment's technical notes (technical), not in those fields.`,
	pm: `Writing style: Project manager. The user reads alignments as a project manager. The fields they read (title, summary, findings, approach, rejected alternatives, and each question's topic, ask, context, options and recommendation) describe only what a user sees and does: screens, controls, wording, states and flows. No file paths, no function or component names, no APIs, no code. Ask questions a project manager can answer. Consequence rule: any technical choice with an effect a user would notice (speed, cost, data kept or lost, limits, something hard to undo) is asked as a product question, in those terms. Never leave a decision out because it is technical. Put the technical detail — files, code, the technical trade-offs — in the alignment's technical notes (technical).`,
};

/**
 * The paragraph after the align block (and the style's) while the session started with Visuals on
 * (§chat.alignment/visuals). Its words never depend on the style, so it never changes mid-session.
 */
export const ALIGN_VISUALS_PARAGRAPH = `Visuals: you may draw on the alignment card. A question, or the alignment itself, can carry a visual {kind, source}: a vis drawing's kind and its source, exactly what a \`vis\` fence would hold, at most 3 per alignment. Add one only when it explains faster than words: a wireframe for a question about a screen; a flow, state or steps for a change in behaviour. Before the first visual of each kind, call vis_guide with that kind and use only the syntax it returns. In the Project manager writing style never use the code, tree or layers kinds. Visuals go in the align tool's visual fields, never as a vis fence in your reply; after importing a planning worker's file, add them with edit_question or edit_doc.`;

/** The align options a block is built with: the writing style and Visuals (align-settings.ts). */
export interface AlignPromptOptions {
	style: AlignStyle;
	visuals: boolean;
}

/** The align block as the prompt carries it: ALIGN_INSTRUCTIONS, then the style's paragraph, then Visuals'. */
export function buildAlignPrompt(options: AlignPromptOptions = { style: "default", visuals: false }): string {
	return [ALIGN_INSTRUCTIONS, ALIGN_STYLE_PARAGRAPHS[options.style], options.visuals ? ALIGN_VISUALS_PARAGRAPH : undefined].filter(Boolean).join("\n\n");
}

/**
 * Whether the vis tools (vis_guide, and in Sova's hosted sessions vis_check) belong in the loadout: the
 * vis minor mode is on, or align is on in a session that started with Visuals (§chat.alignment/visuals).
 * The one rule every site that syncs them asks, so the tool set changes only when this answer does.
 */
export function visToolsWanted(minorModes: readonly MinorMode[], alignVisuals: boolean): boolean {
	return minorModes.includes("vis") || (alignVisuals && minorModes.includes("align"));
}

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
	// Promptless (MINOR_PROMPTLESS): never composed.
	codemode: "",
	memory: "",
};

/** One minor mode's block; align's carries its style and Visuals paragraphs (buildAlignPrompt). */
export function buildMinorPrompt(mode: MinorMode, align?: AlignPromptOptions): string {
	return mode === "align" ? buildAlignPrompt(align) : MINOR_INSTRUCTIONS[mode];
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
