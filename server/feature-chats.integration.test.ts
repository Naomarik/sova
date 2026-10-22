// Feature request chats (§app.project-assistant/feature-chats): start_feature_chat as the assistant's act (Off:
// with the team; one open chat per owner), the chat's loadout as its model is sent it (no write, edit or run tool;
// align served; the planning prompt), the owner's message route (the holder only, as their person), the plan card
// on the owner page (never its technical notes), Hide From refused, only the owner agrees the plan, and the owner
// changing: the chat ends, the new owner can't see or write in it, Needs you says so (t13). Real pi up to the model
// call (a ScriptedModel answers); a throwaway PI_CODING_AGENT_DIR; no model is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { HEntry, ToolCtx } from "../shared/harness";
import { piSession } from "./harness/pi/testing/handle";
import { ScriptedModel, scriptedModelsJson } from "./harness/pi/testing/scripted-model";
import { linkPiConfigExtensions } from "./testing/agent-dir";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];
const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-feature-chats-")));
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
const store = await import("./project-assistant-store");
const tools = await import("./project-assistant-tools");
const poStore = await import("./project-overseer-store");
const baton = await import("./baton");
const loadout = await import("./baton-loadout");
const fc = await import("./feature-chats");
const { ownerAttention } = await import("./owner-attention");
const { createShareApp } = await import("./share/routes");
const { settled } = await import("./workspace-git");

after(async () => {
  await disposeAllChats();
  await settled(join(root, "ws"));
  rmSync(root, { recursive: true, force: true });
});

const TECH = "TECH-NOTE-MARK-6610";
const org = await orgs.createOrg({ name: "Mamluk Arabia", dir: join(root, "ws") });
const alp = await orgs.addPerson(org.id, { name: "Alperen Kaya", role: "Founder" });
const kim = await orgs.addPerson(org.id, { name: "Kim Lee", role: "Coach" });
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

/** The assistant's start_feature_chat, called as the owner's turn would call it (never attended). */
async function startFeature(title: string): Promise<{ text: string; details: Record<string, unknown> }> {
  const t = tools.assistantTools({ orgId: org.id, sessionId: "pa-test", owner: () => tools.ownerNow(org.id, orgs.ownerOf(org.id)?.id ?? ""), branch: () => [] }).find((x) => x.name === "start_feature_chat")!;
  const ctx = { branch: (): HEntry[] => [], sessionId: "pa-test" } as unknown as ToolCtx;
  const out = (await (t.execute as (...a: unknown[]) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }>)("tc", { title, text: `I'd like ${title.toLowerCase()} on the website.` }, undefined, undefined, ctx)) as { content: { text: string }[]; details: Record<string, unknown> };
  return { text: out.content[0]!.text, details: out.details };
}
const setGather = (on: boolean) => {
  const ps = poStore.projectOverseerPaths(project.id);
  const cur = poStore.readPoSettings(ps);
  poStore.writePoSettings(ps, { ...cur, powers: { ...cur.powers, assistant: { ...cur.powers.assistant, gather: on } } });
};

describe("feature request chats", () => {
  test("switch Off: it goes to the team as a feature request, and no chat opens", async () => {
    store.setAssistantModels(org.id, { models: { reply: { model: "scripted/scripted" }, gathering: { model: "scripted/scripted" } } });
    setGather(false);
    const out = await startFeature("Gift cards");
    assert.equal(out.details.started, false);
    assert.match(out.text, /Filed with the team/);
    assert.deepEqual(store.orgRequests(org.id).map((r) => [r.kind, r.title]), [["feature", "Gift cards"]]);
    assert.deepEqual(store.featureChats(org.id), [], "no chat");
    const home = (await (await get(`/api/i/${token}`)).json()) as { abilities?: { projects: { feature?: string }[] } };
    assert.equal(home.abilities?.projects[0]?.feature, "team", "the owner page says the team plans it");
  });

  let sid = "";
  let handle = "";
  test("switch On: it opens as the owner's own chat, no hold, prototypes on, the gathering model; one open chat per owner", async () => {
    setGather(true);
    const home = (await (await get(`/api/i/${token}`)).json()) as { abilities?: { projects: { feature?: string }[] } };
    assert.equal(home.abilities?.projects[0]?.feature, "now", "the owner page says it opens right away");
    const out = await startFeature("Online booking");
    assert.equal(out.details.started, true, out.text);
    sid = String(out.details.featureChat);
    const row = baton.batonById(sid)!.row;
    assert.deepEqual([row.holder, row.state, row.model, row.publicTitle], [alp.id, "open", "scripted/scripted", "Online booking"]);
    assert.deepEqual(row.abilities, { draw: true, readLinks: false, drawHtml: true });
    const rec = store.featureChats(org.id).find((r) => r.sessionId === sid)!;
    assert.equal(rec.personId, alp.id, "it belongs to the owner who opened it");
    handle = plinks.handleOf("k", sid);
    // No link to send: the owner answers on their page.
    assert.ok(!ownerAttention().some((i) => i.kind === "baton-needs-you"), "no Send them their link item");
    const items = ownerAttention().filter((i) => i.org?.orgId === org.id && i.title === "Online booking");
    assert.deepEqual(items.map((i) => i.detail), ["Alperen Kaya is planning a new feature with the assistant on Archery website: Online booking"]);
    // A second one while it is open: refused, nothing filed.
    const before = store.orgRequests(org.id).length;
    const again = await startFeature("Loyalty points");
    assert.equal(again.details.started, false);
    assert.match(again.text, /already has a planning chat open \("Online booking"\)/);
    assert.equal(store.orgRequests(org.id).length, before, "nothing filed");
  });

  test("its loadout: no write, edit or run tool; align served; nothing a gathering takes in; the planning prompt", async () => {
    const active = loadout.activeBatonTools(sid);
    for (const t of ["bash", "read", "write", "edit", "grep", "find", "ls", "read_link", "inspect_files", "confirm_file", "propose_roster_edit"]) assert.ok(!active.includes(t), `no ${t}`);
    for (const t of ["align", "hand_to", "goal_done", "spec_lookup", "code_read", "requirements_confirm"]) assert.ok(active.includes(t), `has ${t}`);
    const prompt = loadout.renderBatonPrompt(sid);
    assert.match(prompt, /# Planning something new/);
    assert.match(prompt, /Project manager style/);
    assert.ok(!prompt.includes("Mamluk Arabia"), "never the org's name");
  });

  test("the owner's message, as their person; the plan card on their page, never its technical notes", async () => {
    const path = baton.sessionPathOf(baton.batonById(sid)!.dir, baton.batonById(sid)!.row);
    const chat = await acquireChat(path);
    const model = new ScriptedModel().attach(piSession(chat));
    model.reply(
      { toolCall: { name: "align", arguments: { ops: [{ op: "create", title: "Online booking", summary: "Book a class.", technical: [TECH] }] } } },
      { toolCall: { name: "align", arguments: { ops: [{ op: "create", title: "Online booking", summary: "Book a class from the site.", approach: ["Add a Book button."], questions: [{ topic: "Who", ask: "Who can book?", options: [{ label: "Anyone", tradeoff: "More bookings." }, { label: "Members only", tradeoff: "Fewer no-shows." }], recommendation: { choice: "Anyone", why: "Simple." }, visual: { kind: "html", source: "<button>Book</button>" } }] }] } } },
      { text: "Here is a first plan." },
    );
    const r = await post(`/api/i/${token}/c/${handle}/message`, { text: "Anyone should book online." });
    assert.equal(r.status, 202, await r.clone().text());
    await until(() => model.calls.length >= 3 && !isSessionBusy(path), "the reply");
    const names = piSession(chat).getActiveToolNames();
    for (const t of ["bash", "write", "edit", "read_link"]) assert.ok(!names.includes(t), `the model has no ${t}`);
    assert.ok(names.includes("align"));
    // Their message is theirs, never the operator's.
    const msgs = (baton.batonById(sid)!.row.budget.messagesUsed);
    assert.equal(msgs, 1);
    const v = (await (await get(`/api/i/${token}/c/${handle}`)).json()) as { items: { kind: string; by?: string; plan?: { questions: { visual?: unknown }[] } }[]; feature?: { canWrite: boolean }; status: { kind: string } };
    assert.deepEqual(v.feature, { canWrite: true, canEnd: true });
    assert.equal(v.status.kind, "planning");
    assert.equal(v.items.find((i) => i.kind === "message")!.by, "you");
    const plans = v.items.filter((i) => i.kind === "plan");
    assert.equal(plans.length, 1);
    assert.deepEqual(plans[0]!.plan!.questions[0]!.visual, { kind: "html", source: "<button>Book</button>" });
    const text = JSON.stringify(v);
    for (const no of [TECH, "technical", "align", "scripted", "toolCall"]) assert.ok(!text.includes(no), `no ${no} on the owner page`);
    // Home: Waiting on you, answered here.
    const home = (await (await get(`/api/i/${token}`)).json()) as { waiting: { conversation: string; feature?: boolean }[]; requests: { title: string; plan?: string }[] };
    assert.deepEqual(home.waiting.map((w) => [w.conversation, w.feature]), [[handle, true]]);
    assert.equal(home.requests.find((x) => x.title === "Online booking")?.plan, "planning");
  });

  test("Hide From is refused; only the owner agrees the plan; another holder's turn refuses the owner's message", async () => {
    await assert.rejects(baton.setHiddenFromOwner(sid, true), (e: Error & { status?: number }) => e.status === 409 && /own: it can't be hidden/.test(e.message));
    await baton.takeBack(sid);
    assert.equal(fc.featureHolderRefusal(sid), "Only Alperen, who asked for this, can agree the plan: hand it back to them first.");
    await assert.rejects(baton.markDone(sid, "Done."), /Only Alperen, who asked for this, can agree the plan/);
    const r = await post(`/api/i/${token}/c/${handle}/message`, { text: "Me again." });
    assert.equal(r.status, 409);
    assert.equal(((await r.json()) as { code: string }).code, "not-holder");
    const v = (await (await get(`/api/i/${token}/c/${handle}`)).json()) as { feature?: { canWrite: boolean }; status: { kind: string } };
    assert.deepEqual([v.feature?.canWrite, v.status.kind], [false, "with-operator"]);
    // Another conversation's handle, or none: 404, as a handle that never existed.
    assert.equal((await post(`/api/i/${token}/c/k_abcdefgh/message`, { text: "x" })).status, 404);
  });

  test("t13: the owner changes to Kim: the chat ends, Kim's link can't see or write in it, Needs you tells the operator", async () => {
    await owner.setOwner(org.id, kim.id);
    await until(() => baton.batonById(sid)?.row.state === "closed", "the chat closed");
    await until(() => !!store.featureChats(org.id).find((r) => r.sessionId === sid)?.ended, "its record ended");
    const { token: kimToken } = plinks.mintOwnerLink(org.id, kim.id);
    const r = await post(`/api/i/${kimToken}/c/${handle}/message`, { text: "I'm the owner now." });
    assert.equal(r.status, 404, "not Kim's chat");
    assert.equal((await get(`/api/i/${kimToken}/c/${handle}`)).status, 404, "nor on Kim's page");
    const kimHome = (await (await get(`/api/i/${kimToken}`)).json()) as { waiting: unknown[]; projects: { conversations: number }[] };
    assert.deepEqual(kimHome.waiting, []);
    // Alperen's link is dead.
    assert.equal((await post(`/api/i/${token}/c/${handle}/message`, { text: "Still me." })).status, 410);
    const ended = ownerAttention().filter((i) => i.kind === "owner-feature-ended");
    assert.equal(ended.length, 1);
    assert.match(ended[0]!.detail ?? "", /Alperen Kaya's feature request chat on Archery website ended: they are no longer the owner\. Online booking/);
  });

  test("the agreed plan is its own Needs you item: an id the planning item's (told, put aside) never covers", async () => {
    const out = await startFeature("Gift vouchers");
    assert.equal(out.details.started, true, out.text);
    const kimSid = String(out.details.featureChat);
    const rid = store.featureChats(org.id).find((r) => r.sessionId === kimSid)!.requestId;
    const itemsOf = () => ownerAttention().filter((i) => i.org?.orgId === org.id && i.title === "Gift vouchers");
    const planning = itemsOf();
    assert.deepEqual(planning.map((i) => [i.id, i.kind]), [[`owner-request:${rid}`, "owner-request"]]);
    await baton.markDone(kimSid, "Agreed.");
    const agreed = itemsOf();
    assert.deepEqual(agreed.map((i) => i.id), [`owner-request:${rid}:agreed`]);
    assert.match(agreed[0]!.detail ?? "", /^Kim Lee agreed a plan on Archery website/);
    // The Overseer's brief remembers what it told by id and kind: told the planning item, the agreed one is still new.
    const { blockerKey } = await import("./attention");
    const { briefDecision } = await import("./overseer");
    const told = new Map([[blockerKey(planning[0]!), { count: 1 }]]);
    const d = briefDecision({ current: agreed.map(blockerKey), announced: told, proactivity: "brief", now: Date.now(), lastBriefAt: 0, unattended: 0, overseerIdle: true });
    assert.deepEqual(d.brief, [blockerKey(agreed[0]!)]);
  });

  test("a close that fails once, or a sweep lost to a restart: the chat still ends, and Needs you says so", async () => {
    // Kim's chat; the first close attempt throws.
    const out = await startFeature("Class reminders");
    assert.equal(out.details.started, true, out.text);
    const s2 = String(out.details.featureChat);
    let calls = 0;
    fc.setFeatureCloseForTest(async (...a) => {
      if (calls++ === 0) throw new Error("stand-in: the close failed");
      return baton.closeBaton(...a);
    });
    try {
      await owner.setOwner(org.id, alp.id);
      await until(() => calls >= 1, "the close attempt");
      const rec = () => store.featureChats(org.id).find((r) => r.sessionId === s2)!;
      assert.equal(rec().ended?.why, "owner-changed", "recorded as ended before the close");
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(baton.batonById(s2)!.row.state, "open", "the failed close left it open");
      // Alperen is the owner again. Found driving a real owner change: Kim's agreed plan still names Kim, never whoever is the owner now.
      const vouchers = ownerAttention().filter((i) => i.org?.orgId === org.id && i.title === "Gift vouchers");
      assert.deepEqual(vouchers.map((i) => i.detail), ["Kim Lee agreed a plan on Archery website: Gift vouchers"]);
      // The next Needs you scan: the item is there, and the sweep closes it.
      const rid = rec().requestId;
      assert.ok(ownerAttention().some((i) => i.kind === "owner-feature-ended" && i.id === `owner-feature-ended:${rid}`));
      await until(() => baton.batonById(s2)?.row.state === "closed", "closed by the next sweep");
      assert.equal(calls, 2);

      // Alperen's chat; the owner changes, and the restart comes before anything was written or closed.
      const out3 = await startFeature("Member cards");
      assert.equal(out3.details.started, true, out3.text);
      const s3 = String(out3.details.featureChat);
      let tried = 0;
      fc.setFeatureCloseForTest(async () => {
        tried++;
        throw new Error("stand-in: the server stopped");
      });
      await owner.setOwner(org.id, kim.id);
      await until(() => tried >= 1, "the close attempt");
      await new Promise((r) => setTimeout(r, 50));
      const lost = store.featureChats(org.id).find((r) => r.sessionId === s3)!;
      store.addFeatureChat(org.id, { sessionId: lost.sessionId, personId: lost.personId, projectId: lost.projectId, requestId: lost.requestId, at: lost.at });
      assert.equal(baton.batonById(s3)!.row.state, "open");
      fc.setFeatureCloseForTest(null);
      // What each org's start runs.
      assert.equal(await fc.endFormerOwnersChats(org.id), 1);
      assert.equal(baton.batonById(s3)!.row.state, "closed");
      assert.equal(store.featureChats(org.id).find((r) => r.sessionId === s3)?.ended?.why, "owner-changed");
      assert.ok(ownerAttention().some((i) => i.id === `owner-feature-ended:${lost.requestId}`));
    } finally {
      fc.setFeatureCloseForTest(null);
    }
  });
});
