// A project overseer on the Claude Code backend is offered the recall tools while its memory is on, checked by what
// the model is offered: the real Claude Code bridge, driving the stand-in `claude` (scripts/fake-claude.mjs), which with
// FAKE_CLAUDE_RECORD asks the bridge's MCP server for tools/list at each turn, as the real CLI does, and records the
// names. A process: hence this tier. A throwaway PI_CODING_AGENT_DIR and Claude login dir; ~/.pi is never read.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import { MEMORY_TOOLS } from "../shared/memory";
import { linkPiConfigExtensions } from "./testing/agent-dir";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-overseer-memory-cc-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
// The runner's stand-in `claude` is first on PATH: signed in on this login dir, recording each turn's offered tools.
const loginDir = join(root, "claude");
mkdirSync(loginDir, { recursive: true });
writeFileSync(join(loginDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fake", refreshToken: "fake", expiresAt: Date.now() + 8 * 3600_000 } }));
process.env.CLAUDE_CONFIG_DIR = loginDir;
const recordFile = join(root, "claude-record.jsonl");
process.env.FAKE_CLAUDE_RECORD = recordFile;
process.env.FAKE_CLAUDE_ONESHOT = "1";
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
linkPiConfigExtensions(agentDir);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));

await import("./testing/in-process-chats"); // chats open in this process (the server hosts none)
const { acquireChat, disposeAllChats, warmChatRuntime } = await import("./chat-manager");
const orgs = await import("./orgs");
const po = await import("./project-overseer");
const store = await import("./project-overseer-store");
const { registerProjectOverseerRoutes } = await import("./project-overseer-routes");
const { settled } = await import("./workspace-git");

after(async () => {
  await disposeAllChats();
  await settled(join(root, "ws"));
  rmSync(root, { recursive: true, force: true });
});

type Line = { tools?: string[]; frame?: unknown };
/** The tools the fake was offered at each user turn, in order. */
const offered = (): string[][] =>
  existsSync(recordFile)
    ? readFileSync(recordFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line).filter((l) => l.frame && l.tools).map((l) => l.tools!)
    : [];

describe("a project overseer on Claude Code", async () => {
  // Its loadout loads no extension, so the provider comes from the chat runtime's own start (as in a chat process).
  await warmChatRuntime();
  const org = await orgs.createOrg({ name: "MemCC", dir: join(root, "ws") });
  mkdirSync(join(root, "proj"));
  const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
  const p = store.projectOverseerPaths(project.id);
  store.writePoSettings(p, { ...store.readPoSettings(p), model: "claude-code-cli/claude-opus-5-5" });
  const app = new Hono();
  registerProjectOverseerRoutes(app);

  test("memory on by default: the CLI is offered zoom and date; switched off, neither", async () => {
    assert.equal(store.readPoSettings(p).memory, undefined, "no saved choice");
    const { path } = await po.ensureProjectOverseer(project.id);
    const chat = await acquireChat(path);
    assert.equal(chat.memory.choice().on, true);
    await chat.acceptPrompt("hello", undefined, "server").turn;
    const on = offered();
    assert.equal(on.length, 1, `one recorded turn: ${readFileSync(recordFile, "utf8").slice(0, 2000)}`);
    assert.ok(on[0]!.some((t) => t.startsWith("sova_")), `its own tools reached the CLI: ${on[0]}`);
    for (const t of MEMORY_TOOLS) assert.ok(on[0]!.includes(t), `${t} offered to the Claude Code model: ${on[0]}`);

    const r = await app.request(`/api/projects/${project.id}/overseer/memory`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: false }) });
    assert.equal(r.status, 200);
    await chat.acceptPrompt("again", undefined, "server").turn;
    const off = offered().at(-1)!;
    assert.equal(offered().length, 2);
    for (const t of MEMORY_TOOLS) assert.ok(!off.includes(t), `${t} not offered once off: ${off}`);
    assert.ok(off.some((t) => t.startsWith("sova_")), "its other tools stay");
  });
});
