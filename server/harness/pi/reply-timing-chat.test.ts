// Run: pnpm test -- server/harness/pi/reply-timing-chat.test.ts. Reply timing in a real chat
// (§app.insights/reply-timing): the chat hears its agent's request go out (P25), times the reply's parts,
// writes one record into the store for a finished reply, tags wire 2's message.end with its timing while
// wire 1's frame stays as it was, and gives the reply's row its `reply` fact on the next hello. A reply
// that errors writes nothing. Real pi; the model is a stream function the test scripts part by part.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { ChatServerMessage } from "../../../shared/protocol";
import { ScriptedModel, scriptedModelsJson } from "./testing/scripted-model";
import { piSession } from "./testing/handle";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-reply-timing-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths
const sessionsDir = join(agentDir, "sessions", "--reply-timing--");
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
const { keepHearingRequests } = await import("./session");
const { parsePerfRecordLine } = await import("../../perf-record");

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
  const path = canonicalPath(join(sessionsDir, `2026-10-13T00-00-${String(n).padStart(2, "0")}-000Z_${id}.jsonl`));
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-13T00:00:00.000Z", cwd })}\n`);
  markOwned(path);
  addWebSession(id);
  return { path, id };
}

type Step = { text: string; output: number; error?: true };

/** A chat whose model streams each reply as a provider does: onPayload, then start, then a thinking part
    and a text part with real waits, then done (or an error). */
async function openChat(steps: Step[]) {
  const { path, id } = sessionFile();
  const chat = await acquireChat(path, true);
  const session = piSession(chat) as any;
  const heard = session.agent.streamFunction;
  new ScriptedModel().attach(session); // auth and the model
  session.agent.streamFunction = (model: any, _context: unknown, options?: { onPayload?: (p: unknown, m: unknown) => unknown }) => {
    const step = steps.shift() ?? { text: "ok", output: 1 };
    const base = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [] as any[], timestamp: Date.now() };
    const usage = { input: 1, output: step.output, cacheRead: 0, cacheWrite: 0, totalTokens: 1 + step.output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const final = step.error
      ? { ...base, usage, stopReason: "error", errorMessage: "boom" }
      : { ...base, usage, content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: step.text }], stopReason: "stop" };
    return {
      async *[Symbol.asyncIterator]() {
        await options?.onPayload?.({}, model); // the request goes out
        await sleep(30);
        yield { type: "start", partial: base };
        if (step.error) {
          yield { type: "error", reason: "error", error: final };
          return;
        }
        await sleep(20);
        yield { type: "thinking_start", contentIndex: 0, partial: base };
        await sleep(40);
        yield { type: "thinking_end", contentIndex: 0, content: "hm", partial: base };
        yield { type: "text_start", contentIndex: 1, partial: base };
        yield { type: "text_delta", contentIndex: 1, delta: step.text, partial: base };
        await sleep(40);
        yield { type: "text_delta", contentIndex: 1, delta: ".", partial: base };
        yield { type: "text_end", contentIndex: 1, content: step.text, partial: base };
        yield { type: "done", reason: "stop", message: final };
      },
      result: async () => final,
    };
  };
  keepHearingRequests(session.agent, heard);
  const wire1: ChatServerMessage[] = [];
  const wire2: any[] = [];
  chat.attach({ send: (m: ChatServerMessage) => wire1.push(m) } as never);
  chat.attach({ wire: 2, send: (m: unknown) => wire2.push(m) } as never);
  return { chat, id, wire1, wire2 };
}

function storeRecords() {
  const dir = join(agentDir, "usage", "perf", "v1");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const day of readdirSync(dir))
    for (const f of readdirSync(join(dir, day))) for (const line of readFileSync(join(dir, day, f), "utf8").split("\n")) if (line) out.push(parsePerfRecordLine(line)!);
  return out;
}

describe("reply timing in a chat (§app.insights/reply-timing)", () => {
  test("a finished reply: one record in the store, its timing on wire 2's message.end and the next hello's row, wire 1 untouched", async () => {
    const { chat, id, wire1, wire2 } = await openChat([{ text: "hello there", output: 120 }]);
    await chat.prompt("hi");
    await until(() => storeRecords().length === 1, "the record");
    const [rec] = storeRecords();
    assert.equal(rec!.sid, id);
    assert.equal(rec!.key, `${id}:${rec!.entryId}`);
    assert.equal(rec!.provider, "scripted");
    assert.equal(rec!.output, 120);
    assert.equal(rec!.stop, "stop");
    assert.ok(rec!.ttftMs >= 40, `the wait holds the response and first-part delays: ${rec!.ttftMs}`);
    assert.equal(rec!.thinking.n, 1);
    assert.ok(rec!.thinkingMs >= 30);
    assert.equal(rec!.text.n, 1);
    assert.ok(rec!.replyMs >= 30);
    assert.equal("reasoning" in rec!, false, "no count reported");
    // Wire 1: the message_end frame as it always was.
    const end1 = wire1.find((m: any) => m.type === "event" && m.event?.type === "message_end" && m.event.message?.role === "assistant") as any;
    assert.ok(end1);
    assert.equal("reply" in end1, false);
    assert.equal(end1.entryId, rec!.entryId);
    // Wire 2: message.end carries it.
    await until(() => wire2.some((f) => f.v === 2 && f.event?.type === "message.end" && f.event.reply), "wire 2's message.end");
    const end2 = wire2.find((f) => f.v === 2 && f.event?.type === "message.end" && f.event.reply);
    assert.deepEqual(end2.event.reply, { ttftMs: rec!.ttftMs, thinkingMs: rec!.thinkingMs, replyMs: rec!.replyMs, thinkingParts: 1, output: 120, effort: rec!.effort ?? end2.event.reply.effort });
    // A new wire-2 client's hello: the reply's first row has the fact.
    const hello2: any[] = [];
    chat.attach({ wire: 2, send: (m: unknown) => hello2.push(m) } as never);
    const hello = hello2.find((m) => m.type === "hello");
    const row = hello.items.find((it: any) => it.facts?.reply);
    assert.ok(row, "a row with the reply fact");
    assert.equal(row.facts.reply.output, 120);
    const hello1: any[] = [];
    chat.attach({ send: (m: unknown) => hello1.push(m) } as never);
    assert.ok(!JSON.stringify(hello1.find((m) => m.type === "hello")).includes('"reply"'), "wire 1's hello has no reply fact");
  });

  test("a reply that errors writes nothing", async () => {
    const before = storeRecords().length;
    const { chat } = await openChat([{ text: "", output: 0, error: true }]);
    await chat.prompt("hi").catch(() => undefined);
    await until(() => !chat.harness.isRunning(), "the run's end");
    await sleep(50);
    assert.equal(storeRecords().length, before);
  });
});
