// Run: pnpm test -- server/harness/pi/mcp.test.ts. The pure rules of a chat's MCP servers (§app/mcp).
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { toPiToolName } from "../../../pi-config/extensions/claude-code/provider/types.ts";
import { cleanMcpEnv, mcpConfigOf, reservedMcpServerName, SnapshotTransport, type McpCheckRecord } from "./mcp";

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

  test("the approved set reaches pi as direct tools, with no env for pi to expand", () => {
    const record: McpCheckRecord = { protocolVersion: "2025-11-25", serverInfo: { name: "s", version: "1" }, tools: [] };
    const loaded = mcpConfigOf([{ name: "s", command: "c", args: ["a"], env: { X: "!touch /x" }, record }]);
    assert.equal(loaded.autoEnableCodemode, false);
    assert.equal(loaded.servers[0]!.config.exposure, "direct");
    assert.equal("env" in loaded.servers[0]!.config, false);
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
