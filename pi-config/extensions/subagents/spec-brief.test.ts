import { test } from "node:test";
import assert from "node:assert/strict";
import { SPEC_INSTRUCTIONS } from "../mode/minor.ts";
import { CARRIED_RULES, carriedText, missingRules, SPEC_BRIEF_SOURCE, SPEC_WRITING, workerSpecBrief, writesCode } from "./spec-brief.ts";

/**
 * The sync pin: the brief as generated from today's spec-mode.md and spec/WRITING.md. A change to
 * either that touches a carried rule (or drops one) fails here; review the new wording for workers,
 * then update this text (and CARRIED_RULES if an anchor moved).
 */
const PINNED = `## Spec discipline (the spawning session has spec mode on)
This project documents behavior in \`.sova/spec/\`. The rules below are quoted from its spec mode; they bind your part of the task.
Trusted tools: start each bash command that runs them with exactly \`core=/agent/extensions/spec/core\`. <project root> is \`git rev-parse --show-toplevel\` of your working directory. Read-only: \`node "$core/sova-spec.mjs" <command> --root <project root> --json\`, where <command> is \`where <path|name|topic words>\`, \`map\`, \`toc '<§id>' --dir out|in|down|up|mentions\`, \`read '<§id>' [--whole] [--no-frame]\`, \`impact '<§id>' [--near]\`, \`check\`, \`census\` or \`scope '<§id>'\`.
- never put \`§\` IDs or spec annotations in source code.
- Search with \`where\` and 3–5 of the task's words, never one (\`where password reset email expiry\`), or a path or name; if no hit fits, try other words once, then \`map\`.
- \`read\` what fits (later reads add \`--no-frame\`); \`toc '<§id>' --dir out\` lists its neighbours, \`impact --near\` what relies on one you will change. An unread link isn't absent.
- Verify in the code: open the files a claim lists and confirm. Labels are declared, never proof; where claim and code disagree, say so: the code is what runs.
- Cite files: every finding names the code file or commit it rests on. In briefs, plans and answers, report the product, not this procedure.
- Every behavior change is spec'd. Before your first edit that changes behavior, read \`$core/../WRITING.md\`, the writing procedure (it also arrives once, with your first \`[spec census]\` note or an alignment's go-ahead).
- Exempt from drafts, not census: work changing no behavior (refactor, tests, tooling), decided from passages you read, never memory; a test that fails or flakes because of product code is that code's behavior fix, never test-only; say you claim the exemption.
- Behavior no claim covers gets a new claim in a feature draft before coding. Write its sentence before the first code edit; \`new\` alone isn't enough. When the task's go-ahead already agrees to it, run \`agree\` on it then, before that edit, not at the end.
- While coding, a \`[spec census]\` note on a tool result is the census, run for you: act on it.
- Any § the task didn't create is foreign, your new claim's parent included, wherever you put the claim.
- Where the task needs a change that contradicts its text or adds what a user sees that it lacks, even one your new claim describes, update it in your draft without asking (the go-ahead covers it and restamps any \`agreed\`), never for a gap it already had or a defect; list each foreign § your draft or workers edit in your reply: "Also updates §X: <what>".
- Documentation changes only through drafts, never by editing current \`claims/\` or \`manifest.json\`: \`node "$core/sova-spec-draft.mjs" <command> --root <project root> --json\`.
- Documenting what the code already does is its own baseline draft, never mixed into a feature draft.
- Read each § the census note's \`Unread § your change landed in\` line (once, after your last edit) marks read first; its \`census --changed --related\` command lists the rest. Every changed file in the boundary is claimed; any outside it whose change a user sees is spec'd.
- The task's go-ahead authorizes its drafts, evidence and promotions as one bounded batch; no dialog per claim, and nothing at session start. A go-ahead to build or merge covers committing them with the code, never asked separately; told not to commit, leave evidence pending; never commit unrelated changes.
- If you are a worker: a parent session started you, and it promotes on its own branch before calling it ready. Your brief is your go-ahead. Work in the draft your brief names, or say which one you started. Promote, commit or record \`--commit\` evidence only when your brief says to, and then only on its branch, never by landing on the default branch; otherwise say what is ready to promote. List each foreign § you updated in your final report.`;

test("both parts still carry every rule the worker brief quotes, and the brief is the pinned text", () => {
	assert.deepEqual(missingRules(SPEC_BRIEF_SOURCE), [], "an anchor is gone or repeated in spec-mode.md + WRITING.md: update CARRIED_RULES");
	assert.equal(SPEC_BRIEF_SOURCE, `${SPEC_INSTRUCTIONS}\n\n${SPEC_WRITING}`, "the short part, then the writing procedure");
	assert.equal(workerSpecBrief("/agent/extensions/spec/core"), PINNED, "a carried rule changed: review the brief, then the pin");
});

test("a code-writing worker's brief keeps every writing rule it carried before the split, and gains topic search", () => {
	const brief = workerSpecBrief("/x");
	// The opening words of each rule the brief carried when spec-mode.md was the whole procedure.
	for (const rule of [
		"never put `§` IDs", "Every behavior change is spec'd.", "Exempt from drafts, not census:", "Behavior no claim covers gets a new claim",
		"When the task's go-ahead already agrees to it, run `agree` on it then", "While coding, a `[spec census]` note", "Any § the task didn't create is foreign",
		"Where the task needs a change", "Documentation changes only through drafts", "Documenting what the code already does",
		"Read each § the census note's `Unread § your change landed in` line", "The task's go-ahead authorizes", "A go-ahead to build or merge covers committing",
	]) assert.ok(brief.includes(rule), rule);
	assert.match(brief, /`where <path\|name\|topic words>`, `map`, `toc/, "the fallback brief can search by topic");
	assert.match(brief, /If you are a worker: .*Your brief is your go-ahead\./, "and its own duties");
});

test("every carried rule is quoted verbatim from one of the two parts, and the brief stays short", () => {
	const flat = (t: string) => t.replace(/\s+/g, " ");
	for (const rule of CARRIED_RULES) {
		const text = carriedText(SPEC_BRIEF_SOURCE, rule)!;
		assert.ok(flat(SPEC_INSTRUCTIONS).includes(text) || flat(SPEC_WRITING).includes(text), rule.anchor);
	}
	const length = workerSpecBrief("/x").length;
	assert.ok(length <= 4000, `a brief, not the whole mode: growing it is a deliberate change (${length} characters)`);
});

test("a rule the file no longer carries is dropped, never invented; sentences end outside quotes and code", () => {
	const text = "Intro. Every behavior change is spec'd. Second one. Third.\nAsk it as \"This also changes §X: <what>. OK?\". It names § only. Tail.";
	assert.equal(carriedText(text, { anchor: "Every behavior change is spec'd.", sentences: 2 }), "Every behavior change is spec'd. Second one.");
	assert.equal(carriedText(text, { anchor: "Ask it as", sentences: 2 }), "Ask it as \"This also changes §X: <what>. OK?\". It names § only.");
	assert.equal(carriedText(text, { anchor: "absent", sentences: 1 }), undefined);
	assert.equal(carriedText("Twice. Twice.", { anchor: "Twice", sentences: 1 }), undefined, "an ambiguous anchor carries nothing");
	assert.ok(missingRules(text).includes("never put `§` IDs"));
	assert.ok(!workerSpecBrief("/x", text).includes("never put"));
	assert.match(workerSpecBrief("/a b/core", text), /core='\/a b\/core'/, "a path with a space is quoted");
});

test("writesCode: pi built-ins and Claude native tools that edit or run commands", () => {
	assert.equal(writesCode(["read", "bash"]), true);
	assert.equal(writesCode(["read", "grep", "find", "ls"]), false);
	assert.equal(writesCode(["Read", "Edit"]), true);
	assert.equal(writesCode(["Read", "Glob", "Grep"]), false);
	assert.equal(writesCode([]), false);
});
