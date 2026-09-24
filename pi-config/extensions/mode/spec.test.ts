import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorkerChoice } from "./delegate.ts";
import { loadSpec, normalizeSpec, parseSpec, saveSpec, specBackends, specDefaults, specKey, specReader } from "./spec.ts";

const claude = (model: string, effort: string): WorkerChoice => ({ backend: "claude-code", model, effort });
const pi = (model: string, effort: string): WorkerChoice => ({ backend: "pi", model, effort });

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "mode-spec-test-"));
}

test("defaults: no writer — the session writes the spec itself", () => {
	assert.deepEqual(specDefaults(), { version: 1, writer: null });
});

test("normalizeSpec is tolerant: a bad primary is no writer, a bad or repeated fallback is no fallback", () => {
	const writer = { primary: claude("opus[1m]", "medium"), fallback: pi("zai/glm-5.3", "high") };
	assert.deepEqual(normalizeSpec({ version: 1, writer }), { version: 1, writer });
	assert.deepEqual(normalizeSpec({ version: 1, writer: null }), specDefaults());
	assert.deepEqual(normalizeSpec({ version: 1 }), specDefaults(), "missing writer");
	for (const bad of [null, [], "x", { version: 2, writer }, { writer }])
		assert.deepEqual(normalizeSpec(bad), specDefaults(), `unreadable or newer: ${JSON.stringify(bad)}`);
	// There is no default worker to fall back to: an unparseable primary means no writer at all.
	assert.deepEqual(normalizeSpec({ version: 1, writer: { primary: claude("opus[1m]", "turbo"), fallback: writer.fallback } }), specDefaults());
	assert.deepEqual(normalizeSpec({ version: 1, writer: { primary: pi("no-slash", "high"), fallback: null } }), specDefaults());
	assert.deepEqual(normalizeSpec({ version: 1, writer: { primary: writer.primary } }), { version: 1, writer: { primary: writer.primary, fallback: null } }, "missing fallback");
	assert.deepEqual(normalizeSpec({ version: 1, writer: { primary: writer.primary, fallback: { backend: "x" } } }), { version: 1, writer: { primary: writer.primary, fallback: null } });
	assert.deepEqual(normalizeSpec({ version: 1, writer: { primary: writer.primary, fallback: writer.primary } }), { version: 1, writer: { primary: writer.primary, fallback: null } }, "a fallback that is its primary is none");
});

test("parseSpec is strict and names the slot", () => {
	const primary = claude("opus[1m]", "medium");
	assert.deepEqual(parseSpec({ version: 1, writer: null }), specDefaults());
	assert.deepEqual(parseSpec({ version: 1, writer: { primary, fallback: null } }), { version: 1, writer: { primary, fallback: null } });
	assert.deepEqual(parseSpec({ version: 1, writer: { primary, fallback: pi("zai/glm-5.3", "high") } }), { version: 1, writer: { primary, fallback: pi("zai/glm-5.3", "high") } });
	const error = (value: unknown) => {
		const parsed = parseSpec(value);
		assert.ok("error" in parsed, JSON.stringify(value));
		return parsed.error;
	};
	assert.match(error(null), /Expected/);
	assert.match(error({ version: 2, writer: null }), /version must be 1/);
	assert.match(error({ version: 1 }), /writer must be/, "writer is required: null says none");
	assert.match(error({ version: 1, writer: "opus" }), /writer must be/);
	assert.match(error({ version: 1, writer: { primary: claude("opus[1m]", "off"), fallback: null } }), /^Spec writer primary: effort for claude-code must be one of/);
	assert.match(error({ version: 1, writer: { primary: pi("glm", "high"), fallback: null } }), /^Spec writer primary: a pi model is "provider\/modelId"/);
	assert.match(error({ version: 1, writer: { primary } }), /^Spec writer fallback: .*\(or null for none\)/, "a missing fallback is not silently none");
	assert.match(error({ version: 1, writer: { primary, fallback: { ...primary } } }), /^Spec writer fallback: the same worker as the primary/);
});

test("load and save: missing or corrupt reads as no writer; save is canonical and atomic", () => {
	const dir = tmp();
	try {
		const path = join(dir, "mode-spec.json");
		assert.deepEqual(loadSpec(path), specDefaults());
		writeFileSync(path, "{ not json");
		assert.deepEqual(loadSpec(path), specDefaults());
		const settings = { version: 1 as const, writer: { primary: claude("opus[1m]", "medium"), fallback: null } };
		saveSpec(path, settings);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), settings);
		assert.deepEqual(loadSpec(path), settings);
		saveSpec(path, specDefaults());
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 1, writer: null });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("specReader re-reads on change and forgets a deleted file", () => {
	const dir = tmp();
	try {
		const path = join(dir, "mode-spec.json");
		const read = specReader(path);
		assert.deepEqual(read(), specDefaults());
		const first = { version: 1 as const, writer: { primary: claude("opus[1m]", "medium"), fallback: null } };
		writeFileSync(path, JSON.stringify(first));
		assert.deepEqual(read(), first);
		assert.equal(read(), read(), "unchanged file: the cached object");
		const second = { version: 1 as const, writer: { primary: pi("zai/glm-5.3", "high"), fallback: claude("opus[1m]", "low") } };
		writeFileSync(`${path}.tmp`, JSON.stringify(second));
		renameSync(`${path}.tmp`, path);
		assert.deepEqual(read(), second, "an atomic replace is seen at the next read");
		rmSync(path);
		assert.deepEqual(read(), specDefaults());
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("specKey and specBackends: what a probe covers", () => {
	assert.deepEqual(specBackends(specDefaults()), [], "no writer, nothing to probe");
	const writer = { primary: pi("zai/glm-5.3", "high"), fallback: claude("opus[1m]", "low") };
	assert.deepEqual(specBackends({ version: 1, writer }), ["pi", "claude-code"]);
	assert.deepEqual(specBackends({ version: 1, writer: { primary: claude("opus[1m]", "low"), fallback: claude("sonnet", "low") } }), ["claude-code"]);
	assert.equal(specKey({ version: 1, writer }), specKey({ version: 1, writer: structuredClone(writer) }));
	assert.notEqual(specKey({ version: 1, writer }), specKey({ version: 1, writer: { ...writer, fallback: null } }));
	assert.notEqual(specKey(specDefaults()), specKey({ version: 1, writer }));
});
