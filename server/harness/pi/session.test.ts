// Run: pnpm test -- server/harness/pi/session.test.ts. The driving session on pi (§app.harness/session):
// it looks the runtime's session and every pi method up at each call (a method replaced after open is the one
// called, the way the chat tests patch `chat.session`), maps Sova's send options and input sources onto pi's in
// the caller's key order, maps each pi event to exactly one HarnessEvent inside pi's own listener, and wraps a
// user-message entry point once per agent. Uses a throwaway PI_CODING_AGENT_DIR with no credentials: no model
// is ever called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const agentDir = mkdtempSync(join(tmpdir(), "sova-harness-session-test-"));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths
const sessionsDir = join(agentDir, "sessions", "--tmp-harness-session--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

const { acquireChat, disposeAllChats } = await import("../../chat-manager");
const { canonicalPath } = await import("../../paths");
const { PiHarnessSession, harnessEventOf, isAlreadyProcessing } = await import("./session");
const { watchUserMessages } = await import("./turns");

after(async () => {
  await disposeAllChats();
  rmSync(agentDir, { recursive: true, force: true });
});

function sessionFile(name: string): string {
  const path = join(sessionsDir, `2026-10-05T00-00-00-000Z_${name}.jsonl`);
  const lines = [
    { type: "session", version: 3, id: name, timestamp: "2026-10-05T00:00:00.000Z", cwd },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-10-05T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "first ask" }] } },
    { type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-05T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "first answer" }], provider: "anthropic", model: "claude-opus-5", stopReason: "stop" } },
  ];
  writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  return canonicalPath(path);
}

type Calls = unknown[][];
const recorder = (calls: Calls, result: unknown = Promise.resolve()) => (...args: unknown[]) => (calls.push(args), result);

describe("PiHarnessSession (§app.harness/session)", () => {
  test("late binding: a method patched on chat.session after open is the one the harness calls", async () => {
    const chat = await acquireChat(sessionFile("01b0-late"), true);
    const s = chat.session as any;
    const prompt: Calls = [];
    const steer: Calls = [];
    const cont: Calls = [];
    s.prompt = recorder(prompt);
    s.steer = recorder(steer);
    s.agent.continue = recorder(cont);
    s.agent.hasQueuedMessages = () => true;
    Object.defineProperty(s, "isStreaming", { get: () => true, configurable: true });
    Object.defineProperty(s, "model", { get: () => ({ provider: "fake", id: "m1", input: ["text", "image"] }), configurable: true });
    const loader = {
      getAgentsFiles: () => ({ agentsFiles: [{ path: "/w/AGENTS.md", content: "x" }] }),
      getSkills: () => ({ skills: [{ name: "a", filePath: "/w/a/SKILL.md", description: "does a" }] }),
      getSystemPromptSource: () => undefined,
      getAppendSystemPromptSources: () => [{ path: "/w/APPEND.md" }],
    };
    Object.defineProperty(s, "resourceLoader", { get: () => loader, configurable: true });

    await chat.harness.send("hello", { images: undefined, source: "user" });
    await chat.harness.steer("nudge", undefined, { source: "system" });
    await chat.harness.queue.continue();
    assert.deepEqual(prompt, [["hello", { images: undefined, source: "interactive" }]]);
    assert.deepEqual(steer, [["nudge", undefined, { source: "extension" }]]);
    assert.equal(cont.length, 1);
    assert.equal(chat.harness.queue.hasQueued(), true);
    assert.equal(chat.harness.isRunning(), true);
    assert.deepEqual(chat.harness.model(), { ref: "fake/m1", provider: "fake", id: "m1", images: true });
    assert.deepEqual(chat.harness.resources(), {
      context: [{ path: "/w/AGENTS.md" }],
      skills: [{ name: "a", filePath: "/w/a/SKILL.md", description: "does a" }],
      systemPrompt: undefined,
      appendSystemPrompt: ["/w/APPEND.md"],
    });

    // And through the chat's own path: a queued hand-off reaches the patched prompt, not pi's.
    Object.defineProperty(s, "isStreaming", { get: () => false, configurable: true });
    const { turn } = chat.acceptPrompt("typed", undefined, "client");
    await turn;
    assert.deepEqual(prompt.at(-1), ["typed", { images: undefined, source: "interactive" }]);
  });

  test("late binding: a session the runtime swaps in is the one used", () => {
    const calls: string[] = [];
    const fake = (name: string) => ({ isStreaming: name === "b", sessionManager: { getLeafId: () => `${name}-leaf` }, abort: () => (calls.push(name), Promise.resolve()) });
    const runtime = { session: fake("a"), services: {} } as any;
    const h = new PiHarnessSession(runtime);
    assert.equal(h.leafId(), "a-leaf");
    assert.equal(h.isRunning(), false);
    void h.abort();
    runtime.session = fake("b");
    assert.equal(h.leafId(), "b-leaf");
    assert.equal(h.isRunning(), true);
    void h.abort();
    assert.deepEqual(calls, ["a", "b"]);
  });

  test("send options go to pi in the caller's key order, sources in pi's words, onAccepted as the preflight", async () => {
    const calls: Calls = [];
    const h = new PiHarnessSession({ session: { prompt: recorder(calls) }, services: {} } as any);
    let accepted = 0;
    await h.send("link", { expand: false, source: "system", delivery: "steer", onAccepted: () => void accepted++ });
    await h.send("queued", { images: undefined, delivery: "followUp", source: "queued" });
    await h.send("replay", { images: undefined, source: "user", expand: false });
    await h.send("plain");
    assert.deepEqual(calls.map((c) => [c[0], c[1] && Object.keys(c[1] as object)]), [
      ["link", ["expandPromptTemplates", "source", "streamingBehavior", "preflightResult"]],
      ["queued", ["images", "streamingBehavior", "source"]],
      ["replay", ["images", "source", "expandPromptTemplates"]],
      ["plain", undefined],
    ]);
    assert.deepEqual(calls.map((c) => (c[1] as { source?: string } | undefined)?.source), ["extension", "rpc", "interactive", undefined]);
    (calls[0]![1] as { preflightResult(ok: boolean): void }).preflightResult(true);
    assert.equal(accepted, 1);
  });

  test("each pi event is one HarnessEvent in Sova's words, its wire-1 frame made on demand", () => {
    const user = { role: "user", content: [{ type: "text", text: "a" }, { type: "image", data: "x", mimeType: "image/png" }, { type: "text", text: "b" }] };
    const end = harnessEventOf({ type: "message_end", message: user });
    assert.equal(end.type, "message.end");
    assert.ok(end.type === "message.end" && end.role === "user" && end.text === "a\nb" && end.handle === user);
    const asst = harnessEventOf({ type: "message_start", message: { role: "assistant", content: [] } });
    assert.ok(asst.type === "message.start" && asst.role === "assistant" && asst.text === undefined);
    const q = harnessEventOf({ type: "queue_update", steering: ["s"], followUp: [] });
    assert.ok(q.type === "queue" && q.steering[0] === "s" && q.followUp.length === 0);
    assert.ok((harnessEventOf({ type: "compaction_end", result: {} }) as { wrote?: boolean }).wrote === true);
    assert.ok((harnessEventOf({ type: "compaction_end", result: undefined, aborted: true }) as { wrote?: boolean }).wrote === false);
    const appended = harnessEventOf({ type: "entry_appended", entry: { type: "custom", id: "c1", parentId: null, customType: "k", data: 1 } });
    assert.ok(appended.type === "entry.appended" && appended.entry?.kind === "state");
    assert.equal(harnessEventOf({ type: "entry_appended" }).type, "other");
    assert.equal(harnessEventOf({ type: "some_new_event" }).type, "other");
    for (const [pi, sova] of [["agent_start", "run.start"], ["agent_settled", "run.settled"], ["agent_end", "run.end"], ["turn_end", "turn.end"], ["tool_execution_end", "tool.end"]])
      assert.equal(harnessEventOf({ type: pi! }).type, sova);
    assert.deepEqual(harnessEventOf({ type: "agent_start" }).frame(), { type: "event", event: { type: "agent_start" } });
  });

  test("subscribe: one pi listener per call, in pi's order and tick", () => {
    const listeners: ((e: unknown) => void)[] = [];
    const session = { subscribe: (fn: (e: unknown) => void) => (listeners.push(fn), () => listeners.splice(listeners.indexOf(fn), 1)) };
    const h = new PiHarnessSession({ session, services: {} } as any);
    const seen: string[] = [];
    const off = h.subscribe((e) => void seen.push(`a:${e.type}`));
    session.subscribe(() => void seen.push("raw"));
    h.subscribe((e) => void seen.push(`b:${e.type}`));
    assert.equal(listeners.length, 3);
    for (const l of [...listeners]) l({ type: "agent_settled" });
    assert.deepEqual(seen, ["a:run.settled", "raw", "b:run.settled"]);
    off();
    assert.equal(listeners.length, 2);
  });

  test("user-message claimers: one wrap per agent, the newest claimer first, as nested wraps were", () => {
    const got: string[] = [];
    const agent = { prompt: (m: unknown) => void got.push(`prompt:${(m as { id: string }).id}`), steer: () => {}, followUp: () => {} };
    const original = agent.prompt;
    const offA = watchUserMessages(agent, (m) => void got.push(`A:${(m as { id: string }).id}`));
    const wrapped = agent.prompt;
    assert.notEqual(wrapped, original);
    watchUserMessages(agent, (m) => void got.push(`B:${(m as { id: string }).id}`));
    assert.equal(agent.prompt, wrapped, "a second claimer adds no second wrap");
    agent.prompt({ id: "1" } as never);
    offA();
    agent.prompt({ id: "2" } as never);
    assert.deepEqual(got, ["B:1", "A:1", "prompt:1", "B:2", "prompt:2"]);
  });

  test("isAlreadyProcessing reads pi's refusal by its text (P4)", () => {
    assert.ok(isAlreadyProcessing(new Error("Agent is already processing a prompt")));
    assert.ok(!isAlreadyProcessing(new Error("Cannot submit a prompt while compaction is in progress")));
    assert.ok(!isAlreadyProcessing("already processing"));
  });
});
