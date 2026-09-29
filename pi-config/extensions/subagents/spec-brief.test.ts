import { test } from "node:test";
import assert from "node:assert/strict";
import { SPEC_INSTRUCTIONS } from "../mode/minor.ts";
import { CARRIED_RULES, carriedText, missingRules, workerSpecBrief, writesCode } from "./spec-brief.ts";

/**
 * The sync pin: the brief as generated from today's spec-mode.md. A change to spec-mode.md that
 * touches a carried rule (or drops one) fails here; review the new wording for workers, then
 * update this text (and CARRIED_RULES if an anchor moved).
 */
const PINNED = `## Spec discipline (the spawning session has spec mode on)
This project documents behavior in \`.sova/spec/\`. The rules below are quoted from its spec mode; they bind your part of the task.
Trusted tools: start each bash command that runs them with exactly \`core=/agent/extensions/spec/core\`. <project root> is \`git rev-parse --show-toplevel\` of your working directory. Read-only: \`node "$core/sova-spec.mjs" <check|census|scope '<§id>'|impact '<§id>'|foreign --base <rev>> --root <project root> --json\`.
- never put \`§\` IDs or spec annotations in source code.
- Every behavior change is spec'd. Exempt from drafts, not census: work changing no behavior (refactor, tests, tooling), decided from \`scope\` output, never memory; a test that fails or flakes because of product code (a race, a wrong value) is that code's behavior fix, never test-only; say you claim the exemption.
- Behavior no claim covers gets a new claim in a feature draft before coding. Write its sentence before the first code edit; \`new\` alone isn't enough.
- While coding, exempt work included, run \`census --changed\` (\`--spec\` your draft, if any) after your first edit, before the next file, and per new file.
- Any § the task didn't create is foreign, your new claim's parent included, wherever you put the claim; editing one in your draft flags.
- Flag only a contradiction, or a user-visible addition, even one your new claim describes, that its own text lacks, never a gap it already had, even one you rely on; otherwise stay silent.
- A \`[spec census]\` note on a tool result is this census, run for you: act on it.
- Documentation changes only through drafts, never by editing current \`claims/\` or \`manifest.json\`: \`node "$core/sova-spec-draft.mjs" <command> --root <project root> --json\`.
- Documenting what the code already does is its own baseline draft, never mixed into a feature draft.
- \`node "$core/sova-spec.mjs" census --changed --root <project root> --json\` must report no in-boundary changed file unclaimed, and no changed file outside it that no claim maps unless a "Plumbing: <path> — <why>" line above the last line names it (never UI text, colour, CLI output or footer rendering) (\`--spec\` the draft's \`spec/\` until promoted; \`--base <rev>\` once committed). Pre-existing unclaimed files aren't the task's job.
- Your reply's last line on a turn that edited, committed, promoted or merged, exempt work included, is exactly "Also changes: §X — <what>; §Y — <what>" or "Also changes: none", nothing after; a turn that only answered writes no such line. Items are separated by ";", each led by the § it names (", /d" after "§a.b/c" is "§a.b/d"); a § inside a description isn't named. It names foreign § only, never your new claims; an addition under one is that §'s change, and a § the user asked for is still foreign. Notes (the exemption, a gap) go above it. A merge or promote turn names every foreign § it lands, even if already reported, workers' included: copy the list \`worktree merge\` or \`promote --write\` prints (\`foreign\` for other ranges). One that leaves draft records unpromoted names their stale § on a "Deferred: §X — <why>" line above the last line; on the default branch it promotes them instead. "Spec check override: <why>" right above the last line excuses only an omission you show is wrong.
- The task's go-ahead authorizes its drafts, evidence and promotions as one bounded batch; no dialog per claim, and nothing at session start. It is not permission to commit: without that, leave evidence pending, and never commit unrelated changes.`;

test("spec-mode.md still carries every rule the worker brief quotes, and the brief is the pinned text", () => {
	assert.deepEqual(missingRules(SPEC_INSTRUCTIONS), [], "an anchor is gone or repeated in spec-mode.md: update CARRIED_RULES");
	assert.equal(workerSpecBrief("/agent/extensions/spec/core"), PINNED, "spec-mode.md changed a carried rule: review the brief, then the pin");
});

test("every carried rule is quoted verbatim from spec-mode.md, and the brief stays short", () => {
	const flat = SPEC_INSTRUCTIONS.replace(/\s+/g, " ");
	for (const rule of CARRIED_RULES) assert.ok(flat.includes(carriedText(SPEC_INSTRUCTIONS, rule)!), rule.anchor);
	assert.ok(workerSpecBrief("/x").length < SPEC_INSTRUCTIONS.length * 0.6, "a brief, not the whole mode");
});

test("a rule the file no longer carries is dropped, never invented; sentences end outside quotes and code", () => {
	const text = "Intro. Every behavior change is spec'd. Second one. Third.\nYour reply's last line is \"Also changes: none\". It names § only. Tail.";
	assert.equal(carriedText(text, { anchor: "Every behavior change is spec'd.", sentences: 2 }), "Every behavior change is spec'd. Second one.");
	assert.equal(carriedText(text, { anchor: "Your reply's last line", sentences: 2 }), "Your reply's last line is \"Also changes: none\". It names § only.");
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
