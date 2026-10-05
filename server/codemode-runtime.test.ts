// Run: pnpm test -- server/codemode-runtime.test.ts. The codemode minor mode in hosted chats
// (§chat.mode-menu/codemode): real SDK runtimes built by the chat manager (so pi's codemode tool comes from
// DEFAULT_EXTENSION_FACTORIES), the real mode extension, and real scripts in pi's sandbox (a worker thread
// running QuickJS) on whatever runtime runs the tests (Bun under pnpm test). Only the chat model is a stub.
// A throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import type { ChatServerMessage } from "../shared/protocol";
import { piSession } from "./harness/pi/testing/handle";
import { CODEMODE_OFF_NOTE, CODEMODE_STUB_DESCRIPTION, CODEMODE_NOTE_TYPE } from "./harness/pi/codemode";
import { holdsSlot } from "../pi-config/extensions/provider-limits/gate.ts";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-codemode-")));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths
const sessionsDir = join(agentDir, "sessions", "--tmp-codemode--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });
// A tool for scripts to call, and the extension API kept so a test can register an MCP-like tool later.
mkdirSync(join(agentDir, "extensions"), { recursive: true });
writeFileSync(
  join(agentDir, "extensions", "echo-tool.ts"),
  `export default function (pi) {
  (globalThis.__codemodePi ??= []).push(pi);
  pi.registerTool({ name: "echo", label: "echo", description: "Echo a word.", parameters: { type: "object", properties: { word: { type: "string" } }, additionalProperties: false }, execute: async (_id, p) => ({ content: [{ type: "text", text: "echo:" + (p.word ?? "") }], details: {} }) });
}
`,
);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [resolve(dirname(fileURLToPath(import.meta.url)), "../pi-config/extensions/mode")] }));

const { acquireChat, disposeAllChats, disposeHeldChat, getModelRuntime } = await import("./chat-manager");
const { markOwned } = await import("./write-guard");

after(async () => {
  await disposeAllChats();
});

type Chat = Awaited<ReturnType<typeof acquireChat>>;
const stubModel = (provider: string) => ({
  id: "stub", name: "stub", api: "stub", provider, baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000,
});

interface Seen {
  tools: { name: string; description: string; parameters: string }[];
  /** The prompt the model has: the system messages' text and sections, patches applied. */
  system: string;
  /** System messages in the context: a prompt or tool-set change adds one. */
  systems: number;
  /** The context's custom and user messages' texts, in order (what reached the model). */
  texts: string[];
  /** Each tool result in the context, by its call id. */
  results: Map<string, string>;
}
type Step = { tool: string; args: Record<string, unknown> } | { text: string } | (() => Promise<void>);

const textOf = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? (b as { text: string }).text : "")).join("") : "";

/** The chat's runs on a script: each request records what it saw and answers with the next step. */
function stub(chat: Chat, provider = "stub") {
  const seen: Seen[] = [];
  const steps: Step[] = [];
  let n = 0;
  const session = piSession(chat) as unknown as {
    _modelRuntime: { hasConfiguredAuth(p: string): boolean };
    agent: { state: { model: unknown }; getApiKey: unknown; streamFunction: unknown };
  };
  session._modelRuntime.hasConfiguredAuth = () => true;
  session.agent.state.model = stubModel(provider);
  session.agent.getApiKey = async () => "stub";
  session.agent.streamFunction = async (_model: unknown, context: any) => {
    const messages = (context.messages ?? []) as any[];
    // pi 1.0 carries the prompt and the tool set as system messages: the leading one, then patches.
    const tools = new Map<string, any>();
    const sections: Record<string, string> = {};
    const base: string[] = [];
    for (const m of messages) {
      if (m.role !== "system") continue;
      if (textOf(m.content)) base.push(textOf(m.content));
      for (const [k, v] of Object.entries((m.sections ?? {}) as Record<string, string | null>)) {
        if (v === null) delete sections[k];
        else sections[k] = v;
      }
      // A redeclared tool (a changed description) is removed and added in one message: removals first.
      for (const r of m.toolsRemoved ?? []) tools.delete(typeof r === "string" ? r : r.name);
      for (const t of m.toolsAdded ?? []) tools.set(t.name, t);
    }
    seen.push({
      tools: [...tools.values()].map((t: any) => ({ name: t.name, description: t.description, parameters: JSON.stringify(t.parameters) })),
      system: JSON.stringify([base, sections]),
      systems: messages.filter((m) => m.role === "system").length,
      texts: messages.filter((m) => m.role === "user" || m.role === "custom").map((m) => textOf(m.content)),
      results: new Map(messages.filter((m) => m.role === "toolResult").map((m) => [m.toolCallId, textOf(m.content)])),
    });
    let step = steps.shift();
    while (typeof step === "function") {
      await step();
      step = steps.shift();
    }
    const call = step && "tool" in step ? step : undefined;
    const message = {
      role: "assistant", api: "stub", provider, model: "stub", timestamp: Date.now(),
      content: call ? [{ type: "toolCall", id: `tc-${++n}`, name: call.tool, arguments: call.args }] : [{ type: "text", text: step && "text" in step ? step.text : "ok" }],
      stopReason: call ? "toolUse" : "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const end = { type: "done", reason: call ? "toolUse" : "stop", message };
    return { async *[Symbol.asyncIterator]() { yield end; }, result: async () => message };
  };
  return { seen, steps };
}

const client = {
  send: (m: ChatServerMessage) => {
    if (m.type === "error") throw new Error(`chat error: ${m.message}`);
  },
};
async function until(cond: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A user turn: its steps (a reply "ok" when none), then idle. */
async function turn(chat: Chat, s: ReturnType<typeof stub>, text: string, ...steps: Step[]): Promise<void> {
  const n = s.seen.length;
  s.steps.push(...steps);
  chat.handle(client, { type: "prompt", text });
  await until(() => s.seen.length > n);
  await until(() => !piSession(chat).isStreaming);
  await piSession(chat).waitForIdle();
}

const toolNames = (s: Seen | undefined) => (s?.tools ?? []).map((t) => t.name);
const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));

let seq = 0;
function sessionFile(minorModes: string[] = []): { path: string; id: string } {
  const id = `01234567-89ab-7cde-8f01-${String(++seq).padStart(12, "0")}`;
  const path = join(sessionsDir, `2026-10-06T00-00-0${seq}-000Z_${id}.jsonl`);
  const entries: unknown[] = [{ type: "session", version: 3, id, timestamp: "2026-10-06T00:00:00.000Z", cwd }];
  if (minorModes.length)
    entries.push({ type: "custom", id: "m1", parentId: null, timestamp: "2026-10-06T00:00:00.000Z", customType: "mode", data: { mode: "normal", active: { version: 1, mode: "normal", strict: false, minorModes } } });
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  markOwned(path);
  return { path, id };
}

const SCRIPT = `// @options: {"max_output_tokens": 2000}
const words = await Promise.all(["a", "b", "c"].map((word) => tools.echo({ word })));
return words.join(",");`;

test("codemode is registered inactive, the minor mode turns it on from the next run, a script's calls write no entries, and off removes it again", async () => {
  const { path } = sessionFile();
  const chat = await acquireChat(path);
  const s = stub(chat);
  assert.ok(!chat.modeState.minorModes.includes("codemode" as never), "off by default");
  await turn(chat, s, "one");
  assert.ok(!toolNames(s.seen.at(-1)).includes("codemode"), "registered, but not declared while the mode is off");
  assert.ok(toolNames(s.seen.at(-1)).includes("echo"));

  await chat.applyMode({ ...chat.modeState, minorModes: ["codemode"] });
  await turn(chat, s, "two", { tool: "codemode", args: { code: SCRIPT } }, { text: "done" });
  const declared = s.seen.at(-2)!;
  assert.ok(toolNames(declared).includes("codemode"), "declared from the next run");
  assert.doesNotMatch(declared.system, /# Minor mode: codemode/, "no prompt block: the tool is the whole mode");
  assert.ok(!declared.texts.some((t) => /Mode change: the user turned the codemode/.test(t)), "and no mode note");
  const result = s.seen.at(-1)!.results.get("tc-1") ?? "";
  assert.match(result, /^Script completed/, `the script ran in pi's sandbox on this runtime: ${result.slice(0, 400)}`);
  assert.match(result, /echo:a,echo:b,echo:c/);

  // The transcript: one call and one result, the nested calls only in its record.
  const entries = lines(path);
  const results = entries.filter((e) => e.type === "message" && e.message.role === "toolResult");
  assert.deepEqual(results.map((e) => e.message.toolName), ["codemode"], "no entry of its own for any nested call");
  const details = results[0].message.details;
  assert.equal(details.calls.length, 3);
  assert.deepEqual(details.calls.map((c: { name: string; status: string }) => [c.name, c.status]), [["echo", "ok"], ["echo", "ok"], ["echo", "ok"]]);
  for (const c of details.calls) assert.match(c.id, /^tc-1\//, "nested ids are <parent>/<n>");

  await chat.applyMode({ ...chat.modeState, minorModes: [] });
  await turn(chat, s, "three");
  assert.ok(!toolNames(s.seen.at(-1)).includes("codemode"), "off: the next request declares no codemode");
  await disposeHeldChat(path, "test done");
});

test("a switch during a run applies after it; a reopened chat comes back with codemode as its mode entry says", async () => {
  const { path } = sessionFile();
  let chat = await acquireChat(path);
  let s = stub(chat);
  // Mid-run: switch on while the run's first request is being answered.
  await turn(chat, s, "one", async () => void (await chat.applyMode({ ...chat.modeState, minorModes: ["codemode"] })), { tool: "echo", args: { word: "x" } }, { text: "done" });
  assert.ok(!toolNames(s.seen.at(-1)).includes("codemode"), "the run that was under way keeps its tools");
  await turn(chat, s, "two");
  assert.ok(toolNames(s.seen.at(-1)).includes("codemode"), "the next run has it");

  await disposeHeldChat(path, "reopen");
  markOwned(path);
  chat = await acquireChat(path);
  s = stub(chat);
  assert.deepEqual([...chat.modeState.minorModes], ["codemode"]);
  await turn(chat, s, "three");
  assert.ok(toolNames(s.seen.at(-1)).includes("codemode"), "restored on reopen");

  // Off, then reopened: pi restores the transcript's tool set (codemode included); the checkbox wins.
  await chat.applyMode({ ...chat.modeState, minorModes: [] });
  await disposeHeldChat(path, "reopen");
  markOwned(path);
  chat = await acquireChat(path);
  s = stub(chat);
  await turn(chat, s, "four");
  assert.ok(!toolNames(s.seen.at(-1)).includes("codemode"), "off stays off after a reopen");
  await disposeHeldChat(path, "test done");
});

test("off keeps codemode while a tool only scripts reach is registered (MCP's deferred exposure)", async () => {
  const { path } = sessionFile(["codemode"]);
  const chat = await acquireChat(path);
  const s = stub(chat);
  await turn(chat, s, "one");
  assert.ok(toolNames(s.seen.at(-1)).includes("codemode"));
  const apis = (globalThis as { __codemodePi?: { registerTool(t: unknown): void }[] }).__codemodePi ?? [];
  apis.at(-1)!.registerTool({ name: "mcp__docs__search", label: "search", description: "Search the docs.", exposure: "deferred", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "hit" }], details: {} }) });
  await chat.applyMode({ ...chat.modeState, minorModes: [] });
  await turn(chat, s, "two");
  assert.ok(toolNames(s.seen.at(-1)).includes("codemode"), "the deferred tool has no other way in");
  assert.ok(!toolNames(s.seen.at(-1)).includes("mcp__docs__search"), "deferred tools are never declared");
  await disposeHeldChat(path, "test done");
});

test("a Claude Code chat: one fixed codemode tool, the same tool list and prompt across toggles, the guide by note once, refusal while off", async () => {
  const { path } = sessionFile();
  const chat = await acquireChat(path);
  const s = stub(chat, "claude-code-cli");
  await turn(chat, s, "one");
  const first = s.seen.at(-1)!;
  const stubTool = first.tools.find((t) => t.name === "codemode");
  assert.equal(stubTool?.description, CODEMODE_STUB_DESCRIPTION, "declared at all times, with the fixed description");
  assert.ok(!first.tools.some((t) => t.description.includes("Codemode: `tools.")), "no other tool carries a script line");

  await turn(chat, s, "two", { tool: "codemode", args: { code: "return 1" } }, { text: "done" });
  assert.equal(s.seen.at(-1)!.results.get("tc-1"), CODEMODE_OFF_NOTE, "off: the call is refused with the off note");

  await chat.applyMode({ ...chat.modeState, minorModes: ["codemode"] });
  await turn(chat, s, "three", { tool: "codemode", args: { code: SCRIPT } }, { text: "done" });
  const on = s.seen.at(-2)!;
  assert.deepEqual(on.tools, first.tools, "the tool list is the same, byte for byte, after turning it on");
  assert.equal(on.system, first.system, "and so is the system prompt: the CLI is not restarted");
  assert.equal(on.systems, first.systems, "no system message (prompt patch or tool-set change) since the first request");
  const guides = (seen: Seen) => seen.texts.filter((t) => t.startsWith("Codemode is now ON"));
  assert.equal(guides(on).length, 1, "the guide arrives as a note");
  assert.match(guides(on)[0]!, /echo/, "with the listing of the tools a script can call");
  assert.match(s.seen.at(-1)!.results.get("tc-2") ?? "", /^Script completed[\s\S]*echo:a,echo:b,echo:c/);
  await turn(chat, s, "four");
  assert.equal(guides(s.seen.at(-1)!).length, 1, "told once: the history replays it, nothing new");

  await chat.applyMode({ ...chat.modeState, minorModes: [] });
  await turn(chat, s, "five");
  const off = s.seen.at(-1)!;
  assert.deepEqual(off.tools, first.tools);
  assert.equal(off.system, first.system);
  assert.equal(off.systems, first.systems);
  assert.equal(off.texts.filter((t) => t === CODEMODE_OFF_NOTE).length, 1, "the off note");
  const notes = lines(path).filter((e) => e.type === "custom_message" && e.customType === CODEMODE_NOTE_TYPE);
  assert.deepEqual(notes.map((e) => [e.display, e.details?.on]), [[false, true], [false, false]], "hidden notes, one per switch");

  // The chat leaves the Claude Code provider: pi's own form from the next run, off as the mode says.
  (piSession(chat) as unknown as { agent: { state: { model: unknown } } }).agent.state.model = stubModel("stub");
  await turn(chat, s, "six");
  assert.ok(!toolNames(s.seen.at(-1)).includes("codemode"), "off: pi's form, not declared");
  await chat.applyMode({ ...chat.modeState, minorModes: ["codemode"] });
  await turn(chat, s, "seven");
  const real = s.seen.at(-1)!.tools.find((t) => t.name === "codemode");
  assert.ok(real && real.description !== CODEMODE_STUB_DESCRIPTION, "on: pi's own description");
  const loadout = (piSession(chat) as unknown as { agent: { state: { tools: { name: string; description: string }[] } } }).agent.state.tools;
  assert.match(loadout.find((t) => t.name === "echo")?.description ?? "", /Codemode: `tools\.echo\(args\)`/, "and pi's script line on the other tools");
  await disposeHeldChat(path, "test done");
});

test("a script's classifier call is one ledger record of the chat whose script made it, holding a provider slot; a disallowed model is refused", async () => {
  // Two sessions registered in this process: the record must name the one whose script ran.
  const a = sessionFile(["codemode"]);
  const b = sessionFile(["codemode"]);
  const chatA = await acquireChat(a.path);
  const chatB = await acquireChat(b.path);
  writeFileSync(join(agentDir, "provider-limits.json"), JSON.stringify({ version: 1, limits: { cls: 1 } }));
  writeFileSync(join(agentDir, "model-policy.json"), JSON.stringify({ version: 1, disabledProviders: [], disabledModels: ["cls/off-1"], subagentDisabledProviders: [], subagentDisabledModels: [] }));
  let held = false;
  const runtime = (await getModelRuntime()) as unknown as { registerProvider(id: string, config: unknown): void };
  const classifier = (id: string) => ({ type: "classifier", id, name: id, api: "test-classifier", baseUrl: "http://127.0.0.1:9", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000 });
  runtime.registerProvider("cls", {
    apiKey: "test",
    models: [classifier("cls-1"), classifier("off-1")],
    classifiers: {
      "test-classifier": {
        classify: async (model: { id: string }) => {
          held = holdsSlot("cls") && existsSync(join(agentDir, "provider-limits", "cls", "slots")) && readdirSync(join(agentDir, "provider-limits", "cls", "slots")).length === 1;
          return { provider: "cls", model: model.id, answers: { q: { type: "bool", probability: 0.9 } }, usage: { input: 7, output: 1, totalTokens: 8, cost: { total: 0 } }, stopReason: "stop" };
        },
      },
    },
  });
  const s = stub(chatB);
  stub(chatA);
  const question = `{ state: { x: 1 }, questions: { q: { type: "bool", instructions: "Is it?", criteria: { true: "yes", false: "no" } } } }`;
  const script = `const on = await models.classify({ provider: "cls", id: "cls-1" }, ${question});
const off = await models.classify({ provider: "cls", id: "off-1" }, ${question});
return JSON.stringify([on.stopReason, on.answers.q && on.answers.q.probability, off.stopReason, off.errorMessage]);`;
  await turn(chatB, s, "classify", { tool: "codemode", args: { code: script } }, { text: "done" });
  const out = s.seen.at(-1)!.results.get("tc-1") ?? "";
  assert.match(out, /\["stop",0\.9,"error","cls\/off-1 is turned off in this device's model policy/, out.slice(0, 500));
  assert.ok(held, "the call held its provider's one slot, and the gate knew it was held");

  const ledger = join(agentDir, "usage", "v1");
  const records = readdirSync(ledger).flatMap((day) => readdirSync(join(ledger, day)).flatMap((f) => readFileSync(join(ledger, day, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))));
  const mine = records.filter((r) => r.provider === "cls");
  assert.equal(mine.length, 1, "one record per call that ran (the refused one never reached the provider)");
  assert.equal(mine[0].owner, b.id, "owned by the chat whose script made the call");
  assert.equal(mine[0].purpose, "classify");
  assert.equal(mine[0].input, 7);
  // The codemode result carries the merged usage; the chat's context fill never counts it.
  const result = lines(b.path).find((e) => e.type === "message" && e.message.role === "toolResult")!;
  assert.equal(result.message.toolName, "codemode");
  await disposeHeldChat(a.path, "test done");
  await disposeHeldChat(b.path, "test done");
});

test("with spec on, what the spec guard tells a script's write reaches the model on the codemode result", async () => {
  const { path } = sessionFile(["spec", "codemode"]);
  const chat = await acquireChat(path);
  const s = stub(chat);
  const script = `await tools.write({ path: ".sova/spec/claims/x.md", content: "x" });
return "wrote";`;
  await turn(chat, s, "write", { tool: "codemode", args: { code: script } }, { text: "done" });
  const result = s.seen.at(-1)!.results.get("tc-1") ?? "";
  assert.match(result, /Script completed/);
  assert.match(result, /you wrote the current spec directly \(\.sova\/spec\/claims\/x\.md\)/, `hoisted onto the script's result: ${result.slice(0, 600)}`);
  await disposeHeldChat(path, "test done");
});
