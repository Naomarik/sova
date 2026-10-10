// A project overseer's prompt fixed at opening (§app.project-overseer/identity): rendered once, kept
// byte for byte across runs, runtimes and a change of level, extra instructions, notes or time;
// what changed is told in the run's hidden note, once per change. The model is a stub.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { piSession } from "./harness/pi/testing/handle";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-po-open-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
symlinkSync(resolve(import.meta.dirname, "..", "pi-config", "extensions"), join(agentDir, "extensions"));

const orgs = await import("./orgs");
const po = await import("./project-overseer");
const store = await import("./project-overseer-store");
const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { settled } = await import("./workspace-git");

after(async () => {
  await disposeAllChats();
  await settled(join(root, "ws"));
});

/** Every request the stub model got. */
const contexts: { systemPrompt?: string; messages: { role: string; content: unknown }[] }[] = [];
const TEST_MODEL = {
  id: "stub", name: "stub", api: "stub", provider: "stub", baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000,
};
function stub(chat: Awaited<ReturnType<typeof acquireChat>>): void {
  const session = piSession(chat) as unknown as {
    _modelRuntime: { hasConfiguredAuth(p: string): boolean };
    agent: { state: { model: unknown }; getApiKey: unknown; streamFunction: unknown };
  };
  session._modelRuntime.hasConfiguredAuth = () => true;
  session.agent.state.model = TEST_MODEL;
  session.agent.getApiKey = async () => "stub";
  session.agent.streamFunction = async (_model: unknown, context: (typeof contexts)[number]) => {
    contexts.push(context);
    const message = {
      role: "assistant", api: "stub", provider: "stub", model: "stub", timestamp: Date.now(), content: [{ type: "text", text: "ok" }], stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; }, result: async () => message };
  };
}
const systemOf = (c: (typeof contexts)[number]) => JSON.stringify({ head: c.systemPrompt ?? null, system: c.messages.filter((m) => m.role === "system") });
const noteOf = (c: (typeof contexts)[number]): string => {
  for (const m of [...c.messages].reverse()) {
    const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((b: { text?: unknown }) => (typeof b?.text === "string" ? b.text : "")).join("\n") : "";
    if (m.role === "user" && text.includes("[now] It is ")) return text;
  }
  return "";
};

test("the prompt is byte-identical across runs and runtimes after a change of limits, extra instructions, notes and time; the next note gives each new value once", async () => {
  const org = await orgs.createOrg({ name: "Open", dir: join(root, "ws") });
  mkdirSync(join(root, "proj"));
  const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
  const { path } = await po.ensureProjectOverseer(project.id);
  const p = store.projectOverseerPaths(project.id);
  let chat = await acquireChat(path);
  stub(chat);
  await piSession(chat).prompt("hello");
  const opening = systemOf(contexts.at(-1)!);
  assert.match(opening, /This conversation opened at /);
  assert.match(noteOf(contexts.at(-1)!), /^\[now\] It is /);
  assert.doesNotMatch(noteOf(contexts.at(-1)!), /\[changed\]/, "nothing changed since it opened");

  await po.patchProjectOverseer(project.id, { watchGapMin: 17, extraSystemPrompt: "EXTRA-NEW: be brief" });
  writeFileSync(p.notes, "NOTE-NEW: invoices close on the 5th\n");
  await new Promise((r) => setTimeout(r, 1100)); // the clock moves on: a second later
  await piSession(chat).prompt("again");
  assert.equal(systemOf(contexts.at(-1)!), opening, "the prompt is as it opened");
  const note = noteOf(contexts.at(-1)!);
  assert.match(note, /## The operator's extra instructions \(now\)\n\nEXTRA-NEW: be brief/);
  assert.match(note, /## Your standing notes \(now\)\n\nNOTE-NEW/);
  assert.match(note, /## Limits \(now\)\n\n[^#]*one every 17 min/);

  await piSession(chat).prompt("and again");
  assert.equal(systemOf(contexts.at(-1)!), opening);
  assert.doesNotMatch(noteOf(contexts.at(-1)!), /\[changed\]/, "each change is told once");

  // A new runtime (a server restart) renders the same prompt from the opening its first note recorded.
  await disposeAllChats();
  chat = await acquireChat(path);
  stub(chat);
  await piSession(chat).prompt("after a restart");
  assert.equal(systemOf(contexts.at(-1)!), opening);
  assert.doesNotMatch(noteOf(contexts.at(-1)!), /\[changed\]/);
});
