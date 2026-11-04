// Run: pnpm test -- server/harness/pi/mcp.test.ts. The pure rules of a chat's MCP servers (§app/mcp).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { toPiToolName } from "../../../pi-config/extensions/claude-code/provider/types.ts";
import type { McpChatServer } from "../../mcp/list";
import type { McpCheckRecord } from "../../mcp/store";
import { cleanMcpEnv, Events, type JsonRpc, type StdioServer } from "../../mcp/transport";
import { mcpConfigOf, reservedMcpServerName, SnapshotTransport } from "./mcp";

const tool = (name: string) => ({ name, description: "", parameters: { type: "object" } }) as never;

describe("the name sova", () => {
  test("the provider's prefix strip tells the two tools apart: pi's read under its one prefix, the server's under two", () => {
    const tools = [tool("read"), tool("mcp__sova__read")];
    assert.equal(toPiToolName("mcp__sova__read", tools), "read");
    assert.equal(toPiToolName("mcp__sova__mcp__sova__read", tools), "mcp__sova__read");
  });

  test("it is refused in any case, and nothing else is", () => {
    for (const name of ["sova", "SOVA", "Sova"]) assert.equal(reservedMcpServerName(name), true, name);
    for (const name of ["sovaa", "my-sova", "sova2", "sova-x", "sova_"]) assert.equal(reservedMcpServerName(name), false, name);
  });
});

describe("what a server is given", () => {
  test("only the basics and its own entry", () => {
    const env = cleanMcpEnv({ PATH: "/bin", HOME: "/h", LC_ALL: "C", TMPDIR: "/t", SOVA_TOKEN: "t", ANTHROPIC_API_KEY: "k", PI_MODEL: "m", SSH_AUTH_SOCK: "s" }, { MINE: "1" });
    assert.deepEqual(env, { PATH: "/bin", HOME: "/h", LC_ALL: "C", TMPDIR: "/t", MINE: "1" });
  });

  test("a listed server reaches pi as direct tools, with nothing for pi to expand or run", () => {
    const config = mcpConfigOf({ name: "s" } as McpChatServer);
    assert.equal(config.exposure, "direct");
    for (const key of ["env", "args", "cwd", "headers"]) assert.equal(key in config, false, key);
  });
});

describe("SnapshotTransport", () => {
  const record: McpCheckRecord = { protocolVersion: "2025-11-25", serverInfo: { name: "s", version: "1" }, tools: [{ name: "t", inputSchema: { type: "object" } }] };
  const transport = () => {
    let started = 0;
    const t = new SnapshotTransport(record, () => { started++; throw new Error("no server here"); }, () => {}, 1000);
    const heard: { id?: unknown; result?: unknown; error?: { message: string } }[] = [];
    t.onMessage((m) => heard.push(m as never));
    return { t, heard, started: () => started };
  };

  test("the handshake and tools/list come from the record and start nothing", async () => {
    const { t, heard, started } = transport();
    await t.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await t.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await t.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await t.send({ jsonrpc: "2.0", id: 3, method: "ping" });
    await Promise.resolve();
    assert.deepEqual(heard.map((m) => m.id), [1, 2, 3]);
    assert.deepEqual((heard[1]!.result as McpCheckRecord).tools, record.tools);
    assert.equal(started(), 0);
  });
});

describe("a filled value never leaves through the transport", () => {
  const SECRET = "filled-9f3a";
  const record: McpCheckRecord = { protocolVersion: "2025-11-25", serverInfo: { name: "s", version: "1" }, tools: [] };

  /** A server holding `SECRET` that prints it and dies at a call, or answers as `on` says. */
  class Leaky extends Events {
    values = [SECRET];
    stderr = "";
    sandboxed = false;
    pid = 1;
    constructor(private readonly on: (m: JsonRpc, self: Leaky) => void) {
      super();
    }
    async start() {}
    async close() {}
    async send(m: JsonRpc) {
      if (m.method === "initialize") return queueMicrotask(() => this.emitMessage({ id: m.id, result: {} }));
      if (m.id !== undefined) this.on(m, this);
    }
    die(text: string) {
      this.stderr += text;
      this.emitClose();
    }
    say(m: JsonRpc) {
      this.emitMessage(m);
    }
    oops(e: Error) {
      this.emitError(e);
    }
  }

  const drive = async (on: (m: JsonRpc, self: Leaky) => void) => {
    const statuses: string[] = [];
    const t = new SnapshotTransport(record, () => new Leaky(on) as unknown as StdioServer, (p) => void statuses.push(JSON.stringify(p)), 1000);
    const heard: unknown[] = [];
    const errors: string[] = [];
    t.onMessage((m) => void heard.push(m));
    t.onError((e) => void errors.push(e.message));
    await t.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await t.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "x" } });
    await new Promise((r) => setTimeout(r, 0));
    return { heard, statuses, errors };
  };

  test("a server that prints it and exits during a call: the call's error and the status lack it", async () => {
    const { heard, statuses } = await drive((_m, self) => self.die(`auth failed for ${SECRET}\n`));
    const out = JSON.stringify([heard, statuses]);
    assert.match(out, /auth failed for/, "the line itself still reaches the model");
    assert.ok(!out.includes(SECRET), out);
  });

  test("a server that refuses the handshake with it", async () => {
    const statuses: string[] = [];
    const server = new Leaky(() => {});
    server.send = async (m: JsonRpc) => (m.method === "initialize" ? queueMicrotask(() => server.say({ id: m.id, error: { message: `bad key ${SECRET}` } })) : undefined);
    const t = new SnapshotTransport(record, () => server as unknown as StdioServer, (p) => void statuses.push(JSON.stringify(p)), 1000);
    const heard: unknown[] = [];
    t.onMessage((m) => void heard.push(m));
    await t.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await t.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {} });
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(!JSON.stringify([heard, statuses]).includes(SECRET));
  });

  test("its error reply, a log notification and an unreadable line lack it; a tool's own result is the server's answer", async () => {
    const { heard, errors } = await drive((m, self) => {
      self.say({ method: "notifications/message", params: { data: `using ${SECRET}` } });
      self.oops(new Error(`Unexpected token in "${SECRET}"`));
      self.say({ id: m.id, error: { code: -1, message: `denied for ${SECRET}` } });
    });
    assert.ok(!JSON.stringify([heard, errors]).includes(SECRET), JSON.stringify([heard, errors]));
    assert.equal(errors.length, 1);
    const { heard: answer } = await drive((m, self) => self.say({ id: m.id, result: { content: [{ type: "text", text: `echo ${SECRET}` }] } }));
    assert.ok(JSON.stringify(answer).includes(SECRET), "passed through as it came");
  });
});

