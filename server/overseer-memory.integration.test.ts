// Overseers run with memory on by default, checked by what the model is sent, not by its answering: real pi up to the model call (a ScriptedModel records each
// request), and real summaries, written by the stand-in `claude` (scripts/fake-claude.mjs with
// FAKE_CLAUDE_ONESHOT=1, a process: hence this tier). A throwaway PI_CODING_AGENT_DIR; ~/.pi is never read.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import type { ChatServerMessage } from "../shared/protocol";
import { MEMORY_TOOLS } from "../shared/memory";
import { MEMORY_CHAT_OPEN, MEMORY_VIEW_MARK } from "../pi-config/extensions/claude-code/provider/memory-view.ts";
import { piSession } from "./harness/pi/testing/handle";
import { ScriptedModel, scriptedModelsJson } from "./harness/pi/testing/scripted-model";
import { linkPiConfigExtensions } from "./testing/agent-dir";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-overseer-memory-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
// The runner's stand-in `claude` is first on PATH; this makes it answer the summarizer's one-shots.
process.env.FAKE_CLAUDE_ONESHOT = "1";
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
linkPiConfigExtensions(agentDir);
writeFileSync(join(agentDir, "models.json"), JSON.stringify(scriptedModelsJson()));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "scripted", defaultModel: "scripted", retry: { enabled: false } }));

await import("./testing/in-process-chats"); // chats open in this process (the server hosts none)
const { acquireChat, disposeAllChats, disposeHeldChat } = await import("./chat-manager");
type Chat = Awaited<ReturnType<typeof acquireChat>>;
const orgs = await import("./orgs");
const po = await import("./project-overseer");
const store = await import("./project-overseer-store");
const overseer = await import("./overseer");
const { readOverseerSettings, writeOverseerSettings } = await import("./overseer-store");
const { saveDefaultMemoryType } = await import("./memory/settings");
const { registerProjectOverseerRoutes } = await import("./project-overseer-routes");
const { settled } = await import("./workspace-git");

after(async () => {
  await disposeAllChats();
  await settled(join(root, "ws"));
  rmSync(root, { recursive: true, force: true });
});

/** A text long enough that its summary needs the summarizer (over 512 bytes). */
const long = (tag: string) => `${tag} ${"the parser keeps every token it reads. ".repeat(16)}`;

type Req = { messages: { role: string; content: unknown }[] };
/** One recorded request, its messages without pi's system-role message (the prompt and loadout record). */
const reqOf = (model: ScriptedModel, k = model.calls.length - 1): Req => {
  const r = model.calls[k]!.context as Req;
  return { ...r, messages: r.messages.filter((m) => m.role !== "system") };
};
const textOf = (content: unknown): string => (typeof content === "string" ? content : JSON.stringify(content));
/** The request's first message is the memory view: the guide, then the `<chat>` lines. */
function viewOf(r: Req): string | undefined {
  const first = r.messages[0];
  if (!first || first.role !== "user" || !Array.isArray(first.content)) return undefined;
  const blocks = first.content as { type: string; text?: string }[];
  return blocks[0]?.text?.startsWith(`${MEMORY_VIEW_MARK}\n`) && blocks[1]?.text?.startsWith(MEMORY_CHAT_OPEN) ? blocks.map((b) => b.text).join("\n") : undefined;
}
/** The tools the chat's run offers the model now (the scripted request records no tool list). */
const toolsOf = (chat: Chat) => piSession(chat).getActiveToolNames();

async function until(cond: () => boolean, what: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function open(path: string): Promise<{ chat: Chat; model: ScriptedModel; log: ChatServerMessage[] }> {
  const chat = await acquireChat(path);
  const model = new ScriptedModel().attach(piSession(chat));
  const log: ChatServerMessage[] = [];
  chat.attach({ send: (m: ChatServerMessage) => log.push(m), sendRaw: (json: string) => log.push(JSON.parse(json)) } as never);
  return { chat, model, log };
}

async function turn(chat: Chat, model: ScriptedModel, text: string, reply = long(`answer to ${text.slice(0, 12)}`)): Promise<void> {
  model.reply({ text: reply });
  await chat.acceptPrompt(text, undefined, "server").turn;
}

describe("a project overseer's memory", async () => {
  const org = await orgs.createOrg({ name: "Mem", dir: join(root, "ws") });
  mkdirSync(join(root, "proj"));
  const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
  const p = store.projectOverseerPaths(project.id);
  const app = new Hono();
  registerProjectOverseerRoutes(app);
  const req = async (method: string, body?: unknown) => {
    const r = await app.request(`/api/projects/${project.id}/overseer/memory`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    return { status: r.status, body: (await r.json()) as { on: boolean; type: string; size: number; status: { state: string } } };
  };

  test("an existing one with history and no saved choice: preparing, then the view in place of its early turns, zoom opens a line; switched off it gets its full history, and stays off after Clear", async () => {
    // An overseer from before memory was on by default: 12 turns of history, run with memory off.
    store.writePoSettings(p, { ...store.readPoSettings(p), memory: { on: false, type: "uniichat", size: 128 } });
    const { path } = await po.ensureProjectOverseer(project.id);
    let { chat, model } = await open(path);
    for (let k = 0; k < 12; k++) await turn(chat, model, long(`question ${k}`));
    assert.equal(viewOf(reqOf(model)), undefined, "off: no view");
    assert.ok(textOf(reqOf(model).messages[0]!.content).includes("question 0"), "off: the full history");
    assert.ok(!toolsOf(chat).includes("zoom"));

    // Its saved choice gone (as every overseer that never chose has none): on, from its next open.
    const { memory: _m, ...rest } = store.readPoSettings(p);
    store.writePoSettings(p, rest);
    assert.deepEqual((await req("GET")).body.on, true, "GET: on by default");
    await disposeHeldChat(path, "test reopen");
    let log: ChatServerMessage[];
    ({ chat, model, log } = await open(path));
    assert.deepEqual(chat.memory.choice(), { on: true, type: "uniichat", size: 128 });
    assert.equal(chat.memory.status().state, "preparing", "its history is prepared from the open");
    // It answers meanwhile, as without memory.
    await turn(chat, model, "while preparing");
    const during = reqOf(model);
    if (chat.memory.status().state === "preparing") {
      assert.equal(viewOf(during), undefined, "still preparing: no view");
      assert.ok(textOf(during.messages[0]!.content).includes("question 0"), "still preparing: the full history");
    }
    await chat.memory.engine().idle();
    await until(() => chat.memory.status().state === "ready", "memory ready");

    // Prepared: the view replaces the early turns, and the recall tools are the model's.
    model.reply({ toolCall: { name: "zoom", arguments: { id: 0, n: 1 } } }, { text: "Recalled." });
    await chat.acceptPrompt("what did I ask first?", undefined, "server").turn;
    const first = reqOf(model, model.calls.length - 2);
    const view = viewOf(first);
    assert.ok(view, "the model's request opens with the memory view");
    assert.match(view!, /Fake summary/, "its lines are the summarizer's");
    assert.ok(!first.messages.some((m, k) => k > 0 && textOf(m.content).includes("question 0")), "the early turns are not sent raw");
    for (const t of MEMORY_TOOLS) assert.ok(toolsOf(chat).includes(t), `${t} in its tools`);
    const after = reqOf(model);
    const result = after.messages.find((m) => m.role === "toolResult");
    assert.ok(result && textOf(result.content).includes("question 0"), "zoom(0, 1) gave message 0 whole");

    // Its tabs heard it: "Preparing memory: n of m" first (the run-status row's words), then ready.
    const statuses = log.filter((m): m is Extract<ChatServerMessage, { type: "memory_status" }> => m.type === "memory_status").map((m) => m.status);
    assert.equal(statuses[0]?.state, "preparing", JSON.stringify(statuses[0]));
    assert.ok(statuses.some((s) => s.state === "ready"), "then ready");

    // Switched off by its own route: its next turn sends the full history, without the recall tools.
    const off = await req("PUT", { on: false });
    assert.equal(off.status, 200);
    assert.deepEqual([off.body.on, off.body.status.state], [false, "off"]);
    await turn(chat, model, "after off");
    assert.equal(viewOf(reqOf(model)), undefined, "off: no view");
    assert.ok(textOf(reqOf(model).messages[0]!.content).includes("question 0"), "off: the full history again");
    assert.ok(!toolsOf(chat).includes("zoom"), "off: no zoom");

    // Clear keeps the choice; the new conversation runs without memory.
    const cleared = await po.clearProjectOverseer(project.id);
    assert.deepEqual(cleared.settings.memory, { on: false, type: "uniichat", size: 128 });
    assert.equal((await req("GET")).body.on, false, "still off after Clear");
    const next = await open(cleared.path!);
    assert.equal(next.chat.memory.choice().on, false);
    await turn(next.chat, next.model, "fresh");
    assert.ok(!toolsOf(next.chat).includes("zoom"));
  });

  test("its WebSocket hears the memory status while on; a bad body is refused and changes nothing", async () => {
    const on = await req("PUT", { on: true });
    assert.equal(on.body.on, true);
    const info = await po.projectOverseerInfo(project.id);
    const { chat, model, log } = await open(info.path!);
    await turn(chat, model, long("one"));
    await turn(chat, model, long("two"));
    await chat.memory.engine().idle();
    await until(() => log.some((m) => m.type === "memory_status"), "a memory_status message");
    assert.equal((await req("PUT", { on: "yes" })).status, 400);
    assert.equal((await req("PUT", { type: "nope" })).status, 400);
    assert.equal((await req("PUT", { size: 3 })).status, 200, "a size is ignored, not refused: the size is Settings'");
    assert.equal(store.readPoSettings(p).memory?.on, true, "refused writes changed nothing");
    assert.equal((await app.request("/api/projects/prj_nope/overseer/memory")).status, 404, "an unknown project");
  });
});

describe("the main Overseer's memory", () => {
  test("new, with no saved choice and a Zoomable default saved for chats: on, UniiChat, and its request carries the view", async () => {
    saveDefaultMemoryType("zoomable");
    const { memory: _m, ...rest } = readOverseerSettings();
    writeOverseerSettings(rest);
    const { path } = await overseer.ensureOverseer();
    const { chat, model, log } = await open(path);
    assert.deepEqual(chat.memory.choice(), { on: true, type: "uniichat", size: 128 }, "the built-in, never the chats' default");
    await turn(chat, model, long("first question"));
    await turn(chat, model, long("second question"));
    await chat.memory.engine().idle();
    await turn(chat, model, "third");
    const r = reqOf(model);
    const view = viewOf(r);
    assert.ok(view, "the request opens with the memory view");
    assert.ok(view!.includes("|"), "with its lines");
    assert.ok(!r.messages.some((m, k) => k > 0 && textOf(m.content).includes("first question")), "the first turn is in the view, not sent raw");
    for (const t of MEMORY_TOOLS) assert.ok(toolsOf(chat).includes(t), `${t} in its tools`);
    assert.ok(log.some((m) => m.type === "memory_status"), "its tabs hear the memory status");
  });
});
