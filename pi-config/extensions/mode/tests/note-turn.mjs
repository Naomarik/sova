// Offline SDK test: a minor-mode toggle keeps the prompt head, and reaches the model as a hidden note.
//
// pi diffs the mode section against the one the model already has. On a model without
// mid-conversation system messages a changed section rewrites the head (the whole cached prefix),
// and the claude-code provider restarts its CLI. So the head's minor blocks stay as the first run
// built them, and a toggle becomes a `mode-note` custom message (display: false). This drives a real
// AgentSession with a scripted provider and the real mode extension through a toggle on, a toggle off
// in a run a worker's report starts, a reopen and a compaction. No model requests.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { jiti } from "../../subagents/tests/runtime.mjs";

const scratchRoot = process.env.MODE_TEST_SCRATCH ?? path.join(homedir(), ".cache", "mode-tests");
mkdirSync(scratchRoot, { recursive: true });
const agentDir = mkdtempSync(path.join(scratchRoot, "note-turn-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const cwd = mkdtempSync(path.join(scratchRoot, "note-turn-cwd-"));
const sessionDir = path.join(agentDir, "sessions");

const { createAgentSession, DefaultResourceLoader, initTheme, SessionManager, SettingsManager } = await jiti.import("@earendil-works/pi-coding-agent");
// `/mode` renders its status line through the theme the TUI initialises at startup.
initTheme();
const { createAssistantMessageEventStream, getCurrentSystemPrompt } = await jiti.import("@earendil-works/pi-ai");
const { VIS_INSTRUCTIONS } = await jiti.import(path.resolve(new URL("../minor.ts", import.meta.url).pathname));

/** Per provider request: the system prompt it leads with, its later system messages, and its user texts. */
let requests = [];
/** Where the extension-supplied compaction keeps from (an entry id), set by the scenario. */
let keepFrom;

const textOf = (content) => (typeof content === "string" ? content : (content ?? []).filter((b) => b.type === "text").map((b) => b.text).join(""));

function streamSimple(model, context) {
	const stream = createAssistantMessageEventStream();
	const messages = context.messages;
	requests.push({
		prompt: getCurrentSystemPrompt(messages) ?? "",
		midSystem: messages.slice(1).filter((m) => m.role === "system").length,
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

async function open(sessionManager) {
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
					models: ["scripted-1", "writer-a", "writer-b"].map(id => ({ id, name: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 })),
					streamSimple,
				});
				// A compaction without a summarizer request, keeping from the entry the scenario names.
				pi.on("session_before_compact", async (event) => ({ compaction: { summary: "Earlier: files were read.", firstKeptEntryId: keepFrom ?? event.preparation.firstKeptEntryId, tokensBefore: 100 } }));
			},
		],
	});
	await resourceLoader.reload();
	// A tiny keep-recent budget, so this short session has something to compact.
	const settingsManager = SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } });
	const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager, sessionManager });
	await session.bindExtensions({ mode: "rpc" });
	const model = session.modelRuntime.getModel("scripted", "scripted-1");
	assert.ok(model, "the scripted provider registered its model");
	await session.setModel(model);
	// As Sova opens a chat: the quiet sync that adopts the host's base options.
	await session.extensionRunner.getCommand("mode").handler("sync", session.extensionRunner.createCommandContext());
	return session;
}

const mode = (session, args) => session.extensionRunner.getCommand("mode").handler(args, session.extensionRunner.createCommandContext());
const systemEntries = (session) => session.sessionManager.getEntries().filter((e) => e.type === "message" && e.message.role === "system");
const noteEntries = (session) => session.sessionManager.getEntries().filter((e) => e.type === "custom_message" && e.customType === "mode-note");

try {
	let session = await open(SessionManager.create(cwd, sessionDir));
	let file;
	let head;
	try {
		await session.prompt("one");
		head = requests[0].prompt;
		assert.doesNotMatch(head, /# Minor mode: vis/);
		assert.equal(systemEntries(session).length, 1, "the first run records the head");

		// (a) Toggle on: same head, no system message, the guide in a hidden note beside the prompt.
		await mode(session, "vis on");
		await session.prompt("two");
		let request = requests.at(-1);
		assert.equal(request.prompt, head, "the provider's system prompt is byte-identical after the toggle");
		assert.equal(request.midSystem, 0, "no mid-conversation system message: nothing for a provider to fold into its head");
		assert.equal(systemEntries(session).length, 1, "no prompt patch in the transcript");
		const on = request.users.at(-1);
		assert.ok(on.startsWith("Mode change: the user turned the vis minor mode on."), "the note follows the user's prompt");
		assert.ok(on.endsWith(VIS_INSTRUCTIONS), "with the whole vis guide");
		assert.equal(request.users.at(-2), "two");
		assert.equal(noteEntries(session).length, 1);
		assert.equal(noteEntries(session)[0].display, false, "stored hidden");
		assert.deepEqual(noteEntries(session)[0].details, { v: 1, minorModes: ["vis"], guides: ["vis"] });
		await session.prompt("three");
		assert.equal(requests.at(-1).users.filter((u) => u.startsWith("Mode change:")).length, 1, "told once: the history replays it, nothing new");

		// Toggle off, then a run a worker's report starts: the note is steered in before its request.
		await mode(session, "vis off");
		await session.sendCustomMessage({ customType: "subagent-complete", content: "worker done", display: true }, { triggerTurn: true });
		await session.waitForIdle?.();
		request = requests.at(-1);
		assert.equal(request.prompt, head);
		assert.equal(request.midSystem, 0);
		assert.match(request.users.at(-1), /^Mode change: the user turned the vis minor mode off\. Its instructions \(the "# Minor mode: vis" block given earlier in this conversation\) no longer apply/);
		assert.equal(systemEntries(session).length, 1);

		// A switch the model hasn't heard of yet when the session closes.
		await mode(session, "vis on");
		file = session.sessionManager.getSessionFile();
	} finally {
		session.dispose();
	}

	// (c) Reopen: the start-time head, the pending switch told, the older notes replayed from history.
	session = await open(SessionManager.open(file, sessionDir));
	try {
		await session.prompt("four");
		const request = requests.at(-1);
		assert.equal(request.prompt, head, "a reopened session rebuilds the head it started with");
		assert.equal(request.midSystem, 0);
		assert.equal(systemEntries(session).length, 1, "and records no patch for it");
		assert.match(request.users.at(-1), /^Mode change: the user turned the vis minor mode back on\. Its instructions \(the "# Minor mode: vis" block given earlier in this conversation\) apply again/);
		assert.equal(request.users.filter((u) => u.startsWith("Mode change:")).length, 3, "every note so far is in the request");

		// (d) Compaction, keeping the recent tail from the vis-on note's prompt ("two"): the next run
		// rebuilds the head with vis, and the kept notes leave the request.
		keepFrom = session.sessionManager.getEntries().find((e) => e.type === "message" && e.message.role === "user" && textOf(e.message.content) === "two").id;
		await session.compact();
		await session.prompt("five");
		const after = requests.at(-1);
		assert.notEqual(after.prompt, head, "the compaction rebuilt the head");
		assert.match(after.prompt, /# Minor mode: vis/, "with the modes active at that point");
		assert.equal(after.users.filter((u) => u.startsWith("Mode change:")).length, 0, "no guide twice: the notes the compaction kept are dropped");
		assert.ok(after.users.includes("two"), "the kept tail itself stays");
		const rebuilt = after.prompt;
		await session.prompt("six");
		assert.equal(requests.at(-1).prompt, rebuilt, "stable from then on");
		file = session.sessionManager.getSessionFile();
	} finally {
		session.dispose();
	}

	session = await open(SessionManager.open(file, sessionDir));
	try {
		await session.prompt("seven");
		assert.equal(requests.at(-1).prompt, requests.at(-2).prompt, "reopened after the compaction: the rebuilt head");
		assert.equal(requests.at(-1).midSystem, 0);
	} finally {
		session.dispose();
	}
	// Writer routes for spec introduced only by a note must reach actual requests, once per change.
	session = await open(SessionManager.inMemory(cwd));
	const setWriter = (id) => {
		const file = path.join(agentDir, "mode-spec.json");
		writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, writer: id ? { primary: { backend: "pi", model: `scripted/${id}`, effort: "off" }, fallback: null } : null }));
		renameSync(`${file}.tmp`, file);
	};
	try {
		await session.prompt("writer baseline");
		const withoutSpec = requests.at(-1).prompt;
		assert.doesNotMatch(withoutSpec, /# Minor mode: spec/);
		setWriter("writer-a");
		await mode(session, "spec on");
		await session.prompt("enable spec by note");
		assert.equal(requests.at(-1).prompt, withoutSpec, "spec still absent from head");
		assert.match(requests.at(-1).users.at(-1), /scripted\/writer-a/);
		setWriter("writer-b");
		const beforeNotes = noteEntries(session).length;
		await session.sendCustomMessage({ customType: "subagent-complete", content: "writer wake", display: true }, { triggerTurn: true });
		await session.waitForIdle();
		const request = requests.at(-1), latest = request.users.at(-1);
		assert.equal(request.prompt, withoutSpec);
		assert.match(latest, /routing now applies instead of any earlier writer routing/);
		assert.match(latest, /scripted\/writer-b/);
		assert.doesNotMatch(latest, /scripted\/writer-a/);
		assert.equal(request.users.join("\n").split("scripted/writer-b").length - 1, 1, "new route reaches actual request exactly once");
		assert.equal(noteEntries(session).length, beforeNotes + 1, "one stored route-change note");
		await session.prompt("unchanged writer");
		assert.equal(noteEntries(session).length, beforeNotes + 1, "no duplicate note next prompt");
		setWriter(null);
		await session.sendCustomMessage({ customType: "subagent-complete", content: "cleared writer wake", display: true }, { triggerTurn: true });
		await session.waitForIdle();
		assert.match(requests.at(-1).users.at(-1), /no worker is configured; write draft claims and evidence yourself/);
		assert.doesNotMatch(requests.at(-1).users.at(-1), /scripted\/writer-[ab]/);
		assert.equal(noteEntries(session).length, beforeNotes + 2, "clearing writer delivered once");
	} finally { session.dispose(); }
	console.log("note-turn: ok");
} finally {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(cwd, { recursive: true, force: true });
}
