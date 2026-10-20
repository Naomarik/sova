// Start Chat on an owner request (§app.project-assistant/request-chat, /requests, /requests-tab): the store's
// `linked` line, the route's refusals, the note written with no turn (stand-in start and note), the request
// following its chat's first operator message and its archive, Needs you's href, and the transcript card.
// A throwaway PI_CODING_AGENT_DIR and workspace in the OS temp dir, deleted after; no chat runs.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import { OWNER_REQUEST_NOTE, type OwnerRequestCard } from "../shared/project-assistant";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-owner-req-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const sessionsDir = join(root, "agent", "sessions", "--proj--");
mkdirSync(sessionsDir, { recursive: true });
const site = join(root, "site");
mkdirSync(site, { recursive: true });

const orgs = await import("./orgs");
const owner = await import("./owner");
const store = await import("./project-assistant-store");
const chat = await import("./owner-request-chat");
const { ownerAttention } = await import("./owner-attention");
const { registerAssistantRoutes } = await import("./project-assistant-routes");
const { setArchived } = await import("./archived-sessions");
const { rowsOfEntry } = await import("./transcript");
after(() => rmSync(root, { recursive: true, force: true }));

const org = await orgs.createOrg({ name: "Mamluk Arabia", dir: join(root, "ws") });
const omar = await orgs.addPerson(org.id, { name: "Omar Haddad", role: "Founder" });
await owner.setOwner(org.id, omar.id);
const proj = await orgs.addProject(org.id, { name: "Archery website", root: site });

let n = 0;
/** A session file on disk: its header, then each user message (`overseer`: marked as an Overseer's). */
function sessionFile(messages: { text: string; overseer?: boolean }[] = []): { id: string; path: string } {
  const id = `0198c0de-0000-7000-8000-${String(++n).padStart(12, "0")}`;
  const path = join(sessionsDir, `2026-10-20T00-00-0${n}-000Z_${id}.jsonl`);
  const at = "2026-10-20T00:00:00.000Z";
  const lines: object[] = [{ type: "session", version: 3, id, timestamp: at, cwd: site }];
  let parent: string | null = null;
  messages.forEach((m, i) => {
    const eid = `u${i}`;
    lines.push({ type: "message", id: eid, parentId: parent, timestamp: at, message: { role: "user", content: [{ type: "text", text: m.text }], timestamp: 0 } });
    parent = eid;
    if (m.overseer) {
      lines.push({ type: "custom", customType: "sova-overseer-sent", data: { v: 1, targetId: eid }, id: `m${i}`, parentId: parent, timestamp: at });
      parent = `m${i}`;
    }
  });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { id, path };
}
const addUser = (path: string, text: string) =>
  appendFileSync(path, `${JSON.stringify({ type: "message", id: `x${++n}`, parentId: null, timestamp: "2026-10-20T00:01:00.000Z", message: { role: "user", content: [{ type: "text", text }], timestamp: 0 } })}\n`);

const file = (kind: Parameters<typeof store.fileRequest>[1]["kind"], title = "The bow page is slow") => store.fileRequest(org.id, { projectId: proj.id, kind, title, text: "It takes ages to open." });

describe("the store's linked line", () => {
  test("linking changes no status: a started release stays started, a with-team one stays with the team", () => {
    const rel = file("deploy", "Release it");
    store.setRequestStatus(org.id, rel.id, "started");
    const s = sessionFile();
    const after = store.linkRequestChat(org.id, rel.id, s.id);
    assert.equal(after.status, "started");
    assert.deepEqual(after.linked?.sessionId, s.id);
    const bug = file("bug");
    assert.equal(store.linkRequestChat(org.id, bug.id, s.id).status, "with-team");
  });
  test("a line of a kind it doesn't know is skipped (an older reader's tolerance holds for newer lines)", () => {
    const r = file("question", "What is the price?");
    appendFileSync(join(orgs.orgDir(org.id), "projects", proj.id, "owner-requests.jsonl"), `${JSON.stringify({ kind: "someday", id: r.id, status: "done", at: new Date().toISOString() })}\n`);
    assert.equal(store.findRequest(org.id, r.id)?.status, "with-team");
  });
});

describe("Start Chat's route refuses", () => {
  const app = new Hono();
  registerAssistantRoutes(app);
  const post = async (rid: string) => {
    const res = await app.request(`/api/orgs/${org.id}/owner/requests/${rid}/chat`, { method: "POST" });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  test("an unknown request: 404", async () => {
    assert.equal((await post("or_nope")).status, 404);
  });
  test("a done or declined request: 409 closed", async () => {
    const r = file("feature", "Dark mode");
    store.setRequestStatus(org.id, r.id, "declined");
    const out = await post(r.id);
    assert.equal(out.status, 409);
    assert.equal(out.body.code, "closed");
  });
  test("a request whose chat is live: 409 has-chat with that chat; archived, it is no longer its chat", async () => {
    const r = file("bug", "Login fails");
    const s = sessionFile();
    store.linkRequestChat(org.id, r.id, s.id);
    const out = await post(r.id);
    assert.equal(out.status, 409);
    assert.equal(out.body.code, "has-chat");
    assert.equal(out.body.sessionId, s.id);
    assert.equal(out.body.path, s.path);
    const [withChat] = await chat.withChats([store.findRequest(org.id, r.id)!]);
    assert.equal(withChat?.chat?.path, s.path);
    assert.equal(withChat?.chat?.startedAt, store.findRequest(org.id, r.id)?.linked?.at);
    setArchived(s.id, true);
    const [gone] = await chat.withChats([store.findRequest(org.id, r.id)!]);
    assert.equal(gone?.chat, undefined, "an archived chat is no chat: Start Chat comes back");
  });
});

describe("Start Chat", () => {
  test("starts a project chat titled after the request, links it without a status change, and writes the request as a note", async () => {
    const r = file("bug", "Checkout button does nothing");
    const s = sessionFile();
    const starts: unknown[] = [];
    const notes: { path: string; type: string; text: string; card: OwnerRequestCard }[] = [];
    const out = await chat.startRequestChat(org.id, r.id, {
      start: async (projectId, body) => (starts.push({ projectId, ...body }), { path: s.path, sessionId: s.id }),
      note: async (path, type, text, card) => (notes.push({ path, type, text, card }), true),
    });
    assert.deepEqual(out, { sessionId: s.id, path: s.path });
    assert.deepEqual(starts, [{ projectId: proj.id, worktree: "later", title: "Checkout button does nothing" }]);
    const after = store.findRequest(org.id, r.id)!;
    assert.equal(after.status, "with-team", "Start Chat leaves it with the team");
    assert.equal(after.linked?.sessionId, s.id);
    assert.ok(ownerAttention().some((a) => a.id === `owner-request:${r.id}`), "still in Needs you");
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.type, OWNER_REQUEST_NOTE);
    assert.equal(notes[0]!.path, s.path);
    assert.match(notes[0]!.text, /^Request from Omar \(the organization's owner\) through the Project Assistant · Problem · Archery website · filed \d{4}-\d\d-\d\d · With the team\n\nCheckout button does nothing\n\nIt takes ages to open\.\n\nThe operator will say what to do with it\.$/);
    assert.deepEqual(notes[0]!.card, { orgId: org.id, requestId: r.id, kind: "bug", projectId: proj.id, project: "Archery website", title: "Checkout button does nothing", text: "It takes ages to open.", filedAt: r.createdAt, ownerName: "Omar Haddad" });
    await assert.rejects(chat.startRequestChat(org.id, r.id, { start: async () => assert.fail("one chat per request"), note: async () => true }), (e: { status?: number; code?: string }) => e.status === 409 && e.code === "has-chat");
  });
});

describe("the request follows its chat", () => {
  test("the operator's first message makes it started; an Overseer's doesn't; archiving puts it back with the team and in Needs you", async () => {
    const r = file("bug", "Images are blurry");
    const s = sessionFile();
    store.linkRequestChat(org.id, r.id, s.id);
    const ref = { orgId: org.id, rid: r.id };
    assert.equal(await chat.noteRequestChatTurn(s.path, ref), false, "no message yet");
    assert.equal(store.findRequest(org.id, r.id)?.status, "with-team");
    // An Overseer's message is not the operator's.
    const o = sessionFile([{ text: "From the Overseer", overseer: true }]);
    const r2 = file("bug", "Overseer case");
    store.linkRequestChat(org.id, r2.id, o.id);
    assert.equal(await chat.noteRequestChatTurn(o.path, { orgId: org.id, rid: r2.id }), false);
    assert.equal(store.findRequest(org.id, r2.id)?.status, "with-team");

    addUser(s.path, "Please look into it");
    assert.equal(await chat.noteRequestChatTurn(s.path, ref), true);
    const started = store.findRequest(org.id, r.id)!;
    assert.equal(started.status, "started");
    assert.equal(started.sessionId, s.id);
    assert.ok(!ownerAttention().some((a) => a.id === `owner-request:${r.id}`), "being worked on: out of Needs you");
    assert.equal(await chat.noteRequestChatTurn(s.path, ref), false, "safe to run twice: it writes once");

    setArchived(s.id, true);
    assert.equal(chat.noteRequestChatArchived(s.id, ref), true);
    assert.equal(store.findRequest(org.id, r.id)?.status, "with-team");
    const item = ownerAttention().find((a) => a.id === `owner-request:${r.id}`);
    assert.ok(item, "back in Needs you");
    assert.equal(item.href, `#/orgs/${encodeURIComponent(org.id)}/requests/${encodeURIComponent(r.id)}`);
  });
  test("a done or declined request stays as the operator set it when its chat is archived", () => {
    const r = file("fix", "Typo on home");
    const s = sessionFile();
    store.linkRequestChat(org.id, r.id, s.id);
    store.setRequestStatus(org.id, r.id, "done");
    assert.equal(chat.noteRequestChatArchived(s.id, { orgId: org.id, rid: r.id }), false);
    assert.equal(store.findRequest(org.id, r.id)?.status, "done");
  });
  test("after a restart: the index is rebuilt from the store, so a first message sent then still counts", async () => {
    const r = file("bug", "Restart case");
    const s = sessionFile();
    store.linkRequestChat(org.id, r.id, s.id);
    chat.resetRequestChatsForTests(null);
    chat.wireRequestChats(); // the boot's wiring: the index from the store
    addUser(s.path, "Go");
    assert.equal(await chat.noteRequestChatTurn(s.path), true, "found through the rebuilt index");
    assert.equal(store.findRequest(org.id, r.id)?.status, "started");
  });
});

describe("review checks", () => {
  test("B1: a fix's own session is not the request's chat: archiving it changes nothing, after a restart either", async () => {
    chat.resetRequestChatsForTests(null);
    await chat.wireRequestChats();
    const r = file("fix", "Fix the cart");
    store.setRequestStatus(org.id, r.id, "started", { sessionId: "s_fix" });
    setArchived("s_fix", true);
    const before = store.findRequest(org.id, r.id)?.status;
    assert.equal(before, "started");
    chat.resetRequestChatsForTests(null);
    await chat.wireRequestChats(); // the restart's catch-up
    assert.equal(store.findRequest(org.id, r.id)?.status, before, "a fix chat keeps today's behaviour");
    assert.equal(chat.noteRequestChatArchived("s_fix", { orgId: org.id, rid: r.id }), false);
  });
  test("B2: a note that isn't written: an error, nothing linked, the new chat archived", async () => {
    const r = file("bug", "Note fails");
    const s = sessionFile();
    const archived: string[] = [];
    await assert.rejects(
      chat.startRequestChat(org.id, r.id, { start: async () => ({ path: s.path, sessionId: s.id }), note: async () => false, archive: async (path: string) => void archived.push(path) }),
      (e: { message?: string }) => e.message === "Couldn't start the chat. Try again.",
    );
    assert.equal(store.findRequest(org.id, r.id)?.linked, undefined, "nothing linked: Start Chat stays available");
    assert.deepEqual(archived, [s.path]);
    await assert.rejects(chat.startRequestChat(org.id, r.id, { start: async () => ({ path: s.path, sessionId: s.id }), note: async () => { throw new Error("chat gone"); }, archive: async () => {} }), /Couldn't start the chat/);
    assert.equal(store.findRequest(org.id, r.id)?.linked, undefined);
  });
});

describe("the org's counts", () => {
  test("OrgDetail carries the Requests tab's counts, and needsYou.requests the requests with the team", async () => {
    const { orgPage } = await import("./org-routes");
    const all = store.orgRequests(org.id);
    const d = await orgPage(org.id);
    const withTeam = all.filter((r) => r.status === "with-team").length;
    assert.ok(withTeam > 0 && all.some((r) => r.status === "started") && all.some((r) => r.status === "done"), "the fixture has every kind");
    assert.deepEqual(d.ownerRequests, { open: withTeam + all.filter((r) => r.status === "started").length, withTeam, total: all.length });
    assert.equal(d.needsYou?.requests, withTeam);
    assert.equal(d.needsYou?.requests, ownerAttention().filter((a) => a.id.startsWith("owner-request:") || a.kind === "owner-outage").length, "the same items Needs you raises");
  });
});

describe("the transcript card", () => {
  test("a request note is an info row with its card; details that don't read fall back to the plain row", () => {
    const card: OwnerRequestCard = { orgId: "o1", requestId: "or_1", kind: "outage", projectId: "p1", project: "Site", title: "Down", text: "All down", filedAt: "2026-10-20T00:00:00.000Z", ownerName: "Omar Haddad" };
    const base = { id: "n1", parentId: null, kind: "note" as const, noteType: OWNER_REQUEST_NOTE, content: "Request from Omar …", display: true, inMessage: false };
    const [row] = rowsOfEntry({ ...base, details: card } as never);
    assert.equal(row?.kind, "info");
    assert.deepEqual(row?.ownerRequest, card);
    assert.equal(row?.text, "Request from Omar …");
    const [plain] = rowsOfEntry({ ...base, details: { kind: "nope" } } as never);
    assert.equal(plain?.ownerRequest, undefined);
    assert.equal(plain?.text, "Request from Omar …");
  });
});

