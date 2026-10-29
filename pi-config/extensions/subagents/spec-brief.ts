/**
 * The worker spec brief: a fixed, short excerpt of the spec minor mode's rules that every
 * code-writing worker (pi or claude-code, agent_spawn or team member) gets in its system prompt
 * while the spawning session has spec on. Workers never load the mode extension, so without it a
 * worker edits code under a spec it has never been told about.
 *
 * Generated, never hand-copied: each rule is whole sentences of the spec mode's two parts, the short
 * finding-your-way part (`mode/spec-mode.md`) and the writing procedure (`spec/WRITING.md`), found by an
 * anchor (the sentence's opening words) and cut at its sentence end, so the brief quotes the files. A
 * worker that gets the brief instead of the spec block keeps every writing rule up front: it has no
 * prompt that points it at the procedure. A carried rule whose anchor is gone is dropped (the brief
 * never invents a rule); spec-brief.test.ts pins the generated text and checks that no anchor is
 * missing, so any change to a carried rule fails there until the pin is reviewed.
 * Node builtins and mode/minor.ts only; no pi imports.
 */
import { readFileSync } from "node:fs";
import { SPEC_INSTRUCTIONS } from "../mode/minor.ts";

/** The writing procedure as this pi-config ships it (`$core/../WRITING.md` once installed). */
export const SPEC_WRITING = readFileSync(new URL("../spec/WRITING.md", import.meta.url), "utf8").trimEnd();

/** Both parts, the short one first: the text every anchor is found in, exactly once. */
export const SPEC_BRIEF_SOURCE = `${SPEC_INSTRUCTIONS}\n\n${SPEC_WRITING}`;

/** One carried rule: the sentence that starts with `anchor`, plus `sentences - 1` that follow it. */
export interface CarriedRule { anchor: string; sentences: number }

export const CARRIED_RULES: readonly CarriedRule[] = [
	// The short part: finding your way, and where the writing procedure is.
	{ anchor: "never put `§` IDs", sentences: 1 },
	{ anchor: "Search with `where` and 3–5", sentences: 1 },
	{ anchor: "`read` what fits", sentences: 2 },
	{ anchor: "Verify in the code:", sentences: 2 },
	{ anchor: "Cite files:", sentences: 2 },
	{ anchor: "Every behavior change is spec'd.", sentences: 2 },
	// The writing procedure: every rule the brief carried before the split.
	{ anchor: "Exempt from drafts, not census:", sentences: 1 },
	{ anchor: "Behavior no claim covers gets a new claim", sentences: 3 },
	{ anchor: "While coding, a `[spec census]` note", sentences: 1 },
	{ anchor: "Any § the task didn't create is foreign", sentences: 1 },
	{ anchor: "Where the task needs a change", sentences: 1 },
	{ anchor: "Documentation changes only through drafts", sentences: 1 },
	{ anchor: "Documenting what the code already does", sentences: 1 },
	{ anchor: "Read each § the census note's `Unread § your change landed in` line", sentences: 2 },
	{ anchor: "The task's go-ahead authorizes", sentences: 2 },
	{ anchor: "If you are a worker:", sentences: 5 },
];

/**
 * The end of the sentence starting at `from`: a period followed by whitespace or the end of the
 * text, outside backticks and double quotes (so `"§X: <what>. OK?"` and `a.b` never end one).
 */
function sentenceEnd(text: string, from: number): number {
	let code = false, quote = false;
	for (let i = from; i < text.length; i++) {
		const c = text[i];
		if (c === "\n" && text[i + 1] !== undefined && /[\n-]/.test(text[i + 1])) return i; // a paragraph or bullet ends it
		if (c === "`") code = !code;
		else if (c === "\"" && !code) quote = !quote;
		else if (c === "." && !code && !quote && (i + 1 === text.length || /\s/.test(text[i + 1]))) return i + 1;
	}
	return text.length;
}

/** The rule's text as the file has it, or undefined when its anchor is not (exactly once) in the file. */
export function carriedText(text: string, rule: CarriedRule): string | undefined {
	const at = text.indexOf(rule.anchor);
	if (at < 0 || text.indexOf(rule.anchor, at + 1) >= 0) return undefined;
	let end = at;
	for (let n = 0; n < rule.sentences; n++) {
		while (end < text.length && text[end] === " ") end++;
		end = sentenceEnd(text, end);
	}
	return text.slice(at, end).replace(/\s+/g, " ").trim();
}

/** Anchors the file no longer carries: what the sync test reports. */
export function missingRules(text: string): string[] {
	return CARRIED_RULES.filter((rule) => carriedText(text, rule) === undefined).map((rule) => rule.anchor);
}

/**
 * The brief for a worker whose trusted spec tools live in `coreDir` (absolute). `$core` in the
 * quoted rules is that directory; the worker is told the one-line assignment, never a guessed path.
 */
export function workerSpecBrief(coreDir: string, text: string = SPEC_BRIEF_SOURCE): string {
	const rules = CARRIED_RULES.map((rule) => carriedText(text, rule)).filter((rule): rule is string => rule !== undefined);
	return [
		"## Spec discipline (the spawning session has spec mode on)",
		"This project documents behavior in `.sova/spec/`. The rules below are quoted from its spec mode; they bind your part of the task.",
		`Trusted tools: start each bash command that runs them with exactly \`core=${shellQuote(coreDir)}\`. <project root> is \`git rev-parse --show-toplevel\` of your working directory. Read-only: \`node "$core/sova-spec.mjs" <command> --root <project root> --json\`, where <command> is \`where <path|name|topic words>\`, \`map\`, \`toc '<§id>' --dir out|in|down|up|mentions\`, \`read '<§id>' [--whole] [--no-frame]\`, \`impact '<§id>' [--near]\`, \`check\`, \`census\` or \`scope '<§id>'\`.`,
		...rules.map((rule) => `- ${rule}`),
	].join("\n");
}

const shellQuote = (value: string): string => /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

/** Pi built-in tools and Claude Code native tools that write files or run commands. */
const WRITING_TOOLS = new Set(["bash", "edit", "write", "Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** A worker gets the brief when its tool list can change code. */
export const writesCode = (tools: readonly string[]): boolean => tools.some((tool) => WRITING_TOOLS.has(tool));
