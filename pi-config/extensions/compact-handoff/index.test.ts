/**
 * The command, the capture on agent_settled and the restore on session_compact, against a fake
 * ExtensionAPI and context: no pi session, no model.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import compactHandoff from "./index.ts";
import { type BranchEntry, HANDOFF_ENTRY, NOTE_MESSAGE, REQUEST_MESSAGE } from "./handoff.ts";

type Handler = (event: any, ctx: any) => unknown;
interface Sent { message: { customType: string; display?: boolean; content: unknown; details?: any }; options?: { triggerTurn?: boolean } }
interface CompactCall { customInstructions?: string; onComplete?: (r: unknown) => void; onError?: (e: Error) => void }

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

function harness(options: { agentDir?: string; now?: () => number } = {}) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const branch: BranchEntry[] = [];
	const sent: Sent[] = [];
	const compacts: CompactCall[] = [];
	const notes: { message: string; level?: string }[] = [];
	const state = { idle: true, pending: false, n: 0 };
	const nextId = () => `e${++state.n}`;
	const pi = {
		on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, command); },
		sendMessage(message: Sent["message"], opts?: Sent["options"]) {
			sent.push({ message, options: opts });
			// pi persists a sent custom message as a custom_message entry.
			branch.push({ type: "custom_message", id: nextId(), customType: message.customType, details: message.details });
		},
		appendEntry(customType: string, data: unknown) { branch.push({ type: "custom", id: nextId(), customType, data }); },
	} as unknown as ExtensionAPI;
	const cwd = temp();
	const ctx = {
		cwd,
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		ui: { notify: (message: string, level?: string) => { notes.push({ message, level }); } },
		sessionManager: {
			getSessionId: () => "sess-1",
			getBranch: () => branch,
			getLeafId: () => branch.at(-1)?.id ?? null,
		},
		compact: (call: CompactCall) => { compacts.push(call); },
	} as unknown as ExtensionContext;
	compactHandoff(pi, { agentDir: options.agentDir ? () => options.agentDir! : undefined, now: options.now ?? (() => NOW) });

	const fire = (event: { type: string } & Record<string, unknown>): unknown => {
		let result: unknown;
		for (const handler of handlers.get(event.type) ?? []) result = handler(event, ctx);
		return result;
	};
	const run = (args = "") => commands.get("compact-handoff")!.handler(args, ctx);
	const reply = (text: string, stopReason = "stop") => {
		fire({ type: "agent_start" });
		branch.push({ type: "message", id: nextId(), message: { role: "assistant", stopReason, content: [{ type: "text", text }] } });
	};
	/** Emit agent_settled, then let the deferred capture run. */
	const settle = async (between?: () => void) => {
		fire({ type: "agent_settled" });
		between?.();
		await new Promise((resolve) => setTimeout(resolve, 5));
	};
	const compaction = (firstKeptEntryId: string | null, reason = "manual") => {
		const entry = { type: "compaction", id: nextId(), firstKeptEntryId, summary: "S" } as BranchEntry & { firstKeptEntryId: string | null };
		branch.push(entry);
		fire({ type: "session_compact", compactionEntry: entry, fromExtension: false, reason, willRetry: false });
		return entry;
	};
	return { pi, ctx, state, branch, sent, compacts, notes, fire, run, reply, settle, compaction, cwd, nextId };
}

const NOTE = "Decided: keep v1 shape.\nRe-read docs/plan.md and §chat.slash-commands/compact-handoff.";

test("registers /compact-handoff", () => {
	const h = harness({ agentDir: temp() });
	assert.equal(typeof h.run, "function");
});

test("refused while the agent streams, while compacting or with queued messages: a notification, no turn", async () => {
	const h = harness({ agentDir: temp() });
	h.state.idle = false;
	await h.run();
	h.state.idle = true;
	h.state.pending = true;
	await h.run();
	assert.equal(h.sent.length, 0);
	assert.equal(h.notes.length, 2);
	assert.match(h.notes[0]!.message, /waits for an idle session/);
});

test("a second run while one is under way is refused", async () => {
	const h = harness({ agentDir: temp() });
	await h.run();
	await h.run();
	assert.equal(h.sent.length, 1);
	assert.match(h.notes[0]!.message, /already under way/);
});

test("the request is a hidden custom message that triggers a turn, with the focus", async () => {
	const h = harness({ agentDir: temp() });
	await h.run("  keep the API decisions ");
	assert.equal(h.sent.length, 1);
	const [{ message, options }] = h.sent;
	assert.equal(message.customType, REQUEST_MESSAGE);
	assert.equal(message.display, false);
	assert.equal(options?.triggerTurn, true);
	assert.match(String(message.content), /<handoff>/);
	assert.match(String(message.content), /keep the API decisions/);
	assert.equal(message.details.focus, "keep the API decisions");
});

test("after the turn: the newest block is saved under the agent dir (not cwd), the entry appended, then compaction with the focus", async () => {
	const agent = temp();
	process.env.PI_CODING_AGENT_DIR = agent; // the default resolution, as pi's getAgentDir()
	const h = harness();
	await h.run("focus text");
	h.reply("Saved the plan.\n<handoff>first draft</handoff>");
	h.reply(`Follow-up.\n<handoff>\n${NOTE}\n</handoff>`);
	await h.settle();

	const file = path.join(agent, "compact-handoffs", "sess-1.md");
	const body = fs.readFileSync(file, "utf8");
	assert.match(body, /- session: sess-1/);
	assert.match(body, /- focus: focus text/);
	assert.ok(body.endsWith(`${NOTE}\n`));
	assert.doesNotMatch(body, /first draft/);
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	assert.deepEqual(fs.readdirSync(h.cwd), []);

	const entry = h.branch.find((e) => e.type === "custom" && e.customType === HANDOFF_ENTRY);
	assert.deepEqual({ ...(entry!.data as object), leafId: undefined }, { v: 1, path: file, note: NOTE, at: new Date(NOW).toISOString(), leafId: undefined });
	assert.equal(typeof (entry!.data as { leafId: unknown }).leafId, "string");

	assert.equal(h.compacts.length, 1);
	assert.match(h.compacts[0]!.customInstructions!, /^focus text\n\n/);
	assert.match(h.compacts[0]!.customInstructions!, new RegExp(`saved at ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

for (const [label, text, stopReason, expect] of [
	["stopped", "<handoff>half</handoff>", "aborted", /stopped/],
	["failed", "<handoff>n</handoff>", "error", /turn failed/],
	["no block", "Done, nothing to hand off.", "stop", /no <handoff> note/],
] as const) {
	test(`${label}: nothing saved, no compaction, a notification`, async () => {
		const agent = temp();
		const h = harness({ agentDir: agent });
		await h.run();
		h.reply(text, stopReason);
		await h.settle();
		assert.equal(h.compacts.length, 0);
		assert.equal(fs.existsSync(path.join(agent, "compact-handoffs")), false);
		assert.equal(h.branch.some((e) => e.customType === HANDOFF_ENTRY), false);
		assert.match(h.notes.at(-1)!.message, expect);
		// The handoff is over: the command runs again.
		await h.run();
		assert.equal(h.sent.length, 2);
	});
}

test("a prompt that starts between the settle and the capture wins: note saved, no compaction", async () => {
	const agent = temp();
	const h = harness({ agentDir: agent });
	await h.run();
	h.reply(`<handoff>${NOTE}</handoff>`);
	await h.settle(() => h.fire({ type: "input", text: "queued", source: "interactive" }));
	assert.equal(h.compacts.length, 0);
	assert.ok(fs.existsSync(path.join(agent, "compact-handoffs", "sess-1.md")));
	assert.match(h.notes.at(-1)!.message, /did not compact/);
});

test("a prompt that starts after our compaction was requested cancels it in session_before_compact", async () => {
	const h = harness({ agentDir: temp() });
	await h.run();
	h.reply(`<handoff>${NOTE}</handoff>`);
	await h.settle();
	assert.equal(h.compacts.length, 1);
	h.fire({ type: "before_agent_start" });
	assert.deepEqual(h.fire({ type: "session_before_compact", reason: "manual", willRetry: false }), { cancel: true });
	h.compacts[0]!.onError!(new Error("Compaction cancelled"));
	assert.match(h.notes.at(-1)!.message, /did not compact/);
});

test("session_before_compact leaves other compactions alone", async () => {
	const h = harness({ agentDir: temp() });
	assert.equal(h.fire({ type: "session_before_compact", reason: "manual", willRetry: false }), undefined);
	await h.run();
	h.reply(`<handoff>${NOTE}</handoff>`);
	await h.settle();
	// Our own compaction, no prompt in between: allowed.
	assert.equal(h.fire({ type: "session_before_compact", reason: "manual", willRetry: false }), undefined);
});

test("a failed compaction says so and keeps the note; the user's Stop says nothing", async () => {
	const agent = temp();
	const h = harness({ agentDir: agent });
	await h.run();
	h.reply(`<handoff>${NOTE}</handoff>`);
	await h.settle();
	const before = h.notes.length;
	h.compacts[0]!.onError!(new Error("Compaction cancelled"));
	assert.equal(h.notes.length, before);
	await h.run();
	h.reply(`<handoff>${NOTE}</handoff>`);
	await h.settle();
	h.compacts[1]!.onError!(new Error("boom"));
	assert.match(h.notes.at(-1)!.message, /compaction failed \(boom\)/);
	assert.ok(fs.existsSync(path.join(agent, "compact-handoffs", "sess-1.md")));
});

test("after a plain /compact: the newest entry on the branch comes back hidden, with its age, and starts no turn", () => {
	const h = harness({ agentDir: temp(), now: () => Date.parse("2026-10-03T12:45:00.000Z") });
	h.branch.push({ type: "message", id: "u0", message: { role: "user", content: "hi" } });
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
	h.branch.push({ type: "message", id: "u0", message: { role: "user", content: "hi" } });
	h.compaction("u0");
	assert.equal(h.sent.length, 0);
});

test("the full flow: the handoff reply still in the kept tail gets only the preamble and path", async () => {
	const agent = temp();
	const h = harness({ agentDir: agent });
	h.branch.push({ type: "message", id: "u0", message: { role: "user", content: "earlier work" } });
	await h.run();
	h.reply(`<handoff>${NOTE}</handoff>`);
	const replyId = h.branch.at(-1)!.id;
	await h.settle();
	// pi compacts, keeping the tail from the handoff reply on.
	h.compaction(replyId);
	const restore = h.sent.at(-1)!;
	assert.equal(restore.message.customType, NOTE_MESSAGE);
	assert.doesNotMatch(String(restore.message.content), /Decided: keep v1 shape/);
	assert.match(String(restore.message.content), /still in the history above/);
	assert.ok(String(restore.message.content).includes(path.join(agent, "compact-handoffs", "sess-1.md")));
	// Kept tail starting after it: the note itself comes back.
	h.branch.push({ type: "message", id: "u9", message: { role: "user", content: "more" } });
	h.compaction("u9");
	assert.ok(String(h.sent.at(-1)!.message.content).includes(NOTE));
});
