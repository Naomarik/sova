// Memory in a held chat, end to end on real pi with a ScriptedModel (§chat.memory/turn, /zoomable, /choice,
// /where): the request a UniiChat turn sends, the compactions UniiChat cancels and zoomable replaces, and the
// memory choice kept on the branch. Messages are short, so every line is built without the summarizer: no
// model, no process. One throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import type { ChatServerMessage } from "../../shared/protocol";
import { ScriptedModel, scriptedModelsJson } from "../harness/pi/testing/scripted-model";
import { piSession } from "../harness/pi/testing/handle";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-chat-memory-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--chat-memory--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(root, "cwd");
mkdirSync(cwd, { recursive: true });
// No summary model may run here: the policy turns Claude Code off, so a line that needs one waits.
writeFileSync(join(agentDir, "model-policy.json"), JSON.stringify({ version: 1, disabledProviders: ["claude-code"], disabledModels: [], subagentDisabledProviders: [], subagentDisabledModels: [] }));
// The tree's pi-config extensions (the mode extension among them), as a hosted runtime loads them.
symlinkSync(resolve(import.meta.dirname, "..", "..", "pi-config", "extensions"), join(agentDir, "extensions"));
writeFileSync(join(agentDir, "models.json"), JSON.stringify(scriptedModelsJson()));
// Keep almost nothing recent, so a compaction has messages to compact.
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "scripted", defaultModel: "scripted", retry: { enabled: false }, compaction: { keepRecentTokens: 8 } }));

const { acquireChat, disposeAllChats } = await import("../chat-manager");
type Chat = Awaited<ReturnType<typeof acquireChat>>;
const { canonicalPath } = await import("../paths");
const { markOwned } = await import("../write-guard");
const { addWebSession } = await import("../web-sessions");
const { MEMORY_COMPACTION_REFUSAL } = await import("../harness/pi/memory");
const { MEMORY } = await import("../harness/state-kinds");

after(async () => {
  await disposeAllChats();
  rmSync(root, { recursive: true, force: true });
});

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let n = 0;
/** A web session file with `pairs` short question/answer pairs. */
function sessionFile(pairs = 6): string {
  const id = `0199dddd-0000-7000-8000-${String(++n).padStart(12, "0")}`;
  const path = canonicalPath(join(sessionsDir, `2026-10-10T00-00-${String(n).padStart(2, "0")}-000Z_${id}.jsonl`));
  const lines: unknown[] = [{ type: "session", version: 3, id, timestamp: "2026-10-10T00:00:00.000Z", cwd }];
  let parent: string | null = null;
  for (let k = 0; k < pairs; k++) {
    const ts = (s: number) => `2026-10-10T00:0${k}:0${s}.000Z`;
    lines.push({ type: "message", id: `u${k}`, parentId: parent, timestamp: ts(1), message: { role: "user", content: [{ type: "text", text: `question ${k} about the parser` }] } });
    lines.push({ type: "message", id: `a${k}`, parentId: `u${k}`, timestamp: ts(2), message: { role: "assistant", content: [{ type: "text", text: `answer ${k}: the parser keeps token ${k * 7}` }], provider: "scripted", model: "scripted", usage: USAGE, stopReason: "stop" } });
    parent = `a${k}`;
  }
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  markOwned(path);
  addWebSession(id);
  return path;
}

async function openChat(path = sessionFile()) {
  const chat = await acquireChat(path, true);
  const model = new ScriptedModel().attach(piSession(chat));
  const log: ChatServerMessage[] = [];
  const client = { send: (m: ChatServerMessage) => log.push(m), sendRaw: (json: string) => log.push(JSON.parse(json)) };
  chat.attach(client as never);
  return { chat, path, model, client, log };
}

async function idle(chat: Chat): Promise<void> {
  const quiet = () => !chat.turnStarting && !chat.harness.isRunning() && chat.queue.size === 0 && !chat.harness.queue.hasQueued();
  await until(quiet, "idle");
  await piSession(chat).waitForIdle();
  await new Promise((r) => setTimeout(r, 5));
  await until(quiet, "idle");
}

type Msg = { role: string; content: string | { type: string; text?: string }[]; customType?: string };
const texts = (m: Msg): string[] => (typeof m.content === "string" ? [m.content] : m.content.filter((b) => b.type === "text").map((b) => b.text ?? ""));
const tools = (chat: Chat): string[] => (piSession(chat) as unknown as { getActiveToolNames(): string[] }).getActiveToolNames();
const contextOf = (model: ScriptedModel, k = -1) => model.calls.at(k)!.context as { messages: Msg[] };

describe("UniiChat in a held chat", () => {
  test("each request of a turn: [guide + view] then the standing mode notes then the turn; the recall tools while on", async () => {
    const { chat, model, log } = await openChat();
    await chat.switchMode({ minorModes: ["memory"] });
    assert.ok(log.some((m) => m.type === "memory_status"), "the status is sent once memory is on");
    model.reply({ text: "noted" });
    await chat.harness.send("first turn with memory");
    await idle(chat);
    // A switch after the head is told in a mode note (memory's own has none: its guide rides the view).
    await chat.switchMode({ minorModes: ["memory", "vis"] });
    model.reply({ text: "vis on" });
    await chat.harness.send("second turn");
    await idle(chat);
    const note = chat.harness.branch().find((e) => e.kind === "note" && e.noteType === "mode-note");
    assert.ok(note, "the switch's note is in the history now");
    model.reply({ toolCall: { name: "zoom", arguments: { id: 0, n: 1 } } }, { text: "done" });
    await chat.harness.send("what did answer 2 say?");
    await idle(chat);
    assert.equal(model.calls.length, 4);
    for (const k of [2, 3]) {
      const { messages } = contextOf(model, k);
      // pi's system prompt entry leads every request; the view comes first after it.
      const [view, ...rest] = messages.filter((m) => m.role !== "system");
      assert.equal(view!.role, "user");
      const blocks = texts(view!);
      assert.match(blocks[0]!, /^# Memory\n/, "the guide leads");
      assert.match(blocks.slice(1).join("\n"), /<chat>[\s\S]*answer 5: the parser keeps token 35[\s\S]*first turn with memory[\s\S]*<\/chat>/, "the view holds the history");
      assert.ok(!messages.some((m) => m.role === "assistant" && texts(m).some((t) => t.startsWith("answer 0") || t === "noted")), "the history itself is not sent");
      assert.match(texts(rest[0]!).join(""), /vis/i, "the standing mode note is kept, right after the view");
      assert.deepEqual(texts(rest[1]!), ["what did answer 2 say?"], "then the turn's own message");
    }
    assert.ok(["zoom", "date"].every((t) => tools(chat).includes(t)), "the recall tools are in the loadout while memory is on");
    assert.match(texts(contextOf(model, 3).messages.find((m) => m.role === "toolResult")!).join(""), /question 0 about the parser/, "the tool loop goes on after the turn");
    const view = (k: number) => texts(contextOf(model, k).messages.find((m) => m.role === "user")!);
    assert.deepEqual(view(2), view(3), "the same view for every request of the run");
    // Off: history as usual, no recall tools.
    await chat.switchMode({ minorModes: [] });
    model.reply({ text: "plain" });
    await chat.harness.send("and now?");
    await idle(chat);
    const plain = contextOf(model);
    assert.ok(plain.messages.some((m) => m.role === "assistant" && texts(m).some((t) => t.startsWith("answer 0"))), "off: the history goes as is");
    assert.ok(!tools(chat).some((t) => t === "zoom" || t === "date"), "off: no recall tools");
    assert.deepEqual(log.filter((m) => m.type === "memory_status").at(-1), { type: "memory_status", status: { state: "off" } });
  });

  test("every compaction is cancelled: /compact, an extension's compact (Claude Code's auto-compact, compact-handoff), pi's threshold", async () => {
    const { chat, client, model, log } = await openChat();
    await chat.switchMode({ minorModes: ["memory"] });
    const entries = () => readFileSync(chat.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type: string });
    chat.handle(client as never, { type: "prompt", text: "/compact", clientId: "c1" } as never);
    await until(() => log.some((m) => m.type === "compact_refused"), "the refusal");
    assert.deepEqual(log.find((m) => m.type === "compact_refused"), { type: "compact_refused", id: "c1", reason: "cancelled", message: MEMORY_COMPACTION_REFUSAL });
    // ctx.compact() / session.compact() is the path Claude Code's auto-compact and compact-handoff take.
    await assert.rejects(piSession(chat).compact(), /Compaction cancelled/);
    // pi's own threshold compaction after a reply near the window.
    model.reply({ text: "big", usage: { input: 99_000, output: 10, totalTokens: 99_010 } });
    await chat.harness.send("one more");
    await idle(chat);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(!entries().some((e) => e.type === "compaction"), "nothing compacted");
  });
});

describe("zoomable compaction in a held chat", () => {
  test("a compaction's summary is the memory lines of what it compacted, on /compact and on pi's threshold", async () => {
    const { chat, model } = await openChat();
    await chat.switchMode({ minorModes: ["memory"], memory: { type: "zoomable" } });
    await new Promise((r) => setTimeout(r, 20));
    await piSession(chat).compact();
    const compactions = () => readFileSync(chat.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === "compaction");
    const first = compactions().at(-1);
    assert.match(first.summary, /^# Memory of the earlier conversation/);
    assert.equal(first.fromHook, true);
    assert.equal(first.details.sovaMemory.v, 1);
    assert.ok(first.details.sovaMemory.messages > 0);
    assert.equal(model.calls.length, 0, "no model wrote the summary");
    const outline = chat.memory.outline();
    assert.equal(outline.type, "zoomable");
    assert.equal(outline.lines.length, first.details.sovaMemory.lines.length, "the outline shows the lines the compaction left");
    // The recall tools stay: a later turn can open a compacted message.
    model.reply({ toolCall: { name: "zoom", arguments: { id: 0, n: 1 } } }, { text: "big", usage: { input: 99_000, output: 10, totalTokens: 99_010 } });
    await chat.harness.send("what was question 0?");
    await idle(chat);
    assert.ok(tools(chat).includes("zoom"));
    const zoomResult = contextOf(model, 1).messages.find((m) => m.role === "toolResult");
    assert.match(texts(zoomResult!).join(""), /question 0 about the parser/);
    await until(() => compactions().length === 2, "pi's threshold compaction", 5000);
    assert.match(compactions().at(-1).summary, /^# Memory of the earlier conversation/);
  });
});

describe("where memory can be turned on (§chat.memory/where)", () => {
  test("typed /mode memory on is refused in a chat; the menu's switch (POST /api/mode's path) turns it on", async () => {
    const { chat, model } = await openChat();
    await chat.harness.send("/mode memory on");
    await idle(chat);
    assert.equal(model.calls.length, 0, "a command, never text for the model");
    assert.ok(!chat.modeState.minorModes.includes("memory"), "typed: refused");
    await chat.switchMode({ minorModes: ["memory"] });
    assert.ok(chat.modeState.minorModes.includes("memory"), "the menu: on");
  });
});

describe("the memory choice is kept on the branch", () => {
  test("a type-only change writes a sova-memory record and a mode message; reopen and a rewind past it keep it", async () => {
    const { chat, path, log, model } = await openChat();
    log.length = 0;
    const r = await chat.switchMode({ memory: { type: "zoomable" } });
    assert.deepEqual([r.memory?.type, r.memory?.size], ["zoomable", 32]);
    assert.deepEqual(chat.harness.state.branch().latest(MEMORY)?.data, { v: 1, type: "zoomable", size: 32 });
    assert.deepEqual(log.find((m) => m.type === "mode")?.memory, { type: "zoomable", size: 32 }, "a new mode message carries it");
    assert.ok(!log.some((m) => m.type === "memory_status"), "memory is still off: no status");
    model.reply({ text: "later" });
    await chat.harness.send("a later message");
    await idle(chat);
    await disposeAllChats();
    const again = await openChat(path);
    assert.deepEqual(again.chat.memory.choiceNow(), { type: "zoomable", size: 32 }, "reopened");
    const later = [...again.chat.harness.branch()].reverse().find((e) => e.kind === "user")!.id;
    again.chat.handle(again.client as never, { type: "rewind", id: "r1", entryId: later } as never);
    await until(() => again.log.some((m) => m.type === "rewound" || m.type === "rewind_refused"), "the rewind");
    assert.ok(again.log.some((m) => m.type === "rewound"), JSON.stringify(again.log.find((m) => m.type === "rewind_refused")));
    assert.deepEqual(again.chat.memory.choiceNow(), { type: "zoomable", size: 32 }, "the record is on the branch the rewind keeps");
  });
});
