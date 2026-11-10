import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { claudeName } from "./catalog.ts";

// The name rule (§app.claude-code-provider/model-names) over the model tables of three real Claude
// Code versions, copied as data into tests/fixtures/claude-tables: the expected answer is Claude
// Code's own display_name, which the rule never reads.
const DIR = new URL("./tests/fixtures/claude-tables/", import.meta.url);
const tables = readdirSync(DIR).map((f) => JSON.parse(readFileSync(new URL(f, DIR), "utf8")) as { version: string; rows: string[] });
const field = (row: string, re: RegExp) => re.exec(row)?.[1];
const rowsOf = (t: { rows: string[] }) => t.rows.map((r) => ({ id: field(r, /id:"([^"]+)"/)!, name: field(r, /display_name:"([^"]+)"/)!, firstParty: field(r, /first_party:"([^"]+)"/)! }));
/** `claude-3-5-sonnet`: the old word order, which the rule leaves unnamed on purpose. */
const oldOrder = (id: string) => /^claude-\d/.test(id);

test("the three tables are there, so the rule below has something to hold over", () => {
	assert.deepEqual(tables.map((t) => [t.version, t.rows.length, rowsOf(t).filter((r) => !oldOrder(r.id)).length]), [["2.1.314", 22, 19], ["2.1.317", 22, 19], ["2.1.321", 24, 21]]);
});

test("every canonical id in every table reads as Claude Code's own name, however it is written", () => {
	for (const t of tables) for (const { id, name, firstParty } of rowsOf(t)) {
		if (oldOrder(id)) continue;
		const forms = [id, id.toUpperCase(), ` ${id} `, `${id}[1m]`, `${id}-20260101`, `${id}-20260101[1m]`, `claude-code-cli/${id}`, `claude-code/${id}`, `claude/${id}`, `anthropic/${id}`, `anthropic/${id}-20260101`, firstParty];
		for (const form of forms) assert.equal(claudeName(form), name, `${t.version}: ${form}`);
	}
});

test("an old-order id stays unnamed, with or without its date", () => {
	for (const t of tables) for (const { id, firstParty } of rowsOf(t)) {
		if (!oldOrder(id)) continue;
		assert.equal(claudeName(id), undefined, id);
		assert.equal(claudeName(firstParty), undefined, firstParty);
	}
});

test("the rule's edges: families it has never met, versions, and what is not a Claude id", () => {
	for (const [id, name] of [
		["claude-nova-1-2", "Nova 1.2"],
		["claude-nova-1", "Nova 1"],
		["claude-nova-1-0", "Nova 1"],
		["claude-nova-1-10", "Nova 1.10"],
		["claude-nova-1-2-20270101", "Nova 1.2"],
		["claude-nova-1-20270101", "Nova 1"],
		["claude-code-cli/claude-nova-1-2[1m]", "Nova 1.2"],
		["claude-opus-6", "Opus 6"],
	] as const) assert.equal(claudeName(id), name, id);
	for (const id of [
		"", "   ", "claude", "claude-", "claude-nova", "claude-nova-", "claude-nova-x", "claude-nova-1-x", "claude-nova-1-2-3", "claude-nova--1", "claude-nova-20270101",
		"claude-nova-1-2-2027010", "claude-nova-latest", "claude-3-5-nova", "gpt-5-mini", "zai/glm-5.3", "zai/claude-nova-1-2", "ollama/opus", "claude-code-cli/gpt-5", "x-claude-nova-1",
	]) assert.equal(claudeName(id), undefined, JSON.stringify(id));
});
