import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, loadSettings, mergeSettings, SETTINGS_FILE } from "./settings.ts";

function agentDir(contents?: string) {
	const dir = mkdtempSync(join(tmpdir(), "vision-settings-"));
	if (contents !== undefined) writeFileSync(join(dir, SETTINGS_FILE), contents);
	return dir;
}

test("a missing settings file yields the defaults, unshared with the constant", () => {
	const settings = loadSettings(agentDir());
	assert.deepEqual(settings, DEFAULT_SETTINGS);
	settings.fallbacks.push("mutated");
	assert.deepEqual(loadSettings(agentDir()).fallbacks, DEFAULT_SETTINGS.fallbacks);
	assert.equal(DEFAULT_SETTINGS.fallbacks.includes("mutated"), false);
});

test("the shipped defaults name concrete vision models and a usable threshold", () => {
	assert.deepEqual(DEFAULT_SETTINGS.fallbacks, ["zai/glm-5.3-flash", "anthropic/claude-haiku-4-5"]);
	assert.equal(DEFAULT_SETTINGS.exhaustedAbovePct, 90);
	assert.equal(DEFAULT_SETTINGS.contextChars, 2000);
});

test("a complete file is honored field for field", () => {
	const dir = agentDir(JSON.stringify({ fallbacks: ["openai-codex/gpt-5.5"], exhaustedAbovePct: 75, contextChars: 0 }));
	assert.deepEqual(loadSettings(dir), { fallbacks: ["openai-codex/gpt-5.5"], exhaustedAbovePct: 75, contextChars: 0 });
});

test("malformed files and fields fall back per field instead of disabling delegation", () => {
	assert.deepEqual(loadSettings(agentDir("{not json")), DEFAULT_SETTINGS);
	assert.deepEqual(loadSettings(agentDir("[]")), DEFAULT_SETTINGS);
	assert.deepEqual(loadSettings(agentDir("null")), DEFAULT_SETTINGS);
	// Per-field: a good threshold survives a useless fallback list.
	const mixed = loadSettings(agentDir(JSON.stringify({ fallbacks: [], exhaustedAbovePct: 50 })));
	assert.deepEqual(mixed.fallbacks, DEFAULT_SETTINGS.fallbacks);
	assert.equal(mixed.exhaustedAbovePct, 50);
	const junk = mergeSettings({ fallbacks: ["noslash", 7, "zai/glm-5.3-flash"], exhaustedAbovePct: 0, contextChars: -1 });
	assert.deepEqual(junk.fallbacks, ["zai/glm-5.3-flash"]);
	assert.equal(junk.exhaustedAbovePct, DEFAULT_SETTINGS.exhaustedAbovePct);
	assert.equal(junk.contextChars, DEFAULT_SETTINGS.contextChars);
	assert.equal(mergeSettings({ exhaustedAbovePct: 101 }).exhaustedAbovePct, DEFAULT_SETTINGS.exhaustedAbovePct);
});
