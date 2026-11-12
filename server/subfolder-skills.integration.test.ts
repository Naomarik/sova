// Run: pnpm test:int -- server/subfolder-skills.integration.test.ts
// Subfolder instruction files and skills, and the skills a chat starts with, in real chats: real pi runtimes
// on the scripted model (and the real Claude Code bridge driving the stand-in `claude`, whose
// `[fake-tool …]` answers with the very text the bridge returned), asserting what the MODEL received, and
// that it received nothing in the cases where it should not. Throwaway agent dir and HOME; ~/.pi is never read.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { WorkerSpec } from "../shared/chat-runtime";
import { piSession } from "./harness/pi/testing/handle";
import { ScriptedModel, scriptedModelsJson } from "./harness/pi/testing/scripted-model";
import { linkPiConfigExtensions } from "./testing/agent-dir";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-subskills-int-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
const home = join(root, "home");
process.env.HOME = home;
const loginDir = join(home, ".claude");
process.env.CLAUDE_CONFIG_DIR = loginDir;
process.env.FAKE_CLAUDE_ONESHOT = "1";
const sessionsDir = join(agentDir, "sessions", "--subskills--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
linkPiConfigExtensions(agentDir);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, defaultProvider: "scripted", defaultModel: "scripted" }));
writeFileSync(join(agentDir, "models.json"), JSON.stringify(scriptedModelsJson()));

const skill = (name: string, description = `${name} does things`, extra = "", body = `# ${name}\n\nThe ${name} recipe.`) => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`;
function put(base: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(base, p)), { recursive: true });
    writeFileSync(join(base, p), text);
  }
}
mkdirSync(loginDir, { recursive: true });
put(loginDir, {
  ".credentials.json": JSON.stringify({ claudeAiOauth: { accessToken: "fake", refreshToken: "fake", expiresAt: Date.now() + 8 * 3600_000 } }),
  "skills/home-direct/SKILL.md": skill("home-direct"),
  "skills/synced/acct/pdf-synced/SKILL.md": skill("pdf-synced"),
});

let count = 0;
/** A fresh project: a repository with skills and instruction files at several depths. */
function project(): string {
  const cwd = join(root, `project-${++count}`);
  put(cwd, {
    ".gitignore": "ignored/\n",
    "AGENTS.md": "# Root rules\n",
    ".claude/skills/root-claude/SKILL.md": skill("root-claude"),
    ".claude/skills/colon/SKILL.md": skill("colon", "Dates: parse and format"),
    ".claude/skills/manual/SKILL.md": skill("manual", "Run by hand", "disable-model-invocation: true\n"),
    ".claude/skills/no-desc/SKILL.md": "---\nname: no-desc\n---\nbody\n",
    ".claude/skills/args/SKILL.md": skill("args", "Takes arguments", "", "Fix issue $ARGUMENTS in ${CLAUDE_SKILL_DIR} first=$0"),
    ".agents/skills/root-agents/SKILL.md": skill("root-agents"),
    "svc/CLAUDE.md": "svc instructions marker\n",
    "svc/x.ts": "one\ntwo\n",
    "svc/.claude/skills/svc-claude/SKILL.md": skill("svc-claude"),
    "svc/.claude/skills/root-claude/SKILL.md": skill("root-claude", "The service's own root-claude"),
    "svc/.claude/skills/svc-manual/SKILL.md": skill("svc-manual", "by hand", "disable-model-invocation: true\n", "manual body $ARGUMENTS"),
    "svc/deep/AGENTS.md": "deep instructions marker\n",
    "svc/deep/y.ts": "y\n",
    "svc/deep/.agents/skills/deep-agents/SKILL.md": skill("deep-agents"),
    "other/z.ts": "z\n",
    "other/.claude/skills/other-skill/SKILL.md": skill("other-skill"),
    "fresh/.claude/skills/fresh-skill/SKILL.md": skill("fresh-skill"),
    "ignored/.claude/skills/ignored-skill/SKILL.md": skill("ignored-skill"),
    "ignored/AGENTS.md": "ignored instructions still load\n",
    "ignored/q.ts": "q\n",
    ".hidden/.claude/skills/hidden-skill/SKILL.md": skill("hidden-skill"),
    ".hidden/h.ts": "h\n",
    "node_modules/m/.claude/skills/dep-skill/SKILL.md": skill("dep-skill"),
    "node_modules/m/d.ts": "d\n",
  });
  execFileSync("git", ["init", "-q"], { cwd });
  return cwd;
}

await import("./testing/in-process-chats"); // chats open in this process (the server hosts none)
const { acquireChat, disposeAllChats, disposeHeldChat, setProjectFact, setWorkerSpec, warmChatRuntime } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
const { getContextView } = await import("./context-tab");
const { clearSetupCache, getSessionSetup, readSetupFile } = await import("./session-setup");

after(async () => {
  await disposeAllChats();
  rmSync(root, { recursive: true, force: true });
});

let seq = 0;
function sessionFile(cwd: string, model?: { provider: string; id: string }): string {
  const id = `01a2b3c4-0000-7000-8000-${String(++seq).padStart(12, "0")}`;
  const path = join(sessionsDir, `2026-11-06T00-00-00-000Z_${id}.jsonl`);
  const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-06T00:00:00.000Z", cwd })];
  if (model) lines.push(JSON.stringify({ type: "model_change", id: `${id}-m`, parentId: null, timestamp: "2026-11-06T00:00:00.000Z", provider: model.provider, modelId: model.id }));
  writeFileSync(path, `${lines.join("\n")}\n`);
  return canonicalPath(path);
}

type Msg = { role: string; toolName?: string; content: { type: string; text?: string }[] | string };
const messagesOf = (model: ScriptedModel, n = model.calls.length - 1) => (model.calls[n]!.context as { messages: Msg[] }).messages;
/** The prompt a call ran on: pi records it by its sections, as system messages. */
const systemOf = (model: ScriptedModel, n = 0) => JSON.stringify(messagesOf(model, n).filter((m) => m.role === "system"));
const textOf = (m: Msg) => (typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join("\n---block---\n"));
/** What the model received in tool results, in its last call. */
const toolResults = (model: ScriptedModel) => messagesOf(model).filter((m) => m.role === "toolResult").map(textOf).join("\n===result===\n");

async function ordinary(cwd: string) {
  const path = sessionFile(cwd);
  const chat = await acquireChat(path, true);
  const model = new ScriptedModel().attach(piSession(chat));
  const turn = async (tools: { name: string; arguments: Record<string, unknown> }[], said = "go") => {
    const replies = tools.map((t) => ({ toolCall: t }));
    model.reply(...replies, { text: "done" });
    await chat.acceptPrompt(said, undefined, "server").turn;
  };
  return { path, chat, model, turn };
}

describe("an ordinary chat", async () => {
  await warmChatRuntime();

  test("it starts with the Claude and .agents folders from its folder up, and the home folder's direct children; never what Claude syncs", async () => {
    const { model, turn, path } = await ordinary(project());
    await turn([]);
    const prompt = systemOf(model);
    for (const name of ["root-claude", "root-agents", "colon", "args", "home-direct"]) assert.match(prompt, new RegExp(`<name>${name}</name>`), name);
    assert.match(prompt, /Dates: parse and format/, "the colon skill is rescued");
    for (const name of ["pdf-synced", "manual", "no-desc", "svc-claude", "deep-agents", "other-skill"]) assert.doesNotMatch(prompt, new RegExp(`<name>${name}</name>`), name);
    const setup = await getSessionSetup(path, { fresh: true });
    assert.ok(setup.state === "ok");
    assert.deepEqual(setup.skills.find((k) => k.name === "manual")?.manualOnly, true);
    assert.equal(setup.skills.find((k) => k.name === "root-claude")?.manualOnly, undefined);
    assert.deepEqual(setup.skillProblems?.map((p) => [p.name, p.reason]), [["no-desc", "no-description"]]);
    await disposeHeldChat(path, "test: done");
  });

  test("a read offers the folders on the way down, after their instruction files, and doesn't again", async () => {
    const cwd = project();
    const { path, model, turn } = await ordinary(cwd);
    await turn([{ name: "read", arguments: { path: "svc/deep/y.ts" } }]);
    const got = toolResults(model);
    assert.match(got, /<sova-instructions path="svc\/CLAUDE\.md">/);
    assert.match(got, /<sova-instructions path="svc\/deep\/AGENTS\.md">/);
    assert.match(got, /<sova-skills dir="svc">/);
    assert.match(got, /<sova-skills dir="svc\/deep">/);
    assert.ok(got.indexOf("<sova-instructions") < got.indexOf("<sova-skills"), "instruction files first");
    assert.ok(got.indexOf('dir="svc">') < got.indexOf('dir="svc/deep">'), "outermost first");
    assert.ok(got.includes(`<location>${join(cwd, "svc/.claude/skills/svc-claude/SKILL.md")}</location>`), "an absolute location the agent can read");
    assert.match(got, /The service&apos;s own root-claude/, "a same-named skill is still offered, with its folder");
    assert.doesNotMatch(got, /svc-manual/, "a manual-only skill isn't offered");
    assert.doesNotMatch(got, /other-skill/, "only the folders touched");
    const system = systemOf(model, 0);
    assert.equal(systemOf(model, model.calls.length - 1), system, "the prompt doesn't change");

    await turn([{ name: "read", arguments: { path: "svc/x.ts" } }, { name: "read", arguments: { path: "svc/deep/y.ts" } }], "again");
    const all = toolResults(model);
    assert.equal(all.split('<sova-skills dir="svc">').length - 1, 1, "offered once");
    assert.equal(all.split('<sova-instructions path="svc/CLAUDE.md">').length - 1, 1, "TRAP: the instruction file doesn't load again beside a skills block");
    await disposeHeldChat(path, "test: done");
  });

  test("an edit and a write offer too, a created file's folder included; two of one batch offer once", async () => {
    const cwd = project();
    const { path, model, turn } = await ordinary(cwd);
    await turn([{ name: "edit", arguments: { path: "svc/x.ts", edits: [{ oldText: "one", newText: "uno" }] } }]);
    assert.equal(readFileSync(join(cwd, "svc/x.ts"), "utf8"), "uno\ntwo\n", "the edit ran");
    assert.match(toolResults(model), /<sova-skills dir="svc">/);
    await turn([{ name: "write", arguments: { path: "fresh/new/created.ts", content: "new\n" } }], "write");
    assert.match(toolResults(model), /<sova-skills dir="fresh">[\s\S]*fresh-skill/);
    model.reply({ toolCalls: [{ name: "read", arguments: { path: "other/z.ts" } }, { name: "read", arguments: { path: "other/z.ts" } }] }, { text: "ok" });
    await (await acquireChat(path)).acceptPrompt("batch", undefined, "server").turn;
    assert.equal(toolResults(model).split('<sova-skills dir="other">').length - 1, 1, "one batch, one block");
    await disposeHeldChat(path, "test: done");
  });

  test("nothing offers from a shell command, a search, a failed read, a hidden, dependency or ignored folder, or the chat's own folder", async () => {
    const cwd = project();
    const { path, model, turn } = await ordinary(cwd);
    await turn([
      { name: "bash", arguments: { command: "cat svc/x.ts" } },
      { name: "grep", arguments: { pattern: "one", path: "svc" } },
      { name: "find", arguments: { pattern: "*.ts", path: "svc" } },
      { name: "ls", arguments: { path: "svc" } },
      { name: "read", arguments: { path: "svc/missing.ts" } },
      { name: "read", arguments: { path: ".hidden/h.ts" } },
      { name: "read", arguments: { path: "node_modules/m/d.ts" } },
      { name: "read", arguments: { path: "AGENTS.md" } },
    ]);
    const got = toolResults(model);
    assert.ok(messagesOf(model).filter((m) => m.role === "toolResult").length === 8, "all eight ran");
    assert.doesNotMatch(got, /<sova-skills/);
    assert.doesNotMatch(got, /<sova-instructions/);
    await turn([{ name: "read", arguments: { path: "ignored/q.ts" } }], "ignored");
    const ignored = toolResults(model);
    assert.match(ignored, /<sova-instructions path="ignored\/AGENTS\.md">/, "instruction files load as they always did");
    assert.doesNotMatch(ignored, /<sova-skills/, "a skills folder git ignores doesn't count");
    await disposeHeldChat(path, "test: done");
  });

  test("a compaction removes the offer, so the menu drops it and the next touch offers it again", async () => {
    const cwd = project();
    const { path, chat, model, turn } = await ordinary(cwd);
    await turn([{ name: "read", arguments: { path: "svc/x.ts" } }]);
    const names = () => chat.harness.commands().filter((c) => c.source === "skill").map((c) => c.name);
    assert.ok(names().includes("skill:svc-claude"), "offered: in the menu");
    assert.ok(!names().includes("skill:svc-manual"), "a manual-only one isn't");
    assert.equal(names().filter((n) => n === "skill:root-claude").length, 1, "the name stays with the starting skill");
    assert.equal(chat.harness.commands().find((c) => c.name === "skill:root-claude")?.path, join(cwd, ".claude/skills/root-claude/SKILL.md"));

    const s = piSession(chat);
    s.sessionManager.appendCompaction("the summary", s.sessionManager.getLeafId()!, 100);
    s.refreshContext();
    assert.ok(!names().includes("skill:svc-claude"), "the block has left the context: out of the menu");
    assert.equal(names().filter((n) => n === "skill:root-claude").length, 1);

    await turn([{ name: "read", arguments: { path: "svc/x.ts" } }], "after");
    const got = toolResults(model);
    assert.match(got, /<sova-skills dir="svc">/, "offered again");
    assert.match(got, /<sova-instructions path="svc\/CLAUDE\.md">/, "and the instruction file with it");
    assert.ok(names().includes("skill:svc-claude"));
    await disposeHeldChat(path, "test: done");
  });

  test("/skill: runs a subfolder's skill by hand before it's offered, a manual-only one too, fills arguments, and counts as read", async () => {
    const cwd = project();
    const { path, chat, model } = await ordinary(cwd);
    model.reply({ text: "ok" });
    await chat.acceptPrompt("/skill:svc-manual ticket 9", undefined, "server").turn;
    const said = textOf(messagesOf(model).at(-1)!);
    const file = join(cwd, "svc/.claude/skills/svc-manual/SKILL.md");
    assert.ok(said.startsWith(`<skill name="svc-manual" location="${file}">`), said.slice(0, 200));
    assert.match(said, /manual body ticket 9/);
    assert.doesNotMatch(said, /\$ARGUMENTS/);

    model.reply({ text: "ok" });
    await chat.acceptPrompt("/skill:args 42 extra", undefined, "server").turn;
    const filled = textOf(messagesOf(model).at(-1)!);
    assert.match(filled, new RegExp(`Fix issue 42 extra in ${join(cwd, ".claude/skills/args")} first=42`));
    assert.ok(!filled.endsWith("42 extra\n") && !/<\/skill>\n\n/.test(filled), "the arguments are in place, not repeated after the block");

    model.reply({ text: "ok" });
    await chat.acceptPrompt("/skill:colon the words", undefined, "server").turn;
    const rescued = textOf(messagesOf(model).at(-1)!);
    assert.ok(rescued.startsWith(`<skill name="colon"`), "pi's parser can't expand it; Sova's hook does");
    assert.ok(rescued.endsWith("</skill>\n\nthe words"), "no placeholder: the text follows");

    model.reply({ text: "ok" });
    await chat.acceptPrompt("/skill:root-agents plain words", undefined, "server").turn;
    const plain = textOf(messagesOf(model).at(-1)!);
    assert.ok(plain.startsWith(`<skill name="root-agents"`) && plain.endsWith("</skill>\n\nplain words"), "a plain starting skill runs as pi runs it");

    model.reply({ text: "ok" });
    await chat.acceptPrompt("/skill:nothing-called-this go", undefined, "server").turn;
    assert.equal(textOf(messagesOf(model).at(-1)!), "/skill:nothing-called-this go", "an unknown name passes through");

    clearSetupCache();
    const view = await getContextView(path);
    assert.ok(view.state === "ok");
    const row = view.nestedSkills?.find((p) => p.label === "svc-manual");
    assert.equal(row?.read, true);
    assert.equal(row?.offered, false);
    assert.equal(row?.manualOnly, true);
    await disposeHeldChat(path, "test: done");
  });

  test("the Context tab: a subfolder's skill goes from not offered to offered, its size moving out of the conversation; one of two same names reads alone", async () => {
    const cwd = project();
    const { path, model, turn } = await ordinary(cwd);
    clearSetupCache();
    const before = await getContextView(path);
    assert.ok(before.state === "ok");
    const row = (v: typeof before, name: string, folder: string) => v.state === "ok" ? v.nestedSkills?.find((p) => p.label === name && p.folder === folder) : undefined;
    assert.equal(row(before, "svc-claude", "svc")?.offered, false);
    assert.equal(row(before, "ignored-skill", "ignored"), undefined, "an ignored folder isn't listed");
    assert.equal(before.nestedSkills?.some((p) => p.label === "hidden-skill" || p.label === "dep-skill"), false);
    assert.ok((row(before, "svc-manual", "svc")?.tokens ?? 0) > 0, "a manual-only skill shows what it would add");

    await turn([{ name: "read", arguments: { path: "svc/.claude/skills/root-claude/SKILL.md" } }]);
    const after = await getContextView(path);
    assert.ok(after.state === "ok");
    assert.equal(row(after, "svc-claude", "svc")?.offered, true);
    assert.equal(row(after, "svc-claude", "svc")?.read, false);
    assert.equal(row(after, "root-claude", "svc")?.read, true, "the service's own was read");
    assert.equal(after.skills.find((p) => p.label === "root-claude")?.read, false, "the starting skill of that name wasn't");
    assert.equal(row(after, "deep-agents", "svc/deep")?.offered, false, "a deeper folder isn't touched");

    const toolTokens = after.talk?.toolResults.tokens ?? -1;
    const blocks = toolResults(model);
    assert.ok(toolTokens * 4 < blocks.length, `a block isn't counted twice: ${toolTokens} tokens against ${blocks.length} chars delivered`);
    const opened = await readSetupFile(path, join(cwd, "svc/deep/.agents/skills/deep-agents/SKILL.md"));
    assert.ok(opened.ok, "a not-yet-offered skill's row opens");
    const refused = await readSetupFile(path, join(cwd, "ignored/.claude/skills/ignored-skill/SKILL.md"));
    assert.ok(!refused.ok && refused.status === 404, "one the list doesn't show doesn't");
    await disposeHeldChat(path, "test: done");
  });

  test("a name switched off before the first message stays off, in the block and the menu", async () => {
    const cwd = project();
    const path = sessionFile(cwd);
    const raw = readFileSync(path, "utf8");
    writeFileSync(path, `${raw}${JSON.stringify({ type: "custom", customType: "sova-loadout", id: "loadout1", parentId: null, timestamp: "2026-11-06T00:00:01.000Z", data: { v: 1, offContext: [], offSkills: ["svc-claude"] } })}\n`);
    const chat = await acquireChat(path, true);
    const model = new ScriptedModel().attach(piSession(chat));
    model.reply({ toolCall: { name: "read", arguments: { path: "svc/x.ts" } } }, { text: "ok" });
    await chat.acceptPrompt("go", undefined, "server").turn;
    const got = toolResults(model);
    assert.match(got, /<sova-skills dir="svc">/);
    assert.doesNotMatch(got, /<name>svc-claude<\/name>/);
    assert.ok(!chat.harness.commands().some((c) => c.name === "skill:svc-claude"));
    model.reply({ text: "ok" });
    await chat.acceptPrompt("/skill:svc-claude go", undefined, "server").turn;
    assert.equal(textOf(messagesOf(model).at(-1)!), "/skill:svc-claude go", "typing it doesn't bring it back");
    await disposeHeldChat(path, "test: done");
  });
});

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const workerSpec = (cwd: string, extra: Partial<WorkerSpec> = {}): WorkerSpec => ({
  kind: "worker",
  parent: { sessionId: "p", path: "/p.jsonl", workerId: "ag_01" },
  cwd,
  model: null,
  thinking: null,
  builtins: null,
  extensions: [],
  flags: {},
  appendSystemPrompt: null,
  env: {},
  agentDir: null,
  lowered: true,
  ...extra,
});

describe("a worker on pi's own backend", () => {
  const start = async (cwd: string, extra: Partial<WorkerSpec> = {}) => {
    const path = sessionFile(cwd, { provider: "scripted", id: "scripted" });
    setWorkerSpec(path, workerSpec(cwd, { model: "scripted/scripted", ...extra }));
    const chat = await acquireChat(path, true);
    const model = new ScriptedModel().attach(piSession(chat));
    return { path, chat, model };
  };

  for (const [tool, args] of [
    ["read", { path: "svc/x.ts" }],
    ["edit", { path: "svc/x.ts", edits: [{ oldText: "one", newText: "uno" }] }],
    ["write", { path: "svc/made.ts", content: "m\n" }],
  ] as const) {
    test(`${tool} offers skills and loads instruction files, and the prompt lists its starting skills`, async () => {
      const cwd = project();
      const { path, chat, model } = await start(cwd);
      model.reply({ toolCall: { name: tool, arguments: args as Record<string, unknown> } }, { text: "ok" });
      await chat.acceptPrompt("go", undefined, "server").turn;
      const got = toolResults(model);
      assert.match(got, /<sova-skills dir="svc">[\s\S]*svc-claude/);
      assert.match(got, /<sova-instructions path="svc\/CLAUDE\.md">/);
      assert.match(systemOf(model), /<name>root-claude<\/name>/);
      await disposeHeldChat(path, "test: done");
    });
  }

  test("one that can touch a file but read none gets the instruction file, and no skills", async () => {
    const cwd = project();
    const { path, chat, model } = await start(cwd, { builtins: ["write"] });
    model.reply({ toolCall: { name: "write", arguments: { path: "svc/made.ts", content: "m\n" } } }, { text: "ok" });
    await chat.acceptPrompt("go", undefined, "server").turn;
    const got = toolResults(model);
    assert.match(got, /<sova-instructions path="svc\/CLAUDE\.md">/);
    assert.doesNotMatch(got, /<sova-skills/);
    await disposeHeldChat(path, "test: done");
  });
});

describe("Claude Code", async () => {
  const CC = join(ROOT, "pi-config", "extensions", "claude-code", "index.ts");
  const said = (entries: readonly { kind: string; blocks?: readonly { type: string; text?: string }[] }[]) =>
    entries.filter((e) => e.kind === "assistant").flatMap((e) => e.blocks ?? []).map((b) => b.text ?? "").join("\n");
  const run = async (path: string, tool: string, args: unknown) => {
    const chat = await acquireChat(path, true);
    // The stand-in's pattern ends at the first `}]`.
    await chat.acceptPrompt(`[fake-tool ${tool} ${JSON.stringify(args).replaceAll("}]", "} ]")}]`, undefined, "server").turn;
    return said(chat.harness.branch());
  };
  const modelRef = { provider: "claude-code-cli", id: "claude-opus-5-5" };

  for (const [tool, args] of [
    ["read", { path: "svc/x.ts" }],
    ["edit", { path: "svc/x.ts", edits: [{ oldText: "one", newText: "uno" }] }],
    ["write", { path: "svc/made.ts", content: "m\n" }],
  ] as const) {
    test(`a Claude Code chat's ${tool}: the bridge delivers the blocks to the model`, async () => {
      const cwd = project();
      const path = sessionFile(cwd, modelRef);
      const text = await run(path, tool, args);
      assert.match(text, /Fake tool result:/, text.slice(0, 300));
      assert.match(text, /<sova-instructions path="svc\/CLAUDE\.md">/, text.slice(0, 600));
      assert.match(text, /<sova-skills dir="svc">/, text.slice(0, 600));
      assert.match(piSession(await acquireChat(path, true)).systemPrompt, /<name>root-claude<\/name>/, "its prompt names its starting skills, as any chat's");
      await disposeHeldChat(path, "test: done");
    });
  }

  test("a Claude Code chat's shell command delivers neither", async () => {
    const cwd = project();
    const path = sessionFile(cwd, modelRef);
    const text = await run(path, "bash", { command: "cat svc/x.ts" });
    assert.match(text, /Fake tool result:/, text.slice(0, 300));
    assert.match(text, /one/, "the command ran");
    assert.doesNotMatch(text, /<sova-skills|<sova-instructions/);
    await disposeHeldChat(path, "test: done");
  });

  for (const [tool, args] of [
    ["read", { path: "svc/x.ts" }],
    ["edit", { path: "svc/x.ts", edits: [{ oldText: "one", newText: "uno" }] }],
    ["write", { path: "svc/made.ts", content: "m\n" }],
  ] as const) {
    test(`a Claude Code worker's ${tool}: the same`, async () => {
      const cwd = project();
      const path = sessionFile(cwd, modelRef);
      setWorkerSpec(path, workerSpec(cwd, { model: "claude-code-cli/claude-opus-5-5", extensions: [CC], flags: { "claude-code-provider": true } }));
      const text = await run(path, tool, args);
      assert.match(text, /<sova-skills dir="svc">/, text.slice(0, 600));
      assert.match(text, /<sova-instructions path="svc\/CLAUDE\.md">/, text.slice(0, 600));
      await disposeHeldChat(path, "test: done");
    });
  }
});

describe("a chat that loads no skills", () => {
  test("a project overseer's read loads the instruction file and offers no skill; its prompt lists none", async () => {
    const orgs = await import("./orgs");
    const po = await import("./project-overseer");
    const cwd = project();
    const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
    const placed = await orgs.addProject(org.id, { name: "Portal", root: cwd });
    const { path } = await po.ensureProjectOverseer(placed.id);
    const chat = await acquireChat(path);
    const model = new ScriptedModel().attach(piSession(chat));
    model.reply({ toolCall: { name: "read", arguments: { path: "svc/x.ts" } } }, { text: "ok" });
    await piSession(chat).prompt("go");
    const got = toolResults(model);
    assert.match(got, /<sova-instructions path="svc\/CLAUDE\.md">/);
    assert.doesNotMatch(got, /<sova-skills/);
    assert.doesNotMatch(systemOf(model), /<available_skills>/);
    assert.deepEqual(chat.harness.commands().filter((c) => c.source === "skill"), []);
    await disposeHeldChat(path, "test: done");
  });
});


describe("where a chat looks below its folder", () => {
  /** A folder with no repository: a subfolder with its instruction file and a skill. */
  const plain = () => {
    const cwd = join(root, `plain-${++count}`);
    put(cwd, { "sub/AGENTS.md": "sub instructions marker\n", "sub/x.md": "x\n", "sub/.agents/skills/foo/SKILL.md": skill("foo") });
    return cwd;
  };
  const menu = (chat: Awaited<ReturnType<typeof acquireChat>>) => {
    const m = chat.commands();
    // A subfolder's: a starting skill (the home folder's home-direct) stays in the menu wherever the chat is.
    return m.type === "commands" ? m.commands.filter((c) => c.name.startsWith("skill:") && c.name !== "skill:home-direct").map((c) => c.name) : [];
  };

  test("a plain folder's chat: a read below offers nothing, /skill:name goes as typed, the menu and the Context tab list nothing below", async () => {
    const cwd = plain();
    const { path, chat, model, turn } = await ordinary(cwd);
    await turn([{ name: "read", arguments: { path: "sub/x.md" } }]);
    assert.doesNotMatch(toolResults(model), /<sova-skills|<sova-instructions/);
    model.reply({ text: "ok" });
    await chat.acceptPrompt("/skill:foo now", undefined, "server").turn;
    assert.equal(textOf(messagesOf(model).at(-1)!), "/skill:foo now", "sent as typed, as an unknown skill is");
    assert.deepEqual(menu(chat), []);
    const v = await getContextView(path);
    assert.ok(v.state === "ok");
    assert.deepEqual([v.state === "ok" && v.nested, v.state === "ok" && v.nestedSkills], [[], undefined]);
    assert.equal((await readSetupFile(path, join(cwd, "sub/AGENTS.md"))).ok, false, "nor does the tab open one");
    await disposeHeldChat(path, "test: done");
  });

  test("as a chat process hears it from its open: in a project, the same folder offers; out of one, the menu drops what the branch offered", async () => {
    const cwd = plain();
    const path = sessionFile(cwd);
    setProjectFact(path, true);
    try {
      const chat = await acquireChat(path, true);
      const model = new ScriptedModel().attach(piSession(chat));
      model.reply({ toolCall: { name: "read", arguments: { path: "sub/x.md" } } }, { text: "done" });
      await chat.acceptPrompt("go", undefined, "server").turn;
      assert.match(toolResults(model), /<sova-instructions path="sub\/AGENTS\.md">[\s\S]*<sova-skills dir="sub">[\s\S]*foo/);
      assert.deepEqual(menu(chat), ["skill:foo"]);
      // Its next build hears it is in none (a reload): the block stays on the branch, the menu leaves it out.
      setProjectFact(path, false);
      await disposeHeldChat(path, "test: reload");
      assert.deepEqual(menu(await acquireChat(path, true)), []);
    } finally {
      setProjectFact(path, null);
      await disposeHeldChat(path, "test: done");
    }
  });

  test("in a Sova project with no repository: a worker's read offers the subfolder's skill, a project overseer's loads its file", async () => {
    const orgs = await import("./orgs");
    const po = await import("./project-overseer");
    const cwd = plain();
    const org = await orgs.createOrg({ name: "Plain", dir: join(root, "ws-plain") });
    const placed = await orgs.addProject(org.id, { name: "No Git", root: cwd });

    const wpath = sessionFile(cwd, { provider: "scripted", id: "scripted" });
    setWorkerSpec(wpath, workerSpec(cwd, { model: "scripted/scripted" }));
    const worker = await acquireChat(wpath, true);
    const wmodel = new ScriptedModel().attach(piSession(worker));
    wmodel.reply({ toolCall: { name: "read", arguments: { path: "sub/x.md" } } }, { text: "ok" });
    await worker.acceptPrompt("go", undefined, "server").turn;
    assert.match(toolResults(wmodel), /<sova-skills dir="sub">[\s\S]*<name>foo<\/name>/);
    await disposeHeldChat(wpath, "test: done");

    // A project overseer loads no skills at all (above): its subfolder's instruction file shows it looks below.
    const { path } = await po.ensureProjectOverseer(placed.id);
    const chat = await acquireChat(path);
    const model = new ScriptedModel().attach(piSession(chat));
    model.reply({ toolCall: { name: "read", arguments: { path: "sub/x.md" } } }, { text: "ok" });
    await piSession(chat).prompt("go");
    assert.match(toolResults(model), /<sova-instructions path="sub\/AGENTS\.md">/);
    await disposeHeldChat(path, "test: done");
  });
});
