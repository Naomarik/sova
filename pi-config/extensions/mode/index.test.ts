import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildMinorPrompt, isMinorMode, MINOR_DESCRIPTIONS, MINOR_MODES, normalizeMinorModes, parseMinorFlag } from "./minor.ts";
import { MODE_CATEGORY_ID, modeCategoryItems } from "./palette.ts";
import { delegateDefaults, type DelegateSettings } from "./delegate.ts";
import {
	applyModeSection,
	buildDelegatePrompt,
	composePrompt,
	DEFAULT_ROUTES,
	DELEGATE_ALIGN_BRIDGE,
	MODE_SECTION,
	statusLabel,
} from "./prompt.ts";
import { routeAll, type Discovery } from "./routing.ts";
import {
	activeOf,
	DEFAULT_ALIGN_VIEWER_SHORTCUT,
	DEFAULT_MODE_SHORTCUT,
	defaults,
	hasMinor,
	isMode,
	LEGACY_MODE_ALIASES,
	loadState,
	MODE_DESCRIPTIONS,
	MODES,
	normalizeActive,
	normalizeState,
	parseMode,
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
		writeFileSync(path, JSON.stringify(["delegate"]));
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
			mode: "delegate",
			strict: true,
			shortcut: "alt+h",
			minorModes: ["align"],
			minorShortcuts: { align: "alt+a" },
		};
		saveState(path, state);
		const onDisk = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(onDisk.mode, "delegate");
		assert.deepEqual(onDisk.minorModes, ["align"]);
		assert.deepEqual(loadState(path), state);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("normalizeState drops invalid values instead of breaking load", () => {
	assert.deepEqual(normalizeState(null), defaults());
	assert.deepEqual(normalizeState({ mode: "weird", strict: "yes", shortcut: "ctrl shift m" }), defaults());
	assert.deepEqual(normalizeState({ mode: "delegate", strict: true, extra: 1 }), {
		version: 1,
		mode: "delegate",
		strict: true,
		minorModes: [],
	});
});

test("old-format files without minor modes load with an empty list", () => {
	const dir = tmp();
	try {
		const path = join(dir, "mode.json");
		writeFileSync(path, JSON.stringify({ version: 1, mode: "delegate", strict: false }));
		assert.deepEqual(loadState(path), { version: 1, mode: "delegate", strict: false, minorModes: [] });
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
	assert.ok(!isMinorMode("delegate"));
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
		assert.ok(![...MODES, ...Object.keys(LEGACY_MODE_ALIASES), "status", "strict", "default"].includes(minor), minor);
		assert.match(minor, /^[a-z-]+$/, "must match the /mode minor-toggle pattern");
	}
});

test("applyModeSection sets, overwrites and deletes the mode section", () => {
	assert.equal(MODE_SECTION, "mode");

	// Set: the section appears next to whatever the host already built.
	const sections: Record<string, string> = { preamble: "base" };
	applyModeSection(sections, "block one");
	assert.deepEqual(sections, { preamble: "base", mode: "block one" });

	// Overwrite: a toggle replaces the section in place, so pi diffs one section.
	applyModeSection(sections, "block two");
	assert.deepEqual(sections, { preamble: "base", mode: "block two" });

	// Delete: back to normal, the key is gone (pi sends null and drops the section).
	applyModeSection(sections, undefined);
	assert.deepEqual(sections, { preamble: "base" });
	assert.ok(!(MODE_SECTION in sections), "the key is removed, not left empty");

	// Deleting when nothing is set is a no-op, and never touches other sections.
	applyModeSection(sections, undefined);
	assert.deepEqual(sections, { preamble: "base" });
});

/** Claude discovery offering fable and opus at every effort: every default profile routes to its primary. */
const offering = (...ids: string[]): Discovery => ({ models: ids.map((id) => ({ id, efforts: ["low", "medium", "high", "xhigh", "max"] })) });
const ALL_OK = routeAll(delegateDefaults(), { "claude-code": offering("claude-fable-5-1[1m]", "opus[1m]") }, () => null);
const PLAN_FALLBACK = routeAll(delegateDefaults(), { "claude-code": offering("opus[1m]") }, () => null);

test("composePrompt joins the delegate block and minor blocks", () => {
	const normal = defaults();
	assert.equal(composePrompt(normal, ALL_OK), undefined);

	const normalAlign = withMinor(normal, "align", true);
	const alignOnly = composePrompt(normalAlign, ALL_OK);
	assert.equal(alignOnly, buildMinorPrompt("align"));
	assert.match(alignOnly ?? "", /^# Minor mode: align/);
	assert.doesNotMatch(alignOnly ?? "", /# Mode: delegate/);

	const delegate = composePrompt({ ...normal, mode: "delegate" }, ALL_OK);
	assert.equal(delegate, buildDelegatePrompt(ALL_OK));

	const both = composePrompt({ ...normalAlign, mode: "delegate" }, PLAN_FALLBACK) ?? "";
	assert.match(both, /^# Mode: delegate/);
	assert.ok(both.indexOf("# Mode: delegate") < both.indexOf("# Minor mode: align"), "delegate before align");
	assert.equal(both, `${buildDelegatePrompt(PLAN_FALLBACK)}\n\n${DELEGATE_ALIGN_BRIDGE}\n\n${buildMinorPrompt("align")}`);
	// The bridge only exists when both are on: delegate alone and align alone stay verbatim.
	assert.doesNotMatch(delegate ?? "", /align minor mode is on/);
	assert.doesNotMatch(alignOnly ?? "", /align minor mode is on/);
	assert.match(DELEGATE_ALIGN_BRIDGE, /no implementation worker until the user has confirmed/);
	// Align stays orthogonal: its pre-confirmation investigation is Planning, never the cheap Investigation profile.
	assert.match(DELEGATE_ALIGN_BRIDGE, /non-editing Planning & specs worker/);
	assert.match(DELEGATE_ALIGN_BRIDGE, /never the Investigation profile/);
	assert.doesNotMatch(both, /\{[A-Z_]+\}/);

	const align = buildMinorPrompt("align");
	assert.match(align, /non-editing Planning & specs worker/);
	assert.match(align, /not the Investigation profile/);
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
	// Questions carry their number inside the checkbox label; a list-number marker would be lost by the viewer.
	assert.match(align, /^- \[ \] \*\*1\. /m);
	assert.doesNotMatch(align.split("### Open questions")[1]?.split("### Rejected")[0] ?? "", /^\d+\. \[[ xX]\]/m);
	assert.match(align, /`\[x\]`/);
	assert.match(align, /Status `confirmed`/);
	assert.match(align, /Status `implementing`/);
	assert.match(align, /go ahead while questions are still open/);
});

test("mode helpers", () => {
	assert.ok(isMode("normal"));
	assert.ok(isMode("delegate"));
	assert.ok(!isMode("claude-heavy"), "the legacy name is read by parseMode, never a mode itself");
	assert.ok(!isMode("build"));
	assert.deepEqual(MODES, ["normal", "delegate"]);
	assert.deepEqual(Object.keys(MODE_DESCRIPTIONS), [...MODES], "one description per canonical mode, nothing else");
	assert.equal(toggleMode("normal"), "delegate");
	assert.equal(toggleMode("delegate"), "normal");
	assert.equal(parseShortcut(DEFAULT_MODE_SHORTCUT), "alt+m");
	assert.equal(parseShortcut("ctrl+shift+p"), "ctrl+shift+p");
	assert.equal(parseShortcut("shift+tab"), "shift+tab");
	assert.equal(parseShortcut("f5"), undefined); // no modifier
	assert.equal(parseShortcut("ctrl+tab"), "ctrl+tab"); // expressible, needs terminal support
	assert.equal(parseShortcut("not-a-key"), undefined);
	assert.equal(parseShortcut(42), undefined);
});

test("parseMode reads canonical names and the permanent legacy alias, nothing else", () => {
	assert.equal(parseMode("normal"), "normal");
	assert.equal(parseMode("delegate"), "delegate");
	assert.equal(parseMode("claude-heavy"), "delegate");
	for (const bad of ["Claude-Heavy", "heavy", "", " delegate", "toString", "__proto__", "constructor", undefined, null, 1, {}, ["delegate"]]) {
		assert.equal(parseMode(bad), undefined, `rejected: ${JSON.stringify(bad)}`);
	}
	for (const target of Object.values(LEGACY_MODE_ALIASES)) assert.ok(isMode(target), "every alias maps to a canonical mode");
});

test("legacy claude-heavy migrates through every state.ts parser and is written back canonical", () => {
	// mode.json (the default for new sessions)
	assert.equal(normalizeState({ version: 1, mode: "claude-heavy", strict: true }).mode, "delegate");
	const dir = tmp();
	try {
		const path = join(dir, "mode.json");
		writeFileSync(path, JSON.stringify({ version: 1, mode: "claude-heavy", strict: false, minorModes: ["align"] }));
		const loaded = loadState(path);
		assert.equal(loaded.mode, "delegate");
		saveState(path, loaded);
		assert.equal(JSON.parse(readFileSync(path, "utf8")).mode, "delegate", "the next write is canonical");
		assert.doesNotMatch(readFileSync(path, "utf8"), /claude-heavy/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	// a session's own snapshot
	assert.deepEqual(normalizeActive({ version: 1, mode: "claude-heavy", strict: true, minorModes: ["align"] }), {
		version: 1,
		mode: "delegate",
		strict: true,
		minorModes: ["align"],
	});
	assert.deepEqual(
		restoreActive([{ type: "custom", customType: "mode", data: { mode: "claude-heavy", active: { version: 1, mode: "claude-heavy", strict: false, minorModes: [] } } }]),
		{ version: 1, mode: "delegate", strict: false, minorModes: [] },
		"a transcript pinned before the rename restores into delegate",
	);
});

test("delegate prompt names every profile's exact worker and leaves no placeholders", () => {
	const prompt = buildDelegatePrompt(ALL_OK);
	assert.doesNotMatch(prompt, /\{[A-Z_]+\}/);
	assert.match(prompt, /^# Mode: delegate/);
	assert.match(prompt, /- Planning & specs \(.*\) → backend "claude-code", model "claude-fable-5-1\[1m\]", effort "medium"; fallback backend "claude-code", model "opus\[1m\]", effort "high"\./);
	assert.match(prompt, /- Investigation \(.*\) → backend "claude-code", model "opus\[1m\]", effort "low"; no fallback — if it fails, ask the user\./);
	assert.match(prompt, /- Routine implementation \(.*\) → backend "claude-code", model "opus\[1m\]", effort "low"; no fallback — if it fails, ask the user\./);
	assert.match(prompt, /- Complex implementation \(.*\) → backend "claude-code", model "opus\[1m\]", effort "medium"; no fallback — if it fails, ask the user\./);
	assert.ok(prompt.indexOf("Planning & specs") < prompt.indexOf("- Investigation") && prompt.indexOf("- Investigation") < prompt.indexOf("- Routine") && prompt.indexOf("- Routine") < prompt.indexOf("- Complex"), "canonical order");
	// Mandatory verification, the only voice, no invented permission modes.
	assert.match(prompt, /only voice to the user/);
	assert.match(prompt, /read the diffs, run the project's tests or type checks/);
	assert.match(prompt, /never how hard you check/);
	assert.doesNotMatch(prompt, /permissionMode|plan mode|--permission/i);
	assert.match(prompt, /usual permissions, so that rule is prompt-level/);
	// Routing rules the approved design fixed.
	assert.match(prompt, /investigation that feeds a design or plan is Planning & specs, not Investigation/);
	assert.match(prompt, /unsure between Routine and Complex, choose Complex/);
	assert.match(prompt, /never substitute one of your own/);
	assert.match(prompt, /When the user names a backend, model or effort for a task, that choice wins over the profile/);
	assert.match(prompt, /a spawn they refuse is reported to the user, not rerouted/);
});

test("delegate prompt discloses a fallback and asks when a profile has no worker", () => {
	const fallback = buildDelegatePrompt(PLAN_FALLBACK);
	assert.match(fallback, /- Planning & specs .* → backend "claude-code", model "opus\[1m\]", effort "high"\. This is the configured FALLBACK: the primary \(backend "claude-code", model "claude-fable-5-1\[1m\]", effort "medium"\) is unavailable — claude-fable-5-1\[1m\] is not offered by claude-code\. Tell the user/);
	assert.match(fallback, /do not retry the primary unless asked/);

	const none = routeAll(delegateDefaults(), { "claude-code": offering("sonnet") }, () => null);
	const prompt = buildDelegatePrompt(none);
	assert.match(prompt, /- Routine implementation .* → NO AVAILABLE WORKER \(opus\[1m\] is not offered by claude-code; no fallback is set\)\. Before delegating this kind of work, tell the user and ask which model to use; do not choose one yourself\./);
	assert.match(prompt, /- Planning & specs .* → NO AVAILABLE WORKER \(claude-fable-5-1\[1m\] is not offered by claude-code; opus\[1m\] is not offered by claude-code\)/);
	assert.doesNotMatch(prompt, /model "sonnet"/, "an offered but unconfigured model is never named");
});

test("a configured fallback that can't run is never offered for the retry", () => {
	// Fable offered, opus not: planning runs on its primary, and its fallback is known dead.
	const deadFallback = routeAll(delegateDefaults(), { "claude-code": offering("claude-fable-5-1[1m]") }, () => null);
	const prompt = buildDelegatePrompt(deadFallback);
	const planning = prompt.split("\n").find((line) => line.startsWith("- Planning & specs"))!;
	assert.match(planning, /→ backend "claude-code", model "claude-fable-5-1\[1m\]", effort "medium"; its configured fallback \(backend "claude-code", model "opus\[1m\]", effort "high"\) can't run — opus\[1m\] is not offered by claude-code — so if the primary fails, ask the user\./);
	assert.doesNotMatch(planning, /; fallback backend/);
	// Denied and effort-unsupported fallbacks are withheld the same way, with their own reasons.
	const denied = buildDelegatePrompt(routeAll(delegateDefaults(), { "claude-code": offering("claude-fable-5-1[1m]", "opus[1m]") }, (c) => (c.model === "opus[1m]" ? "opus[1m] is disabled as a subagent model by user settings." : null)));
	assert.match(denied, /its configured fallback .* can't run — opus\[1m\] is disabled as a subagent model/);
	const effort = buildDelegatePrompt(routeAll(delegateDefaults(), { "claude-code": { models: [{ id: "claude-fable-5-1[1m]" }, { id: "opus[1m]", efforts: ["low"] }] } }, () => null));
	assert.match(effort, /its configured fallback .* can't run — opus\[1m\] does not support effort "high"/);
	// An unverified fallback (discovery failed) is still offered: failure to discover is not absence.
	const unverified = buildDelegatePrompt(routeAll(delegateDefaults(), { "claude-code": { error: "timeout" } }, () => null));
	assert.match(unverified, /- Planning & specs .*; fallback backend "claude-code", model "opus\[1m\]", effort "high"\./);
	assert.match(prompt, /retry once with that profile's fallback only if one is listed above as its fallback/);
});

test("DEFAULT_ROUTES: every default profile on its primary, unverified until probed", () => {
	assert.deepEqual(DEFAULT_ROUTES.map((r) => [r.profile, r.via, r.primary.availability]), [
		["planning", "primary", "unverified"],
		["investigation", "primary", "unverified"],
		["routine", "primary", "unverified"],
		["complex", "primary", "unverified"],
	]);
});

test("status labels", () => {
	const settings: DelegateSettings = delegateDefaults();
	const askRoutine = routeAll(
		{ ...settings, profiles: { ...settings.profiles, routine: { primary: { backend: "claude-code", model: "gone", effort: "low" }, fallback: null } } },
		{ "claude-code": offering("claude-fable-5-1[1m]", "opus[1m]") },
		() => null,
	);
	assert.deepEqual(statusLabel("normal", ALL_OK, false, []), { text: "normal", tone: "dim" });
	assert.deepEqual(statusLabel("normal", PLAN_FALLBACK, false, []), { text: "normal", tone: "dim" }, "routing never shows outside delegate");
	assert.deepEqual(statusLabel("delegate", ALL_OK, false, []), { text: "delegate", tone: "accent" });
	assert.deepEqual(statusLabel("delegate", DEFAULT_ROUTES, false, []), { text: "delegate", tone: "accent" }, "unverified is not degraded");
	assert.deepEqual(statusLabel("delegate", PLAN_FALLBACK, false, []), { text: "delegate · fallback:plan", tone: "warning" });
	assert.deepEqual(statusLabel("delegate", askRoutine, false, []), { text: "delegate · ask:routine", tone: "warning" });
	assert.deepEqual(statusLabel("delegate", ALL_OK, true, []), { text: "delegate · strict", tone: "accent" });
	assert.deepEqual(statusLabel("normal", ALL_OK, true, ["align"]), { text: "normal · align", tone: "accent" });
	assert.deepEqual(statusLabel("delegate", ALL_OK, true, ["align"]), { text: "delegate · strict · align", tone: "accent" });
	assert.deepEqual(statusLabel("delegate", PLAN_FALLBACK, true, ["align"]), { text: "delegate · fallback:plan · strict · align", tone: "warning" });
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
		["mode:normal", "mode:delegate", ...MINOR_MODES.map((minor) => `mode:minor:${minor}`), "mode:align:view", "mode:default:save"],
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
	assert.equal(rows[1].label, "  delegate");
	assert.equal(rows[0].description, "Pi as usual");
	assert.ok(rows[0].run && rows[1].run && !rows[0].toggle, "major rows run, not toggle");

	const heavyRows = modeCategoryItems(() => ({ ...state, mode: "delegate" }), actions);
	assert.equal(heavyRows[0].label, "  normal");
	assert.equal(heavyRows[1].label, "✓ delegate");

	await rows[1].run?.();
	await rows[0].run?.();
	assert.deepEqual(calls, [["mode", "delegate"], ["mode", "normal"]]);

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
		mode: "delegate",
		strict: true,
		shortcut: "alt+h",
		minorModes: ["align"],
		minorShortcuts: { align: "alt+l" },
		viewerShortcut: "alt+v",
	};
	const active = activeOf(state);
	assert.deepEqual(active, { version: 1, mode: "delegate", strict: true, minorModes: ["align"] });
	assert.notEqual(active.minorModes, state.minorModes, "minorModes is copied, never aliased");
	// A ModeActive is itself a valid input, so a restored snapshot can be re-snapshotted.
	assert.deepEqual(activeOf(active), active);
	assert.deepEqual(activeOf(defaults()), { version: 1, mode: "normal", strict: false, minorModes: [] });
});

test("normalizeActive round-trips a snapshot and rejects anything else without throwing", () => {
	const active: ModeActive = { version: 1, mode: "delegate", strict: true, minorModes: ["align"] };
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
		"delegate",
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
	const newer: ModeActive = { version: 1, mode: "delegate", strict: true, minorModes: [] };
	assert.equal(restoreActive([]), undefined, "an empty branch has no snapshot");
	assert.equal(restoreActive(undefined as never), undefined, "a missing branch never throws");
	assert.equal(
		restoreActive([
			{ type: "custom", customType: "align-doc", data: { version: 1, doc: null } },
			{ type: "message" },
			{ type: "custom", customType: "mode", data: { mode: "delegate" } }, // legacy delta marker
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
			{ type: "custom", customType: "mode", data: { active: "delegate" } }, // malformed
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
	const active: ModeActive = { version: 1, mode: "delegate", strict: true, minorModes: ["align"] };
	const block = composePrompt(active, ALL_OK);
	assert.ok(block !== undefined);
	assert.ok(block.indexOf("# Mode: delegate") < block.indexOf(DELEGATE_ALIGN_BRIDGE), "delegate block, then the align bridge");
	assert.match(block, /# Minor mode: align/);
	assert.equal(composePrompt({ version: 1, mode: "normal", strict: true, minorModes: [] } satisfies ModeActive, ALL_OK), undefined);
});
