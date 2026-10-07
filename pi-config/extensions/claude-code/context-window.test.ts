import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as catalog from "./catalog.ts";
import * as shim from "./context-window.ts";
import { registerClaudeCode } from "./index.ts";
import { refreshClaudeModels, STATIC_MODELS } from "./provider/index.ts";
import { BACKEND_REGISTER_EVENT } from "../subagents/contracts.ts";

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
	const registrations: any[] = [];
	const hooks = new Map<string, Function>();
	const events = { on() { return () => {}; }, emit(name: string, d: any) { if (name === BACKEND_REGISTER_EVENT) registrations.push(d); } };
	registerClaudeCode({ events, registerFlag() {}, getFlag: () => undefined, registerProvider() {}, unregisterProvider() {}, on: (name: string, hook: Function) => hooks.set(name, hook) } as any);
	t.after(async () => { await hooks.get("session_shutdown")?.(); });
	const listed = await registrations[0].listModels({}, undefined);
	assert.deepEqual(listed.map((m: any) => [m.id, m.name]), catalogShape());
	assert.deepEqual(listed.find((m: any) => m.id === "claude-haiku-4-5").efforts, undefined, "Haiku takes no effort");
	const { existsSync } = await import("node:fs");
	assert.equal(existsSync(marker), false, "no claude process ran");
});
