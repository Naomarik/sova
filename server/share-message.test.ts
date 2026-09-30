// Run: pnpm exec tsx --test server/share-message.test.ts. The share message path end to end, and the
// share listener's hardening: a throwaway PI_CODING_AGENT_DIR and workspace in the OS temp dir, the
// share server on an ephemeral loopback port; ~/.pi untouched. No model is called: `session.prompt`
// is replaced by a stand-in that behaves like the SDK's around the start of a run (it awaits its
// input handlers before the run is active, and refuses a second prompt once one is).
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import WebSocket from "ws";
import { BATON_HANDOFF_ENTRY, BATON_SENT_ENTRY, MESSAGES_CAP, MESSAGES_DEFAULT, OPERATOR, PHOTO_DEFAULTS, type BatonViewItem } from "../shared/baton";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-share-msg-")));
// A hosted runtime can still write here after after() ran (pi's catalogs, usage cache): exit is last.
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
delete process.env.SOVA_SHARE_PUBLIC_URL;
mkdirSync(join(root, "agent", "sessions", "live"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const links = await import("./baton-links");
const settings = await import("./baton-settings");
const { LIMIT_QUESTION } = await import("./baton-loadout");
const { acquireChat, BusyError, disposeAllChats } = await import("./chat-manager");
const { createShareApp, tokenLimited, tokenWindowSize } = await import("./share/routes");
const { createShareServer } = await import("./share/listener");
const { opaqueSenders, sweepWatchers, viewForToken } = await import("./share/hub");
const { registerOrgRoutes } = await import("./org-routes");
const { LINK_WARNINGS } = await import("../shared/public-links");
const publicLinks = await import("./public-links");
const linksEvents = await import("./share/links-events");
const { replyEnded } = await import("./org-test-fixtures");

after(async () => {
  await disposeAllChats();
  rmSync(root, { recursive: true, force: true });
});

const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
const tony = await orgs.addPerson(org.id, { name: "Tony Reyes", role: "IT" });
const maria = await orgs.addPerson(org.id, { name: "Maria Lopez", role: "Payroll" });
const start = (to: string | string[], extra: Record<string, unknown> = {}) => baton.createBaton({ orgId: org.id, projectId: project.id, to, publicTitle: "Hosting", goal: "Find the server", ...extra });
const rowOf = (sid: string) => baton.batonById(sid)!.row;

const share = createShareApp();
const post = (token: string, text: string) =>
  share.request(`/api/h/${token}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });

const until = async (ready: () => boolean, ms = 2000) => {
  for (const t0 = Date.now(); !ready() && Date.now() - t0 < ms; ) await new Promise((r) => setTimeout(r, 10));
  return ready();
};

/** The SDK's prompt() as far as this path cares: input handlers first (a macrotask), then the run
    becomes active — a prompt that finds a run active without a streamingBehavior is refused. */
function fakeSdk(chat: Awaited<ReturnType<typeof acquireChat>>): string[] {
  const s = chat.session as unknown as { _isAgentRunActive: boolean; prompt: unknown };
  const got: string[] = [];
  s.prompt = async (text: string, opts?: { streamingBehavior?: string }) => {
    await new Promise((r) => setTimeout(r, 5));
    if (s._isAgentRunActive) {
      if (!opts?.streamingBehavior) throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
      got.push(text);
      return;
    }
    s._isAgentRunActive = true;
    got.push(text);
    await new Promise((r) => setTimeout(r, 20));
    s._isAgentRunActive = false;
  };
  return got;
}

describe("the share message route", () => {
  test("several messages at once to a chat whose run hasn't started: every accepted one enters, and only those count", async () => {
    const c = await start(tony.id);
    const got = fakeSdk(await acquireChat(c.path));
    const res = await Promise.all(["COLD_A", "COLD_B", "COLD_C"].map((t) => post(c.token!, t)));
    assert.deepEqual(
      res.map((r) => r.status),
      [202, 202, 202],
    );
    assert.ok(await until(() => got.length === 3), `entered: ${JSON.stringify(got)}`);
    assert.deepEqual([...got].sort(), ["COLD_A", "COLD_B", "COLD_C"]);
    assert.equal(rowOf(c.sessionId).budget.messagesUsed, 3);
  });

  test("a model the runtime refuses: 503, nothing counted, the offer not claimed", async () => {
    const c = await start([tony.id, maria.id]);
    const chat = await acquireChat(c.path);
    fakeSdk(chat);
    const tok = (id: string) => c.links!.find((l) => l.personId === id)!.token;
    const allowed = chat.assertModelAllowed.bind(chat);
    chat.assertModelAllowed = () => {
      throw new Error("That model is turned off in Settings → Models.");
    };
    const res = await post(tok(tony.id), "hello");
    chat.assertModelAllowed = allowed;
    assert.equal(res.status, 503);
    const row = rowOf(c.sessionId);
    assert.equal(row.budget.messagesUsed, 0);
    assert.equal(row.holder, null);
    assert.equal(row.offers![0]!.state, "open");
    assert.equal((await post(tok(maria.id), "me then")).status, 202, "another invitee is not locked out");
    assert.equal(rowOf(c.sessionId).holder, maria.id);
  });

  test("a runtime refusal at the hand-over (a foreign write): 503, and the count and the claim are undone", async () => {
    const c = await start([tony.id, maria.id]);
    const chat = await acquireChat(c.path);
    fakeSdk(chat);
    const before = rowOf(c.sessionId);
    const guard = chat.assertNoForeignWrites.bind(chat);
    chat.assertNoForeignWrites = () => {
      throw new BusyError("Someone else wrote this session.", "recent");
    };
    const res = await post(c.links![0]!.token, "hello");
    chat.assertNoForeignWrites = guard;
    assert.equal(res.status, 503);
    assert.deepEqual(rowOf(c.sessionId), before, "the row is exactly as before");
  });

  test("at the limit the baton goes to the operator and the session needs them", async () => {
    const c = await start(tony.id, { messagesMax: 1 });
    const chat = await acquireChat(c.path);
    const got = fakeSdk(chat);
    assert.equal((await post(c.token!, "one")).status, 202);
    await until(() => got.length === 1 && !chat.session.isStreaming);
    // The reply to the last allowed message ends (this fake SDK emits no run events): the stop moves then.
    await replyEnded(c.sessionId);
    const res = await post(c.token!, "two");
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { code: string }).code, "budget");
    assert.ok(await until(() => rowOf(c.sessionId).holder === OPERATOR), `holder ${rowOf(c.sessionId).holder}`);
    const row = rowOf(c.sessionId);
    assert.equal(row.state, "needs-you");
    assert.equal(row.budget.messagesUsed, 1, "the refused message is not counted");
    const later = await post(c.token!, "three");
    assert.equal(((await later.json()) as { code: string }).code, "budget", "the page keeps saying why");
    assert.equal(baton.batonSummaryField(c.path)!.needsYou?.question, LIMIT_QUESTION);
    const handoffs = readFileSync(c.path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((e) => e.customType === BATON_HANDOFF_ENTRY);
    assert.equal(handoffs.at(-1)?.data.to, OPERATOR, "the transcript records the move");
  });

  test("at the limit nobody but the operator can be handed it; the operator is told to extend; Extend lets them write", async () => {
    const c = await start(OPERATOR, { messagesMax: 1 });
    const chat = await acquireChat(c.path);
    fakeSdk(chat);
    chat.specialEntry!.clientSend!(c.path, { images: 0, text: "" });
    await assert.rejects(baton.handTo(c.sessionId, tony.id, "q", ""), /message limit/);
    await assert.rejects(baton.offerTo(c.sessionId, [tony.id, maria.id], "q", ""), /message limit/);
    assert.throws(() => chat.specialEntry!.clientSend!(c.path, { images: 0, text: "" }), /Extend it to write/);
    await assert.rejects(baton.extendBudget(c.sessionId, 0), /from 1 to/);
    await assert.rejects(baton.extendBudget(c.sessionId, 2.5), /whole number/);
    await assert.rejects(baton.extendBudget(c.sessionId, MESSAGES_CAP), (e: { status?: number; message: string }) => /at most/.test(e.message) && e.status === 400);
    assert.equal((await baton.extendBudget(c.sessionId, 5)).budget.messagesMax, 6);
    assert.equal(chat.specialEntry!.clientSend!(c.path, { images: 0, text: "" }).by, OPERATOR);
    await baton.closeBaton(c.sessionId);
    await assert.rejects(baton.extendBudget(c.sessionId, 5), /closed/);
  });

  test("Extend past the cap is a 400 on the route, like any bad `by`", async () => {
    const c = await start(tony.id, { messagesMax: 1 });
    const app = new Hono();
    registerOrgRoutes(app);
    const extend = (by: number) => app.request(`/api/baton/${c.sessionId}/extend`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ by }) });
    assert.equal((await extend(MESSAGES_CAP - 1)).status, 200);
    assert.equal(rowOf(c.sessionId).budget.messagesMax, MESSAGES_CAP);
    const over = await extend(1);
    assert.equal(over.status, 400);
    assert.match(((await over.json()) as { error: string }).error, /at most/);
    await baton.closeBaton(c.sessionId);
  });

  test("the per-token window forgets tokens with nothing recent", () => {
    const t0 = Date.now() + 60_000; // every token the tests above used is older than a minute by then
    tokenLimited("tok-old", t0);
    tokenLimited("tok-new", t0 + 61_000);
    assert.equal(tokenWindowSize(), 1);
  });
});

describe("the operator's composer in a baton session", () => {
  test("a refused send neither counts nor clears Needs you", async () => {
    const c = await start(OPERATOR);
    const chat = await acquireChat(c.path);
    const got = fakeSdk(chat);
    const client = { send: () => {} } as never;
    const guard = chat.assertNoForeignWrites.bind(chat);
    chat.assertNoForeignWrites = () => {
      throw new BusyError("Someone else wrote this session.", "recent");
    };
    chat.handle(client, { type: "prompt", text: "hi", clientId: "i2" } as never);
    chat.assertNoForeignWrites = guard;
    await new Promise((r) => setTimeout(r, 30));
    const row = rowOf(c.sessionId);
    assert.equal(row.budget.messagesUsed, 0);
    assert.equal(row.state, "needs-you");
    assert.deepEqual(got, []);
  });
});

describe("the message limit is settable", () => {
  test("the default comes from Settings; a start may set its own; both are bounded", async () => {
    assert.equal(rowOf((await start(OPERATOR)).sessionId).budget.messagesMax, MESSAGES_DEFAULT);
    assert.deepEqual(settings.writeBatonSettings({ messagesMax: 7 }), { messagesMax: 7, photos: PHOTO_DEFAULTS });
    assert.equal(rowOf((await start(OPERATOR)).sessionId).budget.messagesMax, 7);
    assert.equal(rowOf((await start(OPERATOR, { messagesMax: 3 })).sessionId).budget.messagesMax, 3);
    for (const bad of [0, -1, 2.5, MESSAGES_CAP + 1, "10"]) {
      await assert.rejects(start(OPERATOR, { messagesMax: bad }), /messagesMax must be/, String(bad));
      assert.ok("error" in settings.writeBatonSettings({ messagesMax: bad }), String(bad));
    }
    assert.equal(settings.readBatonSettings().messagesMax, 7, "a refused write keeps the saved value");
    const file = join(root, "agent", "sova", "baton-settings.json");
    writeFileSync(file, "{nope");
    assert.equal(settings.readBatonSettings().messagesMax, MESSAGES_DEFAULT, "a corrupt file reads as the default");
    settings.writeBatonSettings({ messagesMax: MESSAGES_DEFAULT });
  });

  test("routes: settings GET/PUT, POST /api/baton messagesMax, extend; a link with no share listener says so", async () => {
    const app = new Hono();
    registerOrgRoutes(app);
    const json = (method: string, body?: unknown) => ({ method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await app.request("/api/baton/settings", json("PUT", { messagesMax: 0 }))).status, 400);
    assert.deepEqual(await (await app.request("/api/baton/settings", json("PUT", { messagesMax: 40 }))).json(), { messagesMax: 40, photos: PHOTO_DEFAULTS });
    assert.deepEqual(await (await app.request("/api/baton/settings")).json(), { messagesMax: 40, photos: PHOTO_DEFAULTS });
    const res = await app.request("/api/baton", json("POST", { orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "T", goal: "g", messagesMax: 12 }));
    assert.equal(res.status, 201);
    const created = (await res.json()) as { sessionId: string; link: string; linkWarning?: string };
    assert.equal(rowOf(created.sessionId).budget.messagesMax, 12);
    assert.ok(created.link.startsWith("/h/"));
    assert.equal(created.linkWarning, LINK_WARNINGS.off, "no public address: the setting is named, never env variables");
    const ext = await app.request(`/api/baton/${created.sessionId}/extend`, json("POST", { by: 8 }));
    assert.equal(ext.status, 200);
    assert.equal(((await ext.json()) as { session: { budget: { messagesMax: number } } }).session.budget.messagesMax, 20);
    assert.equal((await app.request(`/api/baton/${created.sessionId}/extend`, json("POST", { by: "8" }))).status, 400);
    process.env.SOVA_SHARE_PUBLIC_URL = "https://share.example";
    const known = (await (await app.request(`/api/baton/${created.sessionId}/link`)).json()) as { link: string; linkWarning?: string; linkWarningCode?: string };
    assert.ok(known.link.startsWith("https://share.example/h/"));
    assert.equal(known.linkWarning, LINK_WARNINGS.unverified, "an address Verify has not passed");
    assert.equal(known.linkWarningCode, "unverified");
    publicLinks.writeServerFields({ verifiedAt: Date.now() });
    const verified = (await (await app.request(`/api/baton/${created.sessionId}/link`)).json()) as { link: string; linkWarning?: string };
    // The mint waits for the link-set listeners (awaitShareLinks): one that fails leaves it unconfirmed.
    const off = linksEvents.onShareLinksChanged(() => Promise.reject(new Error("push failed")));
    const pushFailed = (await (await app.request(`/api/baton/${created.sessionId}/link`)).json()) as { linkWarning?: string; linkWarningCode?: string };
    off();
    publicLinks.writeServerFields({ verifiedAt: null });
    assert.equal(pushFailed.linkWarningCode, "unconfirmed");
    assert.equal(pushFailed.linkWarning, LINK_WARNINGS.unconfirmed.replaceAll("{gateway}", "the gateway"));
    delete process.env.SOVA_SHARE_PUBLIC_URL;
    assert.equal(verified.linkWarning, undefined);
    settings.writeBatonSettings({ messagesMax: MESSAGES_DEFAULT });
  });
});

describe("the share listener", async () => {
  const server = createShareServer({ headersMs: 300, requestMs: 300, checkMs: 50 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  after(() => {
    server.close();
    server.closeAllConnections();
  });
  const open = async (token: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/h?token=${token}`);
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    ws.on("error", () => {});
    await new Promise((r) => ws.on("open", r));
    return { ws, closed };
  };

  test("an oversized frame closes the socket without an uncaught exception", async () => {
    const caught: unknown[] = [];
    const onUncaught = (err: unknown) => caught.push(err);
    process.on("uncaughtException", onUncaught);
    try {
      const { ws, closed } = await open((await start(tony.id)).token!);
      ws.send("x".repeat(5000));
      assert.equal(await closed, 1009);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.off("uncaughtException", onUncaught);
    }
    assert.deepEqual(caught, []);
  });

  test("a body that never arrives is answered 408 at the request timeout, not five minutes later", async () => {
    const token = (await start(tony.id)).token!; // a real link: the route waits for the body
    const t0 = Date.now();
    const reply = await new Promise<string>((resolve, reject) => {
      const sock = connect(port, "127.0.0.1", () => {
        sock.write(`POST /api/h/${token}/message HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 5\r\n\r\n`);
      });
      let data = "";
      sock.on("data", (d) => (data += d));
      sock.on("close", () => resolve(data));
      sock.on("error", reject);
      setTimeout(() => (sock.destroy(), resolve(data)), 3000);
    });
    assert.match(reply, /^HTTP\/1\.1 408/);
    assert.ok(Date.now() - t0 < 2500, `${Date.now() - t0} ms`);
  });

  test("an open socket on a link that stops reading is closed by the sweep, without waiting for a change", async () => {
    const c = await start(tony.id);
    const { closed } = await open(c.token!);
    assert.equal(sweepWatchers(), 0, "a live link stays");
    links.revokeLinks((l) => l.sessionId === c.sessionId);
    assert.equal(sweepWatchers(), 1);
    assert.equal(await closed, 4410);
  });

  test("a share view carries no roster id: `by` is you, operator, or a label", async () => {
    const c = await start(tony.id);
    const lines = readFileSync(c.path, "utf8").trim().split("\n");
    let parent = JSON.parse(lines.at(-1)!).id as string;
    const add = async (id: string, by: string, text: string) => {
      const at = new Date().toISOString();
      appendFileSync(c.path, `${JSON.stringify({ type: "message", id, parentId: parent, timestamp: at, message: { role: "user", content: [{ type: "text", text }] } })}\n`);
      appendFileSync(c.path, `${JSON.stringify({ type: "custom", id: `${id}s`, parentId: id, timestamp: at, customType: BATON_SENT_ENTRY, data: { v: 1, targetId: id, by } })}\n`);
      parent = `${id}s`;
    };
    add("u1", tony.id, "from tony");
    add("u2", maria.id, "from maria");
    add("u3", OPERATOR, "from the operator");
    const view = await viewForToken(c.token!);
    assert.ok(!("status" in view));
    const text = JSON.stringify(view);
    for (const p of orgs.readRoster(org.id)) assert.ok(!text.includes(p.id), `no ${p.id} in the view`);
    const msgs = view.items.filter((i): i is Extract<BatonViewItem, { kind: "message" }> => i.kind === "message");
    assert.deepEqual(
      msgs.map((m) => [m.by, m.name]),
      [
        ["you", "Tony Reyes"],
        ["person-1", "Maria Lopez"],
        [OPERATOR, orgs.operatorName()],
      ],
    );
    assert.deepEqual(
      opaqueSenders(
        [
          { kind: "message", id: "a", by: "p_x", name: "X", text: "" },
          { kind: "message", id: "b", by: "p_y", name: "Y", text: "" },
          { kind: "message", id: "c", by: "p_x", name: "X", text: "" },
        ],
        "p_z",
      ).map((i) => (i as { by: string }).by),
      ["person-1", "person-2", "person-1"],
    );
  });
});
