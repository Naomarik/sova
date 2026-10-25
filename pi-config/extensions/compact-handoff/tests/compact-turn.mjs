// Offline SDK test: /compact-handoff on a real AgentSession, with pi's own compaction settings.
//
// A real pi session (a scripted provider, pi's default keep-recent budget of 20,000 tokens), the real
// extension, and a fake background fork the test settles with a note. No model requests, no child.
// - A short session: pi's compact() would have nothing to summarize, so the command is refused before
//   any fork, with a notification (the drive at b752e17d saw the note saved, then no compaction).
// - A session past the budget: the fork's note is saved, then pi compacts: a compaction entry follows
//   the saved row, and the note comes back after the summary.
import "../../claude-code/tests/hermetic-env.mjs"; // first: a throwaway HOME and agent dir
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { jiti } from "./runtime.mjs";

const root = mkdtempSync(path.join(tmpdir(), "compact-turn-"));
const agentDir = path.join(root, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream } = await jiti.import("@earendil-works/pi-ai");
const { default: compactHandoff } = await jiti.import(path.resolve(import.meta.dirname, "../index.ts"));

/** Every reply is "ok"; pi's summary request gets a recognizable summary. */
function streamSimple(model, context) {
	const stream = createAssistantMessageEventStream();
	const last = context.messages.at(-1);
	const asked = typeof last?.content === "string" ? last.content : (last?.content ?? []).map((b) => b.text ?? "").join("");
	const text = /context checkpoint summary/i.test(asked) ? "THE-SUMMARY" : "ok";
	const message = { role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

async function open(name) {
	const cwd = mkdtempSync(path.join(root, `${name}-`));
	const forks = [];
	const notes = [];
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		extensionFactories: [
			(pi) =>
				pi.registerProvider("scripted", {
					baseUrl: "http://localhost",
					apiKey: "unused",
					api: "openai-completions",
					models: [{ id: "scripted-1", name: "scripted-1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 1000 }],
					streamSimple,
				}),
			(pi) =>
				compactHandoff(pi, {
					workerHost: () => ({}),
					start: (_spec, handlers) => {
						forks.push(handlers);
						return { stop: async () => {}, detach: () => {} };
					},
				}),
		],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager: SettingsManager.inMemory(), sessionManager: SessionManager.create(cwd, path.join(agentDir, "sessions")) });
	const ui = { notify: (message, level) => notes.push({ message, level }), setStatus() {}, setWidget() {}, setTitle() {}, select: async () => undefined, confirm: async () => false, input: async () => undefined };
	await session.bindExtensions({ mode: "rpc", uiContext: ui });
	await session.setModel(session.modelRuntime.getModel("scripted", "scripted-1"));
	return { session, forks, notes };
}

const kinds = (session) => session.sessionManager.getBranch().map((e) => (e.type === "custom" ? `${e.customType}:${e.data?.status ?? ""}` : e.type === "custom_message" ? e.customType : e.type));
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

// A short session: refused before any fork.
{
	const { session, forks, notes } = await open("short");
	await session.prompt("a short question");
	await session.prompt("/compact-handoff the focus");
	assert.equal(forks.length, 0, "no fork for a session pi has nothing to compact in");
	assert.ok(notes.some((n) => /nothing can be compacted yet/.test(n.message) && n.level === "warning"), `the refusal is a notification: ${JSON.stringify(notes)}`);
	assert.equal(kinds(session).some((k) => k.startsWith("compact-handoff")), false, "no run row, no note entry");
	console.log("ok short session: refused before any fork");
}

// A session past the 20,000-token budget: saved, then compacted, then the note after the summary.
{
	const { session, forks, notes } = await open("long");
	for (const i of [1, 2, 3]) await session.prompt(`turn ${i}: ${"lorem ipsum dolor sit amet ".repeat(2500)}`);
	await session.prompt("/compact-handoff the focus");
	assert.equal(forks.length, 1, `the fork started: ${JSON.stringify(notes)}`);
	forks[0].onSettled({ outcome: "success", finalOutput: "<handoff>THE-NOTE</handoff>" });
	for (let i = 0; i < 50 && !kinds(session).includes("compaction"); i++) await settle();
	const after = kinds(session);
	const saved = after.indexOf("compact-handoff-run:saved");
	assert.ok(saved >= 0, `the run's row reads saved: ${after.join(", ")}`);
	assert.ok(after.indexOf("compaction") > saved, `a compaction follows the saved row: ${after.join(", ")}`);
	assert.equal(after.at(-1), "compact-handoff-note", "the note comes back right after the summary");
	assert.ok(session.sessionManager.getBranch().some((e) => e.type === "compaction" && e.summary.includes("THE-SUMMARY")));
	assert.equal(notes.some((n) => /compaction failed/.test(n.message)), false, `no failure: ${JSON.stringify(notes)}`);
	console.log("ok long session: saved, compacted, note restored");
}
