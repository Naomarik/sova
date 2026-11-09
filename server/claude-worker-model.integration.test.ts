// A Claude Code worker on a model Sova's built-in list doesn't hold (§app.claude-code-provider/catalog:
// still used, never refused). Run in the failing order the operator hit: the chat process warms the
// provider up first, then the worker opens with its own model. "Started" is what the stand-in `claude`
// (scripts/fake-claude.mjs) was launched with for the worker's first turn: showing in a list isn't enough.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { linkPiConfigExtensions } from "./testing/agent-dir";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-claude-worker-")));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
const loginDir = join(root, "claude");
mkdirSync(loginDir, { recursive: true });
writeFileSync(join(loginDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fake", refreshToken: "fake", expiresAt: Date.now() + 8 * 3600_000 } }));
process.env.CLAUDE_CONFIG_DIR = loginDir;
const recordFile = join(root, "claude-record.jsonl");
process.env.FAKE_CLAUDE_RECORD = recordFile;
const sessionsDir = join(agentDir, "sessions", "--claude-worker--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
mkdirSync(join(agentDir, "sova"), { recursive: true });
linkPiConfigExtensions(agentDir);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
const project = join(root, "project");
mkdirSync(project, { recursive: true });

await import("./testing/in-process-chats");
const { acquireChat, disposeAllChats, disposeHeldChat, setWorkerSpec, warmChatRuntime } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");

before(async () => {
  await warmChatRuntime();
});
after(async () => {
  await disposeAllChats();
  rmSync(root, { recursive: true, force: true });
});

const argvs = (): string[][] =>
  existsSync(recordFile)
    ? readFileSync(recordFile, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { argv?: string[] }).argv ?? []).filter((a) => a.length)
    : [];

let n = 0;
async function startsOn(id: string): Promise<void> {
  n++;
  const sid = `01a2b3c4-0000-7000-8000-00000000000${n}`;
  const path = canonicalPath(join(sessionsDir, `2026-11-09T00-00-00-000Z_${sid}.jsonl`));
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: sid, timestamp: "2026-11-09T00:00:00.000Z", cwd: project })}\n`);
  const ref = `claude-code-cli/${id}`;
  setWorkerSpec(path, {
    kind: "worker",
    parent: { sessionId: "p", path: "/p.jsonl", workerId: `ag_0${n}` },
    cwd: project,
    model: ref,
    thinking: null,
    builtins: null,
    extensions: [join(ROOT, "pi-config", "extensions", "claude-code", "index.ts")],
    flags: { "claude-code-provider": true, "claude-code-model": id },
    appendSystemPrompt: null,
    env: {},
    agentDir: null,
    lowered: true,
  } as never);
  const before = argvs().length;
  try {
    const chat = await acquireChat(path, true);
    assert.equal(chat.harness.model()?.ref, ref, "the model is set on the worker");
    await chat.acceptPrompt("do the task", undefined, "server").turn;
    const launched = argvs().slice(before);
    assert.ok(launched.length > 0, "the task reached Claude Code");
    assert.equal(launched[0]![launched[0]!.indexOf("--model") + 1], id, `claude runs on that model: ${launched[0]!.join(" ")}`);
    await disposeHeldChat(path, "test: done");
  } finally {
    setWorkerSpec(path, null);
  }
}

test("a shape-valid id Sova doesn't know starts a worker on that model", async () => {
  await startsOn("claude-nova-1-2");
});

test("a built-in model still starts a worker (the control)", async () => {
  await startsOn("claude-haiku-5-5");
});
