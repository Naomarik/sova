// Offline SDK test: the align writing style and Visuals (§chat.alignment/style, §chat.alignment/visuals).
//
// The style's paragraph joins the align block when the head is built, and a later change reaches the
// model once, as a hidden mode-note, never by rewriting the prompt; a reopen neither tells it twice nor
// rebuilds the head with the new style. Visuals are fixed at session start: with align on they bring the
// vis tools and the align tool's visual fields, even with vis off. A real AgentSession with a scripted
// provider and the real mode extension. No model requests.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { jiti } from "../../subagents/tests/runtime.mjs";

const scratchRoot = process.env.MODE_TEST_SCRATCH ?? path.join(homedir(), ".cache", "mode-tests");
mkdirSync(scratchRoot, { recursive: true });
const agentDir = mkdtempSync(path.join(scratchRoot, "style-turn-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const cwd = mkdtempSync(path.join(scratchRoot, "style-turn-cwd-"));
const sessionDir = path.join(agentDir, "sessions");

const { createAgentSession, DefaultResourceLoader, initTheme, SessionManager, SettingsManager } = await jiti.import("@earendil-works/pi-coding-agent");
initTheme();
const { createAssistantMessageEventStream, getCurrentSystemPrompt } = await jiti.import("@earendil-works/pi-ai");
const { ALIGN_STYLE_PARAGRAPHS, ALIGN_VISUALS_PARAGRAPH, ALIGN_INSTRUCTIONS } = await jiti.import(path.resolve(new URL("../minor.ts", import.meta.url).pathname));

let requests = [];
const textOf = (content) => (typeof content === "string" ? content : (content ?? []).filter((b) => b.type === "text").map((b) => b.text).join(""));

function streamSimple(model, context) {
	const stream = createAssistantMessageEventStream();
	const messages = context.messages;
	requests.push({
		prompt: getCurrentSystemPrompt(messages) ?? "",
		midSystem: messages.slice(1).filter((m) => m.role === "system" && (textOf(m.content) !== "" || m.sections !== undefined)).length,
		users: messages.filter((m) => m.role === "user").map((m) => textOf(m.content)),
	});
	const message = { role: "assistant", content: [{ type: "text", text: "done" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
	(async () => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: "done", partial: message });
		stream.push({ type: "done", reason: "stop", message });
	})();
	return stream;
}

async function open(sessionManager, flags = {}) {
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		additionalExtensionPaths: [path.resolve(new URL("../index.ts", import.meta.url).pathname)],
		extensionFactories: [
			(pi) => {
				pi.registerProvider("scripted", {
					baseUrl: "http://localhost",
					apiKey: "unused",
					api: "openai-completions",
					models: [{ id: "scripted-1", name: "scripted-1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
					streamSimple,
				});
			},
		],
	});
	await resourceLoader.reload();
	for (const [name, value] of Object.entries(flags)) resourceLoader.getExtensions().runtime.flagValues.set(name, value);
	const settingsManager = SettingsManager.inMemory({});
	const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager, sessionManager });
	await session.bindExtensions({ mode: "rpc" });
	await session.setModel(session.modelRuntime.getModel("scripted", "scripted-1"));
	await session.extensionRunner.getCommand("mode").handler("sync", session.extensionRunner.createCommandContext());
	return session;
}

const mode = (session, args) => session.extensionRunner.getCommand("mode").handler(args, session.extensionRunner.createCommandContext());
const notes = (session) => session.sessionManager.getEntries().filter((e) => e.type === "custom_message" && e.customType === "mode-note");
const setAlign = (style, visuals) => {
	const file = path.join(agentDir, "mode-align.json");
	writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, style, visuals }));
	renameSync(`${file}.tmp`, file);
};
const styleNotes = (users) => users.filter((u) => u.startsWith("Writing style change:"));

try {
	// ── The style ─────────────────────────────────────────────────────────────────────────────────
	setAlign("pm", false);
	let session = await open(SessionManager.create(cwd, sessionDir));
	let file;
	let head;
	try {
		await mode(session, "align on");
		await session.prompt("one");
		head = requests.at(-1).prompt;
		assert.ok(head.includes(`${ALIGN_INSTRUCTIONS}\n\n${ALIGN_STYLE_PARAGRAPHS.pm}`), "the Project manager paragraph follows the align block in the head");
		assert.ok(!head.includes(ALIGN_VISUALS_PARAGRAPH), "Visuals off: no visuals paragraph");
		assert.ok(!session.getActiveToolNames().includes("vis_guide"), "Visuals off, vis off: no vis_guide");
		assert.equal(styleNotes(requests.at(-1).users).length, 0, "the head carries the style: no note");

		setAlign("simplified", false);
		await session.prompt("two");
		let request = requests.at(-1);
		assert.equal(request.prompt, head, "a style change never rewrites the prompt");
		assert.equal(request.midSystem, 0, "and patches nothing mid-conversation");
		assert.equal(styleNotes(request.users).length, 1, "one hidden note");
		assert.ok(request.users.at(-1).endsWith(ALIGN_STYLE_PARAGRAPHS.simplified), "carrying the new style's paragraph");
		assert.equal(notes(session).length, 1);
		assert.equal(notes(session)[0].display, false, "stored hidden");
		assert.deepEqual(notes(session)[0].details, { v: 1, minorModes: ["align"], guides: [], style: "simplified", headStyle: "pm" });

		await session.prompt("three");
		assert.equal(styleNotes(requests.at(-1).users).length, 1, "told once: the history replays it, nothing new");
		assert.equal(notes(session).length, 1);
		file = session.sessionManager.getSessionFile();
	} finally {
		session.dispose();
	}

	// Reopen: the head it started with (Project manager), the simplified note replayed, nothing told again.
	session = await open(SessionManager.open(file, sessionDir));
	try {
		await session.prompt("four");
		const request = requests.at(-1);
		assert.equal(request.prompt, head, "a reopened session rebuilds the head it started with, style included");
		assert.equal(styleNotes(request.users).length, 1, "the earlier note, nothing new");
		assert.equal(notes(session).length, 1);

		// Back to Default: one note saying the paragraph no longer applies.
		setAlign("default", false);
		await session.prompt("five");
		assert.equal(requests.at(-1).prompt, head);
		assert.match(requests.at(-1).users.at(-1), /^Writing style change: the user set the align writing style back to Default\. The earlier "Writing style: Simplified" paragraph no longer applies/);
		assert.equal(notes(session).length, 2);
	} finally {
		session.dispose();
	}

	// Align off: a style change tells nothing (no align block in context to change).
	session = await open(SessionManager.inMemory(cwd));
	try {
		await session.prompt("no align");
		setAlign("pm", false);
		await session.prompt("still no align");
		assert.equal(styleNotes(requests.at(-1).users).length, 0, "no align, no style note");
		// Align turned on by a note: its block carries the style now, and no second note follows.
		await mode(session, "align on");
		await session.prompt("align by note");
		const last = requests.at(-1).users.at(-1);
		assert.ok(last.includes(`${ALIGN_INSTRUCTIONS}\n\n${ALIGN_STYLE_PARAGRAPHS.pm}`), "the align block in the note is written in the style now");
		assert.equal(styleNotes(requests.at(-1).users).length, 0, "no separate style note");
		await session.prompt("after");
		assert.equal(styleNotes(requests.at(-1).users).length, 0);
	} finally {
		session.dispose();
	}

	// ── Visuals ───────────────────────────────────────────────────────────────────────────────────
	// The caller's flag wins over the file (Sova's launch record); align on, vis off: the vis tools come with it.
	setAlign("default", false);
	session = await open(SessionManager.inMemory(cwd), { "align-visuals": "on" });
	try {
		await mode(session, "align on");
		await session.prompt("draw");
		const first = requests.at(-1);
		assert.ok(first.prompt.includes(`${ALIGN_INSTRUCTIONS}\n\n${ALIGN_VISUALS_PARAGRAPH}`), "Default style, Visuals on: the visuals paragraph right after the align block");
		const tools = session.getActiveToolNames();
		assert.ok(tools.includes("vis_guide"), "align on with Visuals: vis_guide is in the loadout, vis off");
		const align = session.getAllTools().find((t) => t.name === "align");
		assert.match(JSON.stringify(align.parameters), /"visual"/, "the align tool's schema offers visual");
		await session.prompt("again");
		assert.deepEqual(session.getActiveToolNames(), tools, "the tool set holds across runs");
		await mode(session, "align off");
		await session.prompt("align off");
		assert.ok(!session.getActiveToolNames().includes("vis_guide"), "align off, vis off: no vis tools");
	} finally {
		session.dispose();
	}
	// The flag off wins over a file that says on; no flag reads the file.
	setAlign("default", true);
	session = await open(SessionManager.inMemory(cwd), { "align-visuals": "off" });
	try {
		await mode(session, "align on");
		await session.prompt("off by flag");
		assert.ok(!session.getActiveToolNames().includes("vis_guide"), "flag off: no vis tools");
		assert.doesNotMatch(JSON.stringify(session.getAllTools().find((t) => t.name === "align").parameters), /"visual"/, "and no visual fields");
		assert.ok(!requests.at(-1).prompt.includes(ALIGN_VISUALS_PARAGRAPH));
	} finally {
		session.dispose();
	}
	session = await open(SessionManager.inMemory(cwd));
	try {
		await mode(session, "align on");
		await session.prompt("on by file");
		assert.ok(session.getActiveToolNames().includes("vis_guide"), "no flag (the TUI): mode-align.json's Visuals");
		setAlign("default", false);
		await session.prompt("file turned off mid-session");
		assert.ok(session.getActiveToolNames().includes("vis_guide"), "Visuals are fixed at session start");
	} finally {
		session.dispose();
	}
	console.log("style-turn: ok");
} finally {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
}
