import assert from "node:assert/strict";
import test from "node:test";
import {
	CLAUDE_1M_WINDOW,
	CLAUDE_DEFAULT_WINDOW,
	CLAUDE_MODELS,
	canonicalClaudeId,
	claudeByAnswer,
	claudeCliId,
	claudeContextWindow,
	claudeDrift,
	claudeName,
	claudeOffer,
	isLegacyClaudeId,
	latestClaude,
	legacyClaudeRefusal,
	resolveClaude,
	resolveLegacyClaude,
	unverifiedClaudeNote,
} from "./catalog.ts";

test("one entry per real model: catalog ids, CLI names, no aliases and no [1m] forms", () => {
	const ids = CLAUDE_MODELS.map((m) => m.id);
	assert.equal(new Set(ids).size, ids.length, "no id twice");
	for (const m of CLAUDE_MODELS) {
		assert.match(m.id, /^claude-(opus|sonnet|fable|haiku)-\d+(-\d+)?$/, m.id);
		assert.ok(!m.id.includes("[1m]"), m.id);
		assert.equal(m.name, `${m.family[0]!.toUpperCase()}${m.family.slice(1)} ${m.version}`, "the name is the CLI's display name");
		assert.equal(m.priceKey, `anthropic/${m.id}`);
	}
	for (const alias of ["opus", "opus[1m]", "sonnet", "haiku", "fable", "default", "claude-fable-5-1[1m]"]) {
		assert.ok(!ids.includes(alias), `${alias} is never listed`);
	}
	assert.deepEqual(claudeOffer(), CLAUDE_MODELS);
});

test("the names the user reads", () => {
	assert.equal(latestClaude("opus").name, "Opus 5.5");
	assert.equal(latestClaude("sonnet").name, "Sonnet 5.5");
	assert.equal(latestClaude("fable").name, "Fable 5.1");
	assert.equal(latestClaude("haiku").name, "Haiku 4.5");
	assert.deepEqual(["opus", "sonnet", "fable", "haiku"].map((f) => latestClaude(f as "opus").id), ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-4-5"]);
	// Under any provider, by any id the API or an old file uses.
	for (const [id, name] of [
		["claude-opus-5-5", "Opus 5.5"], ["claude-code-cli/claude-opus-5-5", "Opus 5.5"], ["anthropic/claude-haiku-4-5-20251001", "Haiku 4.5"],
		["claude-haiku-4-5-20251001", "Haiku 4.5"], ["claude-opus-5-5[1m]", "Opus 5.5"], ["claude-code-cli/opus[1m]", "Opus 5.5"],
		["claude-fable-5-1[1m]", "Fable 5.1"], ["claude-opus-5[1m]", "Opus 5"], ["sonnet", "Sonnet 5.5"],
	] as const) assert.equal(claudeName(id), name, id);
	for (const id of ["zai/glm-5.3", "gpt-5-mini", "claude-opus-6", "ollama/opus", ""]) assert.equal(claudeName(id), undefined, id);
});

test("an answer id maps to its catalog model; [1m] dropped", () => {
	assert.equal(claudeByAnswer("claude-haiku-4-5-20251001")?.id, "claude-haiku-4-5");
	assert.equal(claudeByAnswer("claude-opus-5-5[1m]")?.id, "claude-opus-5-5");
	assert.equal(claudeByAnswer("opus"), undefined, "an alias is never an answer");
	assert.equal(claudeByAnswer("<synthetic>"), undefined);
});

test("legacy ids: the answer decides when it is one of the alias's models, else the date, else today's", () => {
	assert.equal(resolveLegacyClaude("opus[1m]")?.id, "claude-opus-5-5", "no record: today's target");
	assert.equal(resolveLegacyClaude("opus[1m]", { at: "2026-09-20T00:00:00Z" })?.id, "claude-opus-5");
	assert.equal(resolveLegacyClaude("opus[1m]", { at: "2026-09-22T00:00:00Z", answered: "claude-opus-5" })?.id, "claude-opus-5", "the CLI moved the alias late: the answer wins over the date");
	assert.equal(resolveLegacyClaude("opus[1m]", { at: "2026-09-20T00:00:00Z", answered: "claude-opus-5-5" })?.id, "claude-opus-5-5");
	assert.equal(resolveLegacyClaude("opus[1m]", { at: "2026-09-30T07:00:00Z", answered: "claude-opus-4-8" })?.id, "claude-opus-5-5", "an answer outside the alias's models is a mismatch, not a resolution");
	assert.equal(resolveLegacyClaude("sonnet", { at: Date.parse("2026-09-30T10:53:44Z") })?.id, "claude-sonnet-5");
	assert.equal(resolveLegacyClaude("sonnet", { at: Date.parse("2026-10-04T23:12:31Z") })?.id, "claude-sonnet-5-5");
	assert.equal(resolveLegacyClaude("haiku")?.id, "claude-haiku-4-5");
	assert.equal(resolveLegacyClaude("claude-fable-5-1[1m]")?.id, "claude-fable-5-1");
	assert.equal(resolveLegacyClaude("fable")?.id, "claude-fable-5-1");
	assert.equal(resolveLegacyClaude("claude-opus-5-5[1m]")?.id, "claude-opus-5-5");
	assert.equal(resolveLegacyClaude("claude-opus-6[1m]"), undefined);
	assert.equal(resolveLegacyClaude("claude-opus-5-5"), undefined, "a catalog id is no legacy id");
	for (const id of ["opus", "opus[1m]", "sonnet", "haiku", "fable", "claude-fable-5-1[1m]", "claude-opus-5-5[1m]", "claude-code-cli/opus[1m]"]) assert.ok(isLegacyClaudeId(id), id);
	for (const id of ["claude-opus-5-5", "claude-opus-6", "claude-opus-6[1m]", "zai/glm-5.3"]) assert.ok(!isLegacyClaudeId(id), id);
});

test("what is stored and spawned: the catalog id; an unknown id as given", () => {
	assert.equal(canonicalClaudeId("opus[1m]"), "claude-opus-5-5");
	assert.equal(canonicalClaudeId("claude-code-cli/opus[1m]"), "claude-code-cli/claude-opus-5-5", "the provider prefix is kept");
	assert.equal(canonicalClaudeId("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
	assert.equal(canonicalClaudeId("claude-opus-6"), "claude-opus-6");
	assert.equal(canonicalClaudeId("zai/glm-5.3"), "zai/glm-5.3");
	assert.equal(claudeCliId("sonnet"), "claude-sonnet-5-5");
	assert.equal(claudeCliId("claude-fable-5-1[1m]"), "claude-fable-5-1");
});

test("windows: the catalog's; an unknown id 1M only with [1m]", () => {
	for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "opus[1m]", "opus", "claude-opus-4-7", "claude-opus-6[1m]"]) assert.equal(claudeContextWindow(id), CLAUDE_1M_WINDOW, id);
	for (const id of ["claude-haiku-4-5", "haiku", "claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-6", "claude-opus-6", ""]) assert.equal(claudeContextWindow(id), CLAUDE_DEFAULT_WINDOW, id);
	assert.equal(claudeContextWindow("default", "claude-haiku-4-5-20251001"), CLAUDE_DEFAULT_WINDOW, "what the CLI says it resolves to wins");
});

test("input: an old alias is refused naming the id; an unknown id is only noted", () => {
	assert.equal(legacyClaudeRefusal("opus[1m]"), "opus[1m] is not a Claude model id; use claude-opus-5-5 (Opus 5.5).");
	assert.equal(legacyClaudeRefusal("haiku"), "haiku is not a Claude model id; use claude-haiku-4-5 (Haiku 4.5).");
	assert.equal(legacyClaudeRefusal("claude-opus-5-5[1m]"), "claude-opus-5-5[1m] is not a Claude model id; use claude-opus-5-5 (Opus 5.5).");
	assert.equal(legacyClaudeRefusal("claude-fable-5-1[1m]"), "claude-fable-5-1[1m] is not a Claude model id; use claude-fable-5-1 (Fable 5.1).");
	assert.equal(legacyClaudeRefusal("claude-opus-5-5"), undefined);
	assert.equal(legacyClaudeRefusal("claude-opus-6[1m]"), undefined, "an id the catalog doesn't know runs, noted");
	assert.equal(legacyClaudeRefusal("claude-opus-6"), undefined);
	assert.equal(unverifiedClaudeNote("claude-opus-6"), "Not verified: claude-opus-6 is not in Sova's Claude catalog. It will still be used.");
	assert.equal(unverifiedClaudeNote("claude-opus-5-5"), undefined);
});

test("drift: the CLI's list only notifies, by its resolved models", () => {
	// claude 2.1.289's initialize list (file 1 of the plan): no drift.
	const today = [
		{ id: "default", resolvedModel: "claude-opus-5-5" }, { id: "opus", resolvedModel: "claude-opus-5-5" }, { id: "fable", resolvedModel: "claude-fable-5-1" },
		{ id: "sonnet", resolvedModel: "claude-sonnet-5-5" }, { id: "haiku", resolvedModel: "claude-haiku-4-5-20251001" },
		{ id: "claude-sonnet-5" }, { id: "claude-opus-5" }, { id: "claude-fable-5" }, { id: "claude-opus-4-8" }, { id: "claude-opus-4-7" }, { id: "claude-opus-4-6" }, { id: "claude-sonnet-4-6" },
	];
	assert.deepEqual(claudeDrift(today), { unknown: [], moved: [] });
	assert.deepEqual(claudeDrift([...today, { id: "claude-opus-6", name: "Opus 6" }]).unknown, [{ id: "claude-opus-6", name: "Opus 6" }]);
	assert.deepEqual(claudeDrift([{ id: "opus", resolvedModel: "claude-opus-6" }]).moved, [{ family: "opus", id: "claude-opus-6", current: "claude-opus-5-5" }]);
	assert.equal(resolveClaude("claude-opus-6"), undefined, "drift never adds to the catalog");
});
