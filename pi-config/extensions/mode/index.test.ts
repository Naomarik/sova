import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildMinorPrompt, isMinorMode, MINOR_MODES, normalizeMinorModes, parseMinorFlag } from "./minor.ts";
import { pickPlanner } from "./planner.ts";
import { buildHeavyPrompt, composePrompt, PLANNER_FALLBACK, PLANNER_PRIMARY, statusLabel } from "./prompt.ts";
import {
	DEFAULT_MODE_SHORTCUT,
	defaults,
	hasMinor,
	isMode,
	loadState,
	normalizeState,
	parseShortcut,
	saveState,
	toggleMode,
	withMinor,
	type ModeState,
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
		const state: ModeState = {
			version: 1,
			mode: "claude-heavy",
			strict: true,
			shortcut: "alt+h",
			minorModes: ["align"],
			minorShortcuts: { align: "alt+a" },
		};
		saveState(path, state);
		const onDisk = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(onDisk.mode, "claude-heavy");
		assert.deepEqual(onDisk.minorModes, ["align"]);
		assert.deepEqual(loadState(path), state);
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
		minorModes: [],
	});
});

test("old-format files without minor modes load with an empty list", () => {
	const dir = tmp();
	try {
		const path = join(dir, "mode.json");
		writeFileSync(path, JSON.stringify({ version: 1, mode: "claude-heavy", strict: false }));
		assert.deepEqual(loadState(path), { version: 1, mode: "claude-heavy", strict: false, minorModes: [] });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("minor modes normalize to known names in canonical order", () => {
	assert.deepEqual(normalizeState({ minorModes: ["bogus"] }).minorModes, []);
	assert.deepEqual(normalizeState({ minorModes: "align" }).minorModes, []);
	assert.deepEqual(normalizeState({ minorModes: { align: true } }).minorModes, []);
	assert.deepEqual(normalizeState({ minorModes: ["bogus", "align", "align"] }).minorModes, ["align"]);
	assert.deepEqual(normalizeMinorModes([...MINOR_MODES].reverse().concat(MINOR_MODES)), [...MINOR_MODES]);
	assert.deepEqual(normalizeMinorModes(undefined), []);
	assert.ok(isMinorMode("align"));
	assert.ok(!isMinorMode("claude-heavy"));
	assert.ok(!isMinorMode(1));
});

test("minorShortcuts keep only valid KeyIds for known minor modes", () => {
	assert.deepEqual(normalizeState({ minorShortcuts: { align: "alt+a" } }).minorShortcuts, { align: "alt+a" });
	assert.equal(normalizeState({ minorShortcuts: { align: "not a key" } }).minorShortcuts, undefined);
	assert.equal(normalizeState({ minorShortcuts: { bogus: "alt+b" } }).minorShortcuts, undefined);
	assert.equal(normalizeState({ minorShortcuts: ["alt+a"] }).minorShortcuts, undefined);
});

test("withMinor is pure and idempotent", () => {
	const base = defaults();
	const on = withMinor(base, "align", true);
	assert.notEqual(on, base);
	assert.deepEqual(base.minorModes, [], "input not mutated");
	assert.ok(hasMinor(on, "align"));
	assert.ok(!hasMinor(base, "align"));
	const onAgain = withMinor(on, "align", true);
	assert.notEqual(onAgain, on);
	assert.deepEqual(onAgain.minorModes, ["align"]);
	assert.deepEqual(on.minorModes, ["align"], "input not mutated");
	const off = withMinor(on, "align", false);
	assert.deepEqual(off.minorModes, []);
	assert.deepEqual(on.minorModes, ["align"], "input not mutated");
	assert.deepEqual(withMinor(off, "align", false).minorModes, []);
});

test("parseMinorFlag", () => {
	assert.deepEqual(parseMinorFlag("align"), { minorModes: ["align"], unknown: [] });
	assert.deepEqual(parseMinorFlag(" align , align "), { minorModes: ["align"], unknown: [] });
	assert.deepEqual(parseMinorFlag("align,foo"), { minorModes: ["align"], unknown: ["foo"] });
	assert.deepEqual(parseMinorFlag("foo,bar,foo"), { minorModes: [], unknown: ["foo", "bar"] });
	assert.deepEqual(parseMinorFlag("none"), { minorModes: [], unknown: [] });
	assert.deepEqual(parseMinorFlag(""), { minorModes: [], unknown: [] });
	assert.equal(parseMinorFlag(undefined), undefined);
	assert.equal(parseMinorFlag(true), undefined);
});

test("minor mode names never collide with /mode keywords", () => {
	for (const minor of MINOR_MODES) {
		assert.ok(!["normal", "claude-heavy", "status", "strict"].includes(minor), minor);
		assert.match(minor, /^[a-z-]+$/, "must match the /mode minor-toggle pattern");
	}
});

test("composePrompt joins the heavy block and minor blocks", () => {
	const normal = defaults();
	assert.equal(composePrompt(normal, PLANNER_PRIMARY), undefined);

	const normalAlign = withMinor(normal, "align", true);
	const alignOnly = composePrompt(normalAlign, PLANNER_PRIMARY);
	assert.equal(alignOnly, buildMinorPrompt("align"));
	assert.match(alignOnly ?? "", /^# Minor mode: align/);
	assert.doesNotMatch(alignOnly ?? "", /# Mode: claude-heavy/);

	const heavy = composePrompt({ ...normal, mode: "claude-heavy" }, PLANNER_PRIMARY);
	assert.equal(heavy, buildHeavyPrompt(PLANNER_PRIMARY));

	const both = composePrompt({ ...normalAlign, mode: "claude-heavy" }, PLANNER_FALLBACK) ?? "";
	assert.match(both, /^# Mode: claude-heavy/);
	assert.ok(both.indexOf("# Mode: claude-heavy") < both.indexOf("# Minor mode: align"), "heavy before align");
	assert.equal(both, `${buildHeavyPrompt(PLANNER_FALLBACK)}\n\n${buildMinorPrompt("align")}`);
	assert.doesNotMatch(both, /\{[A-Z_]+\}/);

	const align = buildMinorPrompt("align");
	assert.match(align, /planning worker/);
	assert.match(align, /Stop and wait/);
	assert.match(align, /Exempt/);
	assert.match(align, /do not re-ask/);
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
	assert.deepEqual(statusLabel("normal", PLANNER_PRIMARY, false, []), { text: "normal", tone: "dim" });
	assert.deepEqual(statusLabel("claude-heavy", PLANNER_PRIMARY, false, []), { text: "claude-heavy", tone: "accent" });
	assert.deepEqual(statusLabel("claude-heavy", PLANNER_FALLBACK, false, []), {
		text: "claude-heavy · plan:opus",
		tone: "warning",
	});
	assert.deepEqual(statusLabel("claude-heavy", PLANNER_PRIMARY, true, []), { text: "claude-heavy · strict", tone: "accent" });
	assert.deepEqual(statusLabel("normal", PLANNER_PRIMARY, true, ["align"]), { text: "normal · align", tone: "accent" });
	assert.deepEqual(statusLabel("claude-heavy", PLANNER_PRIMARY, true, ["align"]), {
		text: "claude-heavy · strict · align",
		tone: "accent",
	});
	assert.deepEqual(statusLabel("claude-heavy", PLANNER_FALLBACK, true, ["align"]), {
		text: "claude-heavy · plan:opus · strict · align",
		tone: "warning",
	});
});
