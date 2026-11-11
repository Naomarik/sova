// Run: pnpm test:int -- server/project-skills.integration.test.ts. A folder's context file and skill decisions in
// real chats: real pi runtimes built by the chat manager in this process, a registered project (and an ad hoc
// folder), the routes through the app, a scripted model and a recording worker host. What is checked is what
// each runtime LOADS (its system prompt's context files and skill list) and what reaches its model: both
// modes of the Sova-wide "Allow context files and skills without asking" setting, the first message's fixed
// list (a reopen included), the held first Send, items met mid-chat, workers, and the setup card's rows.
// A throwaway PI_CODING_AGENT_DIR; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
writeFileSync(join(root, "sub", "AGENTS.md"), "SUB-RULES\n");
// An instruction file in the folder above the project (between home and the project): "Above the project".
writeFileSync(join(tmp, "AGENTS.md"), "ABOVE-RULES\n");

await import("./testing/in-process-chats"); // chats open in this process (the server hosts none)
const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const cm = await import("./chat-manager");
const { markOwned } = await import("./write-guard");
const { pageHeaders } = await import("./testing/page");
const { registerProjectIn } = await import("./projects/spaces");
const { applyLoadout, clearSetupCache, getSessionSetup } = await import("./session-setup");
const { LOADOUT_ENTRY, loadoutOnBranch } = await import("./session-loadout");
const { setAllowWithoutAsking } = await import("./context-approval-setting");
const { notifySetupChanged } = await import("./projects/skills-chats");

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
  setAllowWithoutAsking(true);
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

/** Whether a runtime's prompt carries a context file's text. */
const prompts = (chat: Chat, text: string) => piSession(chat).systemPrompt.includes(text);

/** The Sova-wide setting, as the operator's page sets it; new chats not yet started follow. */
async function asking(on: boolean): Promise<void> {
  setAllowWithoutAsking(!on);
  await notifySetupChanged(null);
}

/** Every context file of the project back to Waiting, then these decisions (by key). */
async function decideContext(files: Record<string, string>): Promise<void> {
  const all = { "AGENTS.md": "waiting", "sub/AGENTS.md": "waiting", [join(tmp, "AGENTS.md")]: "waiting", ...files };
  const res = await app.request(`/api/projects/${pid}/context-files`, { method: "PUT", headers: { "content-type": "application/json", ...pageHeaders() }, body: JSON.stringify({ files: all }) });
  assert.equal(res.status, 200, await res.clone().text());
}

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

// ---- default mode (the switch on): as before this feature, but for what is disallowed ---------------------

test("default mode: a new chat of the project, in a folder inside it too, starts without a disallowed skill; its card says why and still switches it", async () => {
  await asking(false);
  await decideContext({});
  await decide({ "block-skill": "disallowed" });
  for (const cwd of [root, join(root, "sub")]) {
    const path = sessionFile(cwd);
    const chat = await cm.acquireChat(path);
    assert.deepEqual(offered(chat), ["keep-skill", "late-skill"], cwd);
    assert.ok(prompts(chat, "ROOT-RULES"), "a waiting context file loads, as before");
    clearSetupCache();
    const setup = await getSessionSetup(path, { fresh: true });
    assert.equal(setup.state, "ok");
    if (setup.state !== "ok") continue;
    assert.deepEqual(setup.approvals, { folder: { kind: "project", id: pid, name: "Skills Project" }, asking: false });
    const block = setup.skills.find((k) => k.name === "block-skill")!;
    assert.equal(block.off, true);
    assert.equal(block.approval?.state, "disallowed");
    assert.equal(setup.skills.find((k) => k.name === "keep-skill")!.approval?.state, "waiting");
  }
  // The per-chat switch overrides the folder for this chat alone (the page's).
  const path = sessionFile();
  await cm.acquireChat(path);
  const r = await applyLoadout(path, { offContext: [], offSkills: [] }, { page: true });
  assert.equal(r.ok, true);
  assert.deepEqual(offered(cm.heldChat(path)!), SKILLS);
  assert.deepEqual(offered(await cm.acquireChat(sessionFile())), ["keep-skill", "late-skill"], "another new chat still follows the project");
});

test("default mode with nothing decided: a new chat builds and stamps nothing, exactly as before", async () => {
  await asking(false);
  await decideContext({});
  await decide({});
  const path = sessionFile();
  const chat = await cm.acquireChat(path);
  assert.deepEqual(offered(chat), SKILLS);
  assert.ok(prompts(chat, "ROOT-RULES") && prompts(chat, "ABOVE-RULES"));
  await turn(chat);
  assert.deepEqual(loadoutEntries(path), [], "no entry written");
});

test("a disallowed context file is off in a new chat, and subfolder files honour the list mid-chat", async () => {
  await asking(false);
  await decide({});
  await decideContext({ "AGENTS.md": "disallowed", "sub/AGENTS.md": "disallowed" });
  const path = sessionFile();
  const chat = await cm.acquireChat(path);
  assert.equal(prompts(chat, "ROOT-RULES"), false);
  const model = new ScriptedModel().attach(piSession(chat));
  model.reply({ toolCall: { name: "read", arguments: { path: join(root, "sub", "x.ts") } } }, { text: "done" });
  const settled = settledOnce(path);
  chat.handle({ send: () => {} }, { type: "prompt", text: "read it" });
  await settled;
  const results = JSON.stringify((model.calls.at(-1)!.context as { messages: { role: string }[] }).messages.filter((m) => m.role === "toolResult"));
  assert.doesNotMatch(results, /SUB-RULES/, "a disallowed subfolder file never reaches the model");
});

test("the first message fixes the chat's list: a later change, and a reopen, never move it", async () => {
  await asking(false);
  await decideContext({});
  await decide({ "block-skill": "disallowed" });
  const path = sessionFile();
  const chat = await cm.acquireChat(path);
  await turn(chat);
  const stamped = loadoutEntries(path).at(-1);
  assert.ok(stamped?.offSkills.includes(join(root, ".agents", "skills", "block-skill", "SKILL.md")), "written with the first message");
  await decide({ "keep-skill": "disallowed", "block-skill": "approved" });
  assert.equal(cm.heldChat(path), chat, "a started chat is not rebuilt");
  await cm.disposeHeldChat(path, "test reopen");
  const reopened = await cm.acquireChat(path);
  assert.deepEqual(offered(reopened), ["keep-skill", "late-skill"], "its own list, not the project's new one");
  assert.equal(loadoutEntries(path).length, 1, "written once");
});

test("a chat started before this feature keeps every skill and context file on, in either mode", async () => {
  await decide({ "block-skill": "disallowed", "late-skill": "disallowed" });
  await asking(true);
  const chat = await cm.acquireChat(sessionFile(root, true));
  assert.deepEqual(offered(chat), SKILLS);
  assert.ok(prompts(chat, "ROOT-RULES"));
  await asking(false);
});

test("a change rebuilds a new chat before its first message, and its panes are told", async () => {
  await asking(false);
  await decideContext({});
  await decide({});
  const path = sessionFile();
  const before = await cm.acquireChat(path);
  assert.deepEqual(offered(before), SKILLS);
  await put({ "late-skill": "disallowed" });
  const now = cm.heldChat(path)!;
  assert.notEqual(now, before, "rebuilt");
  assert.deepEqual(offered(now), ["keep-skill", "block-skill"]);
});

test("a switch on the card never turns on a disallowed skill the card doesn't list", async () => {
  await asking(false);
  await decideContext({});
  await decide({ "sub-skill": "disallowed" });
  const path = sessionFile();
  await cm.acquireChat(path);
  // The card flips a context file only: it sends the skills it lists, none of them off.
  const r = await applyLoadout(path, { offContext: [join(root, "AGENTS.md")], offSkills: [] }, { page: true });
  assert.equal(r.ok, true);
  const chat = cm.heldChat(path)!;
  await turn(chat);
  assert.ok(loadoutEntries(path).at(-1)?.offSkills.includes(join(root, "sub", ".agents", "skills", "sub-skill", "SKILL.md")), "fixed off at the first message");
});

test("only the page turns on, from the card, a row its folder keeps off; turning one off stays open", async () => {
  await asking(false);
  await decideContext({});
  await decide({ "block-skill": "disallowed" });
  const path = sessionFile();
  await cm.acquireChat(path);
  const post = (body: unknown, headers: Record<string, string>) => app.request("/api/sessions/loadout", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const on = await post({ path, offContext: [], offSkills: [] }, {});
  assert.equal(on.status, 403, "a script can't switch a disallowed skill on for itself");
  assert.equal(((await on.json()) as { yourClick?: boolean }).yourClick, true);
  assert.deepEqual(offered(cm.heldChat(path)!), ["keep-skill", "late-skill"], "nothing changed");
  const off = await post({ path, offContext: [], offSkills: ["block-skill", "keep-skill"] }, {});
  assert.equal(off.status, 200, await off.clone().text());
  assert.deepEqual(offered(cm.heldChat(path)!), ["late-skill"]);
  const page = await post({ path, offContext: [], offSkills: [] }, pageHeaders());
  assert.equal(page.status, 200, await page.clone().text());
  assert.deepEqual(offered(cm.heldChat(path)!), SKILLS);
});

// ---- asking mode (the switch off) ----------------------------------------------------------------

test("asking: a new chat starts with every waiting context file and skill off, the user's and the files above the project included", async () => {
  await decide({});
  await decideContext({});
  await asking(true);
  try {
    const path = sessionFile();
    const chat = await cm.acquireChat(path);
    assert.deepEqual(offered(chat), []);
    assert.equal(prompts(chat, "ROOT-RULES"), false);
    assert.equal(prompts(chat, "ABOVE-RULES"), false);
    clearSetupCache();
    const setup = await getSessionSetup(path, { fresh: true });
    assert.equal(setup.state, "ok");
    if (setup.state !== "ok") return;
    assert.equal(setup.approvals?.asking, true);
    const above = setup.context.find((f) => f.path === join(tmp, "AGENTS.md"));
    assert.equal(above?.approval?.group, "above");
    assert.equal(above?.approval?.key, join(tmp, "AGENTS.md"));
    assert.equal(above?.off, true);
    const sub = setup.context.find((f) => f.path === join(root, "sub", "AGENTS.md"));
    assert.equal(sub?.scanOnly, true, "a subfolder's file is listed before the first message");
    assert.equal(sub?.approval?.state, "waiting");
    assert.ok(setup.skills.some((k) => k.name === "sub-skill" && k.scanOnly && k.off), "a subfolder's skill too");
    // Approving rebuilds the chat with it on.
    await decideContext({ "AGENTS.md": "approved", [join(tmp, "AGENTS.md")]: "approved" });
    await decide({ "keep-skill": "approved" });
    const now = cm.heldChat(path)!;
    assert.ok(prompts(now, "ROOT-RULES") && prompts(now, "ABOVE-RULES"));
    assert.deepEqual(offered(now), ["keep-skill"]);
  } finally {
    await asking(false);
  }
});

test("asking: the page's first send waits until nothing is left to decide; a program's never does", async () => {
  await decide({});
  await decideContext({});
  await asking(true);
  try {
    const path = sessionFile();
    await cm.acquireChat(path);
    const send = (headers: Record<string, string>, text = "hello") =>
      app.request("/api/sessions/prompt", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ path, text }) });
    const held = await send(pageHeaders());
    assert.equal(held.status, 409);
    const body = (await held.json()) as { code?: string; waiting?: number };
    assert.equal(body.code, "decide-first");
    assert.ok((body.waiting ?? 0) >= 6, `every waiting file and skill counts (${body.waiting})`);
    assert.deepEqual(loadoutEntries(path), [], "nothing was sent");
    // The operator's page on another computer, relayed by its /peer/<id>/ proxy (which marks it), has a person watching: held the same.
    const remote = await app.request("/api/sessions/prompt", { method: "POST", headers: { "content-type": "application/json", "X-Sova-Relayed": "1" }, body: JSON.stringify({ path, text: "hello" }) }, { incoming: {}, meshPeer: { id: "peer" } });
    assert.equal(remote.status, 409, await remote.clone().text());
    assert.equal(((await remote.json()) as { code?: string }).code, "decide-first");
    assert.deepEqual(loadoutEntries(path), [], "nothing was sent");
    // Disallow All (open to everyone) decides the rest: the page's send goes through.
    await decide(Object.fromEntries([...SKILLS, "sub-skill"].map((n) => [n, "disallowed"])));
    await decideContext({ "AGENTS.md": "disallowed", "sub/AGENTS.md": "disallowed", [join(tmp, "AGENTS.md")]: "disallowed" });
    clearSetupCache();
    const left = (await getSessionSetup(path, { fresh: true })) as Extract<Awaited<ReturnType<typeof getSessionSetup>>, { state: "ok" }>;
    const still = [...left.context, ...left.skills].filter((r) => r.approval?.state === "waiting").map((r) => r.path);
    // Anything else on this machine pi loads (none in this sandbox) is decided too.
    if (still.length) await decideContext(Object.fromEntries(still.map((p) => [p, "disallowed"])));
    const settled = settledOnce(path);
    const ok = await send(pageHeaders());
    assert.equal(ok.status, 200, await ok.clone().text());
    await settled;
    // A program's send into another new chat is never held: it starts with the waiting items off.
    await decide({});
    const other = sessionFile();
    await cm.acquireChat(other);
    const settled2 = settledOnce(other);
    const prog = await app.request("/api/sessions/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: other, text: "hi" }) });
    assert.equal(prog.status, 200, await prog.clone().text());
    await settled2;
    const stamp = loadoutEntries(other).at(-1);
    assert.equal(stamp?.asking, true);
    assert.deepEqual(stamp?.onlySkills, [], "its waiting skills stay off");
    // A direct call from another computer (the Overseer starting a chat there: no relay mark) is a program: never held.
    const third = sessionFile();
    await cm.acquireChat(third);
    const settled3 = settledOnce(third);
    const direct = await app.request("/api/sessions/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: third, text: "hi" }) }, { incoming: {}, meshPeer: { id: "peer" } });
    assert.equal(direct.status, 200, await direct.clone().text());
    await settled3;
    assert.equal(loadoutEntries(third).at(-1)?.asking, true);
    assert.deepEqual(loadoutEntries(third).at(-1)?.onlySkills, [], "its waiting skills stay off");
  } finally {
    await asking(false);
  }
});

test("asking: a skill added after the first message stays off, across a reopen; turning asking off later moves nothing", async () => {
  await decideContext({ "AGENTS.md": "approved" });
  await decide({ "keep-skill": "approved" });
  await asking(true);
  const added = join(root, ".agents", "skills", "added-skill");
  try {
    const path = sessionFile();
    const chat = await cm.acquireChat(path);
    await turn(chat);
    const stamp = loadoutEntries(path).at(-1);
    assert.equal(stamp?.asking, true);
    assert.deepEqual(stamp?.onlySkills, [join(root, ".agents", "skills", "keep-skill", "SKILL.md")]);
    mkdirSync(added, { recursive: true });
    writeFileSync(join(added, "SKILL.md"), "---\nname: added-skill\ndescription: Added later.\n---\n\nbody\n");
    await asking(false);
    await cm.disposeHeldChat(path, "test reopen");
    const reopened = await cm.acquireChat(path);
    assert.doesNotMatch(piSession(reopened).systemPrompt, /<name>added-skill<\/name>/);
    assert.deepEqual(offered(reopened), ["keep-skill"]);
    assert.ok(prompts(reopened, "ROOT-RULES"));
  } finally {
    rmSync(added, { recursive: true, force: true });
    await asking(false);
  }
});

test("asking: a subfolder file met mid-chat is kept from the model with a line; Approve there loads it at the next touch", async () => {
  await decideContext({});
  await decide({});
  await asking(true);
  try {
    const path = sessionFile();
    const chat = await cm.acquireChat(path);
    await turn(chat); // the first message fixes the list (nothing approved)
    const model = new ScriptedModel().attach(piSession(chat));
    model.reply({ toolCall: { name: "read", arguments: { path: join(root, "sub", "x.ts") } } }, { text: "done" });
    let settled = settledOnce(path);
    chat.handle({ send: () => {} }, { type: "prompt", text: "read it" });
    await settled;
    const results = () => JSON.stringify((model.calls.at(-1)!.context as { messages: { role: string }[] }).messages.filter((m) => m.role === "toolResult"));
    assert.doesNotMatch(results(), /SUB-RULES/);
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "custom" && e.customType === "sova-approval-pending");
    assert.deepEqual(lines.map((e) => e.data), [
      { kind: "context", path: join(root, "sub", "AGENTS.md"), name: "sub/AGENTS.md" },
      { kind: "skill", name: "sub-skill", path: join(root, "sub", ".agents", "skills", "sub-skill", "SKILL.md") },
    ]);
    assert.doesNotMatch(results(), /sub-skill/, "nor is the subfolder's skill offered");
    const ctxSent = JSON.stringify(model.calls.at(-1)!.context);
    assert.doesNotMatch(ctxSent, /wasn't loaded/, "the line is never sent to the model");
    // A script can't approve; the page can, and the next touch loads it.
    const approve = (headers: Record<string, string>) =>
      app.request("/api/sessions/approval", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ path, kind: "context", item: join(root, "sub", "AGENTS.md"), state: "approved" }) });
    assert.equal((await approve({})).status, 403);
    const ok = await approve(pageHeaders());
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.deepEqual(await ok.json(), { key: "sub/AGENTS.md", loadedHere: true });
    model.reply({ toolCall: { name: "read", arguments: { path: join(root, "sub", "x.ts") } } }, { text: "done" });
    settled = settledOnce(path);
    chat.handle({ send: () => {} }, { type: "prompt", text: "again" });
    await settled;
    assert.match(results(), /SUB-RULES/);
  } finally {
    await asking(false);
  }
});

test("asking: a worker gets its parent's fixed list and mode, context files included", async () => {
  await decideContext({ "AGENTS.md": "approved" });
  await decide({ "keep-skill": "approved" });
  await asking(true);
  try {
    const path = sessionFile();
    const parent = await cm.acquireChat(path);
    await turn(parent);
    await asking(false);
    await decide({});
    const from = starts.length;
    await turn(parent, [{ name: "agent_spawn", arguments: { prompt: "do it", name: "w", model: "scripted/scripted", wake: false } }], "spawn");
    assert.equal(starts.length, from + 1, "one worker started");
    const spec = starts[from]!.spec as typeof starts[number]["spec"] & { loadout?: { asking?: boolean } };
    assert.equal(spec.loadout?.asking, true);
    const workerPath = sessionFile();
    cm.setWorkerSpec(workerPath, { ...spec, cwd: root });
    try {
      const worker = await cm.acquireChat(workerPath);
      assert.deepEqual(offered(worker), ["keep-skill"]);
      assert.ok(prompts(worker, "ROOT-RULES"));
      assert.equal(prompts(worker, "ABOVE-RULES"), false, "a waiting one stays off in the worker too");
      assert.equal(loadoutOnBranch(piSession(worker).sessionManager.getBranch())?.asking, true, "its own entry");
    } finally {
      await cm.disposeHeldChat(workerPath, "test done");
      cm.setWorkerSpec(workerPath, null);
    }
  } finally {
    await asking(false);
  }
});

test("asking: an approved file whose content changed stays loaded and is marked changed", async () => {
  await decide({});
  await decideContext({ "AGENTS.md": "approved" });
  await asking(true);
  try {
    writeFileSync(join(root, "AGENTS.md"), "ROOT-RULES changed\n");
    const path = sessionFile();
    const chat = await cm.acquireChat(path);
    assert.ok(prompts(chat, "ROOT-RULES changed"), "still loaded");
    clearSetupCache();
    const setup = await getSessionSetup(path, { fresh: true });
    if (setup.state !== "ok") assert.fail(setup.state);
    const row = setup.context.find((f) => f.path === join(root, "AGENTS.md"))!;
    assert.equal(row.approval?.state, "approved");
    assert.equal(row.approval?.changed, true);
  } finally {
    writeFileSync(join(root, "AGENTS.md"), "ROOT-RULES\n");
    await asking(false);
  }
});

test("asking: a folder that isn't a project gets the same list, and an approval there reaches its next chat", async () => {
  const adhoc = join(tmp, "adhoc");
  mkdirSync(adhoc, { recursive: true });
  writeFileSync(join(adhoc, "AGENTS.md"), "ADHOC-RULES\n");
  await asking(true);
  try {
    const path = sessionFile(adhoc);
    const chat = await cm.acquireChat(path);
    assert.equal(prompts(chat, "ADHOC-RULES"), false);
    clearSetupCache();
    const setup = await getSessionSetup(path, { fresh: true });
    if (setup.state !== "ok") assert.fail(setup.state);
    assert.equal(setup.approvals?.folder.kind, "folder");
    const res = await app.request("/api/sessions/approval", { method: "POST", headers: { "content-type": "application/json", ...pageHeaders() }, body: JSON.stringify({ path, kind: "context", item: join(adhoc, "AGENTS.md"), state: "approved" }) });
    assert.equal(res.status, 200, await res.clone().text());
    assert.ok(prompts(cm.heldChat(path)!, "ADHOC-RULES"), "the open new chat was rebuilt with it");
    assert.ok(prompts(await cm.acquireChat(sessionFile(adhoc)), "ADHOC-RULES"));
  } finally {
    await asking(false);
  }
});

test("in a chat's own process every build, a reopen there included, takes the decisions the server sent with the open", async () => {
  await asking(false);
  await decideContext({});
  await decide({});
  const path = sessionFile();
  // As a chat process has it: the server's rule from the open frame (chat-runtime/host.ts open).
  cm.setFolderRule(path, { asking: true, context: { approved: [], disallowed: [] }, skills: { approved: [join(root, ".agents", "skills", "keep-skill", "SKILL.md")], disallowed: [] } });
  try {
    assert.deepEqual(offered(await cm.acquireChat(path)), ["keep-skill"], "the first build");
    // A reopen in the same process (host.ts reopenHere / reacquire): acquireChat again, no new open frame.
    await cm.disposeHeldChat(path, "test reopen");
    assert.deepEqual(offered(await cm.acquireChat(path, true)), ["keep-skill"], "the reopen");
  } finally {
    cm.setFolderRule(path, null);
  }
});

test("a worktree and its main checkout share one decision; a skill only the worktree has is listed and decided there", async () => {
  const { execFileSync } = await import("node:child_process");
  const repo = join(tmp, "repo");
  mkdirSync(repo, { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "AGENTS.md"), "REPO-RULES\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  const wt = join(tmp, "repo-wt");
  git(repo, "worktree", "add", "-q", "-b", "feat/wt", wt);
  mkdirSync(join(wt, ".agents", "skills", "wt-skill"), { recursive: true });
  writeFileSync(join(wt, ".agents", "skills", "wt-skill", "SKILL.md"), "---\nname: wt-skill\ndescription: Only in the worktree.\n---\n\nbody\n");
  const { project: p2 } = await registerProjectIn("standalone", repo, { name: "Worktree Project", origin: "folder" });
  await asking(true);
  try {
    const first = sessionFile(wt);
    await cm.acquireChat(first);
    clearSetupCache();
    const setup = await getSessionSetup(first, { fresh: true });
    if (setup.state !== "ok") assert.fail(setup.state);
    assert.deepEqual(setup.approvals?.folder, { kind: "project", id: p2.id, name: "Worktree Project" });
    assert.equal(setup.skills.find((k) => k.name === "wt-skill")?.approval?.state, "waiting");
    assert.equal(setup.context.find((f) => f.path === join(wt, "AGENTS.md"))?.approval?.key, "AGENTS.md", "the worktree's copy has the main checkout's key");
    // Approved from a chat in the main checkout: the worktree's chats load their own copy.
    const main = sessionFile(repo);
    await cm.acquireChat(main);
    const res = await app.request("/api/sessions/approval", { method: "POST", headers: { "content-type": "application/json", ...pageHeaders() }, body: JSON.stringify({ path: main, kind: "context", item: join(repo, "AGENTS.md"), state: "approved" }) });
    assert.equal(res.status, 200, await res.clone().text());
    assert.ok(prompts(cm.heldChat(first)!, "REPO-RULES"), "the worktree's new chat was rebuilt with it");
    const put2 = await app.request(`/api/projects/${p2.id}/skills`, { method: "PUT", headers: { "content-type": "application/json", ...pageHeaders() }, body: JSON.stringify({ skills: { "wt-skill": "disallowed" } }) });
    assert.equal(put2.status, 200, await put2.clone().text());
    const next = await cm.acquireChat(sessionFile(wt));
    assert.doesNotMatch(piSession(next).systemPrompt, /<name>wt-skill<\/name>/);
    assert.ok(prompts(next, "REPO-RULES"));
  } finally {
    await asking(false);
    await cm.disposeAllChats();
    git(repo, "worktree", "remove", "--force", wt);
  }
});

test("asking: a list that can't be read fails closed: the new chat starts without the folder's context files and skills, and stamps asking", async () => {
  await decide({ "keep-skill": "approved" });
  await decideContext({ "AGENTS.md": "approved" });
  await asking(true);
  cm.setChatHosts({ folderRule: () => Promise.reject(new Error("the list is unreadable")) });
  try {
    const chat = await cm.acquireChat(sessionFile());
    assert.deepEqual(offered(chat), [], "no skill, the approved one included");
    assert.equal(prompts(chat, "ROOT-RULES"), false, "no context file, the approved one included");
    await turn(chat);
    const stamp = loadoutEntries(chat.path).at(-1);
    assert.equal(stamp?.asking, true);
    assert.deepEqual(stamp?.onlySkills, []);
  } finally {
    cm.setChatHosts({});
    await asking(false);
  }
});

test("asking: the page's group send keeps the message as a new member's draft while it has items to decide; the other member gets it", async () => {
  await decide({});
  await decideContext({});
  await asking(true);
  const { getDraft } = await import("./drafts");
  const { idOf } = await import("./sessions-index");
  try {
    const fresh = sessionFile();
    const talked = sessionFile(root, true);
    await cm.acquireChat(fresh);
    const other = await cm.acquireChat(talked);
    const json = { "content-type": "application/json", ...pageHeaders() };
    const group = (await (await app.request("/api/session-groups", { method: "POST", headers: json, body: JSON.stringify({ name: "Pair" }) })).json()) as { id: string };
    for (const path of [fresh, talked]) {
      const res = await app.request("/api/session-groups/assign", { method: "POST", headers: json, body: JSON.stringify({ path, groupId: group.id }) });
      assert.equal(res.status, 200, await res.clone().text());
    }
    new ScriptedModel().attach(piSession(other)).reply({ text: "done" });
    const settled = settledOnce(talked);
    const res = await app.request(`/api/session-groups/${group.id}/prompt`, { method: "POST", headers: json, body: JSON.stringify({ text: "both of you" }) });
    assert.equal(res.status, 200, await res.clone().text());
    const body = (await res.json()) as { sent: string[]; held?: { id: string; code: string }[] };
    assert.deepEqual(body.sent, [idOf(talked)]);
    assert.deepEqual(body.held?.map((h) => [h.id, h.code]), [[idOf(fresh), "decide-first"]]);
    await settled;
    assert.equal(getDraft(idOf(fresh))?.text, "both of you", "the held member keeps it as its draft");
    assert.deepEqual(loadoutEntries(fresh), [], "nothing reached the held member");
    assert.ok(!readFileSync(fresh, "utf8").includes("both of you"));
  } finally {
    await asking(false);
  }
});

test("asking: a skill approved mid-chat in a folder whose other skill was already offered is offered at the next touch there", async () => {
  await decideContext({});
  await decide({});
  await asking(true);
  const skillFile = (name: string) => join(root, "pair", ".agents", "skills", name, "SKILL.md");
  for (const name of ["pair-a", "pair-b"]) {
    mkdirSync(dirname(skillFile(name)), { recursive: true });
    writeFileSync(skillFile(name), `---\nname: ${name}\ndescription: The ${name} recipe.\n---\n\nbody\n`);
  }
  writeFileSync(join(root, "pair", "x.ts"), "x\n");
  try {
    const path = sessionFile();
    const chat = await cm.acquireChat(path);
    await turn(chat);
    const approve = async (name: string) => {
      const res = await app.request("/api/sessions/approval", { method: "POST", headers: { "content-type": "application/json", ...pageHeaders() }, body: JSON.stringify({ path, kind: "skill", item: skillFile(name), state: "approved" }) });
      assert.equal(res.status, 200, await res.clone().text());
    };
    const model = new ScriptedModel().attach(piSession(chat));
    const lastResult = () => JSON.stringify((model.calls.at(-1)!.context as { messages: { role: string }[] }).messages.filter((m) => m.role === "toolResult").at(-1));
    const touch = async () => {
      model.reply({ toolCall: { name: "read", arguments: { path: join(root, "pair", "x.ts") } } }, { text: "done" });
      const settled = settledOnce(path);
      chat.handle({ send: () => {} }, { type: "prompt", text: "read it" });
      await settled;
    };
    await approve("pair-a");
    await touch();
    assert.match(lastResult(), /pair-a/);
    assert.doesNotMatch(lastResult(), /pair-b/, "the waiting one stays off");
    await approve("pair-b");
    await touch();
    assert.match(lastResult(), /pair-b/, "the one approved now is offered at the next touch");
    assert.doesNotMatch(lastResult(), /pair-a/, "the one offered before isn't offered again");
  } finally {
    rmSync(join(root, "pair"), { recursive: true, force: true });
    await asking(false);
  }
});

test("asking: a held chat that hasn't reported its loadout yet is counted from its folder's rule, never as nothing waiting", async () => {
  await decide({});
  await decideContext({});
  await asking(true);
  const { waitingForSession } = await import("./session-setup");
  try {
    const path = sessionFile();
    const chat = await cm.acquireChat(path);
    const before = await waitingForSession(path);
    assert.ok(before > 0, `waiting once loaded (${before})`);
    // As a chat's mirror reads before its build has said how it was built.
    const was = chat.loadoutState;
    chat.loadoutState = null;
    try {
      assert.equal((await import("./chat-handle")).chatHandle(path)?.mirror.loadout, null);
      const early = await waitingForSession(path);
      assert.ok(early > 0, `counted from the folder's rule, not as none (${early})`);
    } finally {
      chat.loadoutState = was;
    }
  } finally {
    await asking(false);
  }
});

test("the setup card's Changed mark reads a skill's whole folder, as the folder's card does; no fingerprint, a large or unreadable folder, and a linked SKILL.md", async () => {
  await decideContext({});
  await decide({ "keep-skill": "approved", "block-skill": "approved" });
  const { updateApprovalStore, projectFolderKey } = await import("./project-skills-store");
  const script = join(root, ".agents", "skills", "keep-skill", "run.sh");
  const dangling = join(root, ".agents", "skills", "late-skill", "gone");
  const linked = join(root, ".agents", "skills", "link-skill");
  const target = join(tmp, "elsewhere", "SKILL.md");
  const rows = async () => {
    clearSetupCache();
    const path = sessionFile();
    await cm.acquireChat(path);
    const s = (await getSessionSetup(path, { fresh: true })) as Extract<Awaited<ReturnType<typeof getSessionSetup>>, { state: "ok" }>;
    assert.equal(s.state, "ok");
    return { path, row: (name: string) => s.skills.find((k) => k.name === name)?.approval };
  };
  try {
    let r = await rows();
    assert.equal(r.row("keep-skill")?.state, "approved");
    assert.equal(r.row("keep-skill")?.changed, undefined, "an unedited approved skill isn't Changed");
    // A script beside its SKILL.md edited (here: added): the folder changed.
    writeFileSync(script, "echo hi\n");
    r = await rows();
    assert.equal(r.row("keep-skill")?.changed, true, "an edited script reads Changed");
    // An approval with no fingerprint matches nothing.
    const blockKey = r.row("block-skill")!.key;
    updateApprovalStore((s) => void (s.folders[projectFolderKey(pid)]!.skills[blockKey] = { state: "approved" }));
    r = await rows();
    assert.equal(r.row("block-skill")?.changed, true, "a hashless approval reads Changed");
    // A part that can't be followed: checked by its listing, said so.
    symlinkSync(join(tmp, "no-such-file"), dangling);
    r = await rows();
    assert.equal(r.row("late-skill")?.fingerprintPartial, true);
    assert.equal(r.row("keep-skill")?.fingerprintPartial, undefined);
    // A linked SKILL.md is keyed where it sits: Approve from the chat finds it there.
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "---\nname: link-skill\ndescription: Linked.\n---\n\nbody\n");
    mkdirSync(linked, { recursive: true });
    symlinkSync(target, join(linked, "SKILL.md"));
    const res = await app.request("/api/sessions/approval", { method: "POST", headers: { "content-type": "application/json", ...pageHeaders() }, body: JSON.stringify({ path: r.path, kind: "skill", item: join(linked, "SKILL.md"), state: "disallowed" }) });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(((await res.json()) as { key: string }).key, ".agents/skills/link-skill/SKILL.md");
  } finally {
    rmSync(script, { force: true });
    rmSync(dangling, { force: true });
    rmSync(linked, { recursive: true, force: true });
    await decide({});
  }
});
