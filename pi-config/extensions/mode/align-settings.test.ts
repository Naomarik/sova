// The align mode's settings file and what it adds to the prompt (§chat.alignment/settings-file,
// §chat.alignment/eagerness, §chat.alignment/style, §chat.alignment/visuals). Node builtins only: node --test align-settings.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import {
	ALIGN_EAGERNESS_LABELS,
	ALIGN_EAGERNESSES,
	ALIGN_STYLE_LABELS,
	ALIGN_STYLES,
	alignSettingsDefaults,
	alignSettingsReader,
	isAlignStyle,
	loadAlignSettings,
	parseAlignOverride,
	parseAlignSettings,
	parseAlignSettingsText,
	resolveAlign,
	saveAlignSettings,
} from "./align-settings.ts";
import { alignFileSchema } from "./align.ts";
import { ALIGN_INSTRUCTIONS, ALIGN_STYLE_PARAGRAPHS, ALIGN_TRIGGER_PARAGRAPHS, ALIGN_TRIGGER_SHARED, ALIGN_VISUALS_PARAGRAPH, alignInstructions, buildAlignPrompt, buildMinorPrompt, VIS_GUIDE_DIR, visToolsWanted } from "./minor.ts";
import { ALIGN_TOOL_DESCRIPTION, ALIGN_TOOL_GUIDELINES } from "./align-tool.ts";
import { buildAlignEagernessNote, buildAlignStyleNote, buildDelegateAlignBridge, buildModeNote, composePrompt, DEFAULT_ROUTES, DELEGATE_ALIGN_BRIDGE, PLANNER_VISUALS_PARAGRAPH } from "./prompt.ts";
import { MODE_NOTE_TYPE, restoreHead } from "./state.ts";

const dir = mkdtempSync(join(tmpdir(), "align-settings-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

test("parse: strict — both fields, version 1, nothing unknown; each error names its field", () => {
	assert.deepEqual(parseAlignSettings({ version: 1, style: "pm", visuals: true }), { version: 1, style: "pm", visuals: true });
	for (const [value, error] of [
		[null, /Expected/],
		[{ version: 2, style: "pm", visuals: true }, /version must be 1/],
		[{ version: 1, style: "expert", visuals: true }, /style must be one of pm, simplified, default/],
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

test("read: a missing or malformed file is Project manager with Visuals off; the writer writes the canonical shape", () => {
	const file = join(dir, "mode-align.json");
	assert.deepEqual(loadAlignSettings(file), alignSettingsDefaults());
	assert.deepEqual(alignSettingsDefaults(), { version: 1, style: "pm", visuals: false });
	writeFileSync(file, JSON.stringify({ version: 1, style: "default", visuals: false }));
	assert.equal(loadAlignSettings(file).style, "default", "a saved Default stays \"default\" (shown as Technical), never migrated");
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, style: "default", visuals: false }, "reading never rewrites the file");
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

test("the styles: Project manager, Simplified, Technical, in that order; the stored \"default\" reads as Technical", () => {
	assert.deepEqual(ALIGN_STYLES, ["pm", "simplified", "default"]);
	assert.deepEqual(ALIGN_STYLES.map((s) => ALIGN_STYLE_LABELS[s]), ["Project manager", "Simplified", "Technical"]);
	assert.ok(isAlignStyle("default"), "the allowed stored values stay default | simplified | pm");
	// The history fallbacks describe what a head was sent with, not the setting: a head nothing records
	// was built in Technical (no paragraph), whatever the default for a missing file is now.
	assert.equal(alignSettingsDefaults().style, "pm");
	assert.equal(buildAlignPrompt(), ALIGN_INSTRUCTIONS);
});

test("a profile's override: eagerness, style and/or visuals, never empty, nothing else; resolution is field by field", () => {
	assert.deepEqual(parseAlignOverride({ style: "pm" }, "p.alignment"), { style: "pm" });
	assert.deepEqual(parseAlignOverride({ visuals: false }, "p.alignment"), { visuals: false });
	assert.deepEqual(parseAlignOverride({ eagerness: "careful" }, "p.alignment"), { eagerness: "careful" });
	assert.deepEqual(parseAlignOverride({ eagerness: "eager", style: "pm" }, "p.alignment"), { eagerness: "eager", style: "pm" }, "a profile may pin Eager over a Careful host");
	for (const [value, error] of [
		[{}, /must set eagerness, style or visuals/],
		[{ eagerness: "timid" }, /p\.alignment\.eagerness must be one of eager, careful/],
		[[], /must be an object/],
		[{ style: "loud" }, /p\.alignment\.style must be one of/],
		[{ visuals: 1 }, /p\.alignment\.visuals must be true or false/],
		[{ review: true }, /unknown field "review"/],
	] as const) {
		const parsed = parseAlignOverride(value, "p.alignment");
		assert.ok("error" in parsed && error.test(parsed.error), JSON.stringify(parsed));
	}
	const host = { style: "simplified", visuals: true } as const;
	assert.deepEqual(resolveAlign(host, null), { eagerness: "eager", style: "simplified", visuals: true }, "no override: the host's file, exactly (no eagerness: Eager)");
	assert.deepEqual(resolveAlign(host, undefined), { eagerness: "eager", style: "simplified", visuals: true });
	assert.deepEqual(resolveAlign(host, { style: "pm" }), { eagerness: "eager", style: "pm", visuals: true }, "the profile's style, the host's visuals");
	assert.deepEqual(resolveAlign(host, { visuals: false }), { eagerness: "eager", style: "simplified", visuals: false });
	assert.deepEqual(resolveAlign(host, { style: "default", visuals: false }), { eagerness: "eager", style: "default", visuals: false });
	// Eagerness, field by field like the others (§chat.subagent-profiles/resolution).
	assert.deepEqual(resolveAlign(host, { eagerness: "careful" }), { eagerness: "careful", style: "simplified", visuals: true }, "the profile's eagerness, the host's style and visuals");
	const careful = { ...host, eagerness: "careful" } as const;
	assert.equal(resolveAlign(careful, null).eagerness, "careful", "a Careful host with no override");
	assert.equal(resolveAlign(careful, { style: "pm" }).eagerness, "careful", "an override without eagerness keeps the host's");
	assert.equal(resolveAlign(careful, { eagerness: "eager" }).eagerness, "eager", "the profile's Eager over a Careful host");
});

test("eagerness in mode-align.json: careful or absent (Eager), eager by hand reads the same, anything else refused; Eager files keep their bytes", () => {
	assert.deepEqual(ALIGN_EAGERNESSES, ["eager", "careful"], "Eager then Careful, everywhere");
	assert.deepEqual(ALIGN_EAGERNESSES.map((e) => ALIGN_EAGERNESS_LABELS[e]), ["Eager", "Careful"]);
	assert.equal(alignSettingsDefaults().eagerness, undefined, "the default is Eager, stored as nothing");
	assert.deepEqual(parseAlignSettings({ version: 1, style: "pm", visuals: false, eagerness: "careful" }), { version: 1, style: "pm", visuals: false, eagerness: "careful" });
	assert.deepEqual(parseAlignSettings({ version: 1, style: "pm", visuals: false, eagerness: "eager" }), { version: 1, style: "pm", visuals: false }, "eager by hand: the same as absent");
	assert.deepEqual(parseAlignSettings({ version: 1, style: "pm", visuals: false }), { version: 1, style: "pm", visuals: false }, "a file with no eagerness parses as before");
	for (const eagerness of ["timid", "", "Careful", true, null, 1]) {
		const parsed = parseAlignSettings({ version: 1, style: "pm", visuals: false, eagerness });
		assert.ok("error" in parsed && /eagerness must be one of eager, careful/.test(parsed.error), `${JSON.stringify(eagerness)} → ${JSON.stringify(parsed)}`);
	}
	assert.equal(parseAlignSettingsText('{"version":1,"style":"pm","visuals":false,"eagerness":"sometimes"}').ok, false, "the mesh's check refuses it too");
	const file = join(dir, "mode-align-eagerness.json");
	writeFileSync(file, JSON.stringify({ version: 1, style: "pm", visuals: true, eagerness: "careful" }));
	assert.equal(resolveAlign(loadAlignSettings(file), null).eagerness, "careful");
	writeFileSync(file, JSON.stringify({ version: 1, style: "pm", visuals: true, eagerness: "bold" }));
	assert.deepEqual(loadAlignSettings(file), alignSettingsDefaults(), "a refused eagerness reads the whole file as the defaults (Eager)");
	saveAlignSettings(file, { version: 1, style: "pm", visuals: true, eagerness: "careful" });
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { version: 1, style: "pm", visuals: true, eagerness: "careful" });
	saveAlignSettings(file, { version: 1, style: "pm", visuals: true });
	const eagerBytes = readFileSync(file, "utf8");
	saveAlignSettings(file, { version: 1, style: "pm", visuals: true, eagerness: "eager" });
	assert.equal(readFileSync(file, "utf8"), eagerBytes, "Eager writes no field: the same bytes as before the field existed");
	assert.deepEqual(JSON.parse(eagerBytes), { version: 1, style: "pm", visuals: true });
	rmSync(file);
});

test("the trigger paragraph: Eager is master's (any prompt implying work, short alignment for a specified ask, lean on asking); Careful the intent test, no example phrases", () => {
	assert.equal(buildAlignPrompt(), alignInstructions("eager"), "no options: Eager");
	assert.equal(ALIGN_INSTRUCTIONS, alignInstructions("eager"));
	const eager = alignInstructions("eager");
	const careful = alignInstructions("careful");
	assert.ok(eager.includes(ALIGN_TRIGGER_PARAGRAPHS.eager) && !eager.includes(ALIGN_TRIGGER_PARAGRAPHS.careful), "the Eager block carries only its own trigger");
	assert.ok(careful.includes(ALIGN_TRIGGER_PARAGRAPHS.careful) && !careful.includes(ALIGN_TRIGGER_PARAGRAPHS.eager), "the Careful block carries only its own trigger");
	assert.equal(careful.replace(ALIGN_TRIGGER_PARAGRAPHS.careful, ALIGN_TRIGGER_PARAGRAPHS.eager), eager, "only the trigger paragraph differs");
	assert.match(ALIGN_TRIGGER_PARAGRAPHS.eager, /any prompt that implies work \(a feature, an investigated fix, a refactor, a migration, new files, or any multi-step change\)/);
	assert.match(ALIGN_TRIGGER_PARAGRAPHS.eager, /When the ask already looks fully specified, still record a short alignment with your reading of it and ask the user to confirm\./);
	assert.match(ALIGN_TRIGGER_PARAGRAPHS.eager, /Bias heavily toward asking\./);
	assert.match(ALIGN_TRIGGER_PARAGRAPHS.careful, /what do they want to be different when this is done\?/);
	assert.match(ALIGN_TRIGGER_PARAGRAPHS.careful, /If it is the product \(how it looks, behaves or is built\), the message is a change request, however it is phrased\./);
	assert.match(ALIGN_TRIGGER_PARAGRAPHS.careful, /want to know or understand something and the product can stay as it is, it is a question: answer it in your reply/);
	assert.match(ALIGN_TRIGGER_PARAGRAPHS.careful, /An investigation into something broken or lacking is the first step of a change request: its findings go on an alignment card, never into a plan written in your reply\./);
	assert.match(ALIGN_TRIGGER_PARAGRAPHS.careful, /When you can't tell which the message is, open the alignment anyway\./);
	assert.match(ALIGN_TRIGGER_PARAGRAPHS.careful, /clarifying question first only when the message can't be planned without one/);
	assert.doesNotMatch(ALIGN_TRIGGER_PARAGRAPHS.careful, /Bias heavily|"[^"]+"/, "no lean toward asking, and no example phrases in quotes");
	assert.doesNotMatch(ALIGN_TRIGGER_PARAGRAPHS.eager, /second alignment just to confirm/, "the confirm-my-reading ban is Careful's alone");
	for (const block of [eager, careful]) {
		assert.ok(block.includes(ALIGN_TRIGGER_SHARED), "the shared wording is in both blocks");
		assert.match(block, /a follow-up that plainly confirms, which means only an answer to an existing alignment card or the go-ahead for a command to run/, "the exemption, narrowed");
		assert.match(block, /A "go", "yes", "do it" or "fix it" to anything you sketched in chat \(a plan, a fix, options in prose\) is a change request, never a confirmation: it opens an alignment first, never the build\./);
		assert.match(block, /1\. Mark the run: call `align` with \{"op": "change_request"\}/, "the change-request mark is unchanged");
		assert.match(block, /### Working notes/, "short replies and Working notes are unchanged");
		assert.doesNotMatch(block, /follow-ups that plainly confirm,/, "the old, wide exemption is gone");
		assert.doesNotMatch(block, /only after the user has said/, "the branch's middle rule is gone");
	}
	assert.equal(buildMinorPrompt("align", { eagerness: "careful", style: "pm", visuals: true }), `${careful}\n\n${ALIGN_STYLE_PARAGRAPHS.pm}\n\n${ALIGN_VISUALS_PARAGRAPH}`, "style and Visuals follow, as before");
});

test("one wording under both choices: the tool's description, its guideline and the Delegate+align bridge carry the shared sentence and name no choice", () => {
	assert.ok(ALIGN_TOOL_DESCRIPTION.includes(ALIGN_TRIGGER_SHARED));
	assert.ok(ALIGN_TOOL_GUIDELINES.some((line) => line.includes(ALIGN_TRIGGER_SHARED)));
	assert.ok(DELEGATE_ALIGN_BRIDGE.includes(ALIGN_TRIGGER_SHARED));
	for (const text of [ALIGN_TOOL_DESCRIPTION, ...ALIGN_TOOL_GUIDELINES, DELEGATE_ALIGN_BRIDGE, buildDelegateAlignBridge(true), ALIGN_TRIGGER_SHARED]) {
		assert.doesNotMatch(text, /\b(?:Eager|Careful|eagerness)\b/i, "never names a choice");
		assert.doesNotMatch(text, /the user said|user asks for something|has said they want/, "no trigger of its own");
	}
	const delegate = { mode: "delegate" as const, strict: false, minorModes: ["align" as const] };
	const bridge = (eagerness: "eager" | "careful") => {
		const text = composePrompt(delegate, DEFAULT_ROUTES, null, delegate.minorModes, { eagerness, style: "pm", visuals: false })!;
		return text.slice(0, text.indexOf("# Minor mode: align"));
	};
	assert.equal(bridge("careful"), bridge("eager"), "the delegate block and bridge are the same bytes under both choices");
	assert.match(DELEGATE_ALIGN_BRIDGE, /When a lighter worker \(an Investigation worker you sent on a bug report or a question\) already investigated the same matter and the user then asks for the change, put the root cause it found in the planning worker's prompt/);
});

test("the eagerness note: the new choice's trigger paragraph, replacing the one the block carries", () => {
	assert.equal(
		buildAlignEagernessNote("careful"),
		`Eagerness change: the user set the align eagerness to Careful. This paragraph replaces the "Which prompts open an alignment" paragraph your align instructions carry (or an earlier note gave), from now on:\n\n${ALIGN_TRIGGER_PARAGRAPHS.careful}`,
	);
	assert.ok(buildAlignEagernessNote("eager").endsWith(ALIGN_TRIGGER_PARAGRAPHS.eager));
	for (const e of ALIGN_EAGERNESSES) assert.ok(ALIGN_TRIGGER_PARAGRAPHS[e].startsWith("Which prompts open an alignment"), "the paragraph the note names is the one it replaces");
});

test("restoreHead: the Eagerness told and the head's, from the newest note, else the head's record, else Eager", () => {
	const note = (details: Record<string, unknown>) => ({ type: "custom_message", customType: MODE_NOTE_TYPE, details: { v: 1, minorModes: ["align"], guides: [], ...details } });
	const user = { type: "message", message: { role: "user" } };
	assert.deepEqual(restoreHead([user, note({ eagerness: "careful", headEagerness: "eager" })]).eagerness, { told: "careful", head: "eager" });
	assert.equal(restoreHead([user, note({ eagerness: "careful", headEagerness: "eager" })]).headEagerness, "eager");
	assert.equal(restoreHead([user, note({ style: "pm", headStyle: "pm" })]).eagerness, undefined, "a style-only note tells no Eagerness");
	assert.equal(restoreHead([user]).headEagerness, "eager", "a head nothing records was built Eager");
	assert.equal(restoreHead([{ type: "custom", customType: "mode-head", data: { v: 1, style: "default", eagerness: "careful" } }, user]).headEagerness, "careful", "the head's own record");
	assert.equal(restoreHead([{ type: "custom", customType: "mode-head", data: { v: 1, style: "pm" } }, user]).headEagerness, "eager", "an older record names no Eagerness: Eager");
	assert.equal(restoreHead([note({ eagerness: "careful", headEagerness: "careful" }), { type: "compaction" }]).eagerness, undefined, "nothing across a compaction");
	assert.equal(restoreHead([user, note({ eagerness: "timid", headEagerness: "eager" })]).eagerness, undefined, "an unknown value is skipped");
});

test("the paragraphs: Technical (\"default\") adds no text; Simplified and Project manager add exactly their own; Visuals follows the style", () => {
	assert.equal(ALIGN_STYLE_PARAGRAPHS.default, undefined);
	assert.equal(buildAlignPrompt(), ALIGN_INSTRUCTIONS, "Technical, Visuals off: the align block is today's, byte for byte");
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
	assert.match(ALIGN_VISUALS_PARAGRAPH, /a wireframe for a simple screen or a flow across screens; an html prototype for a screen beyond a simple one \(look and feel, panes side by side, an editor in a dialog, a dense desktop layout\); a flow, state or steps for a change in behaviour/);
	assert.match(ALIGN_VISUALS_PARAGRAPH, /call vis_guide with that kind/);
	assert.match(ALIGN_VISUALS_PARAGRAPH, /In the Project manager writing style never use the code, tree or layers kinds/);
	assert.doesNotMatch(ALIGN_VISUALS_PARAGRAPH, /Writing style:/, "its words never depend on the style");
	assert.match(ALIGN_VISUALS_PARAGRAPH, /never a vis fence in your reply/);
	// The planning worker's drawings come in its file (the bridge), so the paragraph has no after-import step.
	assert.doesNotMatch(ALIGN_VISUALS_PARAGRAPH, /import|planning worker/);
});

test("composePrompt: the head's align block carries the style and Visuals; the Delegate bridge follows Visuals, never the style", () => {
	const align = { mode: "normal" as const, strict: false, minorModes: ["align" as const] };
	assert.equal(composePrompt(align, DEFAULT_ROUTES), ALIGN_INSTRUCTIONS, "no options: today");
	assert.equal(composePrompt(align, DEFAULT_ROUTES, null, align.minorModes, { style: "default", visuals: false }), ALIGN_INSTRUCTIONS);
	assert.equal(composePrompt(align, DEFAULT_ROUTES, null, align.minorModes, { style: "pm", visuals: false }), `${ALIGN_INSTRUCTIONS}\n\n${ALIGN_STYLE_PARAGRAPHS.pm}`);
	const delegate = { ...align, mode: "delegate" as const };
	const bridgeOf = (options: { style: "default" | "simplified" | "pm"; visuals: boolean }) => {
		const text = composePrompt(delegate, DEFAULT_ROUTES, null, delegate.minorModes, options)!;
		return text.slice(text.indexOf("The align minor mode is on"), text.indexOf("# Minor mode: align"));
	};
	for (const style of ["default", "simplified", "pm"] as const) {
		assert.equal(bridgeOf({ style, visuals: false }), `${DELEGATE_ALIGN_BRIDGE}\n\n`, `${style}, Visuals off: the plain bridge`);
		assert.equal(bridgeOf({ style, visuals: true }), `${buildDelegateAlignBridge(true)}\n\n`, `${style}, Visuals on: the drawing bridge`);
	}
	assert.equal(composePrompt(delegate, DEFAULT_ROUTES)!.includes(DELEGATE_ALIGN_BRIDGE), true, "no options: Visuals off");
	assert.match(DELEGATE_ALIGN_BRIDGE, /copy the one in effect word for word into the planning worker's prompt/);
	assert.match(DELEGATE_ALIGN_BRIDGE, /"technical"\?: \[string/, "the file schema the worker writes carries technical notes");
	// Visuals on: the schema the worker writes takes visuals, and its prompt gets the drawing paragraph, word for word.
	const drawing = buildDelegateAlignBridge(true);
	assert.ok(drawing.startsWith(DELEGATE_ALIGN_BRIDGE.replace(alignFileSchema(false), alignFileSchema(true))), "the same bridge, with the visual schema");
	assert.ok(drawing.endsWith(`Visuals are on: also copy this paragraph word for word into its prompt:\n\n${PLANNER_VISUALS_PARAGRAPH}`));
	assert.doesNotMatch(DELEGATE_ALIGN_BRIDGE, /visual|Drawings/i);
	assert.match(PLANNER_VISUALS_PARAGRAPH, /a wireframe for a simple screen or a flow across screens; an html prototype for a screen beyond a simple one; a flow, state or steps for a change in behaviour/);
	assert.match(PLANNER_VISUALS_PARAGRAPH, /at most 3 in all/);
	assert.ok(PLANNER_VISUALS_PARAGRAPH.includes(`read shared.md and <kind>.md in ${VIS_GUIDE_DIR} and use only that syntax`));
	// The directory it names is the one vis_guide reads: each taught kind's file and shared.md are there.
	assert.ok(isAbsolute(VIS_GUIDE_DIR) && VIS_GUIDE_DIR.endsWith("/vis/"));
	for (const name of ["shared", "wireframe", "flow", "state", "steps"]) assert.ok(existsSync(join(VIS_GUIDE_DIR, `${name}.md`)), name);
	assert.doesNotMatch(PLANNER_VISUALS_PARAGRAPH, /Writing style/, "its words never depend on the style");
	assert.match(PLANNER_VISUALS_PARAGRAPH, /Project manager writing style never use the code, tree or layers kinds/);
	assert.equal(PLANNER_VISUALS_PARAGRAPH.match(/Project manager/g)?.length, 1, "the ban sentence is its only style mention");
	// Align off: no paragraph anywhere, whatever the style.
	assert.equal(composePrompt({ ...align, minorModes: [] }, DEFAULT_ROUTES, null, [], { style: "pm", visuals: true }), undefined);
	// Align turned on by a note: the block it carries is written in the style now.
	const note = buildModeNote([], ["align"], { head: [], guides: [] }, null, false, { style: "simplified", visuals: false })!;
	assert.ok(note.text.endsWith(`${ALIGN_INSTRUCTIONS}\n\n${ALIGN_STYLE_PARAGRAPHS.simplified}`));
});

test("the style note: the new paragraph, or, to Technical, that the old one no longer applies", () => {
	assert.equal(buildAlignStyleNote("default", "pm"), `Writing style change: the user set the align writing style to Project manager. It applies to every alignment you write or change from now on, instead of any earlier writing style:\n\n${ALIGN_STYLE_PARAGRAPHS.pm}`);
	assert.match(buildAlignStyleNote("pm", "simplified"), /to Simplified\.[\s\S]*Writing style: Simplified\./);
	assert.equal(
		buildAlignStyleNote("simplified", "default"),
		'Writing style change: the user set the align writing style to Technical. The earlier "Writing style: Simplified" paragraph no longer applies; write alignments with the files, code and technical trade-offs they need from now on.',
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
	assert.equal(visToolsWanted(["spec", "memory"], true), false);
	assert.equal(visToolsWanted(["align", "vis"], false), true);
});
