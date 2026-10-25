// Versions the Project Assistant starts (§app.project-assistant/tools, /versions, /requests, §app.project-services/callers):
// owner_versions and start_version through a real chat (a ScriptedModel answers), the real assistantAct and the real
// engine on a static project served in-process. Off files a `try` request in Needs you and starts nothing; On is the
// project's services/run act, then `up` of exactly that copy, and the owner's chat carries the version's row with its
// Open handle and no address; a project whose copies can't be shown, or an adopted slot 0, starts nothing. A throwaway
// PI_CODING_AGENT_DIR; ~/.pi is never read; no model is called.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { piSession } from "./harness/pi/testing/handle";
import { ScriptedModel, scriptedModelsJson } from "./harness/pi/testing/scripted-model";
import { linkPiConfigExtensions } from "./testing/agent-dir";
import { reservePorts } from "./test-ports";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k) || k.startsWith("SOVA_CHAT_")) delete process.env[k];
const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-assistant-versions-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.SOVA_SHARE_PREVIEW_URL = "https://*.preview.example";
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
linkPiConfigExtensions(agentDir);
writeFileSync(join(agentDir, "models.json"), JSON.stringify(scriptedModelsJson()));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "scripted", defaultModel: "scripted", retry: { enabled: false } }));

await import("./testing/in-process-chats");
const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { isSessionBusy } = await import("./chat-handle");
const orgs = await import("./orgs");
const owner = await import("./owner");
const plinks = await import("./person-links");
const pa = await import("./project-assistant");
const store = await import("./project-assistant-store");
const tools = await import("./project-assistant-tools");
const po = await import("./project-overseer");
const versions = await import("./owner-versions");
const { hostOf } = await import("./org-engine");
const { ownerAttention } = await import("./owner-attention");
const { createShareApp } = await import("./share/routes");
const { projectEngine } = await import("./project-services/routes");
const { mutateRegistry, readRegistry } = await import("./project-services/store");
const { staticServes, stopStaticServe } = await import("./preview-serve");
const { settled } = await import("./workspace-git");

after(async () => {
  for (const s of staticServes()) await stopStaticServe(s.id).catch(() => false);
  await disposeAllChats();
  await settled(join(root, "ws"));
  rmSync(root, { recursive: true, force: true });
});

const port = await reservePorts(1);
const site = join(root, "site");
mkdirSync(join(site, ".sova"), { recursive: true });
mkdirSync(join(site, "public"), { recursive: true });
writeFileSync(join(site, "public", "index.html"), "archery");
const DEF = { version: 1, services: { web: { static: "public", ports: { http: { base: port } } } }, share: { endpoints: ["web.http"] } };
writeFileSync(join(site, ".sova", "project.json"), JSON.stringify(DEF));
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "init.defaultBranch=master", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe", encoding: "utf8" });
git(site, "init", "-q");
git(site, "add", "-A");
git(site, "commit", "-qm", "site");

const org = await orgs.createOrg({ name: "Mamluk Arabia", dir: join(root, "ws") });
const alp = await orgs.addPerson(org.id, { name: "Alperen Kaya", role: "Founder" });
await owner.setOwner(org.id, alp.id);
const project = await orgs.addProject(org.id, { name: "Archery website", root: site });
const created = await projectEngine().run("create", { project: site }, { kind: "operator" });
assert.equal(created.ok, true, JSON.stringify(created.error));
const instance = created.instance!;
const { token } = plinks.mintOwnerLink(org.id, alp.id);
const share = createShareApp();
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
const post = (path: string, body: unknown) => share.request(path, { method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, body: JSON.stringify(body) });
const get = (path: string) => share.request(path, { headers: { "user-agent": UA } });

async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** What the owner and the model must never get from a version (§app.project-assistant/never). */
const NEVER = [String(port), "preview.example", site, instance, "127.0.0.1", "localhost", "http://", "https://"];
const assertClean = (text: string, where: string) => {
  for (const no of NEVER) assert.ok(!text.includes(no), `no ${no} in ${where}`);
};

const serving = () => staticServes().some((s) => s.port === port);
const runActs = () => hostOf(org.id).feed(project.id, { newestFirst: false, limit: 500 }).filter((e) => e.event === "services/run");
const tryRequests = () => store.orgRequests(org.id).filter((r) => r.kind === "try");
type ToolResult = { role: string; toolName?: string; content: { type: string; text?: string }[]; isError?: boolean };
const lastToolResult = (m: ScriptedModel): ToolResult => {
  const msgs = (m.calls.at(-1)!.context as { messages: ToolResult[] }).messages;
  return [...msgs].reverse().find((x) => x.role === "toolResult")!;
};
const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? "").join("");
/** The system prompt the model's last request ran on. */
const systemPromptOf = (m: ScriptedModel): string => {
  const ctx = m.calls.at(-1)!.context as { systemPrompt?: string; messages: { role: string; content: unknown }[] };
  // pi records the system prompt by its sections, as a system message.
  return `${ctx.systemPrompt ?? ""}${JSON.stringify(ctx.messages.find((x) => x.role === "system") ?? "")}`;
};

let model: ScriptedModel;
let path = "";
async function ask(text: string, call: { name: string; arguments: Record<string, unknown> }, reply: string): Promise<ToolResult> {
  const n = model.calls.length;
  model.reply({ toolCall: call }, { text: reply });
  const r = await post(`/api/i/${token}/assistant`, { text });
  assert.equal(r.status, 202, await r.clone().text());
  await until(() => model.calls.length >= n + 2 && !isSessionBusy(path), `the reply to "${text}"`);
  const res = lastToolResult(model);
  assertClean(JSON.stringify(res), `the ${call.name} result`);
  return res;
}

describe("start_version (§app.project-assistant/tools)", () => {
  test("owner_versions: the label, the project and whether it runs; never an address, port or handle", async () => {
    store.setAssistantModels(org.id, { models: { reply: { model: "scripted/scripted" } } });
    path = (await pa.ensureAssistant(org.id)).path;
    model = new ScriptedModel().attach(piSession(await acquireChat(path)));
    const names = piSession(await acquireChat(path)).getActiveToolNames();
    for (const t of ["owner_versions", "start_version"]) assert.ok(names.includes(t), `has ${t}: ${names.join(",")}`);
    const r = await ask("Can I try the site?", { name: "owner_versions", arguments: {} }, "There's a current version.");
    assert.equal(textOf(r), "- Archery website: Current version: not running");
    assert.ok(!/v_[a-z2-9]{8}/.test(textOf(r)), "no handle");
  });

  test("Off: a `try` request in Needs you (the project's Branches tab), nothing starts; a second ask files none", async () => {
    await po.patchProjectOverseer(project.id, { powers: { assistant: { copiesRun: false } } });
    const acts = runActs().length;
    const r = await ask("Start it please", { name: "start_version", arguments: { version: "Current version" } }, "I've asked the team.");
    assert.equal(textOf(r), "Create, start and update running copies is off for the Project Assistant. Do not retry it. Tell the owner it went to the team: it reaches the operator as a request.");
    assert.deepEqual(tryRequests().map((x) => [x.title, x.status]), [["Current version", "with-team"]]);
    const item = ownerAttention().find((i) => i.id === `owner-request:${tryRequests()[0]!.id}`)!;
    assert.deepEqual([item.kind, item.tier, item.href, item.detail], ["owner-version-request", "act", `#/projects/${project.id}/branches`, "Alperen Kaya asks to try Archery website: Current version"]);
    assert.equal(serving(), false, "nothing started");
    assert.equal(runActs().length, acts, "no act set off");
    await ask("Please, start it", { name: "start_version", arguments: { version: "Current version" } }, "It's with the team.");
    assert.equal(tryRequests().length, 1, "the open request stands");
    const view = await pa.assistantView(org.id);
    assert.ok(!view.messages.some((m) => m.versions?.length), "no Open button without a start");
    // What it offers follows the switches (§app.project-assistant/offers): a new project's column is all Off, so the
    // reply ran with no fix and no planning chat, and its prompt offers no start of a version that isn't running.
    const names = piSession(await acquireChat(path)).getActiveToolNames();
    for (const t of ["start_fix", "start_feature_chat"]) assert.ok(!names.includes(t), `no ${t}: ${names.join(",")}`);
    for (const t of ["owner_versions", "start_version", "deploy", "report_issue"]) assert.ok(names.includes(t), `has ${t}`);
    const prompt = systemPromptOf(model);
    assert.match(prompt, /isn't started from here/);
    assert.doesNotMatch(prompt, /start_fix|start_feature_chat|planning chat/);
  });

  test("the operator starts the copy from Branches: once it is seen running, the open `try` request is done and leaves Needs you", async () => {
    const open = tryRequests().filter((x) => x.status === "with-team");
    assert.equal(open.length, 1, "the Off test's request is open");
    const up = await projectEngine().run("up", { instance }, { kind: "operator" });
    assert.equal(up.ok, true, JSON.stringify(up.error));
    try {
      const [v] = await versions.projectVersions(org.id, project);
      assert.equal(v!.state, "running");
      assert.deepEqual(store.orgRequests(org.id).filter((x) => x.id === open[0]!.id).map((x) => x.status), ["done"], "the request is closed");
      assert.ok(!ownerAttention().some((i) => i.kind === "owner-version-request"), "no owner-version-request in Needs you");
    } finally {
      const down = await projectEngine().run("down", { instance, confirm: true }, { kind: "operator" });
      assert.equal(down.ok, true, JSON.stringify(down.error));
    }
    // A new ask while it's stopped files a new request (the done one is no longer open).
    await po.patchProjectOverseer(project.id, { powers: { assistant: { copiesRun: false } } });
    await ask("Can I try it again?", { name: "start_version", arguments: {} }, "I've asked the team.");
    assert.deepEqual(tryRequests().map((x) => x.status).sort(), ["done", "with-team"]);
  });

  test("On: the project's services/run act by the assistant, then up of exactly that copy; the chat's row opens it through the owner link", async () => {
    await po.patchProjectOverseer(project.id, { powers: { assistant: { copiesRun: true } } });
    const acts = runActs().length;
    const r = await ask("Start it now", { name: "start_version", arguments: {} }, "It's starting: use the Open button.");
    assert.equal(textOf(r), "Current version of Archery website is starting. Its Open button is in this chat and on the home page.");
    const mine = runActs().slice(acts);
    assert.deepEqual(mine.map((e) => [e.by, e.refused ?? null]), [["assistant", null]], "one services/run act, the assistant's, taken");
    await until(serving, "the copy serves");
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "archery");
    const rec = readRegistry().instances.find((i) => i.id === instance)!;
    assert.equal(rec.desired.web, "running");
    const view = await pa.assistantView(org.id);
    const withRow = view.messages.filter((m) => m.versions?.length);
    assert.equal(withRow.length, 1, "the message after the start carries the version");
    assert.equal(withRow[0]!.text, "It's starting: use the Open button.");
    const row = withRow[0]!.versions![0]!;
    assert.deepEqual([row.label, row.project, row.state], ["Current version", "Archery website", "running"]);
    assert.match(row.handle, /^v_[a-z2-9]{8}$/);
    assertClean(JSON.stringify(view), "the owner's chat");
    assertClean(JSON.stringify(await (await get(`/api/i/${token}`)).json()), "the owner's home");
    const open = await get(`/i/${token}/v/${row.handle}`);
    assert.equal(open.status, 302);
    assert.match(open.headers.get("location")!, /^https:\/\/[a-z2-7]{52}\.preview\.example\/$/);
    // Running: asked again, it says so with its button, and sets nothing off.
    const again = await ask("Start it again", { name: "start_version", arguments: { version: "current version" } }, "It's running.");
    assert.equal(textOf(again), "Current version of Archery website is running. Its Open button is in this chat and on the home page.");
    assert.equal(runActs().length, acts + 1, "no second act");
    assert.equal((await pa.assistantView(org.id)).messages.filter((m) => m.versions?.length).length, 2);
    assert.match(systemPromptOf(model), /offer to start it with `start_version`/, "On: starting one is offered");
    // Off with the copy running: opening it is always offered, and the owner still gets its Open button.
    await po.patchProjectOverseer(project.id, { powers: { assistant: { copiesRun: false } } });
    const off = await ask("Can I open it?", { name: "start_version", arguments: {} }, "It's running: use the Open button.");
    assert.equal(textOf(off), "Current version of Archery website is running. Its Open button is in this chat and on the home page.");
    assert.ok(piSession(await acquireChat(path)).getActiveToolNames().includes("start_version"));
    const offPrompt = systemPromptOf(model);
    assert.match(offPrompt, /One that is running or starting can always be opened/);
    assert.match(offPrompt, /isn't started from here/);
    const offRows = (await pa.assistantView(org.id)).messages.filter((m) => m.versions?.length);
    assert.equal(offRows.length, 3, "the Open button, with the switch Off");
    assert.deepEqual([offRows[2]!.text, offRows[2]!.versions![0]!.state], ["It's running: use the Open button.", "running"]);
    assert.equal(runActs().length, acts + 1, "no act");
    await po.patchProjectOverseer(project.id, { powers: { assistant: { copiesRun: true } } });
    // Nothing stops it on its own: the operator does (here, the test).
    // Its owner-bound preview is an active link on the copy, so the operator confirms the stop.
    assert.equal((await projectEngine().run("down", { instance }, { kind: "operator" })).error?.code, "needs-confirm");
    const down = await projectEngine().run("down", { instance, confirm: true }, { kind: "operator" });
    assert.equal(down.ok, true, JSON.stringify(down.error));
    assert.equal(serving(), false);
  });

  test("copies that can't be shown outside the team: refused before any act", async () => {
    const acts = runActs().length;
    const t = tools.assistantTools({ orgId: org.id, sessionId: "s_pa", owner: () => ({ id: alp.id, name: alp.name }), branch: () => [] }).find((x) => x.name === "start_version")!;
    const run = async () => ((await t.execute("c1", { version: "Current version" } as never, undefined, undefined, undefined as never)) as { content: { text: string }[] }).content[0]!.text;
    try {
      writeFileSync(join(site, ".sova", "project.json"), JSON.stringify({ ...DEF, data: { db: { kind: "dir", sensitive: true } } }));
      assert.equal(await run(), "Archery website's versions can't be shown outside the team.");
      writeFileSync(join(site, ".sova", "project.json"), JSON.stringify({ ...DEF, share: { ...DEF.share, allow: false } }));
      assert.equal(await run(), "Archery website's versions can't be shown outside the team.");
    } finally {
      writeFileSync(join(site, ".sova", "project.json"), JSON.stringify(DEF));
    }
    assert.equal(runActs().length, acts, "no act");
    assert.equal(serving(), false);
  });

  test("an adopted slot 0: the engine refuses before the act; it didn't start, the team knows", async () => {
    const acts = runActs().length;
    const adopted = { version: 1, services: { web: { cmd: ["node", "web.mjs"], ports: { http: { base: port } }, adopt: { unit: "sova-standin-site.service", ports: { http: port } } } }, share: { endpoints: ["web.http"] } };
    writeFileSync(join(site, ".sova", "project.json"), JSON.stringify(adopted));
    try {
      const before = tryRequests().length;
      for (const r of tryRequests()) store.setRequestStatus(org.id, r.id, "done");
      const t = tools.assistantTools({ orgId: org.id, sessionId: "s_pa", owner: () => ({ id: alp.id, name: alp.name }), branch: () => [] }).find((x) => x.name === "start_version")!;
      const out = (await t.execute("c2", {} as never, undefined, undefined, undefined as never)) as { content: { text: string }[]; details: Record<string, unknown> };
      assert.equal(out.content[0]!.text, "It didn't start; the team knows.");
      assert.equal(out.details.version, undefined, "no Open button");
      assert.equal(runActs().length, acts, "the engine's refusal comes first: no act");
      const open = tryRequests().filter((x) => x.status === "with-team");
      assert.equal(open.length, 1);
      assert.match(open[0]!.text, /refused-slot0/, "the operator's request says why");
      assert.equal(tryRequests().length, before + 1);
      const [v] = await versions.projectVersions(org.id, project);
      assert.equal(v!.state, "failed");
      const page = await get(`/i/${token}/v/${v!.handle}`);
      assert.deepEqual([page.status, await page.text()], [409, "This version didn't start. The team knows."]);
    } finally {
      writeFileSync(join(site, ".sova", "project.json"), JSON.stringify(DEF));
      versions.clearVersionStartsForTest();
    }
  });

  test("a project with no copies: nothing to try where copies can't be shown; else the Current version's copy is made (q6)", async () => {
    mutateRegistry((r) => {
      r.instances = r.instances.filter((i) => i.id !== instance);
    });
    const t = tools.assistantTools({ orgId: org.id, sessionId: "s_pa", owner: () => ({ id: alp.id, name: alp.name }), branch: () => [] }).find((x) => x.name === "start_version")!;
    writeFileSync(join(site, ".sova", "project.json"), JSON.stringify({ ...DEF, share: { ...DEF.share, allow: false } }));
    try {
      const out = (await t.execute("c3", {} as never, undefined, undefined, undefined as never)) as { content: { text: string }[] };
      assert.equal(out.content[0]!.text, "Archery website has no versions to try.");
    } finally {
      writeFileSync(join(site, ".sova", "project.json"), JSON.stringify(DEF));
    }
    const made = (await t.execute("c4", {} as never, undefined, undefined, undefined as never)) as { content: { text: string }[] };
    assert.match(made.content[0]!.text, /^Current version of Archery website is starting\./);
    assert.ok(readRegistry().instances.some((i) => realpathSync(i.checkout) === realpathSync(site)), "the main checkout's copy was made");
  });
});
