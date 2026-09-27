import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CLAUDE_1M_WINDOW, CLAUDE_DEFAULT_WINDOW, claudeContextWindow, withLongContextVariants } from "./context-window.ts";
import { registerClaudeCode } from "./index.ts";
import { refreshClaudeModels } from "./provider/index.ts";
import { BACKEND_REGISTER_EVENT } from "../subagents/contracts.ts";

type Case = { name: string; input: { id: string; name: string; efforts?: string[] }[]; expected: [string, string, string[]?][] };
const { cases } = JSON.parse(readFileSync(new URL("./tests/fixtures/long-context-lists.json", import.meta.url), "utf8")) as { cases: Case[] };
const shape = (models: readonly { id: string; name: string; efforts?: string[] }[]) =>
	models.map((m) => (m.efforts ? [m.id, m.name, m.efforts] : [m.id, m.name]));

test("window rule: [1m] is 1M, natively 1M models are 1M bare, the rest 200k", () => {
	for (const id of ["opus[1m]", "sonnet[1m]", "haiku[1m]", "claude-opus-4-6[1m]", "opus", "claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5", "sonnet", "claude-opus-4-7"]) {
		assert.equal(claudeContextWindow(id), CLAUDE_1M_WINDOW, id);
	}
	for (const id of ["haiku", "claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-6", "claude-opus-4-5", "opus[1M]", "[1m]opus", "fable", ""]) {
		assert.equal(claudeContextWindow(id), CLAUDE_DEFAULT_WINDOW, id);
	}
	assert.equal(claudeContextWindow("best", "claude-fable-5-1"), CLAUDE_1M_WINDOW, "an alias is judged by what it resolves to");
	assert.equal(claudeContextWindow("opus", "claude-opus-4-6"), CLAUDE_DEFAULT_WINDOW, "resolvedModel beats the alias table");
	assert.equal(claudeContextWindow("opus[1m]", "claude-opus-4-6"), CLAUDE_1M_WINDOW, "the suffix beats both");
});

test("list rule: the shared fixture's cases", () => {
	for (const c of cases) {
		const input = structuredClone(c.input);
		assert.deepEqual(shape(withLongContextVariants(input)), c.expected, c.name);
		assert.deepEqual(input, c.input, `${c.name}: the input is not mutated`);
	}
	const [base, variant] = withLongContextVariants([{ id: "opus", name: "Opus", efforts: ["low"], resolvedModel: "claude-opus-5-5" }]);
	assert.equal(variant!.resolvedModel, "claude-opus-5-5", "the variant keeps the base's other fields");
	assert.notEqual(variant!.efforts, base!.efforts, "and its own copy of the efforts");
});

test("the chat picker's discovery applies the list rule", async () => {
	for (const c of cases) {
		const models = await refreshClaudeModels({ allowNetwork: true, signal: new AbortController().signal }, async () => structuredClone(c.input));
		if (!c.input.length) continue; // an empty discovery falls back to STATIC_MODELS
		assert.deepEqual(models.map((m) => [m.id, m.name]), c.expected.map(([id, name]) => [id, name]), c.name);
	}
});

test("agent_models applies the list rule (a fake `claude` on PATH answers initialize)", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "claude-long-context-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const c = cases[0]!;
	const models = c.input.map((m) => ({ value: m.id, displayName: m.name, ...(m.efforts ? { supportedEffortLevels: m.efforts } : {}) }));
	const bin = join(dir, "claude");
	writeFileSync(bin, `#!/usr/bin/env node
let buf = "";
process.stdin.on("data", (d) => {
	buf += d;
	const nl = buf.indexOf("\\n");
	if (nl < 0) return;
	const { request_id } = JSON.parse(buf.slice(0, nl));
	process.stdout.write(JSON.stringify({ type: "control_response", response: { request_id, subtype: "success", response: { models: ${JSON.stringify(models)} } } }) + "\\n");
});
process.stdin.on("end", () => process.exit(0));
`);
	chmodSync(bin, 0o755);
	const path = process.env.PATH;
	process.env.PATH = `${dir}:${path}`;
	t.after(() => { process.env.PATH = path; });
	const registrations: any[] = [];
	const hooks = new Map<string, Function>();
	const events = { on() { return () => {}; }, emit(name: string, d: any) { if (name === BACKEND_REGISTER_EVENT) registrations.push(d); } };
	registerClaudeCode({ events, registerFlag() {}, getFlag: () => undefined, registerProvider() {}, unregisterProvider() {}, on: (name: string, hook: Function) => hooks.set(name, hook) } as any);
	t.after(async () => { await hooks.get("session_shutdown")?.(); });
	const listed = await registrations[0].listModels({}, undefined);
	assert.deepEqual(shape(listed), c.expected);
});
