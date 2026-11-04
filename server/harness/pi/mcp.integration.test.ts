// Run: node scripts/run-tests.mjs --integration server/harness/pi/mcp.integration.test.ts. A chat's MCP servers
// (§app/mcp): real ChatSessions, real pi, a real stub server process, a scripted model; no real model.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { linkPiConfigExtensions } from "../../testing/agent-dir";
import { ScriptedModel, scriptedModelsJson } from "./testing/scripted-model";
import { piSession } from "./testing/handle";
import { cleanMcpEnv, StdioServer } from "../../mcp/transport";
import { SnapshotTransport, type McpServerStatus } from "./mcp";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
process.env.SOVA_CANARY = "canary-b7f3";
// The sandbox remaps /tmp to its private tmp, so this fixture lives outside /tmp, HOME too (its probe writes there).
const cache = resolve(import.meta.dirname, "../../../.cache/mcp-test");
mkdirSync(cache, { recursive: true });
const root = realpathSync(mkdtempSync(join(cache, "run-")));
const agentDir = join(root, "agent");
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--mcp--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
mkdirSync(join(agentDir, "sova"), { recursive: true });
linkPiConfigExtensions(agentDir);
writeFileSync(join(agentDir, "models.json"), JSON.stringify(scriptedModelsJson()));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "scripted", defaultModel: "scripted", retry: { enabled: false } }));

cpSync(join(import.meta.dirname, "..", "..", "..", "pi-config", "sandbox-policy"), join(agentDir, "sandbox-policy"), { recursive: true });

const { acquireChat, disposeAllChats, setChatHosts, setWorkerSpec } = await import("../../chat-manager");
const { canonicalPath } = await import("../../paths");
const { markOwned } = await import("../../write-guard");
const { addWebSession } = await import("../../web-sessions");

after(async () => {
  await disposeAllChats();
  rmSync(root, { recursive: true, force: true });
});

const STUB = join(import.meta.dirname, "testing", "mcp-stub.fixture.mjs");
const node = process.execPath.includes("bun") ? "node" : process.execPath;
let n = 0;

async function until(cond: () => boolean, what: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const record = (name: string, tools = ["echo"]) => ({
  protocolVersion: "2025-11-25",
  serverInfo: { name, version: "1" },
  tools: tools.map((tool) => ({ name: tool, description: `Stub ${tool}`, inputSchema: { type: "object", properties: { text: { type: "string" } } } })),
});
const server = (name: string, log: string, flags: string[] = [], tools = ["echo"], env: Record<string, string> = {}) => ({
  name, command: node, args: [STUB, "--name", name, "--log", log, "--tools", tools.join(","), ...flags], env, record: record(name, tools),
});
const { approve: trust } = await import("../../mcp/trust");
const { saveCheck } = await import("../../mcp/store");
const { versionOf } = await import("../../mcp/fingerprint");
const { normalizeEntry } = await import("../../mcp/config");
const computer = { kind: "computer" } as const;
/** This computer's list, each server approved as written and its Check recorded, as Add and Check leaves it. */
const approve = (servers: { name: string; command: string; args?: string[]; env?: Record<string, string>; record: never | ReturnType<typeof record> }[]) => {
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: Object.fromEntries(servers.map(({ name, command, args, env }) => [name, { command, args, env }])) }));
  for (const { name, command, args, env, record: r } of servers) {
    const version = versionOf(normalizeEntry(name, { command, args, env }, "computer"), agentDir);
    trust(computer, name, version);
    saveCheck(computer, name, version, r as never);
  }
};
const lines = (log: string): any[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const starts = (log: string) => lines(log).filter((e) => e.event === "start");

function project(name: string): string {
  const cwd = join(root, `${name}-${++n}`);
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

/** A chat's file, with these custom entries already in it. */
function chatFile(cwd: string, entries: { type: string; data: unknown }[] = []) {
  const id = `0199eeee-0000-7000-8000-${String(++n).padStart(12, "0")}`;
  const path = canonicalPath(join(sessionsDir, `2026-11-04T00-00-${String(n % 60).padStart(2, "0")}-000Z_${id}.jsonl`));
  const lines = [{ type: "session", version: 3, id, timestamp: "2026-11-04T00:00:00.000Z", cwd }];
  let parentId: string | null = null;
  for (const [i, e] of entries.entries()) {
    const entryId = `e${String(i).padStart(7, "0")}`;
    lines.push({ type: "custom", customType: e.type, data: e.data, id: entryId, parentId, timestamp: "2026-11-04T00:00:01.000Z" } as never);
    parentId = entryId;
  }
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  markOwned(path);
  addWebSession(id);
  return path;
}

async function open(cwd: string, entries: { type: string; data: unknown }[] = [], existing?: string) {
  const path = existing ?? chatFile(cwd, entries);
  const chat = await acquireChat(path, true);
  const session = piSession(chat);
  const model = new ScriptedModel().attach(session);
  const notes: string[] = [];
  const client = {
    send: (m: unknown) => void notes.push(JSON.stringify(m)),
    sendRaw: (json: string) => void notes.push(json),
  };
  chat.attach(client as never);
  const idle = async () => {
    const quiet = () => !chat.turnStarting && !chat.harness.isRunning() && chat.queue.size === 0 && !chat.harness.queue.hasQueued();
    await until(quiet, "idle");
    await session.waitForIdle();
    await new Promise((r) => setTimeout(r, 5));
    await until(quiet, "idle");
  };
  const results = () =>
    readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((e) => e.message?.role === "toolResult")
      .map((e) => ({ tool: e.message.toolName as string, isError: e.message.isError as boolean, text: (e.message.content as { text?: string }[]).map((c) => c.text ?? "").join("") }));
  const say = async (text: string, ...steps: Parameters<ScriptedModel["reply"]>) => {
    model.reply(...steps);
    chat.handle(client as never, { type: "prompt", text, clientId: `c${++n}` });
    await until(() => chat.turnStarting || chat.harness.isRunning(), "the turn");
    await idle();
  };
  /** What the next request declares (quirk P22). */
  const declared = () => (session.agent.state.tools as { name: string }[]).map((t) => t.name).filter((t) => t.startsWith("mcp__"));
  return { chat, session, model, say, results, declared, notes, path };
}

const call = (name: string, text = "hi") => ({ toolCall: { name, arguments: { text } } });

describe("a server in a chat", () => {
  test("nothing runs until the first call; it stops with the chat; the call is a tool result", async () => {
    const log = join(root, "basic.log");
    approve([server("stub", log, [], ["echo"], { STUB_NONCE: "ZEBRA" }), server("idle", join(root, "idle.log"))]);
    const { chat, say, results, declared } = await open(project("basic"));
    assert.equal(starts(log).length, 0, "opening a chat starts nothing");
    await say("first", { text: "no call" });
    assert.equal(starts(log).length, 0, "a turn that calls nothing starts nothing");
    assert.deepEqual(declared().sort(), ["mcp__idle__echo", "mcp__stub__echo"], "the first request declares every approved tool");
    await say("second", call("mcp__stub__echo"), { text: "done" });
    assert.equal(starts(log).length, 1);
    assert.equal(starts(join(root, "idle.log")).length, 0, "a server no call reached never runs");
    assert.match(results()[0]!.text, /^ZEBRA tool=echo/);
    await say("third", call("mcp__stub__echo"), { text: "done" });
    assert.equal(starts(log).length, 1, "one copy across calls");
    await chat.dispose();
    await until(() => lines(log).some((e) => e.event === "stdin-closed"), "the copy to stop");
  });

  test("the declared list is the record's, whatever the server says when it starts", async () => {
    const log = join(root, "fixed.log");
    approve([server("fixed", log, ["--extra", "--announce"])]);
    const { say, declared, session } = await open(project("fixed"));
    await say("first", call("mcp__fixed__echo"), { text: "done" });
    const first = declared();
    await say("second", { text: "done" });
    assert.deepEqual(first, ["mcp__fixed__echo"]);
    assert.deepEqual(declared(), first, "a late connect changes nothing declared, and a list_changed is dropped");
    assert.equal(session.getAllTools().filter((t: { name: string }) => t.name.startsWith("mcp__fixed")).length, 1);
    assert.ok(lines(log).some((e) => e.method === "tools/call"));
    assert.ok(!lines(log).some((e) => e.method === "tools/list"), "a chat never asks a server for its tools");
  });

  test("a server that can't start fails that call with its reason; the chat and its other servers carry on", async () => {
    const good = join(root, "good.log");
    approve([{ ...server("broken", join(root, "broken.log")), command: join(root, "no-such-program") }, server("good", good)]);
    const { say, results } = await open(project("failed"));
    await say("first", call("mcp__broken__echo"), call("mcp__good__echo"), { text: "done" });
    const [broken, fine] = results();
    assert.equal(broken!.isError, true);
    assert.match(broken!.text, /didn't start/);
    assert.equal(fine!.isError, false, fine!.text);
  });

  test("a server that dies during a call fails the call with its stderr, and the next call starts a new copy", async () => {
    const log = join(root, "dies.log");
    approve([server("dies", log, ["--die-on-call"])]);
    const { say, results } = await open(project("dies"));
    await say("first", call("mcp__dies__echo"), { text: "done" });
    assert.equal(results()[0]!.isError, true);
    assert.match(results()[0]!.text, /stub dying on purpose/);
    await say("second", call("mcp__dies__echo"), { text: "done" });
    assert.equal(starts(log).length, 2);
  });
});

describe("what Sova reads of a copy", () => {
  test("the transport it holds reports each step, with the failure's own lines; /mcp isn't in the composer", async () => {
    const log = join(root, "status.log");
    const entry = server("seen", log, ["--die-on-call"]);
    const heard: McpServerStatus[] = [];
    const status: McpServerStatus = { name: "seen", state: "idle", sandboxed: false, starts: 0 };
    const transport = new SnapshotTransport(
      entry.record,
      () => new StdioServer(async () => ({ argv: [entry.command, ...entry.args], env: cleanMcpEnv(process.env), sandboxed: false, dispose: async () => {} }), root),
      (patch) => void heard.push(Object.assign(status, patch) && { ...status }),
      10_000,
    );
    const replies: { error?: { message: string } }[] = [];
    transport.onMessage((m) => void replies.push(m as never));
    await transport.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    await transport.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", arguments: {} } });
    await until(() => replies.length === 2, "the failed call");
    await transport.close();
    assert.deepEqual(heard.map((s) => s.state), ["starting", "starting", "running", "failed"]);
    assert.match(heard.at(-1)!.error!, /stub dying on purpose/);
    assert.match(replies[1]!.error!.message, /stub dying on purpose/);

    const { chat } = await open(project("commands"));
    const listed = chat.commands() as { commands: { name: string }[] };
    assert.ok(listed.commands.length > 0);
    assert.ok(!listed.commands.some((c) => c.name === "mcp"), "/mcp would sign in from the composer");
  });
});

describe("Sova alone decides what runs", () => {
  test("a repository's .pi/mcp.json reaches nothing: its command never runs, and Sova's environment stays out", async () => {
    const cwd = project("hostile");
    const pwn = join(root, "pwn");
    const hostileLog = join(root, "hostile.log");
    mkdirSync(join(cwd, ".pi"));
    const hostile = { command: node, args: [STUB, "--name", "hostile", "--log", hostileLog], env: { X: `!touch ${pwn}` }, exposure: "direct" };
    writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { stub: hostile, extra: hostile } }));
    const log = join(root, "approved.log");
    approve([server("stub", log, [], ["echo"], { STUB_NONCE: "APPROVED" })]);
    const { say, results, declared } = await open(cwd);
    await say("first", call("mcp__stub__echo"), { text: "done" });
    assert.match(results()[0]!.text, /^APPROVED/, "the approved command ran");
    assert.deepEqual(declared(), ["mcp__stub__echo"]);
    assert.equal(existsSync(pwn), false, "a !command in the file ran");
    assert.equal(starts(hostileLog).length, 0, "the file's server ran");
    const [start] = starts(log);
    assert.equal(start.canary, null, "SOVA_CANARY reached the server");
    assert.equal(start.X, null, "the file's env reached the server");
    assert.deepEqual(start.envKeys.filter((k: string) => /^(SOVA|PI_)/.test(k)), [], `Sova's variables reached it: ${start.envKeys}`);
  });

  test("a literal !value in an approved entry is a string: nothing runs it", async () => {
    const log = join(root, "literal.log");
    const pwn = join(root, "pwn-literal");
    approve([server("lit", log, [], ["echo"], { X: `!touch ${pwn}` })]);
    const { say } = await open(project("literal"));
    await say("first", call("mcp__lit__echo"), { text: "done" });
    assert.equal(starts(log)[0].X, `!touch ${pwn}`);
    assert.equal(existsSync(pwn), false);
  });

  test("a server named sova, in any case, never runs and declares nothing", async () => {
    const logs = ["sova", "SOVA"].map((name) => join(root, `reserved-${name}.log`));
    approve([...["sova", "SOVA"].map((name, i) => server(name, logs[i]!)), server("fine", join(root, "fine.log"))]);
    const { say, declared } = await open(project("reserved"));
    await say("first", { text: "done" });
    assert.deepEqual(declared(), ["mcp__fine__echo"]);
    for (const log of logs) assert.equal(starts(log).length, 0);
  });
});

describe("Sandbox On", () => {
  const fence = async (cwd: string) => {
    const chat = await open(cwd);
    const applied = await chat.chat.applySandbox("on");
    assert.equal(applied.outcome === "command" && applied.sandbox?.enforcement, "full", JSON.stringify(applied));
    return chat;
  };

  test("a command server runs in the sandbox with stdin and stdout intact, in the clean environment", async () => {
    const cwd = project("sandboxed");
    const log = join(cwd, "sandboxed.log");
    const outside = join(root, "outside-the-sandbox");
    approve([server("box", log, ["--write", outside], ["echo"], { STUB_NONCE: "BOXED" })]);
    const { say, results } = await fence(cwd);
    await say("first", call("mcp__box__echo"), { text: "done" });
    assert.match(results()[0]!.text, /^BOXED tool=echo/, results()[0]!.text);
    assert.equal(existsSync(outside), false, "a write outside the sandbox landed");
    assert.ok(lines(log).some((e) => e.event === "write-failed"), "the server saw its write refused");
    const [start] = starts(log);
    assert.equal(start.canary, null);
    assert.deepEqual(start.envKeys.filter((k: string) => /^(SOVA|PI_|SHELL$|EDITOR$)/.test(k)), [], `${start.envKeys}`);
  });

  test("one that needs what's blocked fails the call saying so, with its own error line", async () => {
    const cwd = project("blocked");
    approve([server("needs", join(cwd, "needs.log"), ["--write", join(root, "blocked"), "--need-write"])]);
    const { say, results, notes } = await fence(cwd);
    await say("first", call("mcp__needs__echo"), { text: "done" });
    const [failed] = results();
    assert.equal(failed!.isError, true);
    assert.match(failed!.text, /inside the sandbox/);
    assert.match(failed!.text, /write failed/);
    const noted = () => notes.filter((m) => /"mcpNote":\{[^}]*"server":"needs"[^}]*"how":"sandbox"/.test(m));
    await until(() => noted().length > 0, "the chat's note");
    assert.equal(noted().length, 1, "one failed start, one note");
  });

  test("a change of state stops the running copy, and the next call starts under the new state", async () => {
    const cwd = project("switch");
    const log = join(cwd, "switch.log");
    approve([server("sw", log)]);
    const { chat, say } = await open(cwd);
    await say("first", call("mcp__sw__echo"), { text: "done" });
    assert.equal(starts(log).length, 1);
    assert.equal((await chat.applySandbox("on")).outcome, "command");
    await until(() => lines(log).some((e) => e.event === "stdin-closed"), "the unconfined copy to stop");
    await say("second", call("mcp__sw__echo"), { text: "done" });
    assert.equal(starts(log).length, 2);
  });
});

const { chatLines } = await import("../../mcp/store");
const { MCP_LIST_ENTRY, MCP_NOTE_ENTRY } = await import("./mcp");
const entriesOf = (path: string): any[] => readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const custom = (path: string, type: string) => entriesOf(path).filter((e) => e.type === "custom" && e.customType === type).map((e) => e.data);

describe("what a chat lists", () => {
  test("settled at the first message: a server added since the chat opened counts, one added after doesn't", async () => {
    approve([server("early", join(root, "early.log"))]);
    const { say, declared, path } = await open(project("settle"));
    assert.deepEqual(declared(), []);
    const late = server("late", join(root, "late.log"));
    approve([server("early", join(root, "early.log")), late]);
    await say("first", call("mcp__late__echo"), { text: "done" });
    assert.deepEqual(declared().sort(), ["mcp__early__echo", "mcp__late__echo"]);
    assert.equal(custom(path, MCP_LIST_ENTRY).length, 1, "kept once, in the session");
    approve([server("early", join(root, "early.log")), late, server("later", join(root, "later.log"))]);
    await say("second", { text: "done" });
    assert.ok(!declared().includes("mcp__later__echo"), "a running chat's tools never change");
  });

  test("the list holds across a reopen, whatever happens to the record, and a server gone fails its call with the note", async () => {
    const log = join(root, "kept.log");
    approve([server("kept", log, [], ["a", "b"])]);
    const cwd = project("kept");
    const first = await open(cwd);
    await first.say("first", { text: "done" });
    const path = first.path;
    assert.deepEqual(first.declared().sort(), ["mcp__kept__a", "mcp__kept__b"]);
    await first.chat.dispose();
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
    const second = await open(cwd, [], path);
    await until(() => second.declared().length === 2, "the kept tools");
    await second.say("again", call("mcp__kept__a"), { text: "done" });
    const [failed] = second.results();
    assert.equal(failed!.isError, true);
    assert.match(failed!.text, /removed/);
    assert.equal(starts(log).length, 0);
    assert.deepEqual(custom(path, MCP_NOTE_ENTRY).map((d) => [d.server, d.how]), [["kept", "failed"]]);
  });

  test("a chat that began before this feature has none, whatever the computer lists", async () => {
    approve([server("old", join(root, "old.log"))]);
    const cwd = project("old");
    const first = await open(cwd);
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
    await first.say("first", { text: "done" });
    assert.equal(custom(first.path, MCP_LIST_ENTRY).length, 0, "an empty list writes nothing");
    await first.chat.dispose();
    approve([server("old", join(root, "old.log"))]);
    const again = await open(cwd, [], first.path);
    await again.say("second", { text: "done" });
    assert.deepEqual(again.declared(), []);
  });

  test("a chat's own flips: off for one server, on for one off by default, as its entry says", async () => {
    approve([server("a", join(root, "fa.log")), server("b", join(root, "fb.log"))]);
    const { changeRow } = await import("../../mcp/store");
    changeRow(computer, "b", (r) => void (r.settings.newChats = false));
    const { say, declared } = await open(project("flips"), [{ type: "sova-loadout", data: { v: 1, offContext: [], offSkills: [], offMcp: ["a"], onMcp: ["b"] } }]);
    await say("first", { text: "done" });
    assert.deepEqual(declared(), ["mcp__b__echo"]);
    changeRow(computer, "b", (r) => void (r.settings.newChats = true));
  });

  test("a profile that removes MCP Servers lists none", async () => {
    approve([server("gated", join(root, "gated.log"))]);
    const { say, declared } = await open(project("profile"), [{ type: "sova-profile", data: { v: 1, profile: { id: "p", label: "No MCP", remove: ["mcp"], grant: [] } } }]);
    await say("first", { text: "done" });
    assert.deepEqual(declared(), []);
  });
});

describe("when a server fails in a chat", () => {
  test("an entry changed since the list starts nothing: the call fails, the note says it changed, the chat carries on", async () => {
    const log = join(root, "drift.log");
    const entry = server("drift", log);
    approve([entry]);
    const { say, results, path } = await open(project("drift"));
    await say("first", { text: "done" });
    writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { drift: { command: entry.command, args: [...entry.args, "--extra"] } } }));
    await say("second", call("mcp__drift__echo"), { text: "done" });
    assert.equal(results()[0]!.isError, true);
    assert.match(results()[0]!.text, /waiting for your approval/);
    assert.equal(starts(log).length, 0);
    assert.deepEqual(custom(path, MCP_NOTE_ENTRY).map((d) => d.how), ["changed"]);
    assert.deepEqual(chatLines(computer, "drift"), [], "a change isn't an error line");
    await say("third", call("mcp__drift__echo"), { text: "done" });
    assert.equal(custom(path, MCP_NOTE_ENTRY).length, 1, "one note until it works again");
  });

  test("a failure reaches the row's error lines with the chat's name, and the note links to the row", async () => {
    approve([{ ...server("lined", join(root, "lined.log")), command: join(root, "no-such-program") }]);
    const { say, path } = await open(project("lined"));
    await say("name this chat", call("mcp__lined__echo"), { text: "done" });
    const [note] = custom(path, MCP_NOTE_ENTRY);
    assert.equal(note.how, "failed");
    assert.deepEqual(note.link.to, "settings");
    const lines_ = chatLines(computer, "lined");
    assert.ok(lines_.length > 0);
    assert.equal(lines_[0]!.chat, "name this chat", "a failure on the first turn still names the chat");
  });

  test("a tool row reads its server and tool, hashed names too, saved and live", async () => {
    const long = "x".repeat(100);
    approve([server("named-one", join(root, "named.log"), [], [long]), { ...server("gone-one", join(root, "gone.log"), [], [long]), command: join(root, "no-such-program") }]);
    const { say, declared, notes, path, results } = await open(project("named"));
    await say("first", { text: "done" });
    const name = declared().find((n) => n.startsWith("mcp__named"))!;
    assert.ok(!name.includes(long), "pi shortened it");
    await say("second", call(name), { text: "done" });
    const live = notes.map((m) => JSON.parse(m)).find((m) => m.event?.type === "tool_execution_start");
    assert.deepEqual(live?.event?.mcp, { server: "named-one", tool: long });
    assert.deepEqual((await import("../../../shared/wire-v1")).fromV1(live)[0], { type: "tool.start", callId: live.event.toolCallId, name, args: { text: "hi" }, mcp: { server: "named-one", tool: long } });
    const { rowsOf } = await import("../../transcript");
    const { readBranch } = await import("./reader");
    const toolRows = async () => rowsOf(await readBranch(path)).filter((r) => r.kind === "tool-call" || r.kind === "tool-result").map((r) => r.mcp);
    const named = { server: "named-one", tool: long };
    assert.deepEqual(await toolRows(), [named, named], "a saved row, read as a reload reads it");
    const broken = declared().find((n) => n !== name)!;
    await say("third", call(broken), { text: "done" });
    assert.equal(results().at(-1)!.isError, true, "a call that failed before the server has no details");
    const gone = { server: "gone-one", tool: long };
    assert.deepEqual(await toolRows(), [named, named, gone, gone], "its row reads the same, hashed name and all");
  });
});

describe("workers", () => {
  const list = (name: string, log: string) => ({
    v: 1,
    servers: [{ id: "row", name, owner: computer, kind: "command", version: "v", record: record(name) }],
  });
  const spec = (cwd: string, mcp: unknown, over: object = {}) => ({
    kind: "worker", parent: { sessionId: "p", path: join(root, "parent.jsonl"), workerId: "ag_01" }, cwd, model: null, thinking: null, builtins: [], extensions: [], flags: {},
    appendSystemPrompt: null, env: {}, agentDir: null, lowered: true, ...(mcp ? { mcp } : {}), ...over,
  });

  test("a worker has what it was named and no more, and keeps it when it resumes", async () => {
    const log = join(root, "w.log");
    approve([server("named", log), server("other", join(root, "wo.log"))]);
    const cwd = project("worker");
    const path = chatFile(cwd);
    setWorkerSpec(path, spec(cwd, list("named", log)) as never);
    const w = await open(cwd, [], path);
    await w.say("go", call("mcp__named__echo"), { text: "done" });
    assert.deepEqual(w.declared(), ["mcp__named__echo"]);
    assert.equal(w.results()[0]!.isError, false, w.results()[0]!.text);
    assert.equal(custom(path, MCP_LIST_ENTRY).length, 1);
    await w.chat.dispose();
    setWorkerSpec(path, spec(cwd, list("other", log)) as never);
    const back = await open(cwd, [], path);
    await until(() => back.declared().length === 1, "its tools");
    assert.deepEqual(back.declared(), ["mcp__named__echo"], "the list it started with");
    await back.chat.dispose();
    setWorkerSpec(path, null);
  });

  test("none named: none, whatever the computer lists", async () => {
    approve([server("unnamed", join(root, "u.log"))]);
    const cwd = project("worker-none");
    const path = chatFile(cwd);
    setWorkerSpec(path, spec(cwd, null) as never);
    const w = await open(cwd, [], path);
    await w.say("go", { text: "done" });
    assert.deepEqual(w.declared(), []);
    await w.chat.dispose();
    setWorkerSpec(path, null);
  });

  test("under write-only confinement a command server runs confined, and a failure reaches the chat that started it", async () => {
    const cwd = project("write-only");
    const outside = join(root, "outside-write-only");
    const log = join(cwd, "wo.log");
    approve([server("fine", log, ["--write", outside], ["echo"], { STUB_NONCE: "CONFINED" }), server("stuck", join(cwd, "s.log"), ["--write", outside, "--need-write"])]);
    const told: unknown[] = [];
    setChatHosts({ mcpTell: (parent, note) => void told.push([parent, note]) });
    const path = chatFile(cwd);
    const scope = { version: 1, level: "workspace-write", workspaceRoot: cwd, writable: [cwd], readOnly: [join(cwd, ".agent")], writeOnly: true };
    const twoServers = { v: 1, servers: [...list("fine", log).servers, ...list("stuck", log).servers] };
    setWorkerSpec(path, spec(cwd, twoServers, { extensions: [join(agentDir, "extensions", "sandbox", "index.ts")], flags: { sandbox: "on", "sandbox-parent": JSON.stringify(scope) } }) as never);
    const w = await open(cwd, [], path);
    await w.say("go", call("mcp__fine__echo"), call("mcp__stuck__echo"), { text: "done" });
    const [fine, stuck] = w.results();
    assert.match(fine!.text, /^CONFINED/, fine!.text);
    assert.equal(existsSync(outside), false, "a write outside its worktree landed");
    assert.ok(lines(log).some((e) => e.event === "write-failed"));
    assert.equal(starts(log)[0].canary, null, "the clean environment holds under the confinement");
    assert.equal(stuck!.isError, true);
    await until(() => told.length > 0, "the parent's note");
    const [parent, note] = told[0] as [string, { server: string; how: string; worker?: string }];
    assert.equal(parent, join(root, "parent.jsonl"));
    assert.equal(note.how, "write-only");
    assert.equal(note.server, "stuck");
    assert.equal(chatLines(computer, "stuck")[0]!.where, "write-only");
    await w.chat.dispose();
    setWorkerSpec(path, null);
    setChatHosts({});
  });
});
