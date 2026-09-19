import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pickPlanner } from "./planner.ts";
import { buildHeavyPrompt, PLANNER_FALLBACK, PLANNER_PRIMARY, statusLabel } from "./prompt.ts";
import {
	DEFAULT_MODE_SHORTCUT,
	defaults,
	isMode,
	loadState,
	normalizeState,
	parseShortcut,
	saveState,
	toggleMode,
} from "./state.ts";

function tmp(): string {
	return mkdtempSync(join(tmpdir(), "mode-test-"));
}

test("loadState falls back to defaults when the file is missing or corrupt", () => {
	const dir = tmp();
	try {
		assert.deepEqual(loadState(join(dir, "mode.json")), defaults());
		const path = join(dir, "mode.json");
		writeFileSync(path, "{ not json");
		assert.deepEqual(loadState(path), defaults());
		writeFileSync(path, JSON.stringify(["claude-heavy"]));
		assert.deepEqual(loadState(path), defaults());
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("saveState/loadState round-trips and writes parseable JSON", () => {
	const dir = tmp();
	try {
		const path = join(dir, "mode.json");
		saveState(path, { version: 1, mode: "claude-heavy", strict: true, shortcut: "alt+h" });
		const onDisk = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(onDisk.mode, "claude-heavy");
		assert.deepEqual(loadState(path), { version: 1, mode: "claude-heavy", strict: true, shortcut: "alt+h" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("normalizeState drops invalid values instead of breaking load", () => {
	assert.deepEqual(normalizeState(null), defaults());
	assert.deepEqual(normalizeState({ mode: "weird", strict: "yes", shortcut: "ctrl shift m" }), defaults());
	assert.deepEqual(normalizeState({ mode: "claude-heavy", strict: true, extra: 1 }), {
		version: 1,
		mode: "claude-heavy",
		strict: true,
	});
});

test("mode helpers", () => {
	assert.ok(isMode("normal"));
	assert.ok(isMode("claude-heavy"));
	assert.ok(!isMode("build"));
	assert.equal(toggleMode("normal"), "claude-heavy");
	assert.equal(toggleMode("claude-heavy"), "normal");
	assert.equal(parseShortcut(DEFAULT_MODE_SHORTCUT), "alt+m");
	assert.equal(parseShortcut("ctrl+shift+p"), "ctrl+shift+p");
	assert.equal(parseShortcut("shift+tab"), "shift+tab");
	assert.equal(parseShortcut("f5"), undefined); // no modifier
	assert.equal(parseShortcut("ctrl+tab"), "ctrl+tab"); // expressible, needs terminal support
	assert.equal(parseShortcut("not-a-key"), undefined);
	assert.equal(parseShortcut(42), undefined);
});

test("pickPlanner uses fable when offered and opus high otherwise", () => {
	const fable = { id: "claude-fable-5-1[1m]", name: "Fable" };
	const opus = { id: "opus[1m]", name: "Opus" };
	assert.deepEqual(pickPlanner([fable, opus]), PLANNER_PRIMARY);
	assert.deepEqual(pickPlanner([opus]), PLANNER_FALLBACK);
	assert.deepEqual(pickPlanner([]), PLANNER_FALLBACK);
	assert.deepEqual(pickPlanner(undefined), PLANNER_FALLBACK);
});

test("heavy prompt wires the probed planner and leaves no placeholders", () => {
	const primary = buildHeavyPrompt(PLANNER_PRIMARY);
	assert.doesNotMatch(primary, /\{[A-Z_]+\}/);
	assert.match(primary, /model "claude-fable-5-1\[1m\]", effort "medium"/);
	assert.match(primary, /model "opus\[1m\]"/); // coding worker
	assert.doesNotMatch(primary, /unavailable in this session/);
	// House policy: workers bypass permissions; no Claude plan mode anywhere.
	assert.doesNotMatch(primary, /permissionMode/);
	assert.match(primary, /bypassed permissions/);
	assert.match(primary, /only voice to the user/);
	assert.match(primary, /effort "low".*effort "medium"/s);

	const fallback = buildHeavyPrompt(PLANNER_FALLBACK);
	assert.match(fallback, /model "opus\[1m\]", effort "high"/);
	assert.match(fallback, /planning already runs on opus\[1m\] at high/);
});

test("status labels", () => {
	assert.deepEqual(statusLabel("normal", PLANNER_PRIMARY, false), { text: "• normal", tone: "dim" });
	assert.deepEqual(statusLabel("claude-heavy", PLANNER_PRIMARY, false), { text: "◆ claude-heavy", tone: "accent" });
	assert.deepEqual(statusLabel("claude-heavy", PLANNER_FALLBACK, false), {
		text: "◆ claude-heavy · plan:opus",
		tone: "warning",
	});
	assert.deepEqual(statusLabel("claude-heavy", PLANNER_PRIMARY, true), { text: "◆ claude-heavy · strict", tone: "accent" });
});
