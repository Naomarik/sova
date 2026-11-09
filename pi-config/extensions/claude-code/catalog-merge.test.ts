import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	CLAUDE_1M_WINDOW,
	CLAUDE_DEFAULT_WINDOW,
	CLAUDE_MODELS,
	type ClaudeCatalogData,
	canonicalClaudeId,
	claudeByAnswer,
	claudeContextWindow,
	claudeModel,
	claudeName,
	claudeOffer,
	compareClaudeVersions,
	latestClaude,
	mergeClaudeCatalog,
	parseClaudeId,
	resolveClaude,
	unverifiedClaudeNote,
} from "./catalog.ts";

// The catalog with what Claude Code's table added (§app.claude-code-provider/catalog). Ids are
// made up and newer than anything shipped, so these stay true when a real model joins the seed.
const FABLE_NEXT = { id: "claude-fable-9-1", window: CLAUDE_1M_WINDOW, maxOutput: 128_000, efforts: ["low", "max"], apiIds: ["claude-fable-9-1-20270101"] };
const NOVA = { id: "claude-nova-1-2", window: 500_000, maxOutput: 8_000, efforts: [] };
const seedFable = () => CLAUDE_MODELS.find((m) => m.family === "fable" && m.status === "current")!;
const ids = () => claudeOffer().map((m) => m.id);

afterEach(() => void mergeClaudeCatalog({ models: [] }));

test("nothing merged: the offer is exactly the seed", () => {
	assert.deepEqual(claudeOffer(), CLAUDE_MODELS);
});

test("a merged model is known everywhere, its identity from the rule and its limits from the table", () => {
	assert.equal(claudeModel(FABLE_NEXT.id), undefined, "not known before the merge");
	assert.equal(claudeContextWindow(FABLE_NEXT.id), CLAUDE_DEFAULT_WINDOW);
	assert.ok(unverifiedClaudeNote(FABLE_NEXT.id));

	assert.equal(mergeClaudeCatalog({ models: [FABLE_NEXT], latest: { fable: FABLE_NEXT.id } }), true);

	assert.ok(ids().includes(FABLE_NEXT.id));
	assert.deepEqual(
		(({ id, family, version, name, window, maxOutput, efforts, priceKey }) => ({ id, family, version, name, window, maxOutput, efforts: [...efforts], priceKey }))(claudeModel(FABLE_NEXT.id)!),
		{ id: FABLE_NEXT.id, family: "fable", version: "9.1", name: "Fable 9.1", window: CLAUDE_1M_WINDOW, maxOutput: 128_000, efforts: ["low", "max"], priceKey: `anthropic/${FABLE_NEXT.id}` },
	);
	assert.equal(claudeByAnswer("claude-fable-9-1-20270101")?.id, FABLE_NEXT.id);
	assert.equal(canonicalClaudeId("claude-code-cli/claude-fable-9-1-20270101"), `claude-code-cli/${FABLE_NEXT.id}`);
	assert.equal(unverifiedClaudeNote(FABLE_NEXT.id), undefined);
});

test("a field the table leaves out takes today's default", () => {
	mergeClaudeCatalog({ models: [{ id: "claude-fable-9-1" }] });
	const m = claudeModel("claude-fable-9-1")!;
	assert.deepEqual([m.window, m.maxOutput, [...m.efforts]], [CLAUDE_DEFAULT_WINDOW, 64_000, []]);
});

test("the table's limits, efforts and answer ids replace a built-in entry's; identity never does", () => {
	const seed = CLAUDE_MODELS.find((m) => m.id === "claude-haiku-4-5")!;
	mergeClaudeCatalog({ models: [{ id: seed.id, window: 777_000, maxOutput: 9_000, efforts: ["low"], apiIds: ["claude-haiku-4-5-new"] }] });
	const m = claudeModel(seed.id)!;
	assert.deepEqual([m.window, m.maxOutput, [...m.efforts], [...m.apiIds]], [777_000, 9_000, ["low"], ["claude-haiku-4-5-new"]]);
	assert.deepEqual([m.family, m.version, m.name], [seed.family, seed.version, seed.name]);
	assert.equal(claudeByAnswer("claude-haiku-4-5-new")?.id, seed.id);
});

test("a built-in entry the table lists without a field takes the same defaults as any other", () => {
	const seed = CLAUDE_MODELS.find((m) => m.id === "claude-opus-5-5")!;
	mergeClaudeCatalog({ models: [{ id: seed.id }] });
	const m = claudeModel(seed.id)!;
	assert.deepEqual([m.window, m.maxOutput, [...m.efforts]], [CLAUDE_DEFAULT_WINDOW, 64_000, []]);
});

test("the same data merged again changes nothing, and each merge replaces the last", () => {
	const data: ClaudeCatalogData = { models: [FABLE_NEXT], latest: { fable: FABLE_NEXT.id } };
	assert.equal(mergeClaudeCatalog(data), true);
	const once = JSON.stringify(claudeOffer());
	assert.equal(mergeClaudeCatalog(JSON.parse(JSON.stringify(data))), false, "unchanged data reports no change");
	assert.equal(JSON.stringify(claudeOffer()), once);
	assert.equal(mergeClaudeCatalog({ models: [] }), true);
	assert.deepEqual(claudeOffer(), CLAUDE_MODELS, "replaced, not added to");
	assert.equal(mergeClaudeCatalog({ models: [] }), false);
});

test("current first, each family newest first, a new family after the known ones", () => {
	mergeClaudeCatalog({ models: [NOVA, FABLE_NEXT, { id: "claude-opus-4-9" }], latest: { fable: FABLE_NEXT.id, nova: NOVA.id }, tested: [FABLE_NEXT.id, NOVA.id] });
	const offer = claudeOffer();
	const firstPrevious = offer.findIndex((m) => m.status === "previous");
	assert.ok(firstPrevious > 0);
	assert.ok(offer.slice(firstPrevious).every((m) => m.status === "previous"), "no current entry after a previous one");
	assert.deepEqual(offer.filter((m) => m.status === "current").map((m) => m.family), ["opus", "sonnet", "fable", "haiku", "nova"]);
	const v = (s: string) => s.split(".").map(Number);
	for (const family of new Set(offer.map((m) => m.family))) {
		const versions = offer.filter((m) => m.family === family && m.status === "previous").map((m) => v(m.version));
		for (let i = 1; i < versions.length; i++) assert.ok(versions[i - 1]![0]! > versions[i]![0]! || (versions[i - 1]![0] === versions[i]![0] && (versions[i - 1]![1] ?? 0) > (versions[i]![1] ?? 0)), `${family} newest first`);
	}
	assert.equal(offer.filter((m) => m.family === "fable" && m.status === "current").length, 1, "one current per family");
});

test("a dropped model leaves the offer and nothing else", () => {
	const dropped = [FABLE_NEXT.id, "claude-opus-4-6"];
	mergeClaudeCatalog({ models: [FABLE_NEXT], dropped });
	for (const id of dropped) {
		const name = parseClaudeId(id)!.name;
		assert.ok(!ids().includes(id), `${id} out of the pickers`);
		assert.equal(claudeModel(id)?.id, id, `${id} still resolves`);
		assert.equal(resolveClaude(id)?.id, id);
		assert.equal(claudeName(id), name, `${id} keeps its name`);
		assert.equal(unverifiedClaudeNote(id), undefined, `${id} is no stranger`);
	}
	assert.equal(claudeContextWindow(FABLE_NEXT.id), CLAUDE_1M_WINDOW, "and its window");
	assert.equal(claudeContextWindow("claude-opus-4-6"), CLAUDE_DEFAULT_WINDOW);
});

test("a family's current entry is its newest offered entry that is built in or passed, whatever the table calls latest", () => {
	const [a, b] = ["claude-fable-9-1", "claude-fable-9-2"];
	const seedFables = CLAUDE_MODELS.filter((m) => m.family === "fable").map((m) => m.id);
	const subsets = <T,>(xs: T[]): T[][] => xs.reduce<T[][]>((all, x) => [...all, ...all.map((s) => [...s, x])], [[]]);
	const newest = (xs: string[]) => [...xs].sort((x, y) => compareClaudeVersions(parseClaudeId(y)!.version, parseClaudeId(x)!.version))[0];
	let seen = 0;
	for (const dropped of subsets([seedFables[0]!, a, b])) for (const tested of subsets([a, b])) for (const latest of [undefined, { fable: a }, { fable: b }]) {
		mergeClaudeCatalog({ models: [{ id: a }, { id: b }], dropped, tested, ...(latest ? { latest } : {}) });
		const offered = [...seedFables, a, b].filter((id) => !dropped.includes(id));
		const expected = newest(offered.filter((id) => seedFables.includes(id) || tested.includes(id)))!;
		const label = JSON.stringify({ dropped, tested, latest });
		assert.equal(latestClaude("fable").id, expected, label);
		assert.deepEqual(claudeOffer().filter((m) => m.family === "fable" && m.status === "current").map((m) => m.id), [expected], label);
		seen++;
	}
	assert.equal(seen, 8 * 4 * 3, "every combination ran");
});

test("until it passes, the newest in the picker and the default are different models", () => {
	mergeClaudeCatalog({ models: [FABLE_NEXT], latest: { fable: FABLE_NEXT.id } });
	assert.ok(ids().includes(FABLE_NEXT.id), "in the picker at once");
	assert.equal(latestClaude("fable").id, seedFable().id);
});

test("a brand-new family: offered and named at once, no default until tested", () => {
	mergeClaudeCatalog({ models: [NOVA], latest: { nova: NOVA.id } });
	assert.ok(ids().includes(NOVA.id));
	assert.equal(claudeModel(NOVA.id)?.name, "Nova 1.2");
	assert.equal(claudeModel(NOVA.id)?.status, "previous", "nothing built in or passed: no current entry yet");
	assert.equal(claudeContextWindow(NOVA.id), 500_000);
	assert.equal(latestClaude("nova"), undefined);
	mergeClaudeCatalog({ models: [NOVA], latest: { nova: NOVA.id }, tested: [NOVA.id] });
	assert.equal(latestClaude("nova")?.id, NOVA.id);
	assert.equal(claudeModel(NOVA.id)?.status, "current");
});

test("a name never depends on what the list holds", () => {
	const known = [...CLAUDE_MODELS.map((m) => m.id), FABLE_NEXT.id, NOVA.id, "claude-opus-6", "claude-haiku-4-5-20251001", "claude-fable-9-1[1m]"];
	const names = () => known.map((id) => [claudeName(id), parseClaudeId(id)]);
	const before = names();
	assert.deepEqual(before.map(([n]) => typeof n), known.map(() => "string"), "every one has a name to compare");
	for (const data of [{ models: [FABLE_NEXT, NOVA] }, { models: [FABLE_NEXT], dropped: [FABLE_NEXT.id, "claude-opus-4-6"] }, { models: [], latest: { fable: "claude-fable-5" } }, { models: [{ id: "claude-nova-1-2", apiIds: ["claude-opus-6"] }] }, { models: [] }] as ClaudeCatalogData[]) {
		mergeClaudeCatalog(data);
		assert.deepEqual(names(), before, JSON.stringify(data));
		assert.deepEqual(names(), before, "and again on the next ask");
	}
});

test("what old files hold keeps its meaning after a newer Fable arrives", () => {
	const before = claudeName("fable");
	mergeClaudeCatalog({ models: [FABLE_NEXT], latest: { fable: FABLE_NEXT.id }, tested: [FABLE_NEXT.id] });
	assert.equal(claudeName("fable"), before);
	assert.equal(resolveClaude("fable")?.id, "claude-fable-5-1");
});

test("one merge reaches another copy of this module (pi loads each extension with its own)", async () => {
	const other = (await import(`./catalog.ts?copy=${Date.now()}`)) as typeof import("./catalog.ts");
	assert.notEqual(other.claudeOffer, claudeOffer, "really a second copy, or this proves nothing");
	mergeClaudeCatalog({ models: [FABLE_NEXT] });
	assert.equal(other.claudeModel(FABLE_NEXT.id)?.id, FABLE_NEXT.id);
	other.mergeClaudeCatalog({ models: [NOVA] });
	assert.equal(claudeModel(NOVA.id)?.id, NOVA.id);
	assert.equal(claudeModel(FABLE_NEXT.id), undefined, "a merge replaces, whichever copy made it");
});
