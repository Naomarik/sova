import assert from "node:assert/strict";
import test from "node:test";
import { areaOf, buildSpecTurn, closingWhys, describedOn, normalizeSpecTurnDetails, SPEC_TURN_ENTRY, specTurnLine, type SpecTurnInput } from "./spec-turn.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

const input = (over: Partial<SpecTurnInput> = {}): SpecTurnInput => ({
	ops: [{ kind: "promote", tree: "/repo", branch: "feat/x", actor: "self", before: A, after: A }],
	named: [
		{ ids: ["§app.harness/reader"], text: "— goldens characterize output" },
		{ ids: ["§chat/merge-round"], text: "— new child: landing suites" },
	],
	foreign: ["§app.harness/reader", "§app.harness/wire", "§chat/merge-round"],
	unmapped: ["scripts/run-tests.mjs"],
	unpromoted: [{ draft: "test-speed", ids: ["§chat/merge-round"] }],
	stale: [],
	reply: "Done.\nPlumbing: scripts/run-tests.mjs — test runner globs\nDeferred: §chat/merge-round — waits on the replay run\nAlso changes: §app.harness/reader — goldens characterize output; §chat/merge-round — new child: landing suites",
	ok: true,
	reprompts: 0,
	...over,
});

test("a record is the reply's own § with its words, then the rest the check computed", () => {
	const d = buildSpecTurn(input({ described: new Map([["§app.harness/wire", "code list drops the live traces"]]) }));
	assert.deepEqual(d.own, [
		{ id: "§app.harness/reader", what: "goldens characterize output" },
		{ id: "§chat/merge-round", what: "new child: landing suites" },
	]);
	assert.deepEqual(d.landed, [{ id: "§app.harness/wire", what: "code list drops the live traces" }], "an earlier record's words, never the reply's");
	assert.deepEqual(d.gate.unmapped, [{ path: "scripts/run-tests.mjs", plumbing: "test runner globs" }]);
	assert.deepEqual(d.gate.unpromoted, [{ draft: "test-speed", ids: ["§chat/merge-round"], deferred: "waits on the replay run" }]);
	assert.equal(normalizeSpecTurnDetails(d)?.own.length, 2, "what it builds passes its own check");
});

test("change kinds and operations ride along when the check knows them", () => {
	const d = buildSpecTurn(input({ changes: new Map([["§app.harness/reader", { change: "text", op: 0 }], ["§app.harness/wire", { change: "record", op: 5 }]]) }));
	assert.equal(d.own[0].change, "text");
	assert.equal(d.own[0].op, 0);
	assert.equal(d.landed[0].change, "record");
	assert.equal(d.landed[0].op, undefined, "an operation index past the list is dropped");
});

test("the collapsed line counts changed § and arrivals, a 0 part left out", () => {
	const arrived = { from: "master", count: 83, byArea: [{ area: "chat.composer", count: 12 }] };
	assert.equal(specTurnLine(buildSpecTurn(input({ arrived }))), "Spec · 3 § changed · 83 § from master");
	assert.equal(specTurnLine(buildSpecTurn(input())), "Spec · 3 § changed");
	assert.equal(specTurnLine(buildSpecTurn(input({ named: [], foreign: [], arrived }))), "Spec · 83 § from master");
	assert.equal(specTurnLine(buildSpecTurn(input({ named: [], foreign: [] }))), "Spec · no § changed");
});

test("the strict check refuses a malformed record whole", () => {
	const good = buildSpecTurn(input());
	assert.ok(normalizeSpecTurnDetails(good));
	assert.equal(normalizeSpecTurnDetails({ ...good, v: 2 }), undefined);
	assert.equal(normalizeSpecTurnDetails({ ...good, own: [{ id: "not-a-section" }] }), undefined);
	assert.equal(normalizeSpecTurnDetails({ ...good, ops: [{ ...good.ops[0], tree: "relative/path" }] }), undefined);
	assert.equal(normalizeSpecTurnDetails({ ...good, ops: [{ ...good.ops[0], before: "HEAD; rm -rf /" }] }), undefined, "a revision is a hex sha, never a ref or anything a shell could read");
	assert.equal(normalizeSpecTurnDetails({ ...good, check: { ok: "yes", reprompts: 0 } }), undefined);
	assert.equal(normalizeSpecTurnDetails({ ...good, prose: { "§a/b": 3 } }), undefined);
	assert.equal(normalizeSpecTurnDetails(null), undefined);
	assert.equal(normalizeSpecTurnDetails("x"), undefined);
});

test("prose captured at settle survives the check, keyed by §", () => {
	const d = buildSpecTurn(input({ ops: [{ kind: "commit", tree: "/repo", actor: "self", before: A, after: B }], prose: { "§app.harness/reader": "## §app.harness/reader — One reader\n\nText." } }));
	assert.equal(normalizeSpecTurnDetails(d)?.prose?.["§app.harness/reader"], "## §app.harness/reader — One reader\n\nText.");
});

test("described: earlier records' words on the branch, newest wins; other entries ignored", () => {
	const one = buildSpecTurn(input());
	const two = buildSpecTurn(input({ named: [{ ids: ["§app.harness/reader"], text: "— reworded" }], foreign: ["§app.harness/reader"] }));
	const entries = [
		{ type: "custom", customType: SPEC_TURN_ENTRY, data: one },
		{ type: "custom_message", customType: SPEC_TURN_ENTRY, content: "x", data: two },
		{ type: "custom", customType: SPEC_TURN_ENTRY, data: { v: 1 } },
		{ type: "custom", customType: SPEC_TURN_ENTRY, data: two },
	];
	const d = describedOn(entries);
	assert.equal(d.get("§app.harness/reader"), "reworded");
	assert.equal(d.get("§chat/merge-round"), "new child: landing suites");
	assert.equal(d.has("§app.harness/wire"), false, "a § no record put words to is not described");
});

test("closing whys: Plumbing by path, Deferred by § (suffixes completed), the override", () => {
	const w = closingWhys("x\n**Plumbing: a.ts, ./b.ts — glue**\nDeferred: §a.b/c, /d — later\nSpec check override: the list is wrong\nAlso changes: none");
	assert.equal(w.plumbing.get("a.ts"), "glue");
	assert.equal(w.plumbing.get("b.ts"), "glue");
	assert.equal(w.deferred.get("§a.b/d"), "later");
	assert.equal(w.override, "the list is wrong");
});

test("area of a §", () => {
	assert.equal(areaOf("§app.harness/reader"), "app.harness");
	assert.equal(areaOf("§chat/merge-round"), "chat");
});
