// The align mode's settings file and what it adds to the prompt (§chat.alignment/settings-file,
// §chat.alignment/style, §chat.alignment/visuals). Node builtins only: node --test align-settings.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	alignSettingsDefaults,
	alignSettingsReader,
	loadAlignSettings,
	parseAlignOverride,
	parseAlignSettings,
	parseAlignSettingsText,
	resolveAlign,
	saveAlignSettings,
} from "./align-settings.ts";
import { ALIGN_INSTRUCTIONS, ALIGN_STYLE_PARAGRAPHS, ALIGN_VISUALS_PARAGRAPH, buildAlignPrompt, buildMinorPrompt, visToolsWanted } from "./minor.ts";
import { buildAlignStyleNote, buildModeNote, composePrompt, DEFAULT_ROUTES, DELEGATE_ALIGN_BRIDGE } from "./prompt.ts";
import { MODE_NOTE_TYPE, restoreHead } from "./state.ts";

const dir = mkdtempSync(join(tmpdir(), "align-settings-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test("parse: strict — both fields, version 1, nothing unknown; each error names its field", () => {
	assert.deepEqual(parseAlignSettings({ version: 1, style: "pm", visuals: true }), { version: 1, style: "pm", visuals: true });
	for (const [value, error] of [
		[null, /Expected/],
		[{ version: 2, style: "pm", visuals: true }, /version must be 1/],
		[{ version: 1, style: "expert", visuals: true }, /style must be one of default, simplified, pm/],
		[{ version: 1, style: "pm" }, /visuals must be true or false/],
		[{ version: 1, visuals: false }, /style must be/],
		[{ version: 1, style: "pm", visuals: "yes" }, /visuals must be true or false/],
		[{ version: 1, style: "pm", visuals: true, voice: "x" }, /unknown field "voice"/],
	] as const) {
		const parsed = parseAlignSettings(value);
		assert.ok("error" in parsed && error.test(parsed.error), `${JSON.stringify(value)} → ${JSON.stringify(parsed)}`);
	}
	assert.equal(parseAlignSettingsText("{").ok, false, "not JSON");
	assert.equal(parseAlignSettingsText('{"version":1,"style":"default","visuals":false}').ok, true);
});

test("read: a missing or malformed file is Default with Visuals off; the writer writes the canonical shape", () => {
	const file = join(dir, "mode-align.json");
	assert.deepEqual(loadAlignSettings(file), alignSettingsDefaults());
	assert.deepEqual(alignSettingsDefaults(), { version: 1, style: "default", visuals: false });
	writeFileSync(file, "{ not json");
	assert.deepEqual(loadAlignSettings(file), alignSettingsDefaults());
	writeFileSync(file, JSON.stringify({ version: 1, style: "pm", visuals: true, extra: 1 }));
	assert.deepEqual(loadAlignSettings(file), alignSettingsDefaults(), "a file the strict parse refuses reads as the defaults, never half");
	saveAlignSettings(file, { version: 1, style: "simplified", visuals: true });
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, style: "simplified", visuals: true });
	const read = alignSettingsReader(file);
	assert.equal(read().style, "simplified");
	rmSync(file);
	assert.deepEqual(read(), alignSettingsDefaults(), "a removed file is not cached");
});

test("a profile's override: style and/or visuals, never empty, nothing else; resolution is field by field", () => {
	assert.deepEqual(parseAlignOverride({ style: "pm" }, "p.alignment"), { style: "pm" });
	assert.deepEqual(parseAlignOverride({ visuals: false }, "p.alignment"), { visuals: false });
	for (const [value, error] of [
		[{}, /must set style or visuals/],
		[[], /must be an object/],
		[{ style: "loud" }, /p\.alignment\.style must be one of/],
		[{ visuals: 1 }, /p\.alignment\.visuals must be true or false/],
		[{ review: true }, /unknown field "review"/],
	] as const) {
		const parsed = parseAlignOverride(value, "p.alignment");
		assert.ok("error" in parsed && error.test(parsed.error), JSON.stringify(parsed));
	}
	const host = { style: "simplified", visuals: true } as const;
	assert.deepEqual(resolveAlign(host, null), { style: "simplified", visuals: true }, "no override: the host's file, exactly");
	assert.deepEqual(resolveAlign(host, undefined), { style: "simplified", visuals: true });
	assert.deepEqual(resolveAlign(host, { style: "pm" }), { style: "pm", visuals: true }, "the profile's style, the host's visuals");
	assert.deepEqual(resolveAlign(host, { visuals: false }), { style: "simplified", visuals: false });
	assert.deepEqual(resolveAlign(host, { style: "default", visuals: false }), { style: "default", visuals: false });
});

test("the paragraphs: Default adds no text; Simplified and Project manager add exactly their own; Visuals follows the style", () => {
	assert.equal(ALIGN_STYLE_PARAGRAPHS.default, undefined);
	assert.equal(buildAlignPrompt(), ALIGN_INSTRUCTIONS, "Default, Visuals off: the align block is today's, byte for byte");
	assert.equal(buildMinorPrompt("align"), ALIGN_INSTRUCTIONS);
	assert.equal(buildAlignPrompt({ style: "default", visuals: false }), ALIGN_INSTRUCTIONS);
	assert.equal(buildAlignPrompt({ style: "simplified", visuals: false }), `${ALIGN_INSTRUCTIONS}\n\n${ALIGN_STYLE_PARAGRAPHS.simplified}`);
	assert.equal(buildAlignPrompt({ style: "pm", visuals: true }), `${ALIGN_INSTRUCTIONS}\n\n${ALIGN_STYLE_PARAGRAPHS.pm}\n\n${ALIGN_VISUALS_PARAGRAPH}`);
	assert.equal(buildAlignPrompt({ style: "default", visuals: true }), `${ALIGN_INSTRUCTIONS}\n\n${ALIGN_VISUALS_PARAGRAPH}`);
	// What each promises, said in the paragraph itself.
	assert.match(ALIGN_STYLE_PARAGRAPHS.simplified!, /short sentences and everyday words/);
	assert.match(ALIGN_STYLE_PARAGRAPHS.simplified!, /about 5 findings and 6 approach steps/);
	assert.match(ALIGN_STYLE_PARAGRAPHS.simplified!, /Name a file only when the user must recognise it/);
	assert.match(ALIGN_STYLE_PARAGRAPHS.simplified!, /what changes for the user with each answer/);
	assert.match(ALIGN_STYLE_PARAGRAPHS.pm!, /screens, controls, wording, states and flows/);
	assert.match(ALIGN_STYLE_PARAGRAPHS.pm!, /No file paths, no function or component names, no APIs, no code/);
	assert.match(ALIGN_STYLE_PARAGRAPHS.pm!, /Consequence rule: any technical choice with an effect a user would notice \(speed, cost, data kept or lost, limits, something hard to undo\) is asked as a product question/);
	assert.match(ALIGN_STYLE_PARAGRAPHS.pm!, /Never leave a decision out because it is technical\./);
	assert.match(ALIGN_STYLE_PARAGRAPHS.pm!, /technical notes \(technical\)/);
	assert.match(ALIGN_VISUALS_PARAGRAPH, /wireframe for a question about a screen; a flow, state or steps for a change in behaviour/);
	assert.match(ALIGN_VISUALS_PARAGRAPH, /call vis_guide with that kind/);
	assert.match(ALIGN_VISUALS_PARAGRAPH, /In the Project manager writing style never use the code, tree or layers kinds/);
	assert.doesNotMatch(ALIGN_VISUALS_PARAGRAPH, /Writing style:/, "its words never depend on the style");
});

test("composePrompt: the head's align block carries the style and Visuals; the Delegate bridge never depends on them", () => {
	const align = { mode: "normal" as const, strict: false, minorModes: ["align" as const] };
	assert.equal(composePrompt(align, DEFAULT_ROUTES), ALIGN_INSTRUCTIONS, "no options: today");
	assert.equal(composePrompt(align, DEFAULT_ROUTES, null, align.minorModes, { style: "default", visuals: false }), ALIGN_INSTRUCTIONS);
	assert.equal(composePrompt(align, DEFAULT_ROUTES, null, align.minorModes, { style: "pm", visuals: false }), `${ALIGN_INSTRUCTIONS}\n\n${ALIGN_STYLE_PARAGRAPHS.pm}`);
	const delegate = { ...align, mode: "delegate" as const };
	const pm = composePrompt(delegate, DEFAULT_ROUTES, null, delegate.minorModes, { style: "pm", visuals: true })!;
	const plain = composePrompt(delegate, DEFAULT_ROUTES, null, delegate.minorModes, { style: "default", visuals: false })!;
	assert.ok(pm.includes(DELEGATE_ALIGN_BRIDGE) && plain.includes(DELEGATE_ALIGN_BRIDGE), "the same bridge in either");
	assert.match(DELEGATE_ALIGN_BRIDGE, /copy the one in effect word for word into the planning worker's prompt/);
	assert.match(DELEGATE_ALIGN_BRIDGE, /"technical"\?: \[string/, "the file schema the worker writes carries technical notes");
	// Align off: no paragraph anywhere, whatever the style.
	assert.equal(composePrompt({ ...align, minorModes: [] }, DEFAULT_ROUTES, null, [], { style: "pm", visuals: true }), undefined);
	// Align turned on by a note: the block it carries is written in the style now.
	const note = buildModeNote([], ["align"], { head: [], guides: [] }, null, false, { style: "simplified", visuals: false })!;
	assert.ok(note.text.endsWith(`${ALIGN_INSTRUCTIONS}\n\n${ALIGN_STYLE_PARAGRAPHS.simplified}`));
});

test("the style note: the new paragraph, or back to Default, that the old one no longer applies", () => {
	assert.equal(buildAlignStyleNote("default", "pm"), `Writing style change: the user set the align writing style to Project manager. It applies to every alignment you write or change from now on, instead of any earlier writing style:\n\n${ALIGN_STYLE_PARAGRAPHS.pm}`);
	assert.match(buildAlignStyleNote("pm", "simplified"), /to Simplified\.[\s\S]*Writing style: Simplified\./);
	assert.equal(
		buildAlignStyleNote("simplified", "default"),
		'Writing style change: the user set the align writing style back to Default. The earlier "Writing style: Simplified" paragraph no longer applies; write alignments at your usual level of detail from now on.',
	);
});

test("restoreHead: the newest style note since the last compaction, with or without a recorded head", () => {
	const note = (style: string, headStyle: string) => ({ type: "custom_message", customType: MODE_NOTE_TYPE, details: { v: 1, minorModes: ["align"], guides: [], style, headStyle } });
	const plainNote = { type: "custom_message", customType: MODE_NOTE_TYPE, details: { v: 1, minorModes: ["align", "vis"], guides: ["vis"] } };
	assert.deepEqual(restoreHead([note("simplified", "pm"), plainNote]).style, { told: "simplified", head: "pm" }, "no recorded head: the notes still say the style");
	assert.deepEqual(restoreHead([note("simplified", "pm"), note("default", "pm")]).style, { told: "default", head: "pm" }, "the newest wins");
	assert.equal(restoreHead([note("simplified", "pm"), { type: "compaction" }]).style, undefined, "nothing across a compaction");
	assert.equal(restoreHead([plainNote]).style, undefined, "a note that told no style says none");
	assert.equal(restoreHead([note("loud", "pm")]).style, undefined, "an unknown style is skipped");
});

test("visToolsWanted: vis on, or align on with the session's Visuals; never align alone, never Visuals alone", () => {
	assert.equal(visToolsWanted(["vis"], false), true);
	assert.equal(visToolsWanted(["align"], true), true);
	assert.equal(visToolsWanted(["align"], false), false);
	assert.equal(visToolsWanted([], true), false);
	assert.equal(visToolsWanted(["spec", "codemode"], true), false);
	assert.equal(visToolsWanted(["align", "vis"], false), true);
});
