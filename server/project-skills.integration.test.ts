// Run: pnpm test:int -- server/project-skills.integration.test.ts. A project's skill defaults in real chats:
// real pi runtimes built by the chat manager in this process, a registered project, the project's routes
// through the app, a scripted model and a recording worker host. What is checked is what each runtime
// OFFERS (its system prompt's skill list): a new chat of the project starts without a disallowed skill,
// its first message fixes its list, a later change of the defaults never moves it (a reopen included),
// a chat started before any default keeps every skill, a new chat's card can switch one back on, a change
// rebuilds a new chat before its first message, and a worker takes its parent's list.
// A throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import type { WorkerStart } from "../shared/chat-runtime";
import type { ProjectSkillsView } from "../shared/project-skills";
import { piSession } from "./harness/pi/testing/handle";
import { ScriptedModel, scriptedModelsJson } from "./harness/pi/testing/scripted-model";

for (const k of Object.keys(process.env)) if (/^(SPEC_AGREE_|SOVA_SPEC_|PI_SPEC_)/.test(k) || /_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-project-skills-int-")));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const agentDir = join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.HOME = join(tmp, "home");
process.env.CLAUDE_CONFIG_DIR = join(tmp, "home", ".claude");
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sessionsDir = join(agentDir, "sessions", "--tmp-project-skills--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
writeFileSync(join(agentDir, "models.json"), JSON.stringify(scriptedModelsJson()));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, defaultProvider: "scripted", defaultModel: "scripted", extensions: [join(REPO, "pi-config/extensions/subagents")] }));

const SKILLS = ["keep-skill", "block-skill", "late-skill"];
const root = join(tmp, "proj");
for (const name of SKILLS) {
  mkdirSync(join(root, ".agents", "skills", name), { recursive: true });
  writeFileSync(join(root, ".agents", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} recipe.\n---\n\nbody\n`);
}
// A subfolder's own skill: the project card lists it, a chat at the root's setup card never does.
mkdirSync(join(root, "sub", ".agents", "skills", "sub-skill"), { recursive: true });
writeFileSync(join(root, "sub", ".agents", "skills", "sub-skill", "SKILL.md"), "---\nname: sub-skill\ndescription: The sub-skill recipe.\n---\n\nbody\n");
writeFileSync(join(root, "sub", "x.ts"), "x\n");
writeFileSync(join(root, "AGENTS.md"), "ROOT-RULES\n");

await import("./testing/in-process-chats"); // chats open in this process (the server hosts none)
const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const cm = await import("./chat-manager");
const { markOwned } = await import("./write-guard");
const { pageHeaders } = await import("./testing/page");
const { registerProjectIn } = await import("./projects/spaces");
const { applyLoadout, clearSetupCache, getSessionSetup } = await import("./session-setup");
const { LOADOUT_ENTRY, loadoutOnBranch } = await import("./session-loadout");

const { project } = await registerProjectIn("standalone", root, { name: "Skills Project", origin: "folder" });
const pid = project.id;

const starts: WorkerStart[] = [];
cm.setWorkerHostSource(() => ({
  async start(req) {
    starts.push(req);
    return { chatId: `w${starts.length}`, sessionId: `w${starts.length}`, sessionFile: "", workerId: req.spec.parent.workerId, kind: "worker", pid: null, state: "open" };
  },
  async send() {
    return { queued: false };
  },
  async abort() {},
  async stop() {},
  watch: () => () => {},
  list: async () => [],
}));

after(async () => {
  cm.setWorkerHostSource(null);
  await cm.disposeAllChats();
});

type Chat = Awaited<ReturnType<typeof cm.acquireChat>>;

let seq = 0;
/** A web session file in `cwd`; `talked`: one exchange already on it (a chat started before this feature). */
function sessionFile(cwd = root, talked = false): string {
  const id = `01a5c111-0000-7000-8000-${String(++seq).padStart(12, "0")}`;
  const path = join(sessionsDir, `2026-11-11T00-00-${String(seq).padStart(2, "0")}-000Z_${id}.jsonl`);
  const lines: unknown[] = [{ type: "session", version: 3, id, timestamp: "2026-11-11T00:00:00.000Z", cwd }];
  if (talked) {
    lines.push({ type: "message", id: `u${seq}`, parentId: null, timestamp: "2026-11-11T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 } });
    lines.push({ type: "message", id: `a${seq}`, parentId: `u${seq}`, timestamp: "2026-11-11T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "hello" }], api: "openai-completions", provider: "scripted", model: "scripted", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 } });
  }
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  markOwned(path);
  return path;
}

/** The skills a runtime offers its model, from its system prompt. */
const offered = (chat: Chat) => SKILLS.filter((n) => piSession(chat).systemPrompt.includes(`<name>${n}</name>`));

async function put(skills: Record<string, string>): Promise<ProjectSkillsView> {
  const res = await app.request(`/api/projects/${pid}/skills`, { method: "PUT", headers: { "content-type": "application/json", ...pageHeaders() }, body: JSON.stringify({ skills }) });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as ProjectSkillsView;
}
/** Every name back to Waiting, then these decisions. */
const decide = (skills: Record<string, string>) => put({ ...Object.fromEntries([...SKILLS, "sub-skill"].map((n) => [n, "waiting"])), ...skills });

const settledOnce = (path: string) =>
  new Promise<void>((done) => {
    const off = cm.onChatEvent((e) => {
      if (e.chatId === path && e.type === "settled") {
        off();
        done();
      }
    });
  });

/** One turn, its model's reply scripted (`tools` first). */
async function turn(chat: Chat, tools: { name: string; arguments: Record<string, unknown> }[] = [], text = "go") {
  const model = new ScriptedModel().attach(piSession(chat));
  model.reply(...tools.map((t) => ({ toolCall: t })), { text: "done" });
  const settled = settledOnce(chat.path);
  chat.handle({ send: () => {} }, { type: "prompt", text });
  await settled;
}

const loadoutEntries = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "custom" && e.customType === LOADOUT_ENTRY)
    .map((e) => e.data);

test("the routes: every skill of the project with its state, saved at once; an unknown name is refused", async () => {
  const view = await decide({ "block-skill": "disallowed" });
  assert.deepEqual(view.skills.filter((s) => SKILLS.includes(s.name)).map((s) => [s.name, s.state, s.source.kind]).sort(), [["block-skill", "disallowed", "project"], ["keep-skill", "waiting", "project"], ["late-skill", "waiting", "project"]]);
  const get = await app.request(`/api/projects/${pid}/skills`, { headers: pageHeaders() });
  assert.equal(((await get.json()) as ProjectSkillsView).counts.disallowed, 1);
  const bad = await app.request(`/api/projects/${pid}/skills`, { method: "PUT", headers: { "content-type": "application/json", ...pageHeaders() }, body: JSON.stringify({ skills: { "no-such-skill": "disallowed" } }) });
  assert.equal(bad.status, 404);
});

test("a new chat of the project, in a folder inside it too, starts without a disallowed skill; its card says why and still switches it", async () => {
  await decide({ "block-skill": "disallowed" });
  for (const cwd of [root, join(root, "sub")]) {
    const path = sessionFile(cwd);
    const chat = await cm.acquireChat(path);
    assert.deepEqual(offered(chat), ["keep-skill", "late-skill"], cwd);
    clearSetupCache();
    const setup = await getSessionSetup(path, { fresh: true });
    assert.equal(setup.state, "ok");
    if (setup.state !== "ok") continue;
    assert.deepEqual(setup.project, { id: pid, name: "Skills Project" });
    const block = setup.skills.find((k) => k.name === "block-skill")!;
    assert.equal(block.off, true);
    assert.equal(block.project, "disallowed");
    assert.equal(setup.skills.find((k) => k.name === "keep-skill")!.project, "waiting");
  }
  // The per-chat switch overrides the project for this chat alone.
  const path = sessionFile();
  await cm.acquireChat(path);
  const r = await applyLoadout(path, { offContext: [], offSkills: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(offered(cm.heldChat(path)!), SKILLS);
  assert.deepEqual(offered(await cm.acquireChat(sessionFile())), ["keep-skill", "late-skill"], "another new chat still follows the project");
});

test("the first message fixes the chat's list: a later change, and a reopen, never move it", async () => {
  await decide({ "block-skill": "disallowed" });
  const path = sessionFile();
  const chat = await cm.acquireChat(path);
  await turn(chat);
  const stamped = loadoutEntries(path).at(-1);
  assert.deepEqual(stamped?.offSkills, ["block-skill"], "written with the first message");
  await decide({ "keep-skill": "disallowed", "block-skill": "approved" });
  assert.equal(cm.heldChat(path), chat, "a started chat is not rebuilt");
  await cm.disposeHeldChat(path, "test reopen");
  const reopened = await cm.acquireChat(path);
  assert.deepEqual(offered(reopened), ["keep-skill", "late-skill"], "its own list, not the project's new one");
  assert.equal(loadoutEntries(path).length, 1, "written once");
});

test("a chat started before any default keeps every skill on", async () => {
  await decide({ "block-skill": "disallowed", "late-skill": "disallowed" });
  const chat = await cm.acquireChat(sessionFile(root, true));
  assert.deepEqual(offered(chat), SKILLS);
});

test("a change rebuilds a new chat before its first message", async () => {
  await decide({});
  const path = sessionFile();
  const before = await cm.acquireChat(path);
  assert.deepEqual(offered(before), SKILLS);
  await put({ "late-skill": "disallowed" });
  const now = cm.heldChat(path)!;
  assert.notEqual(now, before, "rebuilt");
  assert.deepEqual(offered(now), ["keep-skill", "block-skill"]);
});

test("a worker gets its parent chat's own list, not the project's", async () => {
  await decide({ "block-skill": "disallowed" });
  const path = sessionFile();
  const chat = await cm.acquireChat(path);
  // The chat switches late-skill off for itself; the project's defaults then change after it started.
  await applyLoadout(path, { offContext: [], offSkills: ["block-skill", "late-skill"] });
  const parent = cm.heldChat(path)!;
  await turn(parent);
  await decide({ "keep-skill": "disallowed" });
  const from = starts.length;
  await turn(parent, [{ name: "agent_spawn", arguments: { prompt: "do it", name: "w", model: "scripted/scripted", wake: false } }], "spawn");
  assert.equal(starts.length, from + 1, "one worker started");
  const spec = starts[from]!.spec;
  assert.deepEqual([...(spec.offSkills ?? [])].sort(), ["block-skill", "late-skill"]);
  // Built as its spec says: without those skills.
  const workerPath = sessionFile();
  cm.setWorkerSpec(workerPath, { ...spec, cwd: root });
  try {
    const worker = await cm.acquireChat(workerPath);
    assert.deepEqual(offered(worker), ["keep-skill"]);
  } finally {
    await cm.disposeHeldChat(workerPath, "test done");
    cm.setWorkerSpec(workerPath, null);
  }
  void chat;
});

test("a switch on the card never turns on a disallowed skill the card doesn't list", async () => {
  await decide({ "sub-skill": "disallowed" });
  const path = sessionFile();
  await cm.acquireChat(path);
  // The card flips a context file only: it sends the skills it lists, none of them off.
  const r = await applyLoadout(path, { offContext: [join(root, "AGENTS.md")], offSkills: [] });
  assert.equal(r.ok, true);
  const chat = cm.heldChat(path)!;
  await turn(chat);
  assert.ok(loadoutEntries(path).at(-1)?.offSkills.includes("sub-skill"), "fixed off at the first message");
});

test("a worker's own readings of skills (a subfolder's offer, the slash list) leave out its parent's off ones", async () => {
  const workerPath = sessionFile();
  const spec = { kind: "agent", parent: { sessionId: "parent", path: "/parent", workerId: "ag_01" }, cwd: root, model: "scripted/scripted", thinking: null, builtins: null, extensions: [], flags: {}, appendSystemPrompt: null, env: {}, agentDir: null, lowered: true, offSkills: ["sub-skill"] } as unknown as import("../shared/chat-runtime").WorkerSpec;
  cm.setWorkerSpec(workerPath, spec);
  try {
    const worker = await cm.acquireChat(workerPath);
    assert.deepEqual(loadoutOnBranch(piSession(worker).sessionManager.getBranch())?.offSkills, ["sub-skill"], "its own entry");
    const model = new ScriptedModel().attach(piSession(worker));
    model.reply({ toolCall: { name: "read", arguments: { path: join(root, "sub", "x.ts") } } }, { text: "done" });
    const settled = settledOnce(workerPath);
    worker.handle({ send: () => {} }, { type: "prompt", text: "read it" });
    await settled;
    const results = JSON.stringify((model.calls.at(-1)!.context as { messages: { role: string }[] }).messages.filter((m) => m.role === "toolResult"));
    assert.match(results, /x/, "the read ran");
    assert.doesNotMatch(results, /sub-skill/, "the subfolder's skill is never offered");
  } finally {
    await cm.disposeHeldChat(workerPath, "test done");
    cm.setWorkerSpec(workerPath, null);
  }
});

test("in a chat's own process every build, a reopen there included, takes the list the server sent with the open", async () => {
  await decide({});
  const path = sessionFile();
  // As a chat process has it: the server's list from the open frame (chat-runtime/host.ts open).
  cm.setProjectSkillsOff(path, ["block-skill"]);
  try {
    assert.deepEqual(offered(await cm.acquireChat(path)), ["keep-skill", "late-skill"], "the first build");
    // A reopen in the same process (host.ts reopenHere / reacquire): acquireChat again, no new open frame.
    await cm.disposeHeldChat(path, "test reopen");
    assert.deepEqual(offered(await cm.acquireChat(path, true)), ["keep-skill", "late-skill"], "the reopen");
  } finally {
    cm.setProjectSkillsOff(path, null);
  }
});

test("a skill only one of the project's worktrees has: the setup lists it waiting, it can be disallowed, and the next new chat there starts without it", async () => {
  const { execFileSync } = await import("node:child_process");
  const repo = join(tmp, "repo");
  mkdirSync(repo, { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "repo\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const wt = join(tmp, "repo-wt");
  git(repo, "worktree", "add", "-q", "-b", "feat/wt", wt);
  mkdirSync(join(wt, ".agents", "skills", "wt-skill"), { recursive: true });
  writeFileSync(join(wt, ".agents", "skills", "wt-skill", "SKILL.md"), "---\nname: wt-skill\ndescription: Only in the worktree.\n---\n\nbody\n");
  const { project: p2 } = await registerProjectIn("standalone", repo, { name: "Worktree Project", origin: "folder" });

  const first = sessionFile(wt);
  await cm.acquireChat(first);
  clearSetupCache();
  const setup = await getSessionSetup(first, { fresh: true });
  assert.equal(setup.state, "ok");
  if (setup.state !== "ok") return;
  assert.equal(setup.project?.id, p2.id);
  assert.equal(setup.skills.find((k) => k.name === "wt-skill")?.project, "waiting");

  const res = await app.request(`/api/projects/${p2.id}/skills`, { method: "PUT", headers: { "content-type": "application/json", ...pageHeaders() }, body: JSON.stringify({ skills: { "wt-skill": "disallowed" } }) });
  assert.equal(res.status, 200, await res.clone().text());
  const view = (await (await app.request(`/api/projects/${p2.id}/skills`, { headers: pageHeaders() })).json()) as ProjectSkillsView;
  assert.equal(view.skills.find((s) => s.name === "wt-skill")?.state, "disallowed", "kept while the worktree has it");

  const next = await cm.acquireChat(sessionFile(wt));
  assert.doesNotMatch(piSession(next).systemPrompt, /<name>wt-skill<\/name>/);
  assert.equal(cm.heldChat(first) !== undefined && piSession(cm.heldChat(first)!).systemPrompt.includes("<name>wt-skill</name>"), false, "the open new chat was rebuilt too");
});
