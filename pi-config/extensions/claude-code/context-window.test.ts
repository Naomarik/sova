import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as catalog from "./catalog.ts";
import * as shim from "./context-window.ts";
import { refreshClaudeModels, STATIC_MODELS } from "./provider/index.ts";
import { registerSubagents } from "../subagents/index.ts";

const catalogShape = () => catalog.claudeOffer().map((m) => [m.id, m.name]);

test("context-window.ts is the catalog's window rule, re-exported", () => {
	assert.equal(shim.claudeContextWindow, catalog.claudeContextWindow);
	assert.equal(shim.CLAUDE_1M_WINDOW, catalog.CLAUDE_1M_WINDOW);
	assert.equal(shim.CLAUDE_DEFAULT_WINDOW, catalog.CLAUDE_DEFAULT_WINDOW);
});

test("the chat picker's models are the catalog, online or not", async () => {
	assert.deepEqual(STATIC_MODELS.map((m) => [m.id, m.name]), catalogShape());
	for (const allowNetwork of [true, false]) {
		const models = await refreshClaudeModels({ allowNetwork, signal: new AbortController().signal });
		assert.deepEqual(models.map((m) => [m.id, m.name]), catalogShape());
	}
	assert.equal(STATIC_MODELS.find((m) => m.id === "claude-haiku-4-5")?.maxTokens, 32_000, "the catalog's output cap, not a guess by id prefix");
	assert.equal(STATIC_MODELS.find((m) => m.id === "claude-opus-5-5")?.contextWindow, 1_000_000);
});

test("agent_models lists the catalog and never runs the CLI (a `claude` on PATH that would answer otherwise)", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "claude-catalog-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const bin = join(dir, "claude");
	const marker = join(dir, "ran");
	writeFileSync(bin, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`);
	chmodSync(bin, 0o755);
	const path = process.env.PATH;
	process.env.PATH = `${dir}:${path}`;
	t.after(() => { process.env.PATH = path; });
	// claude-code is the subagents manager's built-in backend (a pi worker on this provider): its
	// agent_models rows are the catalog.
	const tools = new Map<string, any>();
	const hooks = new Map<string, Function>();
	const events = { on() { return () => {}; }, emit() {} };
	registerSubagents({
		events, registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, registerShortcut() {}, appendEntry() {},
		on: (name: string, hook: Function) => hooks.set(name, hook), getActiveTools: () => [], sendMessage() {}, sendUserMessage() {},
	} as any, undefined, { policyFile: join(dir, "no-policy.json"), agentDir: dir });
	t.after(async () => { await hooks.get("session_shutdown")?.({}, ctx); });
	const ctx: any = { cwd: dir, mode: "rpc", hasUI: false, ui: { setStatus() {}, notify() {} }, sessionManager: { getEntries: () => [] }, modelRegistry: { getAvailable: () => [] } };
	const result = await tools.get("agent_models").execute("t", { backend: "claude-code", limit: 100 }, undefined, () => {}, ctx);
	const listed = result.details.models;
	assert.deepEqual(listed.map((m: any) => [m.id, m.name]).sort(), catalogShape().sort());
	assert.deepEqual(listed.find((m: any) => m.id === "claude-haiku-4-5").efforts, undefined, "Haiku takes no effort");
	const { existsSync } = await import("node:fs");
	assert.equal(existsSync(marker), false, "no claude process ran");
});
