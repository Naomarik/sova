// The owner closes and reopens their own requests (§app.project-assistant/closing, /requests, /request-chat,
// /requests-tab): the store's closed and noted lines, nothing on the team's side moving a closed request, reopen
// restoring where it really stands, Start Chat refused on an owner-closed request, the owner page's route by its
// handle, a closed feature request ending its chat, a held fix's start cancelled, the note in the team's chat, and
// Needs you (quiet, except one closed while being worked on until Got It). Stand-ins for the engine, the chat and
// the note; a throwaway PI_CODING_AGENT_DIR and workspace in the OS temp dir, deleted after; no chat runs.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import { Hono } from "hono";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-owner-close-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const sessionsDir = join(root, "agent", "sessions", "--proj--");
mkdirSync(sessionsDir, { recursive: true });
const site = join(root, "site");
mkdirSync(site, { recursive: true });

const orgs = await import("./orgs");
const owner = await import("./owner");
const plinks = await import("./person-links");
const store = await import("./project-assistant-store");
const chat = await import("./owner-request-chat");
const close = await import("./owner-request-close");
const { ownerAttention } = await import("./owner-attention");
const { registerAssistantRoutes } = await import("./project-assistant-routes");
const { setArchived } = await import("./archived-sessions");
const { createShareApp } = await import("./share/routes");
const { ownerView } = await import("./owner-page");
after(() => rmSync(root, { recursive: true, force: true }));

const org = await orgs.createOrg({ name: "Mamluk Arabia", dir: join(root, "ws") });
const omar = await orgs.addPerson(org.id, { name: "Omar Haddad", role: "Founder" });
await owner.setOwner(org.id, omar.id);
const proj = await orgs.addProject(org.id, { name: "Archery website", root: site });
const byOwner = { kind: "owner" as const, personId: omar.id };

let n = 0;
/** A session file on disk with the given user messages. */
function sessionFile(messages: string[] = []): { id: string; path: string } {
  const id = `0198c0de-0000-7000-8000-${String(++n).padStart(12, "0")}`;
  const path = join(sessionsDir, `2026-10-24T00-00-0${n}-000Z_${id}.jsonl`);
  const at = "2026-10-24T00:00:00.000Z";
  const lines: object[] = [{ type: "session", version: 3, id, timestamp: at, cwd: site }];
  let parent: string | null = null;
  messages.forEach((text, i) => {
    lines.push({ type: "message", id: `u${i}`, parentId: parent, timestamp: at, message: { role: "user", content: [{ type: "text", text }], timestamp: 0 } });
    parent = `u${i}`;
  });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { id, path };
}
const file = (kind: Parameters<typeof store.fileRequest>[1]["kind"], title = "The bow page is slow") => store.fileRequest(org.id, { projectId: proj.id, kind, title, text: "It takes ages to open." });

/** What closing set off, recorded by the stand-ins. */
const calls: { cancelled: string[]; ended: string[]; notes: { path: string; type: string; text: string }[] } = { cancelled: [], ended: [], notes: [] };
beforeEach(() => {
  calls.cancelled = [];
  calls.ended = [];
  calls.notes = [];
  close.setCloseDepsForTest({
    cancelHeldStart: async (_p, rid) => {
      calls.cancelled.push(rid);
      return 1;
    },
    endFeatureChat: async (_o, sid) => void calls.ended.push(sid),
    note: async (path, type, text) => {
      calls.notes.push({ path, type, text });
      return true;
    },
  });
});
after(() => close.setCloseDepsForTest(null));

describe("the store", () => {
  test("a closed line folds to closed with who and the prior status; a reopen line clears it; an older reader's lines stay readable", () => {
    const r = file("bug");
    store.setRequestStatus(org.id, r.id, "started");
    const c = store.closeRequestLine(org.id, r.id, byOwner);
    assert.equal(c.status, "closed");
    assert.deepEqual([c.closed?.by, c.closed?.prior, c.closed?.noted], [byOwner, "started", undefined]);
    assert.throws(() => store.closeRequestLine(org.id, r.id, byOwner), (e: { code?: string }) => e.code === "closed");
    const back = store.reopenRequestLine(org.id, r.id, byOwner, "with-team");
    assert.deepEqual([back.status, back.closed], ["with-team", undefined]);
  });
  test("a close line with no one behind it is no close", () => {
    const r = file("question");
    appendFileSync(join(orgs.orgDir(org.id), "projects", proj.id, "owner-requests.jsonl"), `${JSON.stringify({ kind: "status", id: r.id, status: "closed", at: new Date().toISOString() })}\n`);
    assert.equal(store.findRequest(org.id, r.id)?.status, "with-team");
  });
  test("reopen takes only a request the owner closed: done and declined are the team's", () => {
    const r = file("bug");
    store.setRequestStatus(org.id, r.id, "done");
    assert.throws(() => store.reopenRequestLine(org.id, r.id, byOwner, "with-team"), (e: { code?: string }) => e.code === "not-yours");
  });
  test("nothing on the team's side moves a closed request: a fix starting (onOwnerFixStarted's write) leaves it closed", () => {
    const r = file("fix", "Fix the bow page");
    store.closeRequestLine(org.id, r.id, byOwner);
    assert.equal(store.advanceRequest(org.id, r.id, "started", { sessionId: "s-fix" }), null);
    const after = store.findRequest(org.id, r.id)!;
    assert.deepEqual([after.status, after.sessionId], ["closed", undefined]);
    // Done and declined are closed too: no automatic writer moves them either.
    const d = file("bug");
    store.setRequestStatus(org.id, d.id, "declined");
    assert.equal(store.advanceRequest(org.id, d.id, "started"), null);
    assert.equal(store.findRequest(org.id, d.id)?.status, "declined");
  });
});

describe("closing sets off what it should, and only that", () => {
  test("a fix still waiting to start has its held start cancelled; one already started goes on", async () => {
    const held = file("fix", "Fix the arrows");
    await close.closeOwnerRequests(org.id, [held.id], byOwner);
    const started = file("fix", "Fix the quiver");
    store.setRequestStatus(org.id, started.id, "started", { sessionId: "s-quiver" });
    await close.closeOwnerRequests(org.id, [started.id], byOwner);
    assert.deepEqual(calls.cancelled, [held.id]);
  });
  test("a feature request's open planning chat ends with it; an ended one is left alone", async () => {
    const r = file("feature", "A gift card page");
    store.addFeatureChat(org.id, { sessionId: "feat-open", personId: omar.id, projectId: proj.id, requestId: r.id, at: new Date().toISOString() });
    store.addFeatureChat(org.id, { sessionId: "feat-ended", personId: omar.id, projectId: proj.id, requestId: r.id, at: new Date().toISOString(), ended: { at: new Date().toISOString(), why: "left" } });
    await close.closeOwnerRequests(org.id, [r.id], byOwner);
    assert.deepEqual(calls.ended, ["feat-open"]);
    assert.deepEqual(calls.notes, [], "a planning chat is the owner's own, not the team's: no note");
  });
  test("the team's chat on it gets a note that starts no turn, in the owner's first name and how it was closed", async () => {
    const r = file("bug", "Prices are wrong");
    const s = sessionFile();
    store.linkRequestChat(org.id, r.id, s.id);
    await close.closeOwnerRequests(org.id, [r.id], { kind: "assistant", personId: omar.id });
    assert.deepEqual(calls.notes, [{ path: s.path, type: close.OWNER_REQUEST_CLOSED_NOTE, text: "Omar closed this request through their Project Assistant. The team can stop on it." }]);
  });
  test("several at once; one already closed refuses the whole call and closes none", async () => {
    const a = file("bug", "A");
    const b = file("bug", "B");
    const done = file("bug", "C");
    store.setRequestStatus(org.id, done.id, "done");
    await assert.rejects(() => close.closeOwnerRequests(org.id, [a.id, done.id], byOwner), (e: { code?: string }) => e.code === "closed");
    assert.equal(store.findRequest(org.id, a.id)?.status, "with-team");
    const out = await close.closeOwnerRequests(org.id, [a.id, b.id], byOwner);
    assert.deepEqual(out.map((x) => x.status), ["closed", "closed"]);
  });
});

describe("the team's side: Start Chat, the chat's tracking, reopen", () => {
  const app = new Hono();
  registerAssistantRoutes(app);
  const post = (rid: string, body?: unknown) => app.request(`/api/orgs/${org.id}/owner/requests/${rid}${body === undefined ? "/chat" : ""}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });

  test("Start Chat on an owner-closed request answers 409 closed", async () => {
    const r = file("bug", "Closed before any chat");
    await close.closeOwnerRequests(org.id, [r.id], byOwner);
    const res = await post(r.id);
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code?: string }).code, "closed");
  });
  test("start chat → close → archive → reopen reads with-team; the chat's turn and its archive never moved it while closed", async () => {
    const r = file("bug", "The cart is empty");
    const s = sessionFile();
    store.linkRequestChat(org.id, r.id, s.id);
    chat.resetRequestChatsForTests(new Map([[s.id, { orgId: org.id, rid: r.id }]]));
    appendFileSync(s.path, `${JSON.stringify({ type: "message", id: "x1", parentId: null, timestamp: "2026-10-24T00:01:00.000Z", message: { role: "user", content: [{ type: "text", text: "Look at it" }], timestamp: 0 } })}\n`);
    assert.equal(await chat.noteRequestChatTurn(s.path), true);
    assert.equal(store.findRequest(org.id, r.id)?.status, "started");
    await close.closeOwnerRequests(org.id, [r.id], byOwner);
    assert.equal(await chat.noteRequestChatTurn(s.path), false, "a turn never restarts a closed request");
    setArchived(s.id, true);
    assert.equal(chat.noteRequestChatArchived(s.id), false, "its archive never moves a closed request");
    assert.equal(store.findRequest(org.id, r.id)?.status, "closed");
    const back = await close.reopenOwnerRequest(org.id, r.id, byOwner);
    assert.equal(back.status, "with-team", "its chat is archived: back with the team");
    chat.resetRequestChatsForTests(null);
  });
  test("reopen while its chat lives, closed while started: started again", async () => {
    const r = file("bug", "Slow checkout");
    const s = sessionFile(["Look at it"]);
    store.linkRequestChat(org.id, r.id, s.id);
    store.setRequestStatus(org.id, r.id, "started", { sessionId: s.id });
    await close.closeOwnerRequests(org.id, [r.id], byOwner);
    assert.equal((await close.reopenOwnerRequest(org.id, r.id, byOwner)).status, "started");
  });
  test("Needs you: closing leaves quietly; one closed while being worked on is one item until Got It", async () => {
    const quiet = file("outage", "The app is down");
    const worked = file("bug", "Wrong totals");
    store.setRequestStatus(org.id, worked.id, "started");
    await close.closeOwnerRequests(org.id, [quiet.id, worked.id], byOwner);
    const items = ownerAttention().filter((i) => i.id.includes(quiet.id) || i.id.includes(worked.id));
    assert.deepEqual(items.map((i) => [i.kind, i.detail]), [["owner-request-closed", "Omar Haddad closed a request the team was working on, on Archery website: Wrong totals"]]);
    assert.equal(items[0]!.href, `#/orgs/${org.id}/requests/${worked.id}`);
    const res = await post(worked.id, { noted: true });
    assert.equal(res.status, 200, await res.text());
    assert.equal(ownerAttention().filter((i) => i.id.includes(worked.id)).length, 0);
    // Got It is only for a request the owner closed.
    assert.equal((await post(file("bug").id, { noted: true })).status, 409);
  });
});

describe("the owner page's route (share listener)", () => {
  const share = createShareApp();
  const { token } = plinks.mintOwnerLink(org.id, omar.id);
  const act = (handle: string, body: unknown) => share.request(`/api/i/${token}/requests/${handle}`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0" }, body: JSON.stringify(body) });

  test("close and reopen by the row's handle; the home rows say who closed it; anything else is a 404 or a refusal", async () => {
    const r = file("bug", "A typo on the home page");
    const handle = plinks.handleOf("r", r.id);
    assert.equal((await act(handle, { action: "close" })).status, 202);
    const home = (await ownerView(org.id)) as import("../shared/owner").OwnerHome;
    const row = home.requests!.find((x) => x.handle === handle)!;
    assert.deepEqual([row.status, row.closedBy], ["closed", "you"]);
    assert.equal((await act(handle, { action: "close" })).status, 409, "already closed");
    assert.equal((await act(handle, { action: "reopen" })).status, 202);
    assert.equal(store.findRequest(org.id, r.id)?.status, "with-team");
    assert.equal((await act(plinks.handleOf("r", "or_nothere"), { action: "close" })).status, 404);
    assert.equal((await act(r.id, { action: "close" })).status, 404, "a request id is no handle");
    assert.equal((await act(handle, { action: "delete" })).status, 400);
    assert.equal((await act(handle, { action: "close", extra: 1 })).status, 400);
    const done = file("bug", "Done by the team");
    store.setRequestStatus(org.id, done.id, "done");
    const refused = await act(plinks.handleOf("r", done.id), { action: "reopen" });
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { code?: string }).code, "not-yours");
  });
  test("a request of a project switched off the owner's page is not found", async () => {
    const hiddenRoot = join(root, "hidden");
    mkdirSync(hiddenRoot, { recursive: true });
    const hidden = await orgs.addProject(org.id, { name: "Back office", root: hiddenRoot });
    const r = store.fileRequest(org.id, { projectId: hidden.id, kind: "bug", title: "Hidden one", text: "x" });
    await orgs.patchPlacement(org.id, hidden.id, { ownerHidden: true });
    assert.equal((await act(plinks.handleOf("r", r.id), { action: "close" })).status, 404);
  });
});
