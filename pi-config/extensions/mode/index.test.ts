import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildMinorPrompt, isMinorMode, MINOR_DESCRIPTIONS, MINOR_MODES, normalizeMinorModes, parseMinorFlag } from "./minor.ts";
import { MODE_CATEGORY_ID, modeCategoryItems } from "./palette.ts";
import { pickPlanner } from "./planner.ts";
import { buildHeavyPrompt, composePrompt, HEAVY_ALIGN_BRIDGE, PLANNER_FALLBACK, PLANNER_PRIMARY, statusLabel } from "./prompt.ts";
import {
	activeOf,
	DEFAULT_ALIGN_VIEWER_SHORTCUT,
	DEFAULT_MODE_SHORTCUT,
	defaults,
	hasMinor,
	isMode,
	loadState,
	normalizeActive,
	normalizeState,
	parseShortcut,
	restoreActive,
	saveState,
	toggleMode,
	withMinor,
	type ModeActive,
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

test("viewerShortcut is kept when valid, dropped when invalid, and round-trips", () => {
	assert.equal(DEFAULT_ALIGN_VIEWER_SHORTCUT, "alt+a");
	assert.equal(normalizeState({ viewerShortcut: "alt+v" }).viewerShortcut, "alt+v");
	assert.equal(normalizeState({ viewerShortcut: "nope" }).viewerShortcut, undefined);
	assert.equal(normalizeState({}).viewerShortcut, undefined);
	const dir = tmp();
	try {
		const path = join(dir, "mode.json");
		saveState(path, { ...defaults(), viewerShortcut: "alt+v" });
		assert.equal(loadState(path).viewerShortcut, "alt+v");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
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
	assert.equal(both, `${buildHeavyPrompt(PLANNER_FALLBACK)}\n\n${HEAVY_ALIGN_BRIDGE}\n\n${buildMinorPrompt("align")}`);
	// The bridge only exists when both are on: heavy alone and align alone stay verbatim.
	assert.doesNotMatch(heavy ?? "", /align minor mode is on/);
	assert.doesNotMatch(alignOnly ?? "", /align minor mode is on/);
	assert.match(HEAVY_ALIGN_BRIDGE, /no implementation worker until the user has confirmed/);
	assert.doesNotMatch(both, /\{[A-Z_]+\}/);

	const align = buildMinorPrompt("align");
	assert.match(align, /planning worker/);
	assert.match(align, /Stop and wait/);
	assert.match(align, /Exempt/);
	assert.match(align, /do not re-ask/);
	// The block skeleton align.ts parses (headings verbatim, task-list questions, status words).
	assert.match(align, /^## Alignment: /m);
	assert.match(align, /^### Findings$/m);
	assert.match(align, /^### Approach$/m);
	assert.match(align, /^### Open questions$/m);
	assert.match(align, /^### Rejected$/m);
	assert.match(align, /^### Status$/m);
	assert.match(align, /1\. \[ \] /);
	assert.match(align, /`\[x\]`/);
	assert.match(align, /Status `confirmed`/);
	assert.match(align, /Status `implementing`/);
	assert.match(align, /go ahead while questions are still open/);
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

test("modeCategoryItems: radio major modes, live minor toggles", async () => {
	const state: ModeState = { ...defaults(), minorModes: [] };
	const calls: unknown[][] = [];
	const actions = {
		setMode: (next: string) => {
			calls.push(["mode", next]);
		},
		setMinor: (minor: string, on: boolean) => {
			calls.push(["minor", minor, on]);
		},
		openAlignViewer: () => {
			calls.push(["viewer"]);
		},
		saveDefault: () => {
			calls.push(["default"]);
		},
	};
	assert.equal(MODE_CATEGORY_ID, "mode");
	const rows = modeCategoryItems(() => state, actions);
	assert.deepEqual(
		rows.map((row) => row.id),
		["mode:normal", "mode:claude-heavy", ...MINOR_MODES.map((minor) => `mode:minor:${minor}`), "mode:align:view", "mode:default:save"],
		"two major rows, then one row per minor mode, then the align viewer, then save as default",
	);
	const defaultRow = rows.at(-1);
	assert.ok(defaultRow?.run && !defaultRow.toggle, "save-as-default runs, not toggles");
	await defaultRow.run();
	assert.deepEqual(calls.at(-1), ["default"], "the last row saves the default");
	const viewerRow = rows.at(-2);
	assert.ok(viewerRow?.run && !viewerRow.toggle, "viewer row runs, not toggle");
	await viewerRow.run();
	assert.deepEqual(calls.at(-1), ["viewer"]);
	calls.length = 0;
	assert.equal(rows[0].label, "✓ normal");
	assert.equal(rows[1].label, "  claude-heavy");
	assert.equal(rows[0].description, "Pi as usual");
	assert.ok(rows[0].run && rows[1].run && !rows[0].toggle, "major rows run, not toggle");

	const heavyRows = modeCategoryItems(() => ({ ...state, mode: "claude-heavy" }), actions);
	assert.equal(heavyRows[0].label, "  normal");
	assert.equal(heavyRows[1].label, "✓ claude-heavy");

	await rows[1].run?.();
	await rows[0].run?.();
	assert.deepEqual(calls, [["mode", "claude-heavy"], ["mode", "normal"]]);

	calls.length = 0;
	const align = rows.find((row) => row.id === "mode:minor:align");
	assert.ok(align?.toggle && !align.run && !align.children);
	assert.equal(align.label, "align");
	assert.equal(align.description, MINOR_DESCRIPTIONS.align);
	assert.equal(align.toggle.isOn(), false);
	align.toggle.toggle();
	assert.deepEqual(calls, [["minor", "align", true]], "toggle asks to turn it on");
	// isOn and toggle read live state through getState, not a snapshot.
	state.minorModes = ["align"];
	assert.equal(align.toggle.isOn(), true);
	align.toggle.toggle();
	assert.deepEqual(calls.at(-1), ["minor", "align", false]);
	state.minorModes = [];
	assert.equal(align.toggle.isOn(), false);
});

// ── Per-session active state ─────────────────────────────────────────────────

test("activeOf snapshots only the session-scoped triple, copying minorModes", () => {
	const state: ModeState = {
		version: 1,
		mode: "claude-heavy",
		strict: true,
		shortcut: "alt+h",
		minorModes: ["align"],
		minorShortcuts: { align: "alt+l" },
		viewerShortcut: "alt+v",
	};
	const active = activeOf(state);
	assert.deepEqual(active, { version: 1, mode: "claude-heavy", strict: true, minorModes: ["align"] });
	assert.notEqual(active.minorModes, state.minorModes, "minorModes is copied, never aliased");
	// A ModeActive is itself a valid input, so a restored snapshot can be re-snapshotted.
	assert.deepEqual(activeOf(active), active);
	assert.deepEqual(activeOf(defaults()), { version: 1, mode: "normal", strict: false, minorModes: [] });
});

test("normalizeActive round-trips a snapshot and rejects anything else without throwing", () => {
	const active: ModeActive = { version: 1, mode: "claude-heavy", strict: true, minorModes: ["align"] };
	assert.deepEqual(normalizeActive(JSON.parse(JSON.stringify(active))), active);
	// Defaults for the optional halves of the triple.
	assert.deepEqual(normalizeActive({ version: 1, mode: "normal" }), { version: 1, mode: "normal", strict: false, minorModes: [] });
	assert.deepEqual(normalizeActive({ version: 1, mode: "normal", strict: "yes", minorModes: "align" }), {
		version: 1,
		mode: "normal",
		strict: false,
		minorModes: [],
	});
	assert.deepEqual(normalizeActive({ version: 1, mode: "normal", minorModes: ["align", "bogus", "align"] }), {
		version: 1,
		mode: "normal",
		strict: false,
		minorModes: ["align"],
	});
	for (const bad of [
		undefined,
		null,
		0,
		"claude-heavy",
		[],
		{},
		{ mode: "normal" }, // missing version
		{ version: 2, mode: "normal" }, // a newer schema this build cannot read
		{ version: "1", mode: "normal" },
		{ version: 1 }, // missing mode
		{ version: 1, mode: "heavy" }, // unknown mode
	]) {
		assert.equal(normalizeActive(bad), undefined, `rejected: ${JSON.stringify(bad)}`);
	}
});

test("restoreActive takes the newest usable snapshot and skips everything else", () => {
	const older: ModeActive = { version: 1, mode: "normal", strict: false, minorModes: ["align"] };
	const newer: ModeActive = { version: 1, mode: "claude-heavy", strict: true, minorModes: [] };
	assert.equal(restoreActive([]), undefined, "an empty branch has no snapshot");
	assert.equal(restoreActive(undefined as never), undefined, "a missing branch never throws");
	assert.equal(
		restoreActive([
			{ type: "custom", customType: "align-doc", data: { version: 1, doc: null } },
			{ type: "message" },
			{ type: "custom", customType: "mode", data: { mode: "claude-heavy" } }, // legacy delta marker
			{ type: "custom", customType: "mode", data: { minor: "align", on: true } }, // legacy delta marker
		]),
		undefined,
		"legacy markers carry no session decision",
	);
	assert.deepEqual(
		restoreActive([
			{ type: "custom", customType: "mode", data: { minor: "align", on: true, active: older } },
			{ type: "custom", customType: "mode", data: { strict: true, active: newer } },
		]),
		newer,
		"the last entry with a snapshot wins",
	);
	assert.deepEqual(
		restoreActive([
			{ type: "custom", customType: "mode", data: { mode: "normal", active: older } },
			{ type: "custom", customType: "mode", data: { active: { version: 9, mode: "normal" } } }, // newer schema
			{ type: "custom", customType: "mode", data: { active: "claude-heavy" } }, // malformed
			{ type: "custom", customType: "mode", data: null },
			{ type: "custom", customType: "mode" },
			{ type: "custom", customType: "mode", data: [{ active: newer }] }, // array payload
			{ type: "mode", data: { active: newer } }, // not a custom entry
			{ type: "custom", customType: "mode-state", data: { active: newer } }, // another extension's type
		]),
		older,
		"unreadable newer entries fall through to the newest one this build understands",
	);
	// The snapshot is normalized on the way out, so a hand-edited transcript cannot poison the session.
	assert.deepEqual(restoreActive([{ type: "custom", customType: "mode", data: { active: { version: 1, mode: "normal", minorModes: ["bogus"] } } }]), {
		version: 1,
		mode: "normal",
		strict: false,
		minorModes: [],
	});
});

test("composePrompt takes a ModeActive, so the per-session state drives the turn", () => {
	const active: ModeActive = { version: 1, mode: "claude-heavy", strict: true, minorModes: ["align"] };
	const block = composePrompt(active, PLANNER_PRIMARY);
	assert.ok(block !== undefined);
	assert.ok(block.indexOf("# Mode: claude-heavy") < block.indexOf(HEAVY_ALIGN_BRIDGE), "heavy block, then the align bridge");
	assert.match(block, /# Minor mode: align/);
	assert.equal(composePrompt({ version: 1, mode: "normal", strict: true, minorModes: [] } satisfies ModeActive, PLANNER_PRIMARY), undefined);
});
