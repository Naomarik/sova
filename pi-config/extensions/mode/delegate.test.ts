import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	CLAUDE_EFFORTS,
	DELEGATE_FILE_NAME,
	DELEGATE_PROFILE_INFO,
	DELEGATE_PROFILES,
	delegateDefaults,
	delegateKey,
	delegateReader,
	effectiveEfforts,
	loadDelegate,
	modelShapeError,
	normalizeDelegate,
	parseChoice,
	parseDelegate,
	PI_EFFORTS,
	saveDelegate,
	type DelegateSettings,
} from "./delegate.ts";
import { loadState, normalizeState, saveState } from "./state.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "mode-delegate-test-"));

test("the file is its own, never mode.json", () => {
	assert.equal(DELEGATE_FILE_NAME, "mode-delegate.json");
	assert.notEqual(DELEGATE_FILE_NAME, "mode.json");
	// The reason: mode.json's normalizer rebuilds the file from known fields only, so a routing kept
	// there would be stripped by the next `/mode default`.
	const stripped = normalizeState({ version: 1, mode: "delegate", profiles: delegateDefaults().profiles }) as unknown as Record<string, unknown>;
	assert.ok(!("profiles" in stripped), "normalizeState drops unknown fields");
	const dir = tmp();
	try {
		const modeFile = join(dir, "mode.json");
		saveState(modeFile, loadState(modeFile));
		saveDelegate(join(dir, DELEGATE_FILE_NAME), delegateDefaults());
		saveState(modeFile, { ...loadState(modeFile), mode: "delegate" }); // a `/mode default`
		assert.deepEqual(loadDelegate(join(dir, DELEGATE_FILE_NAME)), delegateDefaults(), "a mode.json write leaves the routing alone");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("defaults preserve the claude-heavy routing and add a conservative Investigation", () => {
	const d = delegateDefaults();
	assert.deepEqual(Object.keys(d.profiles), [...DELEGATE_PROFILES]);
	assert.deepEqual(DELEGATE_PROFILES, ["planning", "investigation", "routine", "complex"]);
	assert.deepEqual(d.profiles.planning, {
		primary: { backend: "claude-code", model: "claude-fable-5-1[1m]", effort: "medium" },
		fallback: { backend: "claude-code", model: "opus[1m]", effort: "high" },
	});
	assert.deepEqual(d.profiles.routine, { primary: { backend: "claude-code", model: "opus[1m]", effort: "low" }, fallback: null });
	assert.deepEqual(d.profiles.complex, { primary: { backend: "claude-code", model: "opus[1m]", effort: "medium" }, fallback: null });
	assert.deepEqual(d.profiles.investigation, { primary: { backend: "claude-code", model: "opus[1m]", effort: "low" }, fallback: null });
	assert.notEqual(delegateDefaults(), delegateDefaults(), "a fresh object each time");
	assert.notEqual(delegateDefaults().profiles.planning.primary, d.profiles.planning.primary, "never aliased");
	assert.deepEqual(
		DELEGATE_PROFILES.map((id) => DELEGATE_PROFILE_INFO[id].label),
		["Planning & specs", "Investigation", "Routine implementation", "Complex implementation"],
	);
});

test("parseChoice is backend-aware", () => {
	assert.deepEqual(parseChoice({ backend: "pi", model: "zai/glm-5.3", effort: "high" }), { backend: "pi", model: "zai/glm-5.3", effort: "high" });
	assert.deepEqual(parseChoice({ backend: "claude-code", model: "opus[1m]", effort: "max", extra: 1 }), { backend: "claude-code", model: "opus[1m]", effort: "max" });
	// pi efforts are pi's thinking ladder; claude's are the CLI's.
	assert.deepEqual(PI_EFFORTS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	assert.deepEqual(CLAUDE_EFFORTS, ["low", "medium", "high", "xhigh", "max"]);
	assert.ok("error" in parseChoice({ backend: "claude-code", model: "opus", effort: "off" }), "claude has no off");
	assert.ok("error" in parseChoice({ backend: "claude-code", model: "opus", effort: "minimal" }));
	assert.ok(!("error" in parseChoice({ backend: "pi", model: "a/b", effort: "off" })), "pi does");
	for (const bad of [
		null,
		[],
		"opus",
		{ model: "opus", effort: "low" },
		{ backend: "codex", model: "x", effort: "low" },
		{ backend: "pi", model: "glm-5.3", effort: "low" }, // pi needs provider/model
		{ backend: "pi", model: "/glm", effort: "low" },
		{ backend: "pi", model: "zai/", effort: "low" },
		{ backend: "claude-code", model: "anthropic/claude-opus", effort: "low" }, // a pi ref on claude
		{ backend: "claude-code", model: "--dangerously", effort: "low" },
		{ backend: "claude-code", model: "opus 1m", effort: "low" },
		{ backend: "claude-code", model: " opus", effort: "low" },
		{ backend: "claude-code", model: "", effort: "low" },
		{ backend: "claude-code", model: "opus", effort: "LOW" },
		{ backend: "claude-code", model: "opus" },
	]) {
		assert.ok("error" in parseChoice(bad), `rejected: ${JSON.stringify(bad)}`);
	}
	assert.equal(modelShapeError("pi", "ollama/qwen3:30b"), null, "pi ids may carry anything after the provider");
	assert.equal(modelShapeError("pi", "openrouter/meta/llama"), null, "and further slashes");
});

test("normalizeDelegate: a bad slot costs that slot only; explicit null fallbacks stay", () => {
	assert.deepEqual(normalizeDelegate(undefined), delegateDefaults());
	assert.deepEqual(normalizeDelegate({ version: 2, profiles: { routine: { primary: { backend: "pi", model: "a/b", effort: "low" } } } }), delegateDefaults(), "a newer schema is never half-read");
	assert.deepEqual(normalizeDelegate({ version: 1 }), delegateDefaults());
	const pi = { backend: "pi", model: "zai/glm-5.3", effort: "high" } as const;
	const read = normalizeDelegate({
		version: 1,
		profiles: {
			planning: { primary: pi, fallback: null },
			investigation: { primary: { backend: "pi", model: "no-slash", effort: "low" }, fallback: pi },
			routine: { primary: pi, fallback: { backend: "claude-code", model: "x", effort: "off" } },
			complex: "garbage",
			bogus: { primary: pi },
		},
	});
	assert.deepEqual(read.profiles.planning, { primary: pi, fallback: null }, "explicit null is no fallback, not the default one");
	assert.deepEqual(read.profiles.investigation, { primary: delegateDefaults().profiles.investigation.primary, fallback: pi }, "bad primary → default primary; good fallback kept");
	assert.deepEqual(read.profiles.routine, { primary: pi, fallback: null }, "bad fallback → the default fallback (none, for routine)");
	assert.deepEqual(read.profiles.complex, delegateDefaults().profiles.complex);
	assert.ok(!("bogus" in read.profiles));
	// Absent fallback key → the default's fallback (planning has one).
	assert.deepEqual(normalizeDelegate({ version: 1, profiles: { planning: { primary: pi } } }).profiles.planning.fallback, delegateDefaults().profiles.planning.fallback);
});

test("parseDelegate is strict and names the slot", () => {
	const good = delegateDefaults();
	assert.deepEqual(parseDelegate(JSON.parse(JSON.stringify(good))), good);
	const withPiFallback: DelegateSettings = JSON.parse(JSON.stringify(good));
	withPiFallback.profiles.routine.fallback = { backend: "pi", model: "zai/glm-5.3", effort: "medium" };
	assert.deepEqual(parseDelegate(withPiFallback), withPiFallback);

	const err = (value: unknown) => {
		const result = parseDelegate(value);
		assert.ok("error" in result, `expected an error for ${JSON.stringify(value)}`);
		return result.error;
	};
	assert.match(err(null), /Expected/);
	assert.match(err({ ...good, version: 2 }), /version must be 1/);
	assert.match(err({ version: 1, profiles: [] }), /profiles must be an object/);
	assert.match(err({ version: 1, profiles: { ...good.profiles, extra: good.profiles.routine } }), /Unknown profile: extra/);
	const { complex: _complex, ...missing } = good.profiles;
	assert.match(err({ version: 1, profiles: missing }), /^Complex implementation: missing$/);
	assert.match(
		err({ version: 1, profiles: { ...good.profiles, investigation: { primary: { backend: "pi", model: "glm", effort: "low" }, fallback: null } } }),
		/^Investigation primary: a pi model is "provider\/modelId"$/,
	);
	assert.match(
		err({ version: 1, profiles: { ...good.profiles, routine: { primary: good.profiles.routine.primary } } }),
		/^Routine implementation fallback: expected \{ backend, model, effort \} \(or null for none\)$/,
		"strict: an absent fallback is not silently none",
	);
	assert.match(
		err({ version: 1, profiles: { ...good.profiles, planning: { primary: good.profiles.planning.primary, fallback: good.profiles.planning.primary } } }),
		/^Planning & specs fallback: the same worker as the primary/,
	);
});

test("save/load round-trips canonically; missing and corrupt files read as defaults", () => {
	const dir = tmp();
	try {
		const path = join(dir, "nested", DELEGATE_FILE_NAME);
		assert.deepEqual(loadDelegate(path), delegateDefaults(), "missing");
		const settings: DelegateSettings = delegateDefaults();
		settings.profiles.investigation = { primary: { backend: "pi", model: "zai/glm-5.3", effort: "minimal" }, fallback: { backend: "claude-code", model: "sonnet", effort: "low" } };
		saveDelegate(path, settings);
		assert.deepEqual(loadDelegate(path), settings);
		const onDisk = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(onDisk.version, 1);
		assert.deepEqual(Object.keys(onDisk.profiles), [...DELEGATE_PROFILES], "canonical order on disk");
		writeFileSync(path, "{ nope");
		assert.deepEqual(loadDelegate(path), delegateDefaults(), "corrupt");
		writeFileSync(path, "[]");
		assert.deepEqual(loadDelegate(path), delegateDefaults(), "foreign shape");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("delegateReader re-reads on change (the turn-boundary read) and forgets a deleted file", () => {
	const dir = tmp();
	try {
		const path = join(dir, DELEGATE_FILE_NAME);
		const read = delegateReader(path);
		assert.deepEqual(read(), delegateDefaults(), "no file yet");
		const first = delegateDefaults();
		first.profiles.routine.primary.effort = "medium";
		saveDelegate(path, first);
		assert.equal(read().profiles.routine.primary.effort, "medium", "a file appearing is picked up");
		assert.equal(read(), read(), "unchanged file: the cached object");
		// An atomic replace within the same millisecond still reads as a change (new inode).
		const second = delegateDefaults();
		second.profiles.routine.primary.effort = "high";
		writeFileSync(`${path}.next`, JSON.stringify(second));
		renameSync(`${path}.next`, path);
		assert.equal(read().profiles.routine.primary.effort, "high");
		rmSync(path);
		assert.deepEqual(read(), delegateDefaults(), "deleted: back to defaults");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("effectiveEfforts: reported ∩ accepted; nothing usable reported means unconstrained, never empty", () => {
	assert.deepEqual(effectiveEfforts("claude-code", ["low", "high", "low"]), ["low", "high"]);
	assert.deepEqual(effectiveEfforts("claude-code", ["low", "new-effort"]), ["low"], "an effort the backend refuses is cut");
	for (const nothing of [undefined, [], ["new-effort"], ["off"]]) {
		assert.deepEqual(effectiveEfforts("claude-code", nothing), [...CLAUDE_EFFORTS], `claude ${JSON.stringify(nothing)}`);
	}
	assert.deepEqual(effectiveEfforts("pi", ["off"]), ["off"], "a non-reasoning pi model takes only off");
	assert.deepEqual(effectiveEfforts("pi", []), [...PI_EFFORTS]);
});

test("delegateKey identifies a routing", () => {
	const a = delegateDefaults();
	const b = delegateDefaults();
	assert.equal(delegateKey(a), delegateKey(b));
	b.profiles.complex.fallback = { backend: "claude-code", model: "sonnet", effort: "high" };
	assert.notEqual(delegateKey(a), delegateKey(b));
	const c = delegateDefaults();
	c.profiles.planning.primary.effort = "high";
	assert.notEqual(delegateKey(a), delegateKey(c));
});
