// A background job's end card as a session's extensions see it (§app.overseer/input-source): the real
// SDK with the real wake-nudge extension delivering a card from a job record, and a recording `input`
// handler; only the model is a stub. Uses a throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { cardFile, JOBS_DIR_ENV, writeJob } from "../../../pi-config/extensions/subagents/job-store.ts";
import { piSession } from "./testing/handle";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-job-card-source-")));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;
const jobsDir = join(agentDir, "jobs");
mkdirSync(join(agentDir, "extensions"), { recursive: true });
writeFileSync(
  join(agentDir, "extensions", "record-input.ts"),
  `export default function (pi) {
  pi.on("input", (event) => {
    (globalThis.__inputs ??= []).push({ text: event.text, source: event.source });
  });
}
`,
);
// The real card deliverer, as a chat process loads it.
writeFileSync(join(agentDir, "extensions", "wake-nudge.ts"), `export { default } from ${JSON.stringify(join(import.meta.dirname, "..", "..", "..", "pi-config", "extensions", "wake-nudge.ts"))};\n`);

await import("../../testing/in-process-chats");
const { acquireChat, disposeAllChats } = await import("../../chat-manager");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const { canonicalPath } = await import("../../paths");
const { markOwned } = await import("../../write-guard");

const saved = { jobs: process.env[JOBS_DIR_ENV], path: process.env.SOVA_CHAT_PATH };
after(async () => {
  await disposeAllChats();
  for (const [k, v] of [[JOBS_DIR_ENV, saved.jobs], ["SOVA_CHAT_PATH", saved.path]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const g = globalThis as unknown as { __inputs?: { text: string; source: string }[] };
const TEST_MODEL = {
  id: "stub", name: "stub", api: "stub", provider: "stub", baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000,
};
type Chat = Awaited<ReturnType<typeof acquireChat>>;
function stubModel(chat: Chat): void {
  const session = piSession(chat) as unknown as {
    _modelRuntime: { hasConfiguredAuth(p: string): boolean };
    agent: { state: { model: unknown }; getApiKey: unknown; streamFunction: unknown };
  };
  session._modelRuntime.hasConfiguredAuth = () => true;
  session.agent.state.model = TEST_MODEL;
  session.agent.getApiKey = async () => "stub";
  session.agent.streamFunction = async () => {
    const message = {
      role: "assistant", api: "stub", provider: "stub", model: "stub", timestamp: Date.now(), content: [{ type: "text", text: "ok" }], stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; }, result: async () => message };
  };
}
async function until(cond: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("a background job's end card's input source (§app.overseer/input-source)", () => {
  test("the card reaches the session's extensions as its own message (source `extension`), never as typed input", async () => {
    const sm = SessionManager.create(agentDir);
    writeFileSync(sm.getSessionFile()!, `${JSON.stringify(sm.getHeader())}\n`, { flag: "wx" });
    const path = canonicalPath(sm.getSessionFile()!);
    const sessionId = sm.getSessionId();
    // The host's keeper recorded the job's end; the chat's own wake-nudge delivers the card.
    writeJob(jobsDir, { v: 1, id: "j1", sessionId, path, kind: "kept", command: "make lab > lab.log &", cwd: agentDir, unit: "u.scope", driver: "systemd", startedAt: Date.now() - 600_000, bootId: "b", output: "/w/lab.log", ended: { at: Date.now(), how: "exited", card: "wake" } });
    process.env[JOBS_DIR_ENV] = jobsDir;
    process.env.SOVA_CHAT_PATH = path;
    markOwned(path);
    const chat = await acquireChat(path);
    stubModel(chat);
    const card = () => g.__inputs?.find((i) => i.text.startsWith("[job j1]"));
    await until(() => card() !== undefined);
    await piSession(chat).waitForIdle();
    await until(() => {
      try {
        return readFileSync(cardFile(jobsDir, sessionId, "j1"), "utf8").trim() === "sent";
      } catch {
        return false;
      }
    });
    assert.equal(card()!.source, "extension");
    assert.notEqual(card()!.source, "interactive");
    assert.ok(readFileSync(path, "utf8").includes("[job j1] Background job ended."), "the card is on the branch");
  });
});
