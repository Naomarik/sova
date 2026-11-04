// Run: node scripts/run-tests.mjs --integration server/harness/pi/mcp.integration.test.ts. A chat's MCP servers
// (§app/mcp): real ChatSessions, real pi, a real stub server process, a scripted model; no real model.
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { linkPiConfigExtensions } from "../../testing/agent-dir";
import { ScriptedModel, scriptedModelsJson } from "./testing/scripted-model";
import { piSession } from "./testing/handle";
import { cleanMcpEnv, SnapshotTransport, StdioServer, type McpServerStatus } from "./mcp";

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

const { acquireChat, disposeAllChats } = await import("../../chat-manager");
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
const approve = (servers: unknown[]) => writeFileSync(join(agentDir, "sova", "mcp-approved.json"), JSON.stringify({ servers }));
const lines = (log: string): any[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const starts = (log: string) => lines(log).filter((e) => e.event === "start");

function project(name: string): string {
  const cwd = join(root, `${name}-${++n}`);
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

async function open(cwd: string) {
  const id = `0199eeee-0000-7000-8000-${String(++n).padStart(12, "0")}`;
  const path = canonicalPath(join(sessionsDir, `2026-11-04T00-00-${String(n).padStart(2, "0")}-000Z_${id}.jsonl`));
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-04T00:00:00.000Z", cwd })}\n`);
  markOwned(path);
  addWebSession(id);
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
    assert.deepEqual(heard.map((s) => s.state), ["starting", "starting", "running", "exited"]);
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
    const noted = () => notes.filter((m) => /"method":"notify".*MCP server .{1,2}needs.{1,2} failed/.test(m));
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
