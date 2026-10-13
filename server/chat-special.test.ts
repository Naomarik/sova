// Run: pnpm test -- server/chat-special.test.ts. A special loadout's chat side (§app.harness/session-special,
// §app.chat-processes/special-kinds): built from data, its run starts asked through the port, the last
// answer kept for a run no server answers; and what it may import (it runs in a chat process too).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { RunStartAnswer, ServerToolDecl, SpecialSpec } from "../shared/chat-runtime";
import { NOT_RUN_NO_SERVER } from "../shared/chat-runtime-wire";
import type { SpecialPort } from "./chat-manager";
import { specialLoadout } from "./chat-special";

const decl = (name: string): ServerToolDecl => ({ name, label: name, description: name, parameters: { type: "object" } });

function specOf(over: Partial<SpecialSpec> = {}): SpecialSpec {
  return {
    kind: "overseer",
    extension: "sova-overseer",
    cwd: null,
    tools: [decl("sova_a")],
    customTools: [decl("read")],
    allow: ["sova_a", "read"],
    loader: { append: "user-then-ours" },
    model: null,
    thinking: null,
    hooks: { compact: true, agentEnd: true },
    context: "redact",
    refuses: {},
    composerClosed: null,
    start: { prompt: {}, append: ["OURS-0"] },
    ...over,
  };
}

/** A pi extension API that records what the factory did. */
function fakePi() {
  const handlers = new Map<string, (event: any, ctx?: any) => any>();
  const registered: string[] = [];
  const active: string[][] = [];
  const sent: unknown[] = [];
  const appended: [string, unknown][] = [];
  const pi = {
    on: (name: string, fn: (event: any, ctx?: any) => any) => void handlers.set(name, fn),
    registerTool: (t: { name: string }) => void registered.push(t.name),
    setActiveTools: (names: string[]) => void active.push(names),
    sendMessage: (m: unknown) => void sent.push(m),
    appendEntry: (type: string, data: unknown) => void appended.push([type, data]),
  };
  return { pi, handlers, registered, active, sent, appended };
}

const ctx = { cwd: "/w", model: { input: ["text", "image"] }, sessionManager: { getLeafId: () => "leaf-1", getBranch: () => [], getSessionId: () => "sid", getSessionFile: () => undefined, getSessionName: () => undefined } };

function portOf(answers: (RunStartAnswer | Error)[]): SpecialPort & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    async runStart(a) {
      asked.push(a);
      const next = answers.shift();
      if (!next || next instanceof Error) throw next ?? new Error("no server");
      return next;
    },
    compact: async () => ({ customType: "c", content: "cards", display: false as const }),
    agentEnd: async (a) => (a.text.includes("sova://s/bad") ? { customType: "ids", content: "bad id", display: false as const } : null),
    runEvent: () => {},
    action: async () => ({ ok: true, result: null }),
  };
}

const build = (spec: SpecialSpec, port: SpecialPort, chatId = `chat-${Math.random()}`) =>
  specialLoadout(chatId, spec, port, { tool: (d) => ({ name: d.name }) as never });

test("the Overseer's loadout: the user's parts then its own, a run's answer spliced in, its note returned", async () => {
  const port = portOf([{ prompt: {}, append: ["OURS-1", "EXTRA"], message: { customType: "note", content: "the time", display: false } }]);
  const b = build(specOf(), port);
  assert.deepEqual(b.allow, ["sova_a", "read"]);
  assert.deepEqual(b.customTools.map((t) => t.name), ["read"], "the file tools are the SDK's custom tools, served");
  const parts = (b.loader as any).appendSystemPromptOverride(["USER"]) as string[];
  assert.deepEqual(parts, ["USER", "OURS-0"], "the spec's start before any run");
  const { pi, handlers, registered } = fakePi();
  (b.loader as any).extensionFactories[0].factory(pi);
  assert.equal((b.loader as any).extensionFactories[0].name, "sova-overseer");
  assert.deepEqual(registered, ["sova_a"]);
  const event = { systemPromptOptions: {} as Record<string, unknown> };
  const out = await handlers.get("before_agent_start")!(event, ctx);
  assert.deepEqual(port.asked, [{ leafId: "leaf-1", images: true }]);
  assert.equal(event.systemPromptOptions.appendSystemPrompt, "USER\n\nOURS-1\n\nEXTRA");
  assert.deepEqual(parts, ["USER", "OURS-1", "EXTRA"], "the loader's own array, refilled in place (quirk P19)");
  assert.equal(b.promptAtRunStart!([]), "USER\n\nOURS-1\n\nEXTRA");
  assert.deepEqual(out, { message: { customType: "note", content: "the time", display: false } });
});

test("no answer in time: the run starts on the last prompt it had, without a run note", async () => {
  const port = portOf([{ prompt: {}, append: ["OURS-1"], message: { customType: "note", content: "n1", display: false } }, new Error(NOT_RUN_NO_SERVER)]);
  const b = build(specOf(), port);
  (b.loader as any).appendSystemPromptOverride(["USER"]);
  const { pi, handlers } = fakePi();
  (b.loader as any).extensionFactories[0].factory(pi);
  await handlers.get("before_agent_start")!({ systemPromptOptions: {} }, ctx);
  const event = { systemPromptOptions: {} as Record<string, unknown> };
  const out = await handlers.get("before_agent_start")!(event, ctx);
  assert.equal(event.systemPromptOptions.appendSystemPrompt, "USER\n\nOURS-1");
  assert.equal(out, undefined, "no run note");
  // Anything but no server answering is the run's own error, never a silent fallback.
  const strict = build(specOf(), portOf([new Error("Not a registered baton session.")]));
  const { pi: pi2, handlers: h2 } = fakePi();
  (strict.loader as any).extensionFactories[0].factory(pi2);
  await assert.rejects(h2.get("before_agent_start")!({ systemPromptOptions: {} }, ctx), /Not a registered baton session/);
});

test("a baton's loadout: no operator setup, its prompt options set verbatim, owner areas re-registered, abilities set", async () => {
  const spec = specOf({
    kind: "baton",
    extension: "sova-baton",
    customTools: [],
    loader: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, append: "none" },
    hooks: {},
    context: "baton",
    start: { prompt: { customPrompt: "P0", appendSystemPrompt: "", contextFiles: [], skills: [], cwd: "(none)" } },
  });
  const port = portOf([
    { prompt: { customPrompt: "P1", appendSystemPrompt: "", contextFiles: [], skills: [], cwd: "(none)" }, reregister: [decl("record_decision")], activeTools: ["hand_to"], baton: { names: { p_1: "Ann" }, holder: "p_1", holderTexts: ["Secret Phrase"], vocabulary: [] } },
  ]);
  const b = build(spec, port);
  const l = b.loader as any;
  assert.equal(l.noExtensions && l.noSkills && l.noPromptTemplates && l.noThemes && l.noContextFiles, true);
  assert.deepEqual(l.appendSystemPromptOverride(["USER"]), [], "nothing of the operator's own setup");
  assert.equal(b.promptAtRunStart, undefined);
  const { pi, handlers, registered, active } = fakePi();
  l.extensionFactories[0].factory(pi);
  assert.equal(handlers.has("agent_end"), false);
  assert.equal(handlers.has("session_compact"), false);
  const event = { systemPromptOptions: { appendSystemPrompt: "X" } as Record<string, unknown> };
  assert.equal(await handlers.get("before_agent_start")!(event, ctx), undefined);
  assert.deepEqual(event.systemPromptOptions, { customPrompt: "P1", appendSystemPrompt: "", contextFiles: [], skills: [], cwd: "(none)" });
  assert.deepEqual(registered, ["sova_a", "record_decision"]);
  assert.deepEqual(active, [["hand_to"]]);
  // The context hook: the holder's secret phrase blanked in the model's own replies.
  const messages = [{ role: "assistant", content: [{ type: "text", text: "about Secret Phrase" }] }];
  const got = handlers.get("context")!({ messages }, ctx);
  assert.match(JSON.stringify(got.messages), /\[redacted\]|█|\*\*\*/i);
  assert.doesNotMatch(JSON.stringify(got.messages), /Secret Phrase/);
});

test("the reply-end and compaction hooks ask the port and send what it answers", async () => {
  const b = build(specOf(), portOf([]));
  const { pi, handlers, sent } = fakePi();
  (b.loader as any).extensionFactories[0].factory(pi);
  await handlers.get("agent_end")!({ messages: [{ role: "assistant", content: "see sova://s/bad" }] });
  await handlers.get("session_compact")!({}, ctx);
  assert.deepEqual(sent, [
    { customType: "ids", content: "bad id", display: false },
    { customType: "c", content: "cards", display: false },
  ]);
});

test("chat-special imports only what a chat process may load: shared types, the adapter's tools, and pure helpers", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "chat-special.ts"), "utf8");
  const imports = [...src.matchAll(/^import[^"]*"([^"]+)";/gm)].map((m) => m[1]!).sort();
  assert.deepEqual(imports, [
    "../shared/chat-runtime",
    "../shared/chat-runtime-wire",
    "../shared/harness",
    "./author-context",
    "./chat-manager",
    "./harness/pi/extension-types",
    "./harness/pi/state",
    "./harness/pi/tools",
    "./overseer-deny",
    "./overseer-id-check",
    "./overseer-redact",
  ]);
  assert.match(src, /import type \{ SpecialPort \} from "\.\/chat-manager";/, "the chat's own module only as a type");
});
