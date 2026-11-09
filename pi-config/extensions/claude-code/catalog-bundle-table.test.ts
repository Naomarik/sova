// Claude Code's table as text, and the rule for what Sova takes from it. Rows are the real ones under
// tests/fixtures/claude-tables; nothing here reads a Claude Code program.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { offerFromTable, parseClaudeTable, type ClaudeTable, type ClaudeTableParse, type ClaudeTableRow } from "./bundle-table.ts";
import { CLAUDE_MODELS } from "./catalog.ts";

const fixture = (version: string) => {
	const f = JSON.parse(readFileSync(join(import.meta.dirname, "tests/fixtures/claude-tables", `${version}.json`), "utf8")) as { rows: string[]; latestPerFamily: string };
	return `var a;[${f.rows.join(",")}];var t={latest_per_family:${f.latestPerFamily}},VERSION:"${version}"`;
};
const row = (id: string, body: string, family = /^claude-([a-z]+)/.exec(id)![1]!) => `{id:"${id}",family:"${family}",display_name:"x"${body}}`;
const table = (...rows: string[]) => rows.join(",");
const ok = (r: ClaudeTableParse) => {
	assert.ok(r.ok, r.ok ? "" : r.reason);
	return r.table;
};
const one = (body: string) => ok(parseClaudeTable(row("claude-opus-9", body))).rows[0]!;

test("every real table parses: its rows, its latest, each row whose id Sova ships reads as Sova holds it", () => {
	for (const [version, rows] of [["2.1.314", 22], ["2.1.317", 22], ["2.1.321", 24]] as const) {
		const t = ok(parseClaudeTable(fixture(version)));
		assert.equal(t.rows.length, rows);
		assert.equal(t.cliVersion, version);
		assert.deepEqual(Object.keys(t.latest).sort(), ["fable", "haiku", "opus", "sonnet"]);
	}
	const t = ok(parseClaudeTable(fixture("2.1.321")));
	for (const seed of CLAUDE_MODELS) {
		const r = t.rows.find((x) => x.id === seed.id);
		if (!r || seed.family === "fable") continue; // the one family that moved after the seed
		assert.equal(r.window, seed.window, seed.id);
		assert.equal(r.maxOutput, seed.maxOutput, seed.id);
		assert.deepEqual(r.efforts, seed.efforts, seed.id);
		assert.deepEqual(r.firstParty && r.firstParty !== r.id ? [r.firstParty] : [], seed.apiIds, seed.id);
	}
});

test("a window reads from its own field, in any literal or order", () => {
	const cases: [string, number][] = [
		[",context:{window:2e5}", 200_000],
		[",context:{window:200000,maximum_window:1e6}", 200_000],
		[",context:{maximum_window:1e6,window:200000}", 200_000],
		[",context:{window:1e6,native_1m:!0}", 1_000_000],
		[",context:{window:2e5,native_1m:!1}", 200_000],
		["", 200_000],
	];
	for (const [body, window] of cases) assert.equal(one(body).window, window, body);
});

test("a row with no context of its own never borrows the next row's", () => {
	const t = ok(parseClaudeTable(table(row("claude-opus-8", ""), row("claude-opus-9", ",context:{window:1e6,native_1m:!0}"))));
	assert.equal(t.rows[0]!.window, 200_000);
});

test("output caps read the default, in any literal, and fall back when absent", () => {
	assert.equal(one(",max_output_tokens:{default:1e5,upper:128000}").maxOutput, 100_000);
	assert.equal(one(",max_output_tokens:{default:128000,upper:128000}").maxOutput, 128_000);
	assert.equal(one("").maxOutput, 64_000);
});

test("efforts come from whole capability tokens", () => {
	const cases: [string, string[]][] = [
		['["effort","max_effort","xhigh_effort"]', ["low", "medium", "high", "xhigh", "max"]],
		['["max_effort","effort"]', ["low", "medium", "high", "max"]],
		['["per_turn_effort","thinking_disabled_effort_cap"]', []],
	];
	for (const [caps, efforts] of cases) assert.deepEqual(one(`,capabilities:${caps}`).efforts, efforts, caps);
	assert.deepEqual(one("").efforts, []);
});

test("only the first-party id is taken from provider_ids", () => {
	assert.equal(one(',provider_ids:{bedrock:"b",first_party:"claude-opus-9-20260101",vertex:"v"}').firstParty, "claude-opus-9-20260101");
});

test("a parse that doesn't hold together is no data, never no models", () => {
	const cases: [string, string][] = [
		["nothing here", "no rows at all"],
		[`${row("claude-opus-9", "")};x={latest_per_family:{opus:"claude-opus-10"}}`, "a latest that isn't a row"],
		[row("claude-opus-9", ",context:{window:0}"), "a zero window"],
		[row("claude-opus-9", ",context:{supports_1m_beta:!0}"), "a context with no window"],
		[row("claude-opus-9", ",max_output_tokens:{default:0,upper:1}"), "a zero cap"],
		['{id:"claude-opus-9",family:"opus",display_name:"x",context:{', "a row that never closes"],
	];
	for (const [text, what] of cases) assert.equal(parseClaudeTable(text).ok, false, what);
});

// ---- what Sova takes

const r = (id: string, over: Partial<ClaudeTableRow> = {}): ClaudeTableRow => ({ id, family: /^claude-([a-z0-9]+)/.exec(id)![1]!, name: id, window: 1_000_000, maxOutput: 128_000, efforts: ["low"], ...over });
const seedRows = () => CLAUDE_MODELS.map((m) => r(m.id));
const T = (rows: ClaudeTableRow[], latest: Record<string, string>): ClaudeTable => ({ rows: [...seedRows(), ...rows], latest });
const ids = (d: { models: readonly { id: string }[] }) => d.models.map((m) => m.id);

test("a newer model in a family the table calls current comes in; older and unnamed ones stay out", () => {
	const d = offerFromTable(T([r("claude-opus-9"), r("claude-opus-3-5"), r("claude-mythos-5"), r("claude-3-5-sonnet")], { opus: "claude-opus-9" }));
	assert.ok(ids(d).includes("claude-opus-9"));
	for (const out of ["claude-opus-3-5", "claude-mythos-5", "claude-3-5-sonnet"]) assert.ok(!ids(d).includes(out), out);
});

test("adoption stops at the table's own latest; a model adopted earlier stays", () => {
	const d = offerFromTable(T([r("claude-opus-9"), r("claude-opus-9-5"), r("claude-opus-10")], { opus: "claude-opus-9-5" }));
	for (const id of ["claude-opus-9", "claude-opus-9-5"]) assert.ok(ids(d).includes(id), id);
	assert.ok(!ids(d).includes("claude-opus-10"), "past the family's latest");
	const earlier = { models: [{ id: "claude-opus-10", window: 5 }] };
	const kept = offerFromTable(T([r("claude-opus-9-5"), r("claude-opus-10")], { opus: "claude-opus-9-5" }), earlier);
	assert.ok(ids(kept).includes("claude-opus-10"));
});

test("versions compare as numbers, and 5 is 5-0", () => {
	const d = offerFromTable(T([r("claude-opus-90-9"), r("claude-opus-90-10")], { opus: "claude-opus-90-10" }));
	assert.ok(ids(d).includes("claude-opus-90-9"), "90.9 is below the latest 90.10, as a string it would be above");
	assert.ok(ids(d).includes("claude-opus-90-10"));
	const past = offerFromTable(T([r("claude-opus-90-9"), r("claude-opus-90-10")], { opus: "claude-opus-90-9" }));
	assert.ok(ids(past).includes("claude-opus-90-9"));
	assert.ok(!ids(past).includes("claude-opus-90-10"), "90.10 is past 90.9, as a string it would be below");
	for (const latest of ["claude-opus-90", "claude-opus-90-0"]) {
		const tie = offerFromTable(T([r("claude-opus-90"), r("claude-opus-90-0")], { opus: latest }));
		for (const id of ["claude-opus-90", "claude-opus-90-0"]) assert.ok(ids(tie).includes(id), `latest ${latest}: ${id} is that same version, not past it`);
	}
});

test("a family new to Sova contributes its latest only", () => {
	const d = offerFromTable(T([r("claude-nova-1"), r("claude-nova-1-2")], { nova: "claude-nova-1-2" }));
	assert.ok(ids(d).includes("claude-nova-1-2"));
	assert.ok(!ids(d).includes("claude-nova-1"));
});

test("a family latest_per_family doesn't name adopts nothing, a table with no latest at all included", () => {
	const none = offerFromTable(T([r("claude-opus-9"), r("claude-nova-1")], {}));
	const onlyHaiku = offerFromTable(T([r("claude-opus-9"), r("claude-haiku-9")], { haiku: "claude-haiku-9" }));
	assert.ok(!ids(none).includes("claude-opus-9"));
	assert.ok(!ids(none).includes("claude-nova-1"));
	assert.ok(!ids(onlyHaiku).includes("claude-opus-9"));
	assert.ok(ids(onlyHaiku).includes("claude-haiku-9"));
});

test("a latest value that is no standard id of its family names nothing: no adoption, no crash", () => {
	const cases: Record<string, string>[] = [{ sonnet: "claude-3-7-sonnet" }, { nova: "claude-3-7-sonnet" }, { opus: "claude-haiku-9" }, { nova: "claude-haiku-9" }];
	for (const latest of cases) {
		const d = offerFromTable(T([r("claude-3-7-sonnet"), r("claude-sonnet-9"), r("claude-opus-9"), r("claude-haiku-9"), r("claude-nova-1")], latest));
		for (const out of ["claude-3-7-sonnet", "claude-sonnet-9", "claude-opus-9", "claude-haiku-9", "claude-nova-1"]) assert.ok(!ids(d).includes(out), `${JSON.stringify(latest)}: ${out}`);
	}
});

test("a dated or [1m] latest is its row; a value that is no row at all makes the table unread", () => {
	const text = (value: string) => `${row("claude-opus-9", "")};x={latest_per_family:{opus:"${value}"}}`;
	for (const value of ["claude-opus-9-20260101", "claude-opus-9[1m]"]) assert.equal(ok(parseClaudeTable(text(value))).latest.opus, "claude-opus-9", value);
	for (const value of ["claude-opus-10", "claude-opus-10-20260101", "not-an-id", "claude-3-7-sonnet"]) assert.equal(parseClaudeTable(text(value)).ok, false, value);
});

test("the table's fields win for a model Sova ships", () => {
	const seed = CLAUDE_MODELS[0]!;
	const d = offerFromTable({ rows: [r(seed.id, { window: 123, maxOutput: 456, efforts: [], firstParty: `${seed.id}-20260101` })], latest: {} });
	assert.deepEqual(d.models.find((m) => m.id === seed.id), { id: seed.id, window: 123, maxOutput: 456, efforts: [], apiIds: [`${seed.id}-20260101`] });
});

test("a model the table no longer has is dropped and stays known; it comes back when the table has it", () => {
	const first = offerFromTable(T([r("claude-opus-9"), r("claude-opus-9-5")], { opus: "claude-opus-9-5" }));
	const without = { rows: seedRows().concat(r("claude-opus-9-5")), latest: { opus: "claude-opus-9-5" } };
	const gone = offerFromTable(without, first);
	assert.deepEqual(gone.dropped, ["claude-opus-9"]);
	assert.ok(ids(gone).includes("claude-opus-9"), "still known");
	const back = offerFromTable({ rows: without.rows.concat(r("claude-opus-9")), latest: without.latest }, gone);
	assert.equal(back.dropped, undefined);
});

test("a built-in model the table doesn't list is dropped, older Claude Code or not", () => {
	const seedPrev = CLAUDE_MODELS.find((m) => m.status === "previous" && m.family === "opus")!;
	const noPrev = offerFromTable({ rows: seedRows().filter((x) => x.id !== seedPrev.id), latest: {} });
	assert.deepEqual(noPrev.dropped, [seedPrev.id]);
	const current = CLAUDE_MODELS.find((m) => m.status === "current" && m.family === "opus")!;
	const older = offerFromTable({ rows: seedRows().filter((x) => x.id !== current.id), latest: {} });
	assert.ok((older.dropped ?? []).includes(current.id));
});

test("an adopted model stays when a newer one arrives, and what passed its test is remembered", () => {
	const first = { ...offerFromTable(T([r("claude-opus-9")], { opus: "claude-opus-9" })), tested: ["claude-opus-9"] };
	const next = offerFromTable(T([r("claude-opus-9"), r("claude-opus-10")], { opus: "claude-opus-10" }), first);
	assert.ok(ids(next).includes("claude-opus-9"));
	assert.ok(ids(next).includes("claude-opus-10"));
	assert.deepEqual(next.tested, ["claude-opus-9"]);
});

test("the same table twice gives the same answer", () => {
	const t = T([r("claude-opus-9")], { opus: "claude-opus-9" });
	const once = offerFromTable(t);
	assert.deepEqual(offerFromTable(t, once), once);
});
