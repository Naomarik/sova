// The mode extension with project minor modes (§chat.mode-menu/project-modes), on a fake pi: the copy a chat
// keeps (byte-identical across a reopen and a compaction, whatever the folder says now), the hidden note for
// a mid-chat turn-on, approval, the tools in the loadout, removed and changed rows, and the worker hand-off.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "project-mode-ext-"));
const agentDir = join(scratch, "agent");
mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.SOVA_CHAT_STATE_ROOT = join(scratch, "state");
// index.ts imports pi's runtime: load it through the installed pi, like the other extension tests.
const { jiti } = await import("../subagents/tests/runtime.mjs");
const { default: modeExtension } = (await jiti.import(new URL("./index.ts", import.meta.url).pathname)) as { default: (pi: never) => void };
const { recordApproval } = await import("./project-tools-approval.ts");
const { MODE_WORKER_EVENT } = await import("./events.ts");
const { MODE_NOTE_TYPE } = await import("./state.ts");
const { PROJECT_SNAPSHOT_TYPE } = await import("./project-format.ts");
test.after(() => rmSync(scratch, { recursive: true, force: true }));

type Entry = { type: string; customType?: string; data?: unknown; details?: unknown; content?: unknown; message?: unknown };
type Handler = (event: unknown, ctx: unknown) => unknown;

/** A pi as far as the mode extension uses it: handlers, commands, entries, tools, the event bus. */
function fakePi(entries: Entry[], cwd: string) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const listeners = new Map<string, ((data: unknown) => void)[]>();
	const tools = new Map<string, { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }>();
	let active: string[] = ["read", "bash"];
	const notes: { text: string; level: string }[] = [];
	const sent: { customType: string; content: string; details: unknown }[] = [];
	const workerEvents: unknown[] = [];
	const pi = {
		on: (name: string, fn: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
		events: {
			on: (name: string, fn: (data: unknown) => void) => {
				listeners.set(name, [...(listeners.get(name) ?? []), fn]);
				return () => {};
			},
			emit: (name: string, data: unknown) => {
				if (name === MODE_WORKER_EVENT) workerEvents.push(data);
				for (const fn of listeners.get(name) ?? []) fn(data);
			},
		},
		registerFlag: () => {},
		getFlag: () => undefined,
		registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
		registerShortcut: () => {},
		registerEntryRenderer: () => {},
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }) => tools.set(tool.name, tool),
		getAllTools: () => [...tools.values()].map((t) => ({ name: t.name })),
		getActiveTools: () => [...active],
		setActiveTools: (next: string[]) => {
			active = [...next];
		},
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendMessage: (message: { customType: string; content: string; details: unknown }) => {
			sent.push(message);
			entries.push({ type: "custom_message", customType: message.customType, content: message.content, details: message.details });
		},
		sendUserMessage: () => {},
	};
	const ctx = {
		cwd,
		hasUI: false,
		mode: "rpc",
		signal: undefined,
		isIdle: () => true,
		sessionManager: { getBranch: () => entries, getSessionId: () => "s1", getHeader: () => ({ timestamp: new Date().toISOString() }) },
		ui: { notify: (text: string, level: string) => notes.push({ text, level }), setStatus: () => {}, setWidget: () => {}, theme: { fg: (_t: string, s: string) => s } },
		modelRegistry: { getAvailable: () => [] },
	};
	modeExtension(pi as never);
	const fire = async (name: string, event: unknown = {}) => {
		let result: unknown;
		for (const fn of handlers.get(name) ?? []) result = (await fn(event, ctx)) ?? result;
		return result;
	};
	return {
		notes,
		sent,
		tools,
		workerEvents,
		activeTools: () => [...active],
		start: (reason = "startup") => fire("session_start", { reason }),
		mode: (args: string) => commands.get("mode")!.handler(args, ctx),
		/** A user prompt: its run's system prompt sections, after the extension wrote them. */
		async prompt(): Promise<string | undefined> {
			entries.push({ type: "message", message: { role: "user" } });
			const sections: Record<string, string> = {};
			await fire("before_agent_start", { prompt: "go", systemPrompt: "base", systemPromptOptions: { sections } });
			await fire("agent_start");
			await fire("agent_settled");
			return sections.mode;
		},
		compact: async () => {
			entries.push({ type: "compaction" });
			await fire("session_compact");
		},
	};
}

function project(name: string) {
	const root = join(scratch, name);
	mkdirSync(join(root, ".git"), { recursive: true });
	const dirOf = (id: string) => join(root, ".sova", "minor-modes", id);
	const put = (id: string, rel: string, text: string) => {
		mkdirSync(join(dirOf(id), rel, ".."), { recursive: true });
		writeFileSync(join(dirOf(id), rel), text);
	};
	return { root, dirOf, put };
}

const notesMode = (body: string, workers = "no") => `---\ndescription: Keep notes\nworkers: ${workers}\n---\n${body}\n`;

test("t13: the copy turned on rebuilds byte-identically after the folder changed, on reopen and after a compaction", async () => {
	const p = project("t13");
	p.put("notes", "MODE.md", notesMode("Write notes in ./NOTES.md."));
	const entries: Entry[] = [];
	const a = fakePi(entries, p.root);
	await a.start();
	await a.mode("project:notes on");
	assert.ok(entries.some((e) => e.customType === PROJECT_SNAPSHOT_TYPE), "the copy is saved in the chat");
	const first = await a.prompt();
	assert.ok(first?.includes("# Project minor mode: notes\nFolder: "), first);
	assert.ok(first?.includes("Write notes in ./NOTES.md."));

	p.put("notes", "MODE.md", notesMode("EDITED instructions."));
	const b = fakePi(entries, p.root);
	await b.start("resume");
	const reopened = await b.prompt();
	assert.equal(reopened, first, "byte-identical mode section on reopen");
	await b.mode("status");
	assert.match(b.notes.at(-1)!.text, /notes \(on, changed since turned on\)/);

	await b.compact();
	const c = fakePi(entries, p.root);
	await c.start("resume");
	assert.equal(await c.prompt(), first, "after a compaction the head is rebuilt from the copy, never the folder");

	// Off and on again takes the edit.
	await c.mode("notes off");
	await c.mode("notes on");
	const d = fakePi(entries, p.root);
	await d.start("resume");
	await d.compact();
	assert.match((await d.prompt()) ?? "", /EDITED instructions\./);
});

test("turned on mid-chat: the prompt keeps its head, a hidden note carries the block once, a reopen repeats nothing", async () => {
	const p = project("midchat");
	p.put("notes", "MODE.md", notesMode("Mid-chat body."));
	const entries: Entry[] = [];
	const a = fakePi(entries, p.root);
	await a.start();
	const head = await a.prompt();
	await a.mode("notes on");
	assert.equal(await a.prompt(), head, "a toggle never rewrites the cached head");
	const note = a.sent.find((m) => m.customType === MODE_NOTE_TYPE);
	assert.ok(note?.content.includes("turned the project minor mode notes on") && note.content.includes("Mid-chat body."), note?.content);

	const b = fakePi(entries, p.root);
	await b.start("resume");
	assert.equal(await b.prompt(), head);
	assert.equal(b.sent.filter((m) => m.customType === MODE_NOTE_TYPE).length, 0, "nothing new to tell after a reopen");
	await b.mode("notes off");
	await b.prompt();
	assert.match(b.sent.at(-1)!.content, /turned the project minor mode notes off/);
});

test("approval, the tools in the loadout, a changed program refused, off takes them away", async () => {
	const p = project("tools");
	p.put("release", "MODE.md", `---\ndescription: Release\ntools: [{"name": "status", "description": "Status", "command": ["./bin/status.sh"]}]\n---\nUse release__status.\n`);
	p.put("release", "bin/status.sh", "#!/bin/sh\necho ready\n");
	chmodSync(join(p.dirOf("release"), "bin/status.sh"), 0o755);
	const entries: Entry[] = [];
	const a = fakePi(entries, p.root);
	await a.start();
	await a.mode("release on");
	assert.match(a.notes.at(-1)!.text, /approve it from a Sova chat's mode menu first/);
	assert.ok(!entries.some((e) => e.customType === PROJECT_SNAPSHOT_TYPE), "refused: nothing saved");

	const { discoverProjectModes } = await import("./project-discovery.ts");
	recordApproval(p.root, "release", discoverProjectModes(p.root).modes[0]!.toolsHash, "user");
	await a.mode("release on");
	assert.ok(a.activeTools().includes("release__status"), a.activeTools().join(","));
	const run = await a.tools.get("release__status")!.execute("c1", {}, undefined);
	assert.match(run.content[0]!.text, /ready/);

	p.put("release", "bin/status.sh", "#!/bin/sh\necho tampered\n");
	await assert.rejects(a.tools.get("release__status")!.execute("c2", {}, undefined), /the files of release changed since it was approved/);

	await a.mode("release off");
	assert.ok(!a.activeTools().includes("release__status"));
	await assert.rejects(a.tools.get("release__status")!.execute("c3", {}, undefined));
});

test("a deleted mode stays on, marked removed, until turned off; broken folders and clashes are listed, never turned on", async () => {
	const p = project("removed");
	p.put("notes", "MODE.md", notesMode("Body."));
	p.put("spec", "MODE.md", notesMode("Clash."));
	p.put("broken", "MODE.md", "no fence");
	const entries: Entry[] = [];
	const a = fakePi(entries, p.root);
	await a.start();
	await a.mode("notes on");
	await a.mode("project:broken on");
	assert.match(a.notes.at(-1)!.text, /not turned on: .*MODE\.md must start/);
	await a.mode("project:spec on");
	assert.match(a.notes.at(-1)!.text, /not turned on: .*built-in minor mode/, "a clash never replaces the built-in");
	rmSync(p.dirOf("notes"), { recursive: true });
	const b = fakePi(entries, p.root);
	await b.start("resume");
	await b.mode("status");
	const status = b.notes.at(-1)!.text;
	assert.match(status, /notes \(on, removed\)/);
	assert.match(status, /broken \(broken: .*MODE\.md must start/);
	assert.match(status, /spec \(broken: .*built-in/);
	assert.match((await b.prompt()) ?? "", /# Project minor mode: notes/);
	await b.mode("notes off");
	await b.mode("status");
	assert.doesNotMatch(b.notes.at(-1)!.text, /notes/);
});

test("workers: a workers: yes mode's copy reaches workers, within the cap", async () => {
	const p = project("workers");
	p.put("crew", "MODE.md", notesMode("Crew rules.", "yes"));
	p.put("solo", "MODE.md", notesMode("Solo rules."));
	const entries: Entry[] = [];
	const a = fakePi(entries, p.root);
	await a.start();
	await a.mode("crew on");
	await a.mode("solo on");
	const last = a.workerEvents.at(-1) as { minorModes: string[]; prompt?: string; projectModes?: { id: string }[] };
	assert.deepEqual(last.projectModes?.map((m) => m.id), ["crew"]);
	assert.ok(last.prompt?.includes("Crew rules.") && !last.prompt.includes("Solo rules."));
});
