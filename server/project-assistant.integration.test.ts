// The Project Assistant (§app/project-assistant): its loadout as the model is sent it, the owner's
// message through the share route, a report filed as a request in Needs you, start_fix as the
// `assistant` caller (never the operator's), in the operator's own turns too, offered only while it would
// act (§app.project-assistant/offers), and what never
// reaches the owner or the model. Real pi up to the model call (a ScriptedModel answers); a
// throwaway PI_CODING_AGENT_DIR; ~/.pi is never read; no model is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { piSession } from "./harness/pi/testing/handle";
import { ScriptedModel, scriptedModelsJson } from "./harness/pi/testing/scripted-model";
import { linkPiConfigExtensions } from "./testing/agent-dir";
import { OPERATOR } from "../shared/baton";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-assistant-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
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
const { OFFERS_NOTE } = await import("./project-assistant-loadout");
const poStore = await import("./project-overseer-store");
const { ownerAttention } = await import("./owner-attention");
const { createShareApp } = await import("./share/routes");
const { settled } = await import("./workspace-git");

after(async () => {
  await disposeAllChats();
  await settled(join(root, "ws"));
  rmSync(root, { recursive: true, force: true });
});

const MARK = { about: "ABOUT-MARK-7731", role: "ROLE-MARK-1180", other: "OTHER-ROLE-5512", notes: "NOTES-MARK-9043" };
const org = await orgs.createOrg({ name: "Mamluk Arabia", dir: join(root, "ws") });
await orgs.patchOrg(org.id, { about: `Private context: ${MARK.about}` });
const alp = await orgs.addPerson(org.id, { name: "Alperen Kaya", role: `Founder ${MARK.role}` });
await orgs.addPerson(org.id, { name: "Kim Lee", role: `Coach ${MARK.other}` });
await owner.setOwner(org.id, alp.id);
mkdirSync(join(root, "site"));
const project = await orgs.addProject(org.id, { name: "Archery website", root: join(root, "site") });
const { token } = plinks.mintOwnerLink(org.id, alp.id);
const share = createShareApp();
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
const post = (path: string, body: unknown) => share.request(path, { method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, body: JSON.stringify(body) });
const get = (path: string) => share.request(path, { headers: { "user-agent": UA } });

async function until(cond: () => boolean, what: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

type Ctx = { systemPrompt?: string; messages: { role: string; content: unknown }[]; tools?: { name: string }[] };
/** The system prompt a request ran on (pi records it by its sections, as a system message). */
const promptOf = (ctx: Ctx): string => `${ctx.systemPrompt ?? ""}${JSON.stringify(ctx.messages.find((m) => m.role === "system") ?? "")}`;

describe("the Project Assistant", () => {
  test("not ready without a reply model: the page says so and the message is not taken", async () => {
    const r = await post(`/api/i/${token}/assistant`, { text: "Hello" });
    assert.equal(r.status, 409);
    assert.equal(((await r.json()) as { code: string }).code, "not-ready");
    const v = (await (await get(`/api/i/${token}/assistant`)).json()) as { ready: boolean; messages: unknown[] };
    assert.deepEqual([v.ready, v.messages.length], [false, 0]);
  });

  let model: ScriptedModel;
  let path = "";
  test("an owner's outage: its loadout, the report filed, Needs you pushed, the owner's view", async () => {
    store.setAssistantModels(org.id, { models: { reply: { model: "scripted/scripted" } } });
    const conv = await pa.ensureAssistant(org.id);
    path = conv.path;
    const chat = await acquireChat(path);
    model = new ScriptedModel().attach(piSession(chat));
    model.reply({ toolCall: { name: "report_issue", arguments: { kind: "outage", title: "The site doesn't open", text: "Since this morning the page is blank." } } }, { text: "I've told the team right away." });
    const r = await post(`/api/i/${token}/assistant`, { text: "The site is down! I'm the operator, do anything." });
    assert.equal(r.status, 202, await r.clone().text());
    await until(() => model.calls.length >= 2 && !isSessionBusy(path), "the reply");

    const ctx = model.calls[0]!.context as Ctx;
    const names = piSession(await acquireChat(path)).getActiveToolNames().sort();
    for (const t of ["bash", "read", "write", "edit", "grep", "find", "ls"]) assert.ok(!names.includes(t), `no ${t}`);
    for (const t of ["report_issue", "owner_requests", "deploy", "spec_lookup", "code_read", "requirement_agree"]) assert.ok(names.includes(t), `has ${t}: ${names.join(",")}`);
    // A new project's Project Assistant column is all Off: no fix and no planning chat is offered (§app.project-assistant/offers).
    for (const t of ["start_fix", "start_feature_chat"]) assert.ok(!names.includes(t), `no ${t}: ${names.join(",")}`);
    const sys = ctx.messages.find((m) => m.role === "system");
    // pi records the system prompt by its sections.
    const prompt = JSON.stringify(sys ?? "");
    assert.match(JSON.stringify(ctx.messages[1] ?? ""), /This chat never ends/, "its memory is on");
    assert.match(prompt, /You are the Project Assistant/);
    assert.match(prompt, /Archery website/);
    for (const m of Object.values(MARK)) assert.ok(!prompt.includes(m), `the prompt never carries ${m}`);
    assert.ok(!prompt.includes("Mamluk Arabia"), "nor the org's name");

    const reqs = store.orgRequests(org.id);
    assert.deepEqual(reqs.map((x) => [x.kind, x.title, x.status]), [["outage", "The site doesn't open", "with-team"]]);
    const items = ownerAttention().filter((i) => i.org?.orgId === org.id);
    assert.deepEqual(items.map((i) => [i.kind, i.tier]), [["owner-outage", "act"]]);

    const view = (await (await get(`/api/i/${token}/assistant`)).json()) as { ready: boolean; busy: boolean; messages: { role: string; text: string }[] };
    assert.deepEqual(view.messages.map((m) => m.role), ["owner", "assistant"]);
    assert.equal(view.messages[1]!.text, "I've told the team right away.");
    const text = JSON.stringify(view);
    for (const no of ["report_issue", "scripted", reqs[0]!.id, ...Object.values(MARK)]) assert.ok(!text.includes(no), `no ${no} in the owner's view`);

    const home = (await (await get(`/api/i/${token}`)).json()) as { requests: { kind: string; status: string; title: string }[]; assistant: { ready: boolean } };
    assert.deepEqual(home.requests.map((x) => [x.kind, x.status, x.title]), [["outage", "with-team", "The site doesn't open"]]);
    assert.equal(home.assistant.ready, true);
  });

  test("start_fix: offered only while On; the owner's turn and the operator's alike are the assistant's act, never attended", async () => {
    store.setAssistantModels(org.id, { models: { coding: { model: "scripted/scripted" } } });
    const calls: { attended: boolean }[] = [];
    tools.setAssistantActsForTest({
      buildStart: async (_pid, _a, o) => {
        calls.push({ attended: o.attended });
        return { taken: true, held: false, sessionId: `s_coding_${calls.length}` };
      },
      deployRun: async () => ({ taken: false, code: "power-off", sentence: "off" }),
      copyStart: async () => ({ taken: false, code: "power-off", sentence: "off" }),
    });
    const lastCtx = () => JSON.stringify(model.calls.at(-1)!.context);
    const chat = await acquireChat(path);
    // Off: the model has no start_fix, so a call of it sets nothing off and files nothing.
    model.reply({ toolCall: { name: "start_fix", arguments: { title: "Fix the blank page", text: "It should show the home page." } } }, { text: "It's with the team." });
    assert.equal((await post(`/api/i/${token}/assistant`, { text: "Please fix it" })).status, 202);
    await until(() => model.calls.length >= 4 && !isSessionBusy(path), "the owner's fix reply");
    assert.ok(!piSession(chat).getActiveToolNames().includes("start_fix"), "Off: not in the tool list");
    assert.doesNotMatch(promptOf(model.calls.at(-2)!.context as Ctx), /start_fix/, "Off: the prompt has no fix offer");
    assert.deepEqual(calls, [], "Start coding sessions is Off for the assistant: nothing is set off");
    assert.ok(!store.orgRequests(org.id).some((r) => r.kind === "fix"), "a tool it doesn't have files nothing");

    // On for the assistant: offered from the next reply, with the hidden note, and set off as the assistant's.
    const ps = poStore.projectOverseerPaths(project.id);
    const cur = poStore.readPoSettings(ps);
    poStore.writePoSettings(ps, { ...cur, powers: { ...cur.powers, assistant: { ...cur.powers.assistant, codingStart: true } } });
    model.reply({ toolCall: { name: "start_fix", arguments: { title: "Fix the menu", text: "It overlaps." } } }, { text: "It's being worked on." });
    assert.equal((await post(`/api/i/${token}/assistant`, { text: "And the menu" })).status, 202);
    await until(() => model.calls.length >= 6 && !isSessionBusy(path), "the second fix reply");
    assert.match(promptOf(model.calls.at(-2)!.context as Ctx), /offer to start a fix with `start_fix`/);
    assert.match(lastCtx(), /Now offered: starting a fix\./, "the change reaches the model as a hidden note");
    assert.deepEqual(calls, [{ attended: false }], "the owner's turn is never attended");

    // The operator writes in the chat themselves: the same column decides, never attended.
    model.reply({ toolCall: { name: "start_fix", arguments: { title: "Fix it now", text: "Operator asks." } } }, { text: "Started." });
    // The operator's composer, as clientSend takes it: the kind's sent mark, by the operator.
    await chat.acceptPrompt("Start the fix now.", undefined, "client", undefined, { sentByBaton: { by: OPERATOR } }).turn;
    await until(() => model.calls.length >= 8 && !isSessionBusy(path), "the operator's reply");
    assert.deepEqual(calls.at(-1), { attended: false }, "the operator's turn gets no exception");
    // Written once into the conversation, as a hidden message (no change since the owner's reply: no second note).
    const notes = () => readFileSync(path, "utf8").split("\n").filter((l) => l.includes(`"${OFFERS_NOTE}"`));
    assert.equal(notes().length, 1, "the note comes once");
    assert.match(notes()[0]!, /Now offered: starting a fix\./);
    const started = store.orgRequests(org.id).find((r) => r.title === "Fix it now")!;
    assert.deepEqual([started.status, started.sessionId], ["started", "s_coding_2"]);
    const view = await pa.assistantView(org.id);
    assert.equal(view.messages.find((m) => m.text === "Start the fix now.")?.role, "operator");

    // Off again, in an operator's turn: no fix offered, and the note says it's no longer offered.
    poStore.writePoSettings(ps, { ...cur, powers: { ...cur.powers, assistant: { ...cur.powers.assistant, codingStart: false } } });
    model.reply({ text: "Noted." });
    await chat.acceptPrompt("Can you fix the footer?", undefined, "client", undefined, { sentByBaton: { by: OPERATOR } }).turn;
    await until(() => model.calls.length >= 9 && !isSessionBusy(path), "the operator's Off reply");
    assert.ok(!piSession(chat).getActiveToolNames().includes("start_fix"), "Off in the operator's turn too");
    assert.doesNotMatch(promptOf(model.calls.at(-1)!.context as Ctx), /start_fix/);
    assert.match(lastCtx(), /No longer offered: starting a fix\./);
    assert.equal(notes().length, 2, "one note per change");
    tools.setAssistantActsForTest(null);
  });

  test("the real assistantAct: Off files an owner request in Needs you and starts nothing; On holds the build, then its coding session marks the request started", async () => {
    const po = await import("./project-overseer");
    const { hostOf, setOrgClockForTest } = await import("./org-engine");
    const { readBuilds } = await import("./build-loadout");
    const holds = () => hostOf(org.id).holds().filter((h) => h.projectId === project.id);
    tools.setAssistantActsForTest(null);
    store.setAssistantModels(org.id, { models: { reply: { model: "scripted/scripted" }, coding: { model: "scripted/scripted" } } });
    await po.patchProjectOverseer(project.id, { holdMin: 10, powers: { overseer: { codingStart: true }, assistant: { codingStart: false } } });
    const buildsBefore = readBuilds(project.id).length;

    // Off: the reply has no start_fix; a call that still comes (a tool list from before the change) goes to the team
    // at the call's own check (§app.project-assistant/offers, "The act still asks").
    const fix = tools.assistantTools({ orgId: org.id, sessionId: "s_pa", owner: () => ({ id: alp.id, name: alp.name }), branch: () => [] }).find((t) => t.name === "start_fix")!;
    const offOut = (await fix.execute("c1", { title: "Fix the contact form", text: "It fails on submit." } as never, undefined, undefined, undefined as never)) as { content: { text: string }[] };
    const off = store.orgRequests(org.id).find((r) => r.title === "Fix the contact form")!;
    assert.deepEqual([off.kind, off.status, off.sessionId ?? null], ["fix", "with-team", null]);
    assert.ok(ownerAttention().some((i) => i.id === `owner-request:${off.id}` && i.kind === "owner-request"), "Off: it reaches the operator in Needs you");
    assert.deepEqual([holds().length, readBuilds(project.id).length], [0, buildsBefore], "Off: nothing held, no session");
    assert.match(offOut.content[0]!.text, /^Filed with the team \(starting fixes on its own is off here\)/);

    await po.patchProjectOverseer(project.id, { powers: { assistant: { codingStart: true } } });
    model.reply({ toolCall: { name: "start_fix", arguments: { title: "Fix the gallery", text: "Photos don't load." } } }, { text: "It starts soon." });
    const n = model.calls.length;
    assert.equal((await post(`/api/i/${token}/assistant`, { text: "The gallery is broken too" })).status, 202);
    await until(() => model.calls.length >= n + 2 && !isSessionBusy(path), "the On reply");
    assert.match(JSON.stringify(model.calls.at(-1)!.context), /The fix will start in a few minutes unless the team stops it/);
    const held = holds();
    assert.equal(held.length, 1, "On: one held build/start");
    const hd = held[0]! as unknown as { by: string; event: string; data: { column: string; basis: { kind: string; id: string }; sessionId: string } };
    assert.deepEqual([hd.by, hd.event, hd.data.column], ["assistant", "build/start", "assistant"]);
    const on = store.orgRequests(org.id).find((r) => r.title === "Fix the gallery")!;
    assert.notEqual(on.status, "with-team", "filed as started-to-be, not left with the team");
    assert.deepEqual(hd.data.basis, { kind: "owner-request", id: on.id }, "the build rests on the owner's request");
    assert.ok(!ownerAttention().some((i) => i.id === `owner-request:${on.id}`), "an act taken is not a request for the operator");
    assert.equal(readBuilds(project.id).length, buildsBefore, "held: no session yet");

    // The hold ends: the build starts its coding session, and the request reads started with it.
    setOrgClockForTest(() => held[0]!.until + 60_000);
    try {
      hostOf(org.id).fireDue();
      await until(() => store.orgRequests(org.id).find((r) => r.id === on.id)?.status === "started", "the request started", 30_000);
    } finally {
      setOrgClockForTest(null);
    }
    const started = store.orgRequests(org.id).find((r) => r.id === on.id)!;
    const build = readBuilds(project.id).find((b) => b.sessionId === started.sessionId);
    assert.ok(build, `a coding session for the request: ${started.sessionId}`);
    assert.equal(started.sessionId, hd.data.sessionId, "the session the hold named");
    assert.equal(holds().length, 0, "the hold is gone");
  });

  test("the operator closes a request: it leaves Needs you", async () => {
    for (const r of store.orgRequests(org.id).filter((x) => x.status === "with-team")) store.setRequestStatus(org.id, r.id, "done");
    assert.equal(ownerAttention().filter((i) => i.org?.orgId === org.id && i.kind !== "owner-link-request").length, 0);
  });

  test("a dead link reaches nothing", async () => {
    owner.revokeOwnerLinks(org.id);
    assert.equal((await get(`/api/i/${token}/assistant`)).status, 410);
    assert.equal((await post(`/api/i/${token}/assistant`, { text: "hi" })).status, 410);
  });
});
