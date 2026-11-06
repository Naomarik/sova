// overseer_ping in a Claude Code chat (§app.overseer-pings/tool "Every ordinary chat, on any model", "Fixed
// text"): what the model is offered is checked through the real Claude Code bridge driving the stand-in
// `claude` (scripts/fake-claude.mjs), which with FAKE_CLAUDE_RECORD asks the bridge's MCP server for tools/list
// at each turn and records each tool's schema and the child's argv. The CLI gets the tool with the schema a pi
// chat declares, and a reopen offers the same tools, so the chat resumes its Claude session instead of
// restarting. A throwaway PI_CODING_AGENT_DIR and Claude login dir; ~/.pi is never read.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { linkPiConfigExtensions } from "./testing/agent-dir";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-pings-cc-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
const loginDir = join(root, "claude");
mkdirSync(loginDir, { recursive: true });
writeFileSync(join(loginDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fake", refreshToken: "fake", expiresAt: Date.now() + 8 * 3600_000 } }));
process.env.CLAUDE_CONFIG_DIR = loginDir;
const recordFile = join(root, "claude-record.jsonl");
process.env.FAKE_CLAUDE_RECORD = recordFile;
process.env.FAKE_CLAUDE_ONESHOT = "1";
const sessionsDir = join(agentDir, "sessions", "--pings-cc--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
linkPiConfigExtensions(agentDir);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
const project = join(root, "project");
mkdirSync(project, { recursive: true });

await import("./testing/in-process-chats"); // chats open in this process (the server hosts none)
const { acquireChat, disposeAllChats, disposeHeldChat, warmChatRuntime } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
const { overseerPingTool } = await import("./overseer-pings");
const { declOfTool } = await import("./chat-handle");
const { OVERSEER_PING_TOOL } = await import("../shared/protocol");
const { piSession } = await import("./harness/pi/testing/handle");

after(async () => {
  await disposeAllChats();
  rmSync(root, { recursive: true, force: true });
});

type Line = { argv?: string[]; tools?: string[]; schemas?: Record<string, unknown>; frame?: unknown };
const turns = (): Line[] =>
  existsSync(recordFile)
    ? readFileSync(recordFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line).filter((l) => l.frame && l.tools)
    : [];

/** A session on `model` ("provider/id"), in the project, with no message yet. */
function session(id: string, provider: string, modelId: string): string {
  const path = join(sessionsDir, `2026-11-06T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(
    path,
    [
      JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-06T00:00:00.000Z", cwd: project }),
      JSON.stringify({ type: "model_change", id: `${id}-m`, parentId: null, timestamp: "2026-11-06T00:00:00.000Z", provider, modelId }),
    ].join("\n") + "\n",
  );
  return canonicalPath(path);
}

/** A schema's parts a model reads: its properties and what is required. */
const shape = (s: unknown) => {
  const o = JSON.parse(JSON.stringify(s ?? null)) as { properties?: unknown; required?: unknown } | null;
  return { properties: o?.properties, required: o?.required };
};

describe("overseer_ping on Claude Code and on pi", async () => {
  await warmChatRuntime();

  test("the CLI is offered mcp__sova__overseer_ping with the schema a pi chat holds, and a reopen resumes with the same tools", async () => {
    const served = shape(declOfTool(overseerPingTool({ sessionId: () => "x", path: () => "x", title: () => "x" })).parameters);
    const piPath = session("01a2b3c4-0000-7000-8000-0000000000a1", "zai", "glm-5.3");
    const pi = await acquireChat(piPath, true);
    const piTool = piSession(pi).getAllTools().find((t) => t.name === OVERSEER_PING_TOOL);
    assert.ok(piTool, "a pi chat holds it");
    assert.deepEqual(shape(piTool!.parameters), served, "a pi chat's schema is the served one");

    const ccPath = session("01a2b3c4-0000-7000-8000-0000000000c1", "claude-code-cli", "claude-opus-5-5");
    let chat = await acquireChat(ccPath, true);
    await chat.acceptPrompt("hello", undefined, "server").turn;
    const first = turns()[0];
    assert.ok(first, `one recorded turn: ${existsSync(recordFile) ? readFileSync(recordFile, "utf8").slice(0, 2000) : "none"}`);
    assert.ok(first.tools!.includes(OVERSEER_PING_TOOL), `the tool reached the CLI: ${first.tools}`);
    assert.deepEqual(shape(first.schemas?.[OVERSEER_PING_TOOL]), served, "the CLI's schema is the pi chat's");

    await disposeHeldChat(ccPath, "test: reopen");
    chat = await acquireChat(ccPath, true);
    await chat.acceptPrompt("again", undefined, "server").turn;
    const second = turns()[1];
    assert.ok(second, "a second recorded turn");
    assert.deepEqual(second.tools, first.tools, "the same tools across builds");
    assert.deepEqual(shape(second.schemas?.[OVERSEER_PING_TOOL]), served);
    assert.ok(second.argv!.includes("--resume"), `its CLI resumes rather than restarting: ${second.argv!.join(" ")}`);
    await disposeHeldChat(ccPath, "test: done");
    await disposeHeldChat(piPath, "test: done");
  });
});
