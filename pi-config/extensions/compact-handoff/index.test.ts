/**
 * The command, the fork's settle, the deferred compaction and the restore on session_compact,
 * against a fake ExtensionAPI, context and background fork: no pi session, no model, no child.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BackgroundForkHandlers, BackgroundForkResult, BackgroundForkSpec } from "../subagents/fork/background.ts";
import compactHandoff from "./index.ts";
import { type BranchEntry, HANDOFF_ENTRY, NOTE_MESSAGE, NOTHING_NOTE } from "./handoff.ts";
import { RUN_ENTRY } from "./run.ts";

type Handler = (event: any, ctx: any) => unknown;
interface Sent { message: { customType: string; display?: boolean; content: unknown; details?: any }; options?: { triggerTurn?: boolean } }
interface CompactCall { customInstructions?: string; onComplete?: (r: unknown) => void; onError?: (e: Error) => void }
interface Fork { spec: BackgroundForkSpec; handlers: BackgroundForkHandlers; stopped: number; settle(result: Partial<BackgroundForkResult>): void }

const temps: string[] = [];
const temp = (): string => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "compact-handoff-index-"));
	temps.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	delete process.env.PI_CODING_AGENT_DIR;
});

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A session file with a real conversation, as pi writes it. */
function sessionFile(dir: string): string {
	const file = path.join(dir, "session.jsonl");
	const lines = [
		{ type: "session", version: 3, id: "sess-1", timestamp: "2026-10-03T11:00:00.000Z", cwd: dir },
		{ type: "message", id: "u0", parentId: null, message: { role: "user", content: "earlier work" } },
		{ type: "message", id: "a0", parentId: "u0", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
	];
	fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	return file;
}

function harness(options: { agentDir?: string; now?: () => number; file?: string | null; model?: { provider: string; id: string }; startThrows?: boolean; branch?: BranchEntry[] } = {}) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const branch: BranchEntry[] = options.branch ?? [{ type: "message", id: "u0", message: { role: "user", content: "earlier work" } }];
	const sent: Sent[] = [];
	const compacts: CompactCall[] = [];
	const notes: { message: string; level?: string }[] = [];
	const forks: Fork[] = [];
	const state = { idle: true, pending: false, n: 0 };
	const nextId = () => `e${++state.n}`;
	const cwd = temp();
	const file = options.file === null ? undefined : (options.file ?? sessionFile(cwd));
	const pi = {
		on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, command); },
		registerEntryRenderer() {},
		sendMessage(message: Sent["message"], opts?: Sent["options"]) {
			sent.push({ message, options: opts });
			branch.push({ type: "custom_message", id: nextId(), customType: message.customType, details: message.details });
		},
		appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", id: nextId(), customType, data }); },
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd,
		model: options.model ?? { provider: "zai", id: "glm-5.3" },
		thinkingLevel: "low",
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		ui: { notify: (message: string, level?: string) => { notes.push({ message, level }); } },
		sessionManager: {
			getSessionId: () => "sess-1",
			getSessionFile: () => file,
			getBranch: () => branch,
			getLeafId: () => branch.at(-1)?.id ?? null,
		},
		compact: (call: CompactCall) => { compacts.push(call); },
	} as unknown as ExtensionContext;
	compactHandoff(pi, {
		agentDir: options.agentDir ? () => options.agentDir! : undefined,
		now: options.now ?? (() => NOW),
		claudeForkPoint: () => undefined,
		start: (spec, h) => {
			if (options.startThrows) throw new Error("spawn pi ENOENT");
			let settled = false;
			const fork: Fork = {
				spec,
				handlers: h,
				stopped: 0,
				settle(result) {
					if (settled) return;
					settled = true;
					h.onSettled({ outcome: "success", finalOutput: "", ...result });
				},
			};
			forks.push(fork);
			return { stop: async () => { fork.stopped++; fork.settle({ outcome: "aborted" }); } };
		},
	});

	const fire = (event: { type: string } & Record<string, unknown>): unknown => {
		let result: unknown;
		for (const handler of handlers.get(event.type) ?? []) result = handler(event, ctx);
		return result;
	};
	const run = (args = "") => commands.get("compact-handoff")!.handler(args, ctx);
	const settleMain = async (between?: () => void) => {
		fire({ type: "agent_settled" });
		between?.();
		await tick();
	};
	const compaction = (firstKeptEntryId: string | null, reason = "manual") => {
		const entry = { type: "compaction", id: nextId(), firstKeptEntryId, summary: "S" } as BranchEntry & { firstKeptEntryId: string | null };
		branch.push(entry);
		fire({ type: "session_compact", compactionEntry: entry, fromExtension: false, reason, willRetry: false });
		return entry;
	};
	const rows = () => branch.filter((e) => e.type === "custom" && e.customType === RUN_ENTRY).map((e) => e.data as any);
	return { pi, ctx, state, branch, sent, compacts, notes, forks, fire, run, settleMain, compaction, rows, cwd, nextId };
}

const NOTE = "Decided: keep v1 shape.\nRe-read docs/plan.md and §chat.slash-commands/compact-handoff.";

test("refused while the agent streams, while compacting or with queued messages: a notification, no fork", async () => {
	const h = harness({ agentDir: temp() });
	h.state.idle = false;
	await h.run();
	h.state.idle = true;
	h.state.pending = true;
	await h.run();
	assert.equal(h.forks.length, 0);
	assert.equal(h.notes.length, 2);
	assert.match(h.notes[0]!.message, /waits for an idle session/);
});

test("a session with no conversation on disk is refused, no fork", async () => {
	const agent = temp();
	const h = harness({ agentDir: agent, file: null });
	await h.run();
	assert.equal(h.forks.length, 0);
	assert.match(h.notes[0]!.message, /nothing to hand off/);
	assert.equal(h.rows().length, 0);
});

test("the fork: a run-private copy and session dir, read-only policy, the parent's model, the focus in its task; only the running row enters the session", async () => {
	const agent = temp();
	const h = harness({ agentDir: agent });
	const before = h.branch.length;
	await h.run("  keep the API decisions ");
	assert.equal(h.forks.length, 1);
	const { spec } = h.forks[0]!;
	const runDir = path.join(agent, "compact-handoffs", ".runs", spec.id);
	assert.equal(spec.forkSession, path.join(runDir, "copy.jsonl"));
	assert.equal(spec.sessionDir, path.join(runDir, "sessions"));
	assert.ok(fs.readFileSync(spec.forkSession!, "utf8").includes('"id":"a0"'));
	assert.deepEqual(spec.policy, { label: "The handoff writer" });
	assert.equal(spec.model, "zai/glm-5.3");
	assert.equal(spec.effort, "low");
	assert.equal(spec.name, "compact-handoff");
	assert.match(spec.task, /<handoff>/);
	assert.match(spec.task, /read-only/);
	assert.match(spec.task, /focus for this handoff and the summary: keep the API decisions/);
	// Nothing but the row: no instruction, no turn.
	assert.equal(h.sent.length, 0);
	assert.deepEqual(h.branch.slice(before).map((e) => [e.type, e.customType]), [["custom", RUN_ENTRY]]);
	assert.deepEqual(h.rows(), [{ v: 1, id: spec.id, status: "running", at: new Date(NOW).toISOString(), focus: "keep the API decisions" }]);
	// A second run while one is under way is refused.
	await h.run();
	assert.equal(h.forks.length, 1);
	assert.match(h.notes.at(-1)!.message, /already under way/);
});

test("the fork lands: note saved under the agent dir, entry and saved row appended, run dir gone, compaction; the note comes back in full", async () => {
	const agent = temp();
	process.env.PI_CODING_AGENT_DIR = agent; // the default resolution, as pi's getAgentDir()
	const h = harness();
	await h.run("focus text");
	const fork = h.forks[0]!;
	const runDir = path.dirname(fork.spec.forkSession!);
	fork.settle({ finalOutput: `Checked the plan.\n<handoff>first draft</handoff>\n<handoff>\n${NOTE}\n</handoff>` });

	const file = path.join(agent, "compact-handoffs", "sess-1.md");
	const body = fs.readFileSync(file, "utf8");
	assert.match(body, /- session: sess-1/);
	assert.match(body, /- focus: focus text/);
	assert.ok(body.endsWith(`${NOTE}\n`));
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(fs.readdirSync(h.cwd), ["session.jsonl"]);
	assert.equal(fs.existsSync(runDir), false);

	const entry = h.branch.find((e) => e.type === "custom" && e.customType === HANDOFF_ENTRY);
	assert.deepEqual({ ...(entry!.data as object), leafId: undefined }, { v: 1, path: file, note: NOTE, at: new Date(NOW).toISOString(), leafId: undefined });
	assert.deepEqual(h.rows().map((r) => r.status), ["running", "saved"]);
	assert.equal(h.rows()[1].path, file);
	assert.equal(h.rows()[1].id, fork.spec.id);

	assert.equal(h.compacts.length, 1);
	assert.match(h.compacts[0]!.customInstructions!, /^focus text\n\n/);
	assert.ok(h.compacts[0]!.customInstructions!.includes(`saved at ${file}`));
	h.compacts[0]!.onComplete!({});
	// pi compacts, keeping a tail that starts at the earlier work: the note itself comes back.
	h.compaction("u0");
	const restore = h.sent.at(-1)!;
	assert.equal(restore.message.customType, NOTE_MESSAGE);
	assert.equal(restore.message.display, false);
	assert.ok(String(restore.message.content).includes(NOTE));
	// The main session never held the handoff turn.
	assert.equal(h.branch.some((e) => e.type === "message" && e.message?.role === "assistant"), false);
	assert.equal(h.branch.some((e) => e.type === "message" && e.message?.role === "toolResult"), false);
});

test("a nothing note: saved and compacted with no note line, nothing comes back then or later, and an older note is not revived", async () => {
	const agent = temp();
	const h = harness({ agentDir: agent });
	h.pi.appendEntry(HANDOFF_ENTRY, { v: 1, path: path.join(agent, "compact-handoffs", "sess-1.md"), note: "older note", at: "2026-10-03T09:00:00.000Z", leafId: "u0" });
	await h.run("focus text");
	h.forks[0]!.settle({ finalOutput: `Checked.\n<handoff>\n${NOTHING_NOTE}\n</handoff>` });
	const file = path.join(agent, "compact-handoffs", "sess-1.md");
	assert.ok(fs.readFileSync(file, "utf8").endsWith(`${NOTHING_NOTE}\n`));
	assert.equal((h.branch.filter((e) => e.customType === HANDOFF_ENTRY).at(-1)!.data as any).note, NOTHING_NOTE);
	assert.equal(h.rows().at(-1).status, "saved");
	assert.equal(h.compacts.length, 1);
	assert.equal(h.compacts[0]!.customInstructions, "focus text");
	h.compacts[0]!.onComplete!({});
	h.compaction("u0");
	h.branch.push({ type: "message", id: "u9", message: { role: "user", content: "later" } });
	h.compaction("u9", "threshold");
	assert.equal(h.sent.length, 0);
});

for (const [label, result, expect] of [
	["fork error", { outcome: "error", error: "429 rate limited", finalOutput: "<handoff>n</handoff>" }, /the fork failed \(429 rate limited\)/],
	["fork stopped", { outcome: "aborted", finalOutput: "" }, /the fork was stopped/],
	["no block", { outcome: "success", finalOutput: "Done, nothing to hand off." }, /no <handoff> note/],
] as const) {
	test(`${label}: nothing saved, no compaction, a failed row; the run dir stays for diagnosis`, async () => {
		const agent = temp();
		const h = harness({ agentDir: agent });
		await h.run();
		const fork = h.forks[0]!;
		const before = h.branch.length;
		fork.settle(result as Partial<BackgroundForkResult>);
		assert.equal(h.compacts.length, 0);
		assert.equal(fs.existsSync(path.join(agent, "compact-handoffs", "sess-1.md")), false);
		assert.equal(h.branch.some((e) => e.customType === HANDOFF_ENTRY), false);
		assert.deepEqual(h.branch.slice(before).map((e) => e.customType), [RUN_ENTRY]);
		assert.equal(h.rows().at(-1).status, "failed");
		assert.match(h.rows().at(-1).error, expect);
		assert.match(h.notes.at(-1)!.message, expect);
		assert.ok(fs.existsSync(fork.spec.forkSession!));
		// The handoff is over: the command runs again.
		await h.run();
		assert.equal(h.forks.length, 2);
	});
}

test("a failed run's dir is swept by a later run once it is a day old", async () => {
	const agent = temp();
	const h = harness({ agentDir: agent });
	await h.run();
	h.forks[0]!.settle({ outcome: "error" });
	const runDir = path.dirname(h.forks[0]!.spec.forkSession!);
	const old = new Date(NOW - 25 * 3600 * 1000);
	fs.utimesSync(runDir, old, old);
	await h.run();
	assert.equal(fs.existsSync(runDir), false);
	assert.ok(fs.existsSync(h.forks[1]!.spec.forkSession!));
});

test("the fork cannot start: refused with a notification, no row, no turn, no run dir left", async () => {
	const agent = temp();
	const h = harness({ agentDir: agent, startThrows: true });
	const before = h.branch.length;
	await h.run();
	assert.equal(h.branch.length, before);
	assert.equal(h.sent.length, 0);
	assert.match(h.notes.at(-1)!.message, /could not start its fork \(spawn pi ENOENT\); nothing was done/);
	assert.equal(h.notes.at(-1)!.level, "error");
	assert.deepEqual(fs.readdirSync(path.join(agent, "compact-handoffs", ".runs")), []);
});

test("/compact-handoff cancel stops the fork: a cancelled row, nothing saved, run dir gone", async () => {
	const agent = temp();
	const h = harness({ agentDir: agent });
	await h.run("cancel"); // nothing under way
	assert.match(h.notes.at(-1)!.message, /No \/compact-handoff is under way/);
	await h.run();
	const fork = h.forks[0]!;
	await h.run("cancel");
	assert.ok(fork.stopped >= 1);
	assert.deepEqual(h.rows().map((r) => r.status), ["running", "cancelled"]);
	assert.equal(h.compacts.length, 0);
	assert.equal(h.branch.some((e) => e.customType === HANDOFF_ENTRY), false);
	assert.equal(fs.existsSync(path.dirname(fork.spec.forkSession!)), false);
	assert.match(h.notes.at(-1)!.message, /cancelled/);
});

test("a message reaches the session mid-fork: the note is saved at once, the compaction waits for the next idle settle", async () => {
	const agent = temp();
	const h = harness({ agentDir: agent });
	await h.run();
	// A prompt starts while the fork writes.
	h.fire({ type: "input", text: "next question", source: "interactive" });
	h.fire({ type: "before_agent_start" });
	h.state.idle = false;
	h.forks[0]!.settle({ finalOutput: `<handoff>${NOTE}</handoff>` });
	assert.ok(fs.existsSync(path.join(agent, "compact-handoffs", "sess-1.md")));
	assert.equal(h.rows().at(-1).status, "saved");
	assert.equal(h.compacts.length, 0);
	assert.match(h.notes.at(-1)!.message, /compacts when it is next idle/);
	// While waiting, another /compact-handoff is refused.
	h.state.idle = true;
	await h.run();
	assert.equal(h.forks.length, 1);
	// The turn settles, but a queued prompt starts in the same instant: still no compaction.
	await h.settleMain(() => h.fire({ type: "input", text: "queued", source: "interactive" }));
	assert.equal(h.compacts.length, 0);
	// The next settle with nothing behind it compacts.
	await h.settleMain();
	assert.equal(h.compacts.length, 1);
	assert.ok(h.compacts[0]!.customInstructions!.includes("handoff note"));
});

test("a prompt that starts after our compaction was requested cancels it, and it compacts at the next idle settle", async () => {
	const h = harness({ agentDir: temp() });
	await h.run();
	h.forks[0]!.settle({ finalOutput: `<handoff>${NOTE}</handoff>` });
	assert.equal(h.compacts.length, 1);
	h.fire({ type: "before_agent_start" });
	assert.deepEqual(h.fire({ type: "session_before_compact", reason: "manual", willRetry: false }), { cancel: true });
	h.compacts[0]!.onError!(new Error("Compaction cancelled"));
	await h.settleMain();
	assert.equal(h.compacts.length, 2);
	// Our own compaction, no prompt in between: allowed.
	assert.equal(h.fire({ type: "session_before_compact", reason: "manual", willRetry: false }), undefined);
});

test("cancel while the compaction waits: it never compacts, the note stays saved", async () => {
	const agent = temp();
	const h = harness({ agentDir: agent });
	await h.run();
	h.state.idle = false;
	h.forks[0]!.settle({ finalOutput: `<handoff>${NOTE}</handoff>` });
	h.state.idle = true;
	await h.run("cancel");
	assert.match(h.notes.at(-1)!.message, /will not compact/);
	await h.settleMain();
	assert.equal(h.compacts.length, 0);
	assert.ok(fs.existsSync(path.join(agent, "compact-handoffs", "sess-1.md")));
});

test("another compaction while ours waits brings the note back and drops ours", async () => {
	const h = harness({ agentDir: temp() });
	await h.run();
	h.state.idle = false;
	h.forks[0]!.settle({ finalOutput: `<handoff>${NOTE}</handoff>` });
	h.compaction("u0", "threshold");
	assert.ok(String(h.sent.at(-1)!.message.content).includes(NOTE));
	h.state.idle = true;
	await h.settleMain();
	assert.equal(h.compacts.length, 0);
});

test("a failed compaction says so and keeps the note; the user's Stop says nothing", async () => {
	const agent = temp();
	const h = harness({ agentDir: agent });
	await h.run();
	h.forks[0]!.settle({ finalOutput: `<handoff>${NOTE}</handoff>` });
	const before = h.notes.length;
	h.compacts[0]!.onError!(new Error("Compaction cancelled"));
	assert.equal(h.notes.length, before);
	await h.run();
	h.forks[1]!.settle({ finalOutput: `<handoff>${NOTE}</handoff>` });
	h.compacts[1]!.onError!(new Error("boom"));
	assert.match(h.notes.at(-1)!.message, /compaction failed \(boom\)/);
	assert.ok(fs.existsSync(path.join(agent, "compact-handoffs", "sess-1.md")));
});

test("shutdown stops the fork and writes nothing; the next prompt settles the row as interrupted", async () => {
	const agent = temp();
	const h = harness({ agentDir: agent });
	await h.run("why");
	const fork = h.forks[0]!;
	const before = h.branch.length;
	await h.fire({ type: "session_shutdown" });
	assert.ok(fork.stopped >= 1);
	assert.equal(h.branch.length, before);
	// The session reopens in a fresh process (same branch) and is prompted.
	const again = harness({ agentDir: agent, branch: h.branch });
	again.fire({ type: "before_agent_start" });
	assert.deepEqual(again.rows().map((r) => r.status), ["running", "interrupted"]);
	assert.equal(again.rows()[1].id, fork.spec.id);
	assert.equal(again.rows()[1].focus, "why");
	// Once per session: a second prompt adds nothing.
	again.fire({ type: "before_agent_start" });
	assert.equal(again.rows().length, 2);
});

test("a Claude Code parent with no live CLI session: the fork folds, and the notification says so", async () => {
	const h = harness({ agentDir: temp(), model: { provider: "claude-code-cli", id: "haiku" } });
	await h.run();
	assert.equal(h.forks[0]!.spec.claudeFork, undefined);
	assert.match(h.notes.at(-1)!.message, /replays the history without the prompt cache/);
	const z = harness({ agentDir: temp() });
	await z.run();
	assert.doesNotMatch(z.notes.at(-1)!.message, /replays/);
});

test("after a plain /compact: the newest entry on the branch comes back hidden, with its age, and starts no turn", () => {
	const h = harness({ agentDir: temp(), now: () => Date.parse("2026-10-03T12:45:00.000Z") });
	h.pi.appendEntry(HANDOFF_ENTRY, { v: 1, path: "/agent/compact-handoffs/sess-1.md", note: "older note", at: "2026-10-03T09:00:00.000Z", leafId: "u0" });
	h.pi.appendEntry(HANDOFF_ENTRY, { v: 1, path: "/agent/compact-handoffs/sess-1.md", note: NOTE, at: "2026-10-03T12:00:00.000Z", leafId: "u0" });
	h.branch.push({ type: "message", id: "u1", message: { role: "user", content: "later" } });
	h.compaction("u1", "threshold");
	assert.equal(h.sent.length, 1);
	const [{ message, options }] = h.sent;
	assert.equal(message.customType, NOTE_MESSAGE);
	assert.equal(message.display, false);
	assert.equal(options?.triggerTurn, false);
	const content = String(message.content);
	assert.match(content, /written 2026-10-03T12:00:00\.000Z \(45 minutes ago\)/);
	assert.match(content, /saved at \/agent\/compact-handoffs\/sess-1\.md/);
	assert.match(content, /Check it against the summary/);
	assert.ok(content.includes(NOTE));
	assert.doesNotMatch(content, /older note/);
});

test("no entry on the branch: nothing is added after a compaction", () => {
	const h = harness({ agentDir: temp() });
	h.compaction("u0");
	assert.equal(h.sent.length, 0);
});

test("a note from before the fork whose reply is still in the kept tail gets only the preamble and path", () => {
	const h = harness({ agentDir: temp() });
	h.branch.push({ type: "message", id: "r0", message: { role: "assistant", content: [{ type: "text", text: `<handoff>${NOTE}</handoff>` }] } });
	h.pi.appendEntry(HANDOFF_ENTRY, { v: 1, path: "/agent/compact-handoffs/sess-1.md", note: NOTE, at: "2026-10-03T12:00:00.000Z", leafId: "r0" });
	h.compaction("r0");
	assert.doesNotMatch(String(h.sent.at(-1)!.message.content), /Decided: keep v1 shape/);
	assert.match(String(h.sent.at(-1)!.message.content), /still in the history above/);
});
