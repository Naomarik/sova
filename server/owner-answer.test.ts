// The owner answers on their page (§app.owner-page/content, Answering on the page; §app.baton/links): POST
// /api/i/<token>/c/<k_handle>/message takes the owner's message only while the conversation waits on them (they hold
// its current hand-off, an open offer reached them, or they hold its lease), as a hand-off link's message is taken:
// counted as their own, under the same lock and message limit; refused otherwise, counting nothing. The view says
// `canAnswer` exactly then. In-process chats with a stand-in SDK; a throwaway PI_CODING_AGENT_DIR; no model is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { piSession } from "./harness/pi/testing/handle";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-owner-answer-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
delete process.env.SOVA_SHARE_PUBLIC_URL;
mkdirSync(join(root, "agent", "sessions", "live"), { recursive: true });

await import("./testing/in-process-chats");
const orgs = await import("./orgs");
const owner = await import("./owner");
const plinks = await import("./person-links");
const baton = await import("./baton");
const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { createShareApp } = await import("./share/routes");
const { replyEnded } = await import("./org-test-fixtures");

after(async () => {
  await disposeAllChats();
  rmSync(root, { recursive: true, force: true });
});

const org = await orgs.createOrg({ name: "Answer Co", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
const alp = await orgs.addPerson(org.id, { name: "Alperen Kaya", role: "Founder" });
const kim = await orgs.addPerson(org.id, { name: "Kim Lee", role: "Coach" });
await owner.setOwner(org.id, alp.id);
const { token } = plinks.mintOwnerLink(org.id, alp.id);
const start = (to: string | string[], extra: Record<string, unknown> = {}) => baton.createBaton({ orgId: org.id, projectId: project.id, to, publicTitle: "Opening hours", goal: "Find the hours", ...extra });
const rowOf = (sid: string) => baton.batonById(sid)!.row;
const share = createShareApp();
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1";
const answer = (sid: string, text: string) =>
  share.request(`/api/i/${token}/c/${plinks.handleOf("k", sid)}/message`, { method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, body: JSON.stringify({ text }) });
const view = async (sid: string) => (await (await share.request(`/api/i/${token}/c/${plinks.handleOf("k", sid)}`, { headers: { "user-agent": UA } })).json()) as { canAnswer?: true; yourTurn: boolean };
const codeOf = async (r: Response) => ((await r.json()) as { code?: string }).code;

const until = async (ready: () => boolean, ms = 10_000) => {
  for (const t0 = Date.now(); !ready() && Date.now() - t0 < ms; ) await new Promise((r) => setTimeout(r, 10));
  return ready();
};

/** The SDK's prompt() as far as this path cares (as server/share-message.test.ts's). */
function fakeSdk(chat: Awaited<ReturnType<typeof acquireChat>>): string[] {
  const s = piSession(chat) as unknown as { _isAgentRunActive: boolean; prompt: unknown };
  const got: string[] = [];
  s.prompt = async (text: string) => {
    await new Promise((r) => setTimeout(r, 5));
    s._isAgentRunActive = true;
    got.push(text);
    await new Promise((r) => setTimeout(r, 20));
    s._isAgentRunActive = false;
  };
  return got;
}

describe("the owner answers on their page", () => {
  test("a conversation they hold: their message is taken as theirs and counted once; the view offers the box", async () => {
    const c = await start(alp.id);
    const got = fakeSdk(await acquireChat(c.path));
    assert.equal((await view(c.sessionId)).canAnswer, true);
    const r = await answer(c.sessionId, "We open at 9.");
    assert.equal(r.status, 202, await r.clone().text());
    assert.ok(await until(() => got.length === 1), "the message reached the chat");
    assert.equal(got[0], "We open at 9.");
    assert.equal(rowOf(c.sessionId).budget.messagesUsed, 1);
    assert.ok(rowOf(c.sessionId).participants.includes(alp.id) || rowOf(c.sessionId).wroteAt, "it counts as the owner's own message");
  });

  test("a conversation someone else holds: 409 not-holder, nothing counted, no box", async () => {
    const c = await start(kim.id);
    fakeSdk(await acquireChat(c.path));
    assert.equal((await view(c.sessionId)).canAnswer, undefined);
    const r = await answer(c.sessionId, "Let me answer instead.");
    assert.equal(r.status, 409);
    assert.equal(await codeOf(r), "not-holder");
    assert.equal(rowOf(c.sessionId).budget.messagesUsed, 0);
  });

  test("an open offer that reached the owner: their message claims it; once someone else holds it, 409 taken", async () => {
    const mine = await start([alp.id, kim.id]);
    fakeSdk(await acquireChat(mine.path));
    assert.equal((await view(mine.sessionId)).canAnswer, true);
    assert.equal((await answer(mine.sessionId, "I'll take this one.")).status, 202);
    assert.equal(rowOf(mine.sessionId).holder, alp.id, "the owner holds the offer's lease now");

    const theirs = await start([alp.id, kim.id]);
    fakeSdk(await acquireChat(theirs.path));
    const kimLink = theirs.links!.find((l) => l.personId === kim.id)!.token;
    const k = await share.request(`/api/h/${kimLink}/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Mine." }) });
    assert.equal(k.status, 202);
    assert.equal((await view(theirs.sessionId)).canAnswer, undefined);
    const r = await answer(theirs.sessionId, "Me too.");
    assert.equal(r.status, 409);
    assert.equal(await codeOf(r), "taken");
  });

  test("at the message limit: 409 budget; done: 409 closed; hidden from the owner: 404", async () => {
    const limited = await start(alp.id, { messagesMax: 1 });
    const got = fakeSdk(await acquireChat(limited.path));
    assert.equal((await answer(limited.sessionId, "one")).status, 202);
    await until(() => got.length === 1);
    await replyEnded(limited.sessionId);
    const r = await answer(limited.sessionId, "two");
    assert.equal(r.status, 409);
    assert.equal(await codeOf(r), "budget");
    assert.equal(rowOf(limited.sessionId).budget.messagesUsed, 1, "the refused message is not counted");

    const done = await start(alp.id);
    await baton.markDone(done.sessionId, "Sorted.");
    const d = await answer(done.sessionId, "late");
    assert.equal(d.status, 409);
    assert.equal(await codeOf(d), "closed");

    const hidden = await start(alp.id);
    await baton.setHiddenFromOwner(hidden.sessionId, true);
    const h = await answer(hidden.sessionId, "hello");
    assert.equal(h.status, 404, "a hidden conversation answers as one that never existed");
  });

  test("text only, at most 4,000 characters, never starting with /", async () => {
    const c = await start(alp.id);
    fakeSdk(await acquireChat(c.path));
    assert.equal((await answer(c.sessionId, "x".repeat(4001))).status, 413);
    assert.equal((await answer(c.sessionId, "/close")).status, 400);
    const extra = await share.request(`/api/i/${token}/c/${plinks.handleOf("k", c.sessionId)}/message`, { method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, body: JSON.stringify({ text: "hi", images: ["x"] }) });
    assert.equal(extra.status, 400, "no photos or files through the page");
    assert.equal(rowOf(c.sessionId).budget.messagesUsed, 0);
  });
});
