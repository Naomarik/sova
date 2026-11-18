// Run: pnpm test server/harness/pi/tool-run-chat.test.ts. Tool-running time in a real chat: each top-level
// tool call's record goes into the tool-run store the moment the call ends, a wait on the session's own
// workers tagged as its own kind, and a call the user stopped still counts up to the stop. Real pi; the
// model is a stream function the test scripts, the tools an extension of the test's own.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { ScriptedModel, scriptedModelsJson } from "./testing/scripted-model";
import { piSession } from "./testing/handle";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-tool-run-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths
const sessionsDir = join(agentDir, "sessions", "--tool-run--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(root, "cwd");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(agentDir, "models.json"), JSON.stringify(scriptedModelsJson()));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "scripted", defaultModel: "scripted", retry: { enabled: false } }));

const { acquireChat, disposeAllChats } = await import("../../chat-manager");
const { canonicalPath } = await import("../../paths");
const { markOwned } = await import("../../write-guard");
const { addWebSession } = await import("../../web-sessions");
const { parseToolRunLine } = await import("../../tool-run-record");

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let n = 0;
function sessionFile(): { path: string; id: string } {
  const id = `0199eeee-0000-7000-8000-${String(++n).padStart(12, "0")}`;
  const path = canonicalPath(join(sessionsDir, `2026-11-18T00-00-${String(n).padStart(2, "0")}-000Z_${id}.jsonl`));
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-18T00:00:00.000Z", cwd })}\n`);
  markOwned(path);
  addWebSession(id);
  return { path, id };
}

// A wait on workers that settles after 150 ms, and a long tool that runs until it is stopped: the test's own
// extension, as a chat process loads one.
mkdirSync(join(agentDir, "extensions"), { recursive: true });
writeFileSync(
  join(agentDir, "extensions", "test-tools.ts"),
  `const params = { type: "object", properties: {} };
export default function (pi) {
  pi.registerTool({
    name: "agent_wait", label: "Wait", description: "wait", parameters: params,
    execute: async () => {
      await new Promise((r) => setTimeout(r, 150));
      return { content: [{ type: "text", text: "settled" }], details: {} };
    },
  });
  pi.registerTool({
    name: "slow_tool", label: "Slow", description: "slow", parameters: params,
    execute: (_id, _p, signal) => new Promise((_resolve, reject) => {
      const t = setTimeout(() => reject(new Error("never stopped")), 30000);
      signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); });
    }),
  });
}
`,
);

/** A chat whose first reply calls `calls` and whose later replies just answer. */
async function openChat(calls: string[]) {
  const { path, id } = sessionFile();
  const chat = await acquireChat(path, true);
  const session = piSession(chat) as any;
  new ScriptedModel().attach(session); // auth and the model
  let replies = 0;
  session.agent.streamFunction = (model: any) => {
    const first = replies++ === 0;
    const base = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [] as any[], timestamp: Date.now() };
    const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const final = first
      ? { ...base, usage, content: calls.map((name, i) => ({ type: "toolCall", id: `call-${i}`, name, arguments: {} })), stopReason: "toolUse" }
      : { ...base, usage, content: [{ type: "text", text: "done" }], stopReason: "stop" };
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "start", partial: base };
        yield { type: "done", reason: final.stopReason, message: final };
      },
      result: async () => final,
    };
  };
  return { chat, id };
}

function storeRecords(sid: string) {
  const dir = join(agentDir, "usage", "tools", "v1");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const day of readdirSync(dir))
    for (const f of readdirSync(join(dir, day)))
      for (const line of readFileSync(join(dir, day, f), "utf8").split("\n")) if (line) out.push(parseToolRunLine(line)!);
  return out.filter((r) => r.sid === sid).sort((a, b) => a.key.localeCompare(b.key));
}

describe("tool-running time in a chat", () => {
  test("a wait on workers is recorded as worker-wait when it ends, before the next reply", async () => {
    const { chat, id } = await openChat(["agent_wait"]);
    const began = Date.now();
    await chat.prompt("go");
    await until(() => !chat.harness.isRunning(), "the run's end");
    const recs = storeRecords(id);
    assert.equal(recs.length, 1);
    const [r] = recs;
    assert.equal(r!.key, `${id}:call-0`);
    assert.equal(r!.kind, "worker-wait");
    assert.equal(r!.tool, "agent_wait");
    assert.ok(r!.start >= began && r!.end - r!.start >= 140, `the wait's span: ${r!.end - r!.start} ms`);
    assert.equal(typeof r!.producer, "string");
  });

  test("a long tool and then Stop before the next reply: its time up to the stop is recorded", async () => {
    const { chat, id } = await openChat(["slow_tool"]);
    void chat.prompt("go").catch(() => undefined);
    await until(() => chat.harness.isRunning(), "the run");
    await sleep(400);
    assert.equal(storeRecords(id).length, 0, "nothing until the call ends");
    await chat.harness.abort();
    await until(() => !chat.harness.isRunning(), "the run's end");
    await until(() => storeRecords(id).length === 1, "the record");
    const [r] = storeRecords(id);
    assert.equal(r!.kind, "tool");
    assert.equal(r!.tool, "slow_tool");
    assert.ok(r!.end - r!.start >= 300, `counted to the stop: ${r!.end - r!.start} ms`);
  });
});
