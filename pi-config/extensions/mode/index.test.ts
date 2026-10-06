import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { ALIGN_INSTRUCTIONS, buildMinorPrompt, CODEMODE_TOOL, isMinorMode, MINOR_DESCRIPTIONS, MINOR_MODES, MINOR_PROMPTLESS, MINOR_WORKER, type MinorMode, normalizeMinorModes, parseMinorFlag, promptedMinorModes, SCRIPT_ONLY_EXPOSURES, SPEC_CORE_SHELL, SPEC_INSTRUCTIONS, stripVisComments, VIS_FILES, VIS_INSTRUCTIONS, VIS_KIND_FILES, VIS_KINDS, visGuide, visOverview, workerMinorModes } from "./minor.ts";
import { parseModeWorkerEvent } from "./events.ts";
import { MODE_CATEGORY_ID, modeCategoryItems } from "./palette.ts";
import { ALIGN_FILE_SCHEMA, ALIGN_NUDGE_TEXT, ALIGN_OPS } from "./align.ts";
import { delegateDefaults, type DelegateSettings } from "./delegate.ts";
import {
	applyModeSection,
	buildDelegatePrompt,
	buildModeNote,
	buildSpecWriterPrompt,
	composePrompt,
	composeWorkerPrompt,
	DEFAULT_ROUTES,
	DELEGATE_ALIGN_BRIDGE,
	MODE_SECTION,
	SPEC_WORKER_NOTE,
	statusLabel,
} from "./prompt.ts";
import { routeAll, routeWriter, type Discovery } from "./routing.ts";
import { specDefaults, type SpecSettings } from "./spec.ts";
import { ALSO_CHANGES_OVERRIDE as SPEC_CHECK_OVERRIDE, DIGEST_TAG } from "./spec-guard.ts";
import {
	activeOf,
	DEFAULT_ALIGN_VIEWER_SHORTCUT,
	DEFAULT_MODE_SHORTCUT,
	defaults,
	hasMinor,
	isMode,
	loadState,
	MODE_DESCRIPTIONS,
	MODE_NOTE_TYPE,
	MODES,
	normalizeActive,
	normalizeState,
	parseMode,
	parseShortcut,
	restoreActive,
	restoreHead,
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
		assert.ok(![...MODES, "status", "strict", "default"].includes(minor), minor);
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
/** Fable listed at low only: planning's primary can't run at medium, so its fallback. (An alias the CLI's varying list omits is unverified, not unavailable.) */
const fableLowOnly = { id: "claude-fable-5-1[1m]", efforts: ["low"] };
const PLAN_FALLBACK = routeAll(delegateDefaults(), { "claude-code": { models: [fableLowOnly, { id: "opus[1m]", efforts: ["low", "medium", "high", "xhigh", "max"] }] } }, () => null);

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
	assert.match(align, /never re-ask a settled question/);
	// Every alignment goes through the tool, never prose; answers and lifecycle through ops.
	assert.match(align, /record every alignment with the `align` tool/);
	assert.match(align, /Never write an alignment as reply text/);
	assert.match(align, /import it with the import op and that absolute path/);
	assert.match(align, /decide \(in their words\), accept only the questions they told you to take your recommendation on/);
	assert.match(align, /leave the rest open/);
	assert.match(align, /Never set status implementing while a question is open/);
	assert.match(align, /set status implementing before you build/);
	assert.match(align, /status done when the work is finished/);
	assert.match(align, /align exempt and a reason/);
	assert.match(align, /Several alignments can be open at once/);
	// No markdown template survives: the parser that read it is gone.
	assert.doesNotMatch(align, /^#{2,3} (Alignment|Findings|Open questions|Status)/m);
	assert.doesNotMatch(align, /\[ \]/);
	// The bridge hands the planning worker's result over as a file, in the tool's schema.
	assert.match(DELEGATE_ALIGN_BRIDGE, /Workers have no align tool/);
	assert.match(DELEGATE_ALIGN_BRIDGE, /align \{op: "import", path: that same absolute path\}/);
	// No text the model reads names an op shape the tool no longer takes, and every op it names is one.
	for (const text of [align, DELEGATE_ALIGN_BRIDGE, ALIGN_NUDGE_TEXT]) {
		assert.doesNotMatch(text, /fromFile|create \+|\bdrop \{|\{why\}|exempt with why|accept \{q|q: "open"/);
		for (const op of text.match(/\b(?:accept|drop|edit)_[a-z]+\b/g) ?? []) assert.ok((ALIGN_OPS as readonly string[]).includes(op), op);
	}
	// The planner's one write is named, absolute and outside the repo, and the delegate block's
	// no-edit rule names that same exception, so the two never contradict each other.
	assert.match(DELEGATE_ALIGN_BRIDGE, /one permitted write is the alignment JSON/);
	assert.match(DELEGATE_ALIGN_BRIDGE, /absolute path outside the repository that you name in its prompt/);
	assert.match(buildDelegatePrompt([]), /must not edit files[^\n]*The one exception is a planning worker's alignment JSON \(align on\), written outside the repository\./);
	assert.match(align, /absolute path outside the repository/);
	assert.ok(DELEGATE_ALIGN_BRIDGE.includes(ALIGN_FILE_SCHEMA), "the bridge quotes the one file schema");
	assert.match(DELEGATE_ALIGN_BRIDGE, /status is implementing/);
});

test("vis: vis/overview.md minus its owner comments and stub kinds' lines, composed last", () => {
	const vis = buildMinorPrompt("vis");
	assert.equal(vis, VIS_INSTRUCTIONS);
	assert.match(vis, /^# Minor mode: vis\n/);
	assert.doesNotMatch(vis, /<!--|owner:/, "owner notes never reach the model");
	assert.equal(vis, visOverview(readFileSync(new URL("./vis/overview.md", import.meta.url), "utf8")), "the overview file, nothing more");
	// The kind list only: no kind's grammar or example is in the prompt; vis_guide carries it.
	assert.doesNotMatch(vis, /```vis /);
	assert.match(vis, /call `vis_guide` with that kind/);
	assert.deepEqual([...vis.matchAll(/^- ([a-z /]+): /gm)].flatMap((m) => m[1]!.split(" / ")), [...VIS_KINDS]);
	// A stub kind is never taught: whichever kind files carry the marker.
	for (const [word, file] of Object.entries(VIS_KIND_FILES)) assert.equal(VIS_KINDS.includes(word), !VIS_FILES[file]!.includes("<!-- stub -->"), word);
	const taught = (w: string) => w !== "x";
	assert.equal(visOverview("<!-- note -->\n# A\n\n- x: hidden\n- y: shown\n- x / y: hidden too\n- y / z: shown too\n", taught), "# A\n\n- y: shown\n- y / z: shown too");
	assert.equal(composePrompt(withMinor(withMinor(defaults(), "vis", true), "align", true), ALL_OK), `${buildMinorPrompt("align")}\n\n${vis}`);
});

test("vis_guide: the shared rules then the kind's file, for the listed kinds only", () => {
	const shared = readFileSync(new URL("./vis/shared.md", import.meta.url), "utf8");
	const wireframe = readFileSync(new URL("./vis/wireframe.md", import.meta.url), "utf8");
	assert.equal(visGuide("wireframe"), `${stripVisComments(shared)}\n\n${stripVisComments(wireframe)}`);
	assert.match(visGuide("wireframe"), /^# vis: rules for every kind\n/);
	assert.doesNotMatch(visGuide("flow"), /<!--/);
	assert.equal(visGuide("html"), visGuide("svg"));
	assert.equal(VIS_KIND_FILES.html, "html-svg");
	for (const bad of ["mermaid", "overview", "shared", "html-svg", ""]) assert.throws(() => visGuide(bad), /No vis kind/);
});

test("spec: a registered minor mode, composed after align and never bridged", () => {
	assert.deepEqual(MINOR_MODES, ["align", "spec", "vis", "codemode"], "registry order is prompt and status order");
	assert.deepEqual(Object.keys(MINOR_DESCRIPTIONS), [...MINOR_MODES], "one description per minor mode, nothing else");
	assert.deepEqual(parseMinorFlag("spec,align"), { minorModes: ["align", "spec"], unknown: [] });
	const spec = buildMinorPrompt("spec");
	const align = buildMinorPrompt("align");
	assert.match(spec, /^# Minor mode: spec\n/);

	const both = withMinor(withMinor(defaults(), "spec", true), "align", true);
	assert.equal(composePrompt(both, ALL_OK), `${align}\n\n${spec}`, "each block verbatim, align first whatever the toggle order");
	assert.equal(composePrompt(withMinor(defaults(), "spec", true), ALL_OK), spec);
	// Only align bridges into delegate; spec rides after the delegate block unchanged.
	assert.equal(composePrompt({ ...defaults(), mode: "delegate", minorModes: ["spec"] }, ALL_OK), `${buildDelegatePrompt(ALL_OK)}\n\n${spec}`);
	assert.equal(
		composePrompt({ ...defaults(), mode: "delegate", minorModes: ["align", "spec"] }, ALL_OK),
		`${buildDelegatePrompt(ALL_OK)}\n\n${DELEGATE_ALIGN_BRIDGE}\n\n${align}\n\n${spec}`,
	);
	assert.doesNotMatch(spec, /\balign\b/, "spec composes with align without naming it");
	assert.deepEqual(statusLabel("normal", ALL_OK, false, ["align", "spec"]), { text: "normal · align · spec", tone: "accent" });
	// Off means absent; on means exactly once, alone or composed.
	const heading = /^# Minor mode: spec$/gm;
	for (const state of [defaults(), withMinor(defaults(), "align", true), { ...defaults(), mode: "delegate" as const }])
		assert.equal((composePrompt(state, ALL_OK) ?? "").match(heading), null, "spec off: no block");
	for (const state of [withMinor(defaults(), "spec", true), both, { ...defaults(), mode: "delegate" as const, minorModes: ["align", "spec"] as MinorMode[] }])
		assert.equal((composePrompt(state, ALL_OK) ?? "").match(heading)?.length, 1, "spec on: one block");
});

test("spec: the prompt is spec-mode.md, byte for byte", () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const canonical = readFileSync(join(here, "spec-mode.md"), "utf8");
	assert.equal(buildMinorPrompt("spec"), canonical.trimEnd(), "the only normalization is trimEnd");
	assert.ok(canonical.endsWith("\n") && !canonical.endsWith("\n\n"), "the file ends in exactly one newline");
	// The shell prefix is the file's one ```sh block, and appears nowhere else.
	assert.equal(canonical.match(/^```sh$/gm)?.length, 1);
	assert.ok(canonical.includes(`\`\`\`sh\n${SPEC_CORE_SHELL}\n\`\`\``));
	assert.equal(canonical.split(SPEC_CORE_SHELL).length, 2, "one occurrence");
});

test("spec: minor.ts reads its own spec-mode.md, from any cwd, and refuses a malformed one", () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const canonical = readFileSync(join(here, "spec-mode.md"), "utf8");
	// A standalone copy of just these files (minor.ts and the prompt texts it reads), imported from an unrelated cwd.
	const load = (md: string) => {
		const dir = mkdtempSync(join(tmpdir(), "spec-mode-"));
		try {
			writeFileSync(join(dir, "minor.ts"), readFileSync(join(here, "minor.ts")));
			writeFileSync(join(dir, "spec-mode.md"), md);
			cpSync(join(here, "vis"), join(dir, "vis"), { recursive: true });
			const src = `import(${JSON.stringify(pathToFileURL(join(dir, "minor.ts")).href)}).then((m) => process.stdout.write(JSON.stringify([m.buildMinorPrompt("spec"), m.SPEC_CORE_SHELL])))`;
			return spawnSync(process.execPath, ["--input-type=module", "-e", src], { cwd: tmpdir(), encoding: "utf8" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
	const ok = load(canonical);
	assert.equal(ok.status, 0, ok.stderr);
	assert.deepEqual(JSON.parse(ok.stdout), [canonical.trimEnd(), SPEC_CORE_SHELL]);
	const edited = load(canonical.replace("Trusted tools:", "Edited tools:"));
	assert.equal(edited.status, 0, edited.stderr);
	assert.match(JSON.parse(edited.stdout)[0], /^Edited tools:/m, "the text comes from the file, not a copy");
	const fence = `\`\`\`sh\n${SPEC_CORE_SHELL}\n\`\`\``;
	for (const [what, md] of [
		["no block", canonical.replace(fence, SPEC_CORE_SHELL)],
		["two blocks", canonical.replace(fence, `${fence}\n\n${fence}`)],
		["prefix repeated in prose", `${canonical}\n${SPEC_CORE_SHELL}\n`],
	]) {
		const bad = load(md);
		assert.notEqual(bad.status, 0, `${what}: loading fails`);
		assert.match(bad.stderr, /spec-mode\.md: /, `${what}: says why`);
	}
});

test("spec: the shell prefix resolves the agent dir the way pi does", () => {
	const resolve = (env: Record<string, string>) =>
		spawnSync("bash", ["-c", `${SPEC_CORE_SHELL}; printf %s "$core"`], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: "/h", ...env } }).stdout;
	assert.equal(resolve({}), "/h/.pi/agent/extensions/spec/core");
	assert.equal(resolve({ PI_CODING_AGENT_DIR: "" }), "/h/.pi/agent/extensions/spec/core", "empty is unset, as in getAgentDir");
	assert.equal(resolve({ PI_CODING_AGENT_DIR: "/abs/agent" }), "/abs/agent/extensions/spec/core");
	assert.equal(resolve({ PI_CODING_AGENT_DIR: "~/agent" }), "/h/agent/extensions/spec/core", "a leading ~ is home, as pi expands it");
	assert.equal(resolve({ PI_CODING_AGENT_DIR: "~" }), "/h/extensions/spec/core");
	assert.equal(resolve({ PI_CODING_AGENT_DIR: "/a/~b" }), "/a/~b/extensions/spec/core", "only a leading ~ expands");
	assert.equal(resolve({ PI_CODING_AGENT_DIR: "~other/agent" }), "~other/agent/extensions/spec/core", "~user is not home: pi expands only ~ and ~/");
	assert.equal(resolve({ PI_CODING_AGENT_DIR: "~other" }), "~other/extensions/spec/core");
});

test("spec: the prompt names the trusted tools, their real flags, and the draft workflow", () => {
	const spec = buildMinorPrompt("spec");
	assert.ok(spec.includes(`start each bash command with exactly this, never a guessed path:\n\n\`\`\`sh\n${SPEC_CORE_SHELL}\n\`\`\``));
	const here = dirname(fileURLToPath(import.meta.url));
	const coreDir = join(here, "../spec/core");
	// Every tool the prompt runs from $core ships in the linked directory, and so does the README it points to.
	const named = [...new Set([...spec.matchAll(/"\$core\/([\w.-]+\.mjs)"/g)].map((m) => m[1]))];
	assert.deepEqual(named, ["sova-spec.mjs", "sova-spec-draft.mjs"]);
	assert.ok(spec.includes("`sova-spec-review.mjs`, see `$core/../README.md`"));
	for (const tool of [...named, "sova-spec-review.mjs"]) assert.ok(existsSync(join(coreDir, tool)), `${tool} ships beside this extension`);
	assert.ok(existsSync(join(here, "../spec/README.md")));
	// Every flag the prompt spells is one a named tool parses: each tool names an unknown flag in its usage error.
	const usage = (tool: string, arg: string) => {
		const r = spawnSync(process.execPath, [join(coreDir, tool), arg], { encoding: "utf8" });
		return `${r.stdout}${r.stderr}`;
	};
	for (const tool of named) assert.match(usage(tool, "--no-such-flag"), /unknown flag --no-such-flag/, `${tool} reports an unknown flag`);
	// The reading commands parse their own flags, so a flag is probed inside each command too.
	const commandProbe = (cmd: string, flag: string) => {
		const r = spawnSync(process.execPath, [join(coreDir, "sova-spec.mjs"), ...cmd.split(" "), flag], { encoding: "utf8" });
		return `${r.stdout}${r.stderr}`;
	};
	const commands = ["toc §a/b", "read §a/b", "impact §a/b", "map", "where a.ts"];
	for (const cmd of commands) assert.match(commandProbe(cmd, "--no-such-flag"), /unknown flag --no-such-flag/, `${cmd} reports an unknown flag`);
	// A flag the text spells inside a reading command's form is probed with that command, never with any other.
	const probeOf: Record<string, string> = { toc: "toc §a/b", read: "read §a/b", impact: "impact §a/b", map: "map", where: "where a.ts" };
	const paired = new Set<string>();
	for (const [, cmd, rest] of spec.matchAll(/`(toc|read|impact|map|where)\b([^`]*)`/g)) {
		for (const flag of rest!.match(/--[a-z][a-z-]*/g) ?? []) {
			assert.ok(!commandProbe(probeOf[cmd!]!, flag).includes(`unknown flag ${flag}`), `${cmd} takes ${flag}, as the text pairs them`);
			paired.add(flag);
		}
	}
	for (const flag of ["--dir", "--whole", "--no-frame", "--near"]) assert.ok(paired.has(flag), `${flag} is spelled in its command's form`);
	for (const cmd of ["toc", "read"]) assert.ok(!commandProbe(probeOf[cmd]!, "--cursor").includes("unknown flag --cursor"), `${cmd} pages with --cursor`);
	const flags = new Set(spec.match(/--[a-z][a-z-]*/g));
	for (const flag of flags) {
		if (paired.has(flag)) continue;
		const real = named.some((tool) => !usage(tool, flag).includes(`unknown flag ${flag}`)) || commands.some((cmd) => !commandProbe(cmd, flag).includes(`unknown flag ${flag}`));
		assert.ok(real, `${flag} is a real flag`);
	}
	for (const flag of ["--dir", "--whole", "--no-frame", "--near", "--cursor"]) assert.ok(flags.has(flag), `${flag} is named`);
	for (const flag of ["--spec", "--commit", "--snapshot", "--doc-only", "--plan", "--write", "--verification", "--changed", "--base"]) assert.ok(flags.has(flag), `${flag} is named`);
	// Every draft command the prompt names is one the draft tool advertises.
	const draftUsage = usage("sova-spec-draft.mjs", "--no-such-flag");
	for (const cmd of ["new", "status", "diff", "check", "evidence", "promote", "recover"]) {
		assert.match(draftUsage, new RegExp(`[<|] ?${cmd}[ >]`), `${cmd} is a draft command`);
		assert.match(spec, new RegExp(`\`${cmd}\\b`), `${cmd} is named`);
	}
	// Task reading pulls: contents, then one passage; whole-chain packet/scope remain machine inspection.
	assert.match(spec, /only reads: `map`, `where <path\|name>`, `toc '<§id>' --dir out\|in\|down\|up\|mentions`, `read '<§id>' \[--whole\] \[--no-frame\]`, `impact '<§id>' \[--near\]`, `check`, `census`, `foreign --base <rev>`, and whole-chain `packet`\/`scope '<§id>'` \(machine inspection\); `--cursor <next>` continues a page; `--spec <dir>` reads a draft\./);
	for (const cmd of ["foreign", "map", "where", "toc", "read"]) assert.doesNotMatch(usage("sova-spec.mjs", cmd), /unknown command/, `${cmd} is a core command`);
	assert.doesNotMatch(spec, /--budget/, "every default budget fits a passage: the guide spends no words on it");
	// A project's copy is foreign code: inspected and asked about, never run blind.
	assert.match(spec, /A project's own copy is foreign code: read it and ask before running it/);
	assert.match(spec, /never run other project scripts, installs or network commands/);
	assert.match(spec, /Without trusted tools, say so and read the files directly/);
	// The discipline, one assertion per rule.
	assert.match(spec, /It needs no Git or prior docs;/, "any project, no incumbent prose");
	assert.match(spec, /Before coding:\n1\. Justify roots \(`map`, `where`\); `toc` each `--dir out` \(an area: `--dir down`\), and `impact --near` any you will change\./, "contents before reading, and reverse impact before changing");
	assert.match(spec, /`read` each root and every `requires` line whose "what" doesn't rule it out, and any other line touching the task; `toc` what you read to go further\./, "the root itself is read, and a dependency is read unless its what rules it out: never skipped for a missing why");
	assert.match(spec, /Every `read` after the first adds `--no-frame`\. Work from read passages as written; finish fragments at `end == total`\./, "the frame once; literal passages; finish exact fragments");
	assert.match(spec, /2\. Track unread\/unknowns: an unread link isn't absent, "uninvestigated" isn't none\./, "didn't open never reads as nothing there");
	assert.match(spec, /`done`\/exit 0: selected stream only, never complete context or reading proof/, "navigation, not completeness or read proof");
	assert.match(spec, /Labels are declared, never proof: `migrated` text is the requirement with its implementation unreviewed; `candidate` is a proposal\./);
	assert.match(spec, /Documentation changes only through drafts, never by editing current `claims\/` or `manifest\.json`/);
	assert.match(spec, /`new <name> --write` copies the whole current spec \(or starts one\)/, "a draft is a full copy");
	assert.match(spec, /Documenting what the code already does is its own baseline draft, never mixed into a feature draft/, "baseline apart from the feature");
	assert.match(spec, /agreement approves intent, not current truth/);
	assert.match(spec, /After implementing, verify each changed promise\. Relabel each record as it will read once current: explicit `authority`: `accepted` for new or rewritten prose \(the task's go-ahead adopts it\), `migrated` only for text still as ported, never `candidate`;/);
	assert.doesNotMatch(spec, /or `migrated`/, "migrated is provenance, not an alternative to accepted");
	assert.match(spec, /`--commit <rev>` \(Git: the implementation's existing commit\)/);
	assert.match(spec, /It is not permission to commit: without that, leave evidence pending, and never commit unrelated changes\./, "task approval is not a commit");
	assert.match(spec, /`cause: manifest-not-found` means no spec: start a draft\./, "a generic refusal is not permission to bootstrap a malformed spec");
	assert.match(spec, /Promote only what is implemented and verified\. A refusal is resolved, never forced\./);
	assert.match(spec, /Write `"requires": \[\]` only after investigating; otherwise omit the key/);
	// Mandatory: every behavior change is spec'd, and only a declared no-behavior change is exempt.
	assert.match(spec, /Every behavior change is spec'd\. Exempt from drafts, not census: work changing no behavior \(refactor, tests, tooling\), decided from passages you read, never memory; a test that fails or flakes because of product code is that code's behavior fix, never test-only; say you claim the exemption\./, "a flaky test's product cause is no test-only exemption");
	assert.match(spec, /Behavior no claim covers gets a new claim in a feature draft before coding\. Write its sentence before the first code edit; `new` alone isn't enough\./, "the claim comes before the code");
	assert.ok(spec.indexOf("Before coding:") < spec.indexOf("before coding.") && spec.indexOf("before coding.") < spec.indexOf("Documentation changes only through drafts"), "the new claim is a before-coding step");
	// Only what the task changed is claimed; neighbours are linked, never spec'd.
	assert.match(spec, /Claim only files the task changed \(each record's `code`\); unchanged dependencies are not spec'd; `requires` names only existing claims\./);
	// The finish gate: the changed-file census, run on the draft until it is promoted.
	assert.match(spec, /Before finishing:\n- `node "\$core\/sova-spec\.mjs" census --changed --root <project root> --json` must report no in-boundary changed file unclaimed, and no changed file outside it that no claim maps unless a "Plumbing: <path> — <why>" line above the last line names it \(never UI text, colour, CLI output or footer rendering\) \(`--spec` the draft's `spec\/` until promoted; `--base <rev>` once committed\)\. Pre-existing unclaimed files aren't the task's job\./);
	// Promotion is no longer conditional on a commit: promote, or say why not.
	assert.match(spec, /- Read `\$core\/\.\.\/PROMOTE\.md`; promote what you verified, or say in your reply why not\./);
	assert.doesNotMatch(spec, /Before `git commit`, if/, "the old conditional is gone");
	assert.match(spec, /A `conflict` is per declaration: re-apply in a new draft from current\./);
	// The `--doc-only` cases are checked against the draft tool itself: see "the guide's doc-only cases are the draft tool's".
	assert.match(spec, /A Git merge conflict in `manifest\.json`: run `merge-manifest --write` first; if it refuses, take master's manifest and matching claims \(`git checkout master -- …`\), re-apply the branch's spec changes in a new draft, and promote\. Never take a side before it has run\./);
	assert.match(usage("sova-spec-draft.mjs", "--no-such-flag"), /merge-manifest/, "merge-manifest is a draft command");
	assert.match(spec, /never put `§` IDs or spec annotations in source code/);
	assert.match(spec, /authorizes its drafts, evidence and promotions as one bounded batch; no dialog per claim, and nothing at session start/);
	assert.match(spec, /No check, record, evidence or promotion proves correctness; no tool checks meaning\./);
	assert.match(spec, /only the passages and unknowns relevant to its part, quoted literally/, "workers get the relevant slice, not the graph");
	assert.doesNotMatch(spec, /\{[A-Z_]+\}/);
	assert.match(spec, /your new claim's parent included/);
	assert.match(spec, /even one your new claim describes/);
	assert.match(spec, /wherever you put the claim/);
	assert.match(spec, /never a gap it already had, even one you rely on/);
	assert.match(spec, /"Also changes: none"/);
	assert.match(spec, /Before finishing:\n(- .*\n)*- Your reply's last line on a turn that edited, committed, promoted or merged, exempt work included, is exactly "Also changes: §X — <what>; §Y — <what>" or "Also changes: none", nothing after; a turn that only answered writes no such line\. Items are separated by ";", each led by the § it names \(", \/d" after "§a\.b\/c" is "§a\.b\/d"\); a § inside a description isn't named\. It names foreign § only, never your new claims; an addition under one is that §'s change, and a § the user asked for is still foreign\./, "the handoff line is a finishing step on change turns, exempt work included; none on a Q&A turn; its grammar");
	assert.match(spec, /One that leaves draft records unpromoted names their stale § on a "Deferred: §X — <why>" line above the last line; on the default branch it promotes them instead\./, "q14: no Deferred exit at a master landing");
	assert.match(spec, /A merge or promote turn names every foreign § it lands, even if already reported, workers' included: copy the list `worktree merge` or `promote --write` prints/, "merge and promote turns copy the computed list");
	assert.match(spec, /"Spec check override: <why>"/);
	assert.match(spec, /on the default branch it promotes them instead\. "Spec check override: <why>" right above the last line excuses only an omission you show is wrong\./, "the override never adds a §");
	assert.ok(spec.includes(SPEC_CHECK_OVERRIDE), "the prompt spells the override the check accepts");
	assert.ok(spec.includes(`A \`${DIGEST_TAG}\` note on a tool result is this census`), "the automatic census is named by its tag");
	assert.match(spec, /While coding, exempt work included, edit one file per tool call \(no multi-file sed, heredoc or parallel edits\) and run `census --changed` \(`--spec` your draft, if any\) after the first edit and each new file\./, "q15: per tool call, so each file's census lands before the next");
	assert.match(spec, /Trusted tools: start each bash command with exactly this, never a guessed path:\n\n```sh\n/, "the recipe, not a hard-coded agent dir");
	assert.match(spec, /plumbing \(a request, hook, helper or CSS class\) never flags/);
	assert.match(spec, /editing one in your draft flags\. Read it with `read`;/, "a foreign § is read alone, not with its chain");
	assert.ok(spec.split(/\s+/).length <= 1063, "short enough to ride every turn: growing it is a deliberate change");
	assert.match(spec, /and no changed file outside it that no claim maps unless a "Plumbing: <path> — <why>" line above the last line names it \(never UI text, colour, CLI output or footer rendering\)/, "the boundary is not an exemption");
});

test("spec: the guide's doc-only cases are the draft tool's: each one it names is accepted, and every case the tool's rule lists is named", () => {
	const guide = buildMinorPrompt("spec");
	const named = guide.match(/`--doc-only` \(([^)]*)\)/)?.[1]?.split(", ");
	assert.ok(named, "the guide names the doc-only cases in one parenthesis");
	const draftTool = fileURLToPath(new URL("../spec/core/sova-spec-draft.mjs", import.meta.url));
	const dir = tmp();
	try {
		mkdirSync(join(dir, ".sova/spec/claims/g"), { recursive: true });
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src/b.ts"), "export const b = 1;\n");
		const doc = (v: string) => `# §g/doc — Doc\n\nThe doc ${v}.\n\n${["note", "sec", "agreed", "field", "view", "built"].map((h) => `## §g.doc/${h} — ${h}\n\nThe ${h} ${h === "field" || h === "view" ? "stays" : v}.\n`).join("\n")}`;
		writeFileSync(join(dir, ".sova/spec/claims/g/doc.md"), doc("one"));
		const built = { kind: "behavior", requires: [], code: ["src/b.ts"], authority: "accepted", evidence: "verified" };
		const claims: Record<string, object> = {
			"§g/doc": { ...built, kind: "surface" },
			"§g.doc/note": { kind: "note", authority: "accepted" },
			"§g.doc/sec": { kind: "section", members: ["§g.doc/note"], authority: "accepted" },
			"§g.doc/agreed": { kind: "behavior", requires: [], authority: "accepted", agreed: { by: "op", at: "2026-10-06" } },
			"§g.doc/field": built,
			"§g.doc/view": { ...built, kind: "surface" },
			"§g.doc/built": built,
		};
		writeFileSync(join(dir, ".sova/spec/manifest.json"), JSON.stringify({ formatVersion: 1, claims }));
		const draft = (...args: string[]) => {
			const r = spawnSync(process.execPath, [draftTool, ...args, "--root", dir, "--json"], { encoding: "utf8" });
			return { status: r.status, out: JSON.parse(r.stdout) };
		};
		assert.equal(draft("new", "d", "--write").status, 0);
		const spec = join(dir, ".sova/spec/drafts/d/spec");
		writeFileSync(join(spec, "claims/g/doc.md"), doc("two"));
		const manifest = JSON.parse(readFileSync(join(spec, "manifest.json"), "utf8"));
		manifest.claims["§g.doc/field"].embeds = ["§g.doc/view"];
		writeFileSync(join(spec, "manifest.json"), JSON.stringify(manifest));
		const docOnly = (id: string) => draft("evidence", "d", "--id", id, "--by", "t", "--verification", "read both passages", "--doc-only");
		// The refusal for a built behavior states the tool's whole doc-only rule: its kinds, agreed kinds and field keys.
		const refused = docOnly("§g.doc/built");
		assert.equal(refused.status, 1, "a built behavior's prose change is not doc-only");
		const rule = JSON.stringify(refused.out).match(/--doc-only covers only ([a-z/]+) kinds, agreed ([a-z/]+) records with no code, and ([a-z/]+)-only changes, not /);
		assert.ok(rule, "the tool's doc-only rule has the three parts the guide names: if it gains a part, revisit the guide");
		const [, kinds, agreedKinds, fields] = rule;
		assert.deepEqual(agreedKinds!.split("/").sort(), ["behavior", "surface"], "agreed records: behaviors and surfaces");
		// Each case the guide names is one the tool accepts, driven on its own record.
		const cases: Record<string, string> = { notes: "§g.doc/note", sections: "§g.doc/sec", "agreed records without code": "§g.doc/agreed" };
		cases[`${fields!.split("/").sort((a, b) => ["embeds", "about", "core"].indexOf(a) - ["embeds", "about", "core"].indexOf(b)).map((f) => `\`${f}\``).join("/")}-only changes`] = "§g.doc/field";
		for (const kind of kinds!.split("/")) assert.ok(`${kind}s` in cases, `the tool's doc-only kind ${kind} has a case here`);
		assert.deepEqual([...named].sort(), Object.keys(cases).sort(), "the guide names exactly the tool's doc-only cases");
		for (const [label, id] of Object.entries(cases)) assert.equal(docOnly(id).status, 0, `the tool takes --doc-only for ${label} (${id})`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("spec: shipped task-reading argv lists contents, then delivers one passage in exact fragments, to parents and workers", () => {
	const guide = readFileSync(new URL("./spec-mode.md", import.meta.url), "utf8").trimEnd();
	const tocForm = guide.match(/`(toc) '<§id>' (--dir) (out\|in\|down\|up\|mentions)`/);
	const readForm = guide.match(/`(read) '<§id>' \[(--whole)\] \[(--no-frame)\]`/);
	const cursorFlag = guide.match(/`(--cursor) <next>` continues a page/)?.[1];
	assert.ok(tocForm && readForm && cursorFlag, "use the actual shipped guide's CLI forms, not a second instruction source");
	const [, toc, dirFlag, dirs] = tocForm;
	const [, read, , noFrameFlag] = readForm;
	const dir = tmp();
	try {
		mkdirSync(join(dir, ".sova/spec/claims/guide"), { recursive: true });
		const root = "§guide/task";
		const rule = "§guide.task/rule";
		const prose = `## ${rule} — The rule\n\n${"Exact 🙂 prose; ".repeat(300)}\n`;
		writeFileSync(join(dir, ".sova/spec/claims/guide/task.md"), `# ${root} — Exact task\n\nThe task needs its rule.\n\n${prose}`);
		writeFileSync(join(dir, ".sova/spec/manifest.json"), JSON.stringify({ formatVersion: 1, claims: { [root]: { kind: "surface", requires: [rule], code: [] }, [rule]: { kind: "behavior", requires: [], code: [] } } }));
		const cli = fileURLToPath(new URL("../spec/core/sova-spec.mjs", import.meta.url));
		const run = (...args: string[]) => {
			const r = spawnSync(process.execPath, [cli, ...args, "--root", dir, "--json"], { encoding: "utf8" });
			assert.equal(r.stderr, "", "no unbounded stderr side channel");
			const page = JSON.parse(r.stdout);
			assert.equal(r.status, page.exit);
			return page;
		};
		for (const d of dirs!.split("|")) assert.notEqual(run(toc!, root, dirFlag!, d).exit, 2, `--dir ${d} is a direction toc takes`);
		const contents = run(toc!, root, dirFlag!, "out");
		assert.deepEqual(contents.lines.map((line: { id: string; group: string }) => [line.id, line.group]), [[rule, "requires"]], "the requires line is listed, not delivered");
		assert.ok(contents.lines[0].what && contents.lines[0].bytes > 0, "each line says what it is and what reading it costs");
		assert.deepEqual(contents.footer.delivered, [], "contents only: no passage");
		let cursor: string | null = null;
		let joined = "";
		let end = 0;
		let total = -1;
		let pages = 0;
		do {
			// The first read brings the frame; every later one adds --no-frame, as the guide says.
			const page = run(read!, rule, ...(pages ? [noFrameFlag!] : []), "--budget", "1024", ...(cursor ? [cursorFlag!, cursor] : []));
			assert.ok([0, 1].includes(page.exit), JSON.stringify(page));
			assert.ok(page.items.length, "a continued page must advance");
			for (const item of page.items) {
				assert.equal(item.id, rule, "one passage: nothing it requires or mentions");
				assert.equal(item.fragment.start, end);
				end = item.fragment.end;
				joined += item.text;
				assert.equal(end, Buffer.byteLength(joined));
				assert.ok(total < 0 || item.fragment.total === total, "every fragment names the same total");
				total = item.fragment.total;
			}
			cursor = page.next;
			assert.equal(page.status, cursor ? "more" : "done");
			assert.ok(++pages < 100, "navigation cannot empty-loop");
		} while (cursor);
		assert.ok(pages > 1, "this fixture discriminates fragment navigation");
		assert.equal(end, total, "finished at end == total");
		const scope = spawnSync(process.execPath, [cli, "scope", rule, "--root", dir, "--json"], { encoding: "utf8" });
		assert.equal(scope.status, 0, scope.stderr);
		assert.equal(joined, JSON.parse(scope.stdout).passages.find((p: { id: string }) => p.id === rule).text, "the guide's continuation argv recovers the exact passage");
		assert.equal(composePrompt(withMinor(defaults(), "spec", true), ALL_OK), guide);
		assert.equal(composeWorkerPrompt({ minorModes: ["spec"] }), `${guide}\n\n${SPEC_WORKER_NOTE}`, "workers inherit the same reading guide");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("spec: shipped missing-spec guidance distinguishes refusal causes and preserves orphaned claims", () => {
	const guide = buildMinorPrompt("spec");
	const cause = guide.match(/`cause: (manifest-not-found)` means no spec: start a draft/);
	assert.ok(cause, "the guide names the actual bounded missing-spec cause");
	const dir = tmp();
	try {
		const core = fileURLToPath(new URL("../spec/core/", import.meta.url));
		const run = (tool: string, ...args: string[]) => {
			const r = spawnSync(process.execPath, [join(core, tool), ...args, "--root", dir, "--json"], { encoding: "utf8" });
			return { ...r, out: JSON.parse(r.stdout) };
		};
		assert.ok(!existsSync(join(dir, ".git")), "bootstrap works without Git");
		const packet = run("sova-spec.mjs", "packet", "§guide/task");
		assert.equal(packet.status, 2);
		assert.equal(packet.out.code, "graph-untrusted");
		assert.equal(packet.out.cause, cause[1], "the shipped guide's missing-spec cause is visible");
		const draft = run("sova-spec-draft.mjs", "new", "bootstrap");
		assert.equal(draft.status, 0, draft.stderr);
		assert.ok(!existsSync(join(dir, ".sova/spec/drafts")), "a preview does not create a draft");
		mkdirSync(join(dir, ".sova/spec/claims/guide"), { recursive: true });
		const path = join(dir, ".sova/spec/claims/guide/task.md");
		const orphan = "# §guide/task — Preserve orphaned prose\n";
		writeFileSync(path, orphan);
		const orphanPacket = run("sova-spec.mjs", "packet", "§guide/task");
		assert.equal(orphanPacket.out.cause, cause[1]);
		const refused = run("sova-spec-draft.mjs", "new", "bootstrap");
		assert.equal(refused.status, 2);
		assert.ok(JSON.stringify(refused.out).includes("orphaned-spec"), "missing manifest never authorizes destructive orphan bootstrap");
		assert.equal(readFileSync(path, "utf8"), orphan);
		assert.ok(!existsSync(join(dir, ".sova/spec/drafts")));
		writeFileSync(join(dir, ".sova/spec/manifest.json"), "{ malformed");
		const malformed = run("sova-spec.mjs", "packet", "§guide/task");
		assert.equal(malformed.status, 2);
		assert.equal(malformed.out.code, "graph-untrusted");
		assert.equal(malformed.out.cause, undefined, "a malformed existing spec must not look missing");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("mode helpers", () => {
	assert.ok(isMode("normal"));
	assert.ok(isMode("delegate"));
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

test("parseMode reads the mode names, nothing else", () => {
	assert.equal(parseMode("normal"), "normal");
	assert.equal(parseMode("delegate"), "delegate");
	for (const bad of ["Delegate", "heavy", "", " delegate", "toString", "__proto__", "constructor", undefined, null, 1, {}, ["delegate"]]) {
		assert.equal(parseMode(bad), undefined, `rejected: ${JSON.stringify(bad)}`);
	}
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
	assert.match(fallback, /- Planning & specs .* → backend "claude-code", model "opus\[1m\]", effort "high"\. This is the configured FALLBACK: the primary \(backend "claude-code", model "claude-fable-5-1\[1m\]", effort "medium"\) is unavailable — claude-fable-5-1\[1m\] does not support effort "medium" \(supports: low\)\. Tell the user/);
	assert.match(fallback, /do not retry the primary unless asked/);

	const none = routeAll(delegateDefaults(), { "claude-code": { models: [fableLowOnly, { id: "opus[1m]", efforts: ["xhigh"] }, { id: "sonnet", efforts: ["low", "medium", "high"] }] } }, () => null);
	const prompt = buildDelegatePrompt(none);
	assert.match(prompt, /- Routine implementation .* → NO AVAILABLE WORKER \(opus\[1m\] does not support effort "low" \(supports: xhigh\); no fallback is set\)\. Before delegating this kind of work, tell the user and ask which model to use; do not choose one yourself\./);
	assert.match(prompt, /- Planning & specs .* → NO AVAILABLE WORKER \(claude-fable-5-1\[1m\] does not support effort "medium" \(supports: low\); opus\[1m\] does not support effort "high" \(supports: xhigh\)\)/);
	assert.doesNotMatch(prompt, /model "sonnet"/, "an offered but unconfigured model is never named");
	// The CLI's list of the moment omitting every configured alias: nothing is refused, every profile stays on its primary.
	const unlisted = buildDelegatePrompt(routeAll(delegateDefaults(), { "claude-code": offering("sonnet") }, () => null));
	assert.doesNotMatch(unlisted, /NO AVAILABLE WORKER|FALLBACK/);
	assert.match(unlisted, /- Planning & specs .* → backend "claude-code", model "claude-fable-5-1\[1m\]", effort "medium"; fallback backend "claude-code", model "opus\[1m\]", effort "high"\./);
});

test("a configured fallback that can't run is never offered for the retry", () => {
	// Fable offered, opus not: planning runs on its primary, and its fallback is known dead.
	const deadFallback = routeAll(delegateDefaults(), { "claude-code": { models: [{ id: "claude-fable-5-1[1m]" }, { id: "opus[1m]", efforts: ["low"] }] } }, () => null);
	const prompt = buildDelegatePrompt(deadFallback);
	const planning = prompt.split("\n").find((line) => line.startsWith("- Planning & specs"))!;
	assert.match(planning, /→ backend "claude-code", model "claude-fable-5-1\[1m\]", effort "medium"; its configured fallback \(backend "claude-code", model "opus\[1m\]", effort "high"\) can't run — opus\[1m\] does not support effort "high" \(supports: low\) — so if the primary fails, ask the user\./);
	assert.doesNotMatch(planning, /; fallback backend/);
	// A fallback the CLI's list of the moment omits is still offered: absence from that list is not an answer.
	const unlistedFallback = buildDelegatePrompt(routeAll(delegateDefaults(), { "claude-code": offering("claude-fable-5-1[1m]") }, () => null));
	assert.match(unlistedFallback, /- Planning & specs .*; fallback backend "claude-code", model "opus\[1m\]", effort "high"\./);
	// Denied fallbacks are withheld the same way, with their own reason.
	const denied = buildDelegatePrompt(routeAll(delegateDefaults(), { "claude-code": offering("claude-fable-5-1[1m]", "opus[1m]") }, (c) => (c.model === "opus[1m]" ? "opus[1m] is disabled as a subagent model by user settings." : null)));
	assert.match(denied, /its configured fallback .* can't run — opus\[1m\] is disabled as a subagent model/);
	// An unverified fallback (discovery failed) is still offered: failure to discover is not absence.
	const unverified = buildDelegatePrompt(routeAll(delegateDefaults(), { "claude-code": { error: "timeout" } }, () => null));
	assert.match(unverified, /- Planning & specs .*; fallback backend "claude-code", model "opus\[1m\]", effort "high"\./);
	assert.match(prompt, /retry once with that profile's fallback only if one is listed above as its fallback/);
});

const WRITER: SpecSettings = {
	version: 1,
	writer: { primary: { backend: "claude-code", model: "opus[1m]", effort: "medium" }, fallback: { backend: "pi", model: "zai/glm-5.3", effort: "high" } },
};
const piOffering = (...ids: string[]): Discovery => ({ models: ids.map((id) => ({ id, efforts: ["off", "low", "medium", "high"] })) });

test("spec writer: a paragraph after the spec block only while spec is on and a writer is set", () => {
	const spec = buildMinorPrompt("spec");
	const writer = routeWriter(WRITER, { "claude-code": offering("opus[1m]"), pi: piOffering("zai/glm-5.3") }, () => null)!;
	const paragraph = buildSpecWriterPrompt(writer);
	const specOn = withMinor(defaults(), "spec", true);
	// On: spec block verbatim, then the paragraph — spec-mode.md itself is untouched.
	assert.equal(composePrompt(specOn, ALL_OK, writer), `${spec}\n\n${paragraph}`);
	assert.equal(buildMinorPrompt("spec"), readFileSync(join(dirname(fileURLToPath(import.meta.url)), "spec-mode.md"), "utf8").trimEnd());
	// Under delegate, with align: the paragraph rides with the spec block, after everything else.
	assert.equal(
		composePrompt({ ...defaults(), mode: "delegate", minorModes: ["align", "spec"] }, ALL_OK, writer),
		`${buildDelegatePrompt(ALL_OK)}\n\n${DELEGATE_ALIGN_BRIDGE}\n\n${buildMinorPrompt("align")}\n\n${spec}\n\n${paragraph}`,
	);
	// Off: a writer set but spec off contributes nothing, in either major mode.
	assert.equal(composePrompt(defaults(), ALL_OK, writer), undefined);
	assert.equal(composePrompt(withMinor(defaults(), "align", true), ALL_OK, writer), buildMinorPrompt("align"));
	assert.equal(composePrompt({ ...defaults(), mode: "delegate" }, ALL_OK, writer), buildDelegatePrompt(ALL_OK));
	// No writer (null): today's behaviour — the session writes the spec itself.
	assert.equal(routeWriter(specDefaults(), {}, () => null), null);
	assert.equal(composePrompt(specOn, ALL_OK, null), spec);
	assert.equal(composePrompt(specOn, ALL_OK), spec);
	for (const block of [composePrompt(specOn, ALL_OK), composePrompt(defaults(), ALL_OK, writer) ?? ""]) assert.doesNotMatch(block ?? "", /Spec writer/);
});

test("spec writer: the paragraph names the exact worker, the drafts-only rule, and the retry", () => {
	const onPrimary = buildSpecWriterPrompt(routeWriter(WRITER, { "claude-code": offering("opus[1m]"), pi: piOffering("zai/glm-5.3") }, () => null)!);
	assert.match(onPrimary, /^Spec writer: draft claims and evidence records are written by one worker, spawned with agent_spawn on exactly this backend, model and effort → backend "claude-code", model "opus\[1m\]", effort "medium"; fallback backend "pi", model "zai\/glm-5\.3", effort "high"\. /);
	assert.match(onPrimary, /Give it the relevant spec passages quoted literally, the files the task changed, and the verification you did\./);
	assert.match(onPrimary, /It writes only under `\.sova\/spec\/drafts\/`, never current `claims\/` or `manifest\.json`; you check its draft, run the checks and the census, and promote yourself\./);
	assert.match(onPrimary, /retry once with the fallback only if one is listed above, and say so; otherwise ask the user which model to use — never substitute one of your own\.$/);
	assert.equal(onPrimary.match(/\n/g), null, "one paragraph");
	// No fallback configured: a failed primary means asking.
	const alone = buildSpecWriterPrompt(routeWriter({ version: 1, writer: { primary: WRITER.writer!.primary, fallback: null } }, { "claude-code": offering("opus[1m]") }, () => null)!);
	assert.match(alone, /effort "medium"; no fallback — if it fails, ask the user\./);
	// Primary unavailable: the fallback, disclosed, and the retry rule is not repeated.
	const fallback = buildSpecWriterPrompt(routeWriter(WRITER, { "claude-code": { models: [{ id: "opus[1m]", efforts: ["low"] }] }, pi: piOffering("zai/glm-5.3") }, () => null)!);
	assert.match(fallback, /→ backend "pi", model "zai\/glm-5\.3", effort "high"\. This is the configured FALLBACK: the primary \(backend "claude-code", model "opus\[1m\]", effort "medium"\) is unavailable — opus\[1m\] does not support effort "medium" \(supports: low\)\. Tell the user the first time you use it; do not retry the primary unless asked\./);
	assert.doesNotMatch(fallback, /retry once/);
	// Neither can run (policy and discovery): rendered as Delegate renders a profile with no worker.
	const none = buildSpecWriterPrompt(
		routeWriter(WRITER, { "claude-code": offering("opus[1m]"), pi: piOffering("zai/glm-5.3") }, (c) => (c.backend === "claude-code" ? "Backend claude-code is disabled for subagents by user settings." : "zai/glm-5.3 is off for subagents.")) as NonNullable<ReturnType<typeof routeWriter>>,
	);
	assert.match(none, /→ NO AVAILABLE WORKER \(Backend claude-code is disabled for subagents by user settings\.; zai\/glm-5\.3 is off for subagents\.\)\. Before handing off spec writing, tell the user and ask which model to use; do not choose one yourself\./);
	assert.doesNotMatch(none, /retry once/);
	assert.doesNotMatch(none, /\{[A-Z_]+\}/);
});

test("status label: a spec writer off its primary is shown while spec is on", () => {
	const fallback = routeWriter(WRITER, { "claude-code": { models: [{ id: "opus[1m]", efforts: ["low"] }] }, pi: piOffering("zai/glm-5.3") }, () => null);
	const none = routeWriter(WRITER, {}, () => "denied");
	const ok = routeWriter(WRITER, {}, () => null);
	assert.deepEqual(statusLabel("normal", ALL_OK, false, ["spec"], fallback), { text: "normal · spec · writer:fallback", tone: "warning" });
	assert.deepEqual(statusLabel("normal", ALL_OK, false, ["spec"], none), { text: "normal · spec · writer:ask", tone: "warning" });
	assert.deepEqual(statusLabel("normal", ALL_OK, false, ["spec"], ok), { text: "normal · spec", tone: "accent" });
	assert.deepEqual(statusLabel("normal", ALL_OK, false, [], fallback), { text: "normal", tone: "dim" }, "spec off: the writer never shows");
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
		{ ...settings, profiles: { ...settings.profiles, routine: { primary: { backend: "claude-code", model: "opus[1m]", effort: "max" }, fallback: null } } },
		{ "claude-code": { models: [{ id: "claude-fable-5-1[1m]", efforts: ["low", "medium", "high"] }, { id: "opus[1m]", efforts: ["low", "medium", "high"] }] } },
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

// ── Workers (§chat.mode-menu/workers) ────────────────────────────────────────

test("MINOR_WORKER declares every minor mode, and nothing else: spec reaches workers, align and vis do not", () => {
	assert.deepEqual(Object.keys(MINOR_WORKER).sort(), [...MINOR_MODES].sort());
	for (const minor of MINOR_MODES) assert.equal(typeof MINOR_WORKER[minor], "boolean", minor);
	assert.equal(MINOR_WORKER.spec, true);
	assert.equal(MINOR_WORKER.align, false);
	assert.equal(MINOR_WORKER.vis, false);
	assert.deepEqual(workerMinorModes(["vis", "spec", "align"]), ["spec"], "registry order, worker-scope only");
	assert.deepEqual(workerMinorModes(["align"]), []);
});

test("composeWorkerPrompt: the spec block byte for byte, then the worker note; never delegate, align, the bridge or a writer", () => {
	const discovery: Record<string, Discovery> = {};
	const writer = routeWriter({ ...specDefaults(), writer: { primary: { backend: "claude-code", model: "sonnet", effort: "high" }, fallback: null } } as SpecSettings, discovery, () => null);
	const everything = { mode: "delegate" as const, strict: true, minorModes: ["align", "spec", "vis"] as MinorMode[] };
	// The parent's own block carries all of it: the worker's must carry none of it.
	const parent = composePrompt(everything, DEFAULT_ROUTES, writer)!;
	assert.ok(parent.includes("# Mode: delegate") && parent.includes("# Minor mode: align") && parent.includes("# Minor mode: vis") && parent.includes("Spec writer:"), "the parent block is the full one");
	const worker = composeWorkerPrompt(everything)!;
	assert.equal(worker, `${SPEC_INSTRUCTIONS}\n\n${SPEC_WORKER_NOTE}`);
	assert.ok(worker.startsWith(SPEC_INSTRUCTIONS), "starts with spec-mode.md exactly");
	for (const absent of ["# Mode: delegate", "# Minor mode: align", "# Minor mode: vis", DELEGATE_ALIGN_BRIDGE, "Spec writer:", ALIGN_INSTRUCTIONS.slice(0, 200), VIS_INSTRUCTIONS.slice(0, 200)])
		assert.ok(!worker.includes(absent), `worker prompt must not include ${absent.slice(0, 40)}`);
	assert.equal(composeWorkerPrompt({ minorModes: ["align"] }), undefined, "align alone reaches no worker");
	assert.equal(composeWorkerPrompt({ minorModes: ["vis"] }), undefined, "vis alone reaches no worker");
	assert.equal(composeWorkerPrompt({ minorModes: [] }), undefined);
});

test("codemode: a minor mode with no prompt block, no mode note and no worker reach; its tool and host contract", () => {
	assert.equal(MINOR_DESCRIPTIONS.codemode, "Let the model run JavaScript that calls tools in parallel and filters their output (pi's codemode tool)");
	assert.equal(MINOR_WORKER.codemode, false, "workers never get it");
	assert.equal(CODEMODE_TOOL, "codemode");
	assert.deepEqual(Object.keys(MINOR_PROMPTLESS), [...MINOR_MODES], "every minor mode decides");
	assert.deepEqual(promptedMinorModes(["align", "spec", "vis", "codemode"]), ["align", "spec", "vis"]);
	// No block: alone it composes nothing, beside others it adds nothing.
	assert.equal(composePrompt(withMinor(defaults(), "codemode", true), ALL_OK), undefined);
	const vis = withMinor(defaults(), "vis", true);
	assert.equal(composePrompt(withMinor(vis, "codemode", true), ALL_OK), composePrompt(vis, ALL_OK));
	assert.doesNotMatch(composePrompt({ ...defaults(), mode: "delegate", minorModes: ["codemode"] }, ALL_OK)!, /codemode/);
	// No note, on or off; a real switch beside it is still told.
	assert.equal(buildModeNote([], ["codemode"], { head: [], guides: [] }), undefined, "turning codemode on tells nothing");
	assert.equal(buildModeNote(["codemode"], [], { head: ["codemode"], guides: [] }), undefined, "nor does turning it off");
	const both = buildModeNote([], ["vis", "codemode"], { head: [], guides: [] })!;
	assert.deepEqual(both.guides, ["vis"]);
	assert.doesNotMatch(both.text, /codemode/);
	assert.equal(composeWorkerPrompt({ minorModes: ["codemode"] }), undefined);
	// The status line names it like any minor mode.
	assert.deepEqual(statusLabel("normal", ALL_OK, false, ["codemode"]), { text: "normal · codemode", tone: "accent" });
	assert.ok(SCRIPT_ONLY_EXPOSURES.has("codemode") && SCRIPT_ONLY_EXPOSURES.has("deferred") && !SCRIPT_ONLY_EXPOSURES.has("direct") && !SCRIPT_ONLY_EXPOSURES.has("model-only"));
});

test("SPEC_WORKER_NOTE: the parent promotes, the brief is the go-ahead, and the reply ends on the Also changes line spec-mode.md names", () => {
	assert.match(SPEC_WORKER_NOTE, /parent session started you, and it promotes/);
	assert.match(SPEC_WORKER_NOTE, /Do not promote, commit, or record `--commit` evidence unless your brief says to/);
	assert.match(SPEC_WORKER_NOTE, /Your brief is your go-ahead/);
	// The note leans on spec-mode.md's own wording; a rewrite there must revisit the note.
	for (const phrase of ["`--commit`", "Also changes:", "draft", "promote"]) assert.ok(SPEC_INSTRUCTIONS.includes(phrase.replace(/`/g, "")) || SPEC_INSTRUCTIONS.includes(phrase), phrase);
	assert.ok(!SPEC_INSTRUCTIONS.includes(SPEC_WORKER_NOTE), "spec-mode.md itself stays the parent's text");
});

test("parseModeWorkerEvent keeps a v1 payload and drops everything else", () => {
	assert.deepEqual(parseModeWorkerEvent({ version: 1, minorModes: ["spec"], prompt: "x" }), { version: 1, minorModes: ["spec"], prompt: "x" });
	assert.deepEqual(parseModeWorkerEvent({ version: 1, minorModes: [] }), { version: 1, minorModes: [] });
	for (const bad of [null, "x", { version: 2, minorModes: [] }, { version: 1 }, { version: 1, minorModes: [1] }, { version: 1, minorModes: [""] }, { version: 1, minorModes: [], prompt: 3 }, { version: 1, minorModes: [], prompt: "  " }])
		assert.equal(parseModeWorkerEvent(bad), undefined, JSON.stringify(bad));
});

test("composePrompt: minor blocks follow the head's set, the delegate bridge the active align", () => {
	const active = { mode: "normal" as const, strict: false, minorModes: ["vis"] as MinorMode[] };
	assert.equal(composePrompt(active, DEFAULT_ROUTES, null, ["spec"]), buildMinorPrompt("spec"), "the head's blocks, not the active ones");
	assert.equal(composePrompt(active, DEFAULT_ROUTES, null, []), undefined);
	assert.equal(composePrompt(active, DEFAULT_ROUTES), buildMinorPrompt("vis"), "no head: the active set, as before");
	const delegate = { mode: "delegate" as const, strict: false, minorModes: ["align"] as MinorMode[] };
	const block = composePrompt(delegate, DEFAULT_ROUTES, null, [])!;
	assert.ok(block.endsWith(DELEGATE_ALIGN_BRIDGE), "align on (a tool-set change anyway): the bridge is in");
	assert.doesNotMatch(block, /# Minor mode: align/, "the align block itself is the head's business");
});

test("buildModeNote: whole guide on first turning on, a pointer after, a line for off", () => {
	const none = { head: [] as MinorMode[], guides: [] as MinorMode[] };
	assert.equal(buildModeNote(["vis"], ["vis"], none), undefined, "nothing changed");
	const on = buildModeNote([], ["vis"], none)!;
	assert.deepEqual(on.guides, ["vis"]);
	assert.equal(on.text, `Mode change: the user turned the vis minor mode on. Its instructions follow and apply from now on, as if they were part of your system prompt.\n\n${buildMinorPrompt("vis")}`);
	const back = buildModeNote([], ["vis"], { head: [], guides: ["vis"] })!;
	assert.deepEqual(back.guides, []);
	assert.match(back.text, /turned the vis minor mode back on\. Its instructions \(the "# Minor mode: vis" block given earlier in this conversation\) apply again/);
	const inHead = buildModeNote([], ["vis"], { head: ["vis"], guides: [] })!;
	assert.match(inHead.text, /block in your system prompt\) apply again/);
	const off = buildModeNote(["vis", "spec"], ["align"], { head: ["spec"], guides: ["vis"] })!;
	const parts = off.text.split("\n\nMode change: ");
	assert.equal(parts.length, 3, "one part per switched mode");
	assert.match(parts[0], /^Mode change: the user turned the spec minor mode off\. Its instructions \(the "# Minor mode: spec" block in your system prompt\) no longer apply/);
	assert.match(parts[1], /^the user turned the vis minor mode off\. .*given earlier in this conversation/);
	assert.ok(parts[2].startsWith("the user turned the align minor mode on") && parts[2].endsWith(buildMinorPrompt("align")), "offs first, then ons");
	const writer = routeWriter({ version: 1, writer: { primary: { backend: "claude-code", model: "opus[1m]", effort: "medium" }, fallback: null } }, {}, () => null)!;
	assert.ok(buildModeNote([], ["spec"], none, writer)!.text.endsWith(`${buildMinorPrompt("spec")}\n\n${buildSpecWriterPrompt(writer)}`), "spec carries its writer paragraph, as in the prompt");
});

test("restoreHead: the newest recorded head, the newest note, and nothing across a compaction", () => {
	const pin = (minorModes: MinorMode[], head?: MinorMode[]) => ({ type: "custom", customType: "mode", data: { mode: "normal", active: { version: 1, mode: "normal", strict: false, minorModes }, ...(head ? { head } : {}) } });
	const note = (minorModes: MinorMode[], guides: MinorMode[]) => ({ type: "custom_message", customType: MODE_NOTE_TYPE, details: { v: 1, minorModes, guides } });
	assert.deepEqual(restoreHead([]), { head: undefined, told: undefined, guides: [] }, "never sent: the head follows the active set");
	assert.deepEqual(restoreHead([pin(["vis"])]), { head: undefined, told: undefined, guides: [] }, "a Sova pin carries no head");
	assert.deepEqual(restoreHead([pin(["vis"], [])]), { head: [], told: [], guides: [] }, "recorded, not told yet");
	assert.deepEqual(
		restoreHead([pin(["vis"], []), note(["vis"], ["vis"]), pin([]), note([], [])]),
		{ head: [], told: [], guides: ["vis"] },
		"an entry equal to its head carries none; the older one still names it, and every guide since counts",
	);
	assert.deepEqual(restoreHead([pin(["vis"], []), note(["vis"], ["vis"]), pin([])]), { head: [], told: ["vis"], guides: ["vis"] }, "a switch not told yet: told is the last note's");
	assert.deepEqual(
		restoreHead([pin(["vis"], []), note(["vis"], ["vis"]), { type: "compaction" }, pin(["spec", "vis"], ["vis"])]),
		{ head: ["vis"], told: ["vis"], guides: [] },
		"notes before a compaction don't count",
	);
	assert.deepEqual(restoreHead([pin(["vis"], []), { type: "compaction" }]).head, undefined, "a compaction rebuilds the head from the active set");
	assert.deepEqual(restoreHead([pin(["vis"], []), { type: "custom_message", customType: MODE_NOTE_TYPE, details: { v: 2 } }]).told, [], "an unknown note is skipped");
	assert.doesNotThrow(() => restoreHead(null as never));
});

test("buildModeNote in the worker form: spec turned on carries the worker note, never a writer", () => {
	const writer = routeWriter({ version: 1, writer: { primary: { backend: "claude-code", model: "opus[1m]", effort: "medium" }, fallback: null } }, {}, () => null)!;
	const note = buildModeNote([], ["spec"], { head: [], guides: [] }, writer, true)!;
	assert.ok(note.text.endsWith(`\n\n${composeWorkerPrompt({ minorModes: ["spec"] })}`), "the worker form of the block");
	assert.doesNotMatch(note.text, /Spec writer:/);
});
