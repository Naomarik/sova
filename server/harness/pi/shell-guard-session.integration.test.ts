// The kill guard (§chat/kill-guard) in a real AgentSession, through pi's own tool_call path and its real
// bash tool: a scripted model calls bash, and what ran is read off the disk. Every command here only
// lists (pgrep) or touches a file in a temp folder; nothing is ever signalled. The hook is built for an
// explicit platform, so this proves the same thing on any host.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const agentDir = mkdtempSync(join(tmpdir(), "sova-shell-guard-session-"));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const { shellGuardExtension } = await import("../../shell-guard-extension");
const pi = await import("@earendil-works/pi-coding-agent");
const piAi = await import(pathToFileURL(join(realpathSync(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent")), "..", "pi-ai", "dist", "index.js")).href);

/** A session whose model calls bash once with `command`, then says ok; the guard built for `platform`. */
async function run(command: string, platform: string) {
  const requests: unknown[][] = [];
  function streamSimple(model: any, context: any) {
    const stream = piAi.createAssistantMessageEventStream();
    requests.push(context.messages);
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    const base = { api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: zero }, timestamp: Date.now() };
    const first = requests.length === 1;
    const toolCall = { type: "toolCall", id: "call_1", name: "bash", arguments: { command } };
    const message = first ? { ...base, role: "assistant", content: [toolCall], stopReason: "toolUse" } : { ...base, role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      if (first) stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
      else stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: message });
      stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
    });
    return stream;
  }
  const cwd = mkdtempSync(join(agentDir, "cwd-"));
  const resourceLoader = new pi.DefaultResourceLoader({
    cwd,
    agentDir,
    extensionFactories: [
      (api: any) =>
        api.registerProvider("scripted", {
          baseUrl: "http://localhost",
          apiKey: "unused",
          api: "openai-completions",
          models: [{ id: "scripted-1", name: "Scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
          streamSimple,
        }),
      shellGuardExtension(platform) as never,
    ],
  });
  await resourceLoader.reload();
  const sessionManager = pi.SessionManager.inMemory(cwd);
  const { session } = await pi.createAgentSession({ cwd, agentDir, resourceLoader, settingsManager: pi.SettingsManager.inMemory(), sessionManager });
  await session.bindExtensions({ mode: "rpc" });
  const model = session.modelRuntime.getModel("scripted", "scripted-1");
  assert.ok(model);
  await session.setModel(model);
  try {
    await session.prompt("go");
  } finally {
    session.dispose();
  }
  const result = sessionManager.getBranch().find((e: any) => e.type === "message" && e.message.role === "toolResult") as any;
  assert.ok(result, "the call has a tool result");
  return { cwd, requests, result: result.message, text: JSON.stringify(result.message.content) };
}

const MARK = "sova-guard-no-such-process-7f3a";

test("macOS: a refused command runs nothing, and the refusal is the tool's error reply the model reads", async () => {
  const r = await run(`pgrep -f ${MARK} -P 1; touch ran`, "darwin");
  assert.equal(existsSync(join(r.cwd, "ran")), false, "nothing of the command ran, the touch after it included");
  assert.equal(r.result.isError, true);
  assert.match(r.text, /Sova refused this bash command before it ran; nothing ran/);
  assert.match(r.text, /on macOS, pgrep reads every argument after the first pattern/);
  assert.equal(r.requests.length, 2, "the model is called again with the refusal");
  assert.match(JSON.stringify(r.requests[1]), /Sova refused this bash command/);
});

test("macOS: a correct command runs as written", async () => {
  const r = await run(`pgrep -f ${MARK}; touch ran`, "darwin");
  assert.equal(existsSync(join(r.cwd, "ran")), true);
  assert.doesNotMatch(r.text, /Sova refused/);
});

test("Linux: the very same command runs: the guard registers nothing there", async () => {
  const r = await run(`pgrep -f ${MARK} -P 1; touch ran`, "linux");
  assert.equal(existsSync(join(r.cwd, "ran")), true);
  assert.doesNotMatch(r.text, /Sova refused/);
});
