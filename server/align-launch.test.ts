// A chat's align launch record (§chat.alignment-review/flag, §chat.alignment/visuals): adversarial review and
// Visuals are taken at the chat's first start, written with its first message, and every later start of the
// same chat gets the same flags — whatever the settings say by then — and so does the web's review gate
// (the hello's `alignReview`). Real SDK runs, the real mode extension; only the model is a stub.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import type { ChatServerMessage } from "../shared/protocol";
import { piSession } from "./harness/pi/testing/handle";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-align-launch-")));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths
const sessionsDir = join(agentDir, "sessions", "--tmp-align-launch--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [resolve(dirname(fileURLToPath(import.meta.url)), "../pi-config/extensions/mode")] }));

const { acquireChat, disposeAllChats, disposeHeldChat } = await import("./chat-manager");
const { markOwned } = await import("./write-guard");
const { writeWebSettings } = await import("./web-settings");
const { saveAlignSettingsBody } = await import("./align-settings");

after(async () => {
  await disposeAllChats();
  rmSync(agentDir, { recursive: true, force: true });
});

type Chat = Awaited<ReturnType<typeof acquireChat>>;
const TEST_MODEL = {
  id: "stub", name: "stub", api: "stub", provider: "stub", baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000,
};
let requests = 0;
function fakeRuns(chat: Chat): void {
  const session = piSession(chat) as unknown as {
    _modelRuntime: { hasConfiguredAuth(p: string): boolean };
    agent: { state: { model: unknown }; getApiKey: unknown; streamFunction: unknown };
  };
  session._modelRuntime.hasConfiguredAuth = () => true;
  session.agent.state.model = TEST_MODEL;
  session.agent.getApiKey = async () => "stub";
  session.agent.streamFunction = async () => {
    requests++;
    const message = {
      role: "assistant", api: "stub", provider: "stub", model: "stub", timestamp: Date.now(),
      content: [{ type: "text", text: "ok" }], stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; }, result: async () => message };
  };
}
const client = {
  send: (m: ChatServerMessage) => {
    if (m.type === "error") throw new Error(`chat error: ${m.message}`);
  },
};
async function until(cond: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
async function settledRun(chat: Chat, text: string): Promise<void> {
  const n = requests;
  chat.handle(client, { type: "prompt", text });
  await until(() => requests > n);
  await piSession(chat).waitForIdle();
}

/** The flags the runtime's extensions were handed, the two this feature decides. */
const alignFlags = (chat: Chat) => {
  const flags = (piSession(chat) as unknown as { extensionRunner: { getFlagValues(): Map<string, boolean | string> } }).extensionRunner.getFlagValues();
  return { review: flags.get("adversarial-review"), visuals: flags.get("align-visuals") };
};
const launchRecords = (path: string) =>
  readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "custom" && e.customType === "sova-align-launch").map((e) => e.data);

test("flip the settings between two opens of the same chat: the second runtime's flags and web gate equal the first's", async () => {
  writeWebSettings({ alignment: { review: true } });
  saveAlignSettingsBody({ version: 1, style: "default", visuals: true });
  const path = join(sessionsDir, "2026-10-09T00-00-00-000Z_01234567-89ab-7cde-8f01-0000000000b1.jsonl");
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: "01234567-89ab-7cde-8f01-0000000000b1", timestamp: "2026-10-09T00:00:00.000Z", cwd })}\n`);
  markOwned(path);

  let chat = await acquireChat(path);
  fakeRuns(chat);
  const first = { flags: alignFlags(chat), gate: chat.hello().alignReview };
  assert.deepEqual(first, { flags: { review: true, visuals: "on" }, gate: true }, "the first start takes the switches as saved");
  assert.deepEqual(launchRecords(path), [], "merely opening writes nothing");
  await settledRun(chat, "first");
  assert.deepEqual(launchRecords(path), [{ v: 1, review: true, visuals: true }], "the first message writes the launch record, once");

  // Flip both, then reopen the same chat (a server restart, a CLI restart).
  writeWebSettings({ alignment: { review: false } });
  saveAlignSettingsBody({ version: 1, style: "default", visuals: false });
  await disposeHeldChat(path, "reopen");
  markOwned(path);
  chat = await acquireChat(path);
  fakeRuns(chat);
  assert.deepEqual({ flags: alignFlags(chat), gate: chat.hello().alignReview }, first, "the reopened runtime starts exactly as the first did");
  await settledRun(chat, "second");
  assert.equal(launchRecords(path).length, 1, "no second record");

  // A new chat started now takes the settings as they are now.
  const fresh = join(sessionsDir, "2026-10-09T00-00-01-000Z_01234567-89ab-7cde-8f01-0000000000b2.jsonl");
  writeFileSync(fresh, `${JSON.stringify({ type: "session", version: 3, id: "01234567-89ab-7cde-8f01-0000000000b2", timestamp: "2026-10-09T00:00:01.000Z", cwd })}\n`);
  markOwned(fresh);
  const other = await acquireChat(fresh);
  assert.deepEqual({ flags: alignFlags(other), gate: other.hello().alignReview }, { flags: { review: false, visuals: "off" }, gate: false }, "its flag registered off (its default), Visuals off");
});
