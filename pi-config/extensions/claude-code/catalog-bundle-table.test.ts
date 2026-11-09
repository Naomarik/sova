// Claude Code's table as text, and the rule for what Sova takes from it. Rows are the real ones under
// tests/fixtures/claude-tables; nothing here reads a Claude Code program.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MIN_BUILT_IN_SHARE, offerFromTable, parseClaudeTable, type ClaudeTable, type ClaudeTableParse, type ClaudeTableRow } from "./bundle-table.ts";
import { CLAUDE_MODELS } from "./catalog.ts";

const realTable = (version: string) => JSON.parse(readFileSync(join(import.meta.dirname, "tests/fixtures/claude-tables", `${version}.json`), "utf8")) as { rows: string[]; latestPerFamily: string };
const programText = (rows: string[], latest: string, version = "2.1.321") => `var a;[${rows.join(",")}];var t={latest_per_family:${latest}},VERSION:"${version}"`;
const fixture = (version: string) => {
	const f = realTable(version);
	return programText(f.rows, f.latestPerFamily, version);
};
const REAL = realTable("2.1.321");
/** A whole program's text with `extra` rows after the real ones, so each case fails only for its own reason. */
const whole = (...extra: string[]) => programText([...REAL.rows, ...extra], REAL.latestPerFamily);
const row = (id: string, body: string, family = /^claude-([a-z]+)/.exec(id)![1]!) => `{id:"${id}",family:"${family}",display_name:"x"${body}}`;
const ok = (r: ClaudeTableParse) => {
	assert.ok(r.ok, r.ok ? "" : r.reason);
	return r.table;
};
const one = (body: string) => ok(parseClaudeTable(whole(row("claude-opus-9", body)))).rows.find((x) => x.id === "claude-opus-9")!;

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
	const t = ok(parseClaudeTable(whole(row("claude-opus-8", ""), row("claude-opus-9", ",context:{window:1e6,native_1m:!0}"))));
	assert.equal(t.rows.find((x) => x.id === "claude-opus-8")!.window, 200_000);
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
		[programText(REAL.rows, '{opus:"claude-opus-10"}'), "a latest that isn't a row"],
		[programText(REAL.rows, "{}"), "an empty latest_per_family"],
		[REAL.rows.join(","), "no latest_per_family"],
		[whole(row("claude-opus-9", ",context:{window:0}")), "a zero window"],
		[whole(row("claude-opus-9", ",context:{supports_1m_beta:!0}")), "a context with no window"],
		[whole(row("claude-opus-9", ",max_output_tokens:{default:0,upper:1}")), "a zero cap"],
		[`${whole()},{id:"claude-opus-9",family:"opus",display_name:"x",context:{`, "a row that never closes"],
	];
	for (const [text, what] of cases) assert.equal(parseClaudeTable(text).ok, false, what);
});

test("a real table with most rows cut is partial, not a table with models missing", () => {
	const kept = REAL.rows.filter((r) => /id:"claude-(opus|fable)-5-5"|id:"claude-haiku-5-5"|id:"claude-sonnet-5-5"|id:"claude-fable-5-2"/.test(r));
	const parsed = parseClaudeTable(programText(kept, REAL.latestPerFamily));
	assert.equal(parsed.ok, false);
	assert.match(parsed.ok ? "" : parsed.reason, /built-in models/);
});

test("a table with most built-in ids is whole, and just under the floor isn't", () => {
	const builtIn = new Set<string>(CLAUDE_MODELS.map((m) => m.id));
	const idOf = (x: string) => /id:"([^"]+)"/.exec(x)![1]!;
	const others = REAL.rows.filter((x) => !builtIn.has(idOf(x)));
	const seeds = REAL.rows.filter((x) => builtIn.has(idOf(x)));
	const latestIds = new Set([...REAL.latestPerFamily.matchAll(/"([^"]+)"/g)].map((m) => m[1]!));
	const ordered = [...seeds.filter((x) => latestIds.has(idOf(x))), ...seeds.filter((x) => !latestIds.has(idOf(x)))];
	const floor = Math.floor(CLAUDE_MODELS.length * MIN_BUILT_IN_SHARE) + 1;
	assert.equal(parseClaudeTable(programText([...others, ...ordered.slice(0, floor)], REAL.latestPerFamily)).ok, true);
	assert.equal(parseClaudeTable(programText([...others, ...ordered.slice(0, floor - 1)], REAL.latestPerFamily)).ok, false);
});

test("a field renamed across the whole table is no data; one row lacking it takes the default", () => {
	const noCaps = REAL.rows.map((x) => x.replace(/,?capabilities:\[[^\]]*\]/, ""));
	const noOutput = REAL.rows.map((x) => x.replace(/,?max_output_tokens:\{[^}]*\}/, ""));
	const reason = (rows: string[]) => {
		const p = parseClaudeTable(programText(rows, REAL.latestPerFamily));
		return p.ok ? "parsed" : p.reason;
	};
	assert.match(reason(noCaps), /capabilities/);
	assert.match(reason(noOutput), /output cap/);
	assert.deepEqual(one("").efforts, []);
	assert.equal(one("").maxOutput, 64_000);
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

test("a family latest_per_family doesn't name adopts nothing", () => {
	const onlyHaiku = offerFromTable(T([r("claude-opus-9"), r("claude-haiku-9"), r("claude-nova-1")], { haiku: "claude-haiku-9" }));
	assert.ok(!ids(onlyHaiku).includes("claude-opus-9"));
	assert.ok(!ids(onlyHaiku).includes("claude-nova-1"));
	assert.ok(ids(onlyHaiku).includes("claude-haiku-9"));
});

test("a table that isn't whole changes nothing, however it arrives", () => {
	const gone = CLAUDE_MODELS.find((m) => m.status === "previous")!.id;
	const prev = { ...offerFromTable({ rows: seedRows().filter((x) => x.id !== gone).concat(r("claude-opus-9")), latest: { opus: "claude-opus-9" } }), tested: ["claude-opus-9"] };
	assert.deepEqual(prev.dropped, [gone]);
	for (const partial of [{ rows: [seedRows()[0]!], latest: {} }, { rows: [seedRows()[0]!], latest: { [seedRows()[0]!.family]: seedRows()[0]!.id } }, { rows: seedRows(), latest: {} }]) {
		const after = offerFromTable(partial, prev);
		assert.deepEqual(after.dropped, prev.dropped);
		assert.deepEqual(after.models, prev.models);
		assert.deepEqual(after.tested, prev.tested);
	}
	assert.equal(offerFromTable({ rows: [seedRows()[0]!], latest: {} }, null).dropped, undefined);
});

test("a latest value that is no standard id of its family names nothing: no adoption, no crash", () => {
	const cases: Record<string, string>[] = [{ sonnet: "claude-3-7-sonnet" }, { nova: "claude-3-7-sonnet" }, { opus: "claude-haiku-9" }, { nova: "claude-haiku-9" }];
	for (const latest of cases) {
		const d = offerFromTable(T([r("claude-3-7-sonnet"), r("claude-sonnet-9"), r("claude-opus-9"), r("claude-haiku-9"), r("claude-nova-1")], latest));
		for (const out of ["claude-3-7-sonnet", "claude-sonnet-9", "claude-opus-9", "claude-haiku-9", "claude-nova-1"]) assert.ok(!ids(d).includes(out), `${JSON.stringify(latest)}: ${out}`);
	}
});

test("a dated or [1m] latest is its row; a value that is no row at all makes the table unread", () => {
	const text = (value: string) => programText([...REAL.rows, row("claude-opus-9", "")], `{opus:"${value}"}`);
	for (const value of ["claude-opus-9-20260101", "claude-opus-9[1m]"]) assert.equal(ok(parseClaudeTable(text(value))).latest.opus, "claude-opus-9", value);
	for (const value of ["claude-opus-10", "claude-opus-10-20260101", "not-an-id"]) assert.equal(parseClaudeTable(text(value)).ok, false, value);
});

test("the table's fields win for a model Sova ships", () => {
	const seed = CLAUDE_MODELS[0]!;
	const d = offerFromTable({ rows: [...seedRows().filter((x) => x.id !== seed.id), r(seed.id, { window: 123, maxOutput: 456, efforts: [], firstParty: `${seed.id}-20260101` })], latest: { [seed.family]: seed.id } });
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

test("a built-in model a whole table doesn't list is dropped, an older Claude Code's included", () => {
	const opus = CLAUDE_MODELS.filter((m) => m.family === "opus");
	const current = opus.find((m) => m.status === "current")!;
	const previous = opus.find((m) => m.status === "previous")!;
	const noPrev = offerFromTable({ rows: seedRows().filter((x) => x.id !== previous.id), latest: { opus: current.id } });
	assert.deepEqual(noPrev.dropped, [previous.id]);
	const older = offerFromTable({ rows: seedRows().filter((x) => x.id !== current.id), latest: { opus: previous.id } });
	assert.deepEqual(older.dropped, [current.id], "this Claude Code predates the newest Opus");
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
