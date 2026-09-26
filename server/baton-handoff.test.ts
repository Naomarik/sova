// Run: pnpm exec tsx --test server/baton-handoff.test.ts. §app/baton moves while a reply is being
// written, people who leave, and an earlier holder invited to a new offer. A throwaway
// PI_CODING_AGENT_DIR and workspace in the OS temp dir; the model is a stub that can hold its reply.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import { BATON_HANDOFF_ENTRY, BATON_LEASE_ENTRY, LEASE_IDLE_MS, OPERATOR } from "../shared/baton";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-baton-handoff-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const loadout = await import("./baton-loadout");
const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { offerOutsider, viewForToken } = await import("./share/hub");
const { registerOrgRoutes } = await import("./org-routes");

after(async () => {
  await disposeAllChats();
  rmSync(root, { recursive: true, force: true });
});

const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
const person = (name: string) => orgs.addPerson(org.id, { name, role: "Staff" });
const app = new Hono();
registerOrgRoutes(app);
const post = (path: string, body?: unknown) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

const entriesOf = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const STUB = {
  id: "stub", name: "stub", api: "stub", provider: "stub", baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000,
};
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** A baton chat whose model replies "ok" once `release()` is called, or stops when aborted.
    `start()`: with `holdStart`, a prompt waits in the SDK's input handlers (a turn that is starting,
    its run not yet begun) until it is called. */
async function heldChat(path: string, opts: { holdStart?: boolean } = {}) {
  const chat = await acquireChat(path);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let start: () => void = () => {};
  const s = chat.session as unknown as {
    _modelRuntime: { hasConfiguredAuth(p: string): boolean };
    agent: { state: { model: unknown }; getApiKey: unknown; streamFunction: unknown };
    _runInputHandlers(...a: unknown[]): Promise<unknown>;
  };
  if (opts.holdStart) {
    const started = new Promise<void>((r) => (start = r));
    const run = s._runInputHandlers.bind(s);
    s._runInputHandlers = async (...a) => (await started, run(...a));
  }
  s._modelRuntime.hasConfiguredAuth = () => true;
  s.agent.state.model = STUB;
  s.agent.getApiKey = async () => "stub";
  s.agent.streamFunction = async (_m: unknown, _c: unknown, opts?: { signal?: AbortSignal }) => {
    // Aborted already when the model is called: a stop that came at the run's first event.
    const aborted = new Promise<"aborted">((r) => (opts?.signal?.aborted ? r("aborted") : opts?.signal?.addEventListener("abort", () => r("aborted"), { once: true })));
    const how = await Promise.race([gate.then(() => "done" as const), aborted]);
    const message = {
      role: "assistant", api: "stub", provider: "stub", model: "stub", timestamp: Date.now(), usage,
      content: [{ type: "text", text: "ok" }],
      stopReason: how === "aborted" ? "aborted" : "stop",
    };
    const end = how === "aborted" ? { type: "error", reason: "aborted", error: message } : { type: "done", reason: "stop", message };
    return { async *[Symbol.asyncIterator]() { yield end; }, result: async () => message };
  };
  return { chat, release, start };
}

/** Someone's message enters as the share route does it: the lock, then the prompt. */
function says(chat: Awaited<ReturnType<typeof heldChat>>["chat"], sessionId: string, by: string, text: string, now = Date.now()) {
  const noted = baton.noteMessage(sessionId, by, now);
  loadout.recordNoted(chat, by, noted);
  void chat.acceptPrompt(text, undefined, "server", undefined, { sentByBaton: { by } }).turn.catch(() => {});
}

describe("a lease never lapses while the reply to its holder is being written", () => {
  test("mid-reply a lapsed lease stays with its holder; the reply's end renews it; a lease entry waits for the reply", async () => {
    const maria = person("Maria Lopez");
    const tony = person("Tony Reyes");
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: [maria.id, tony.id], publicTitle: "Invoices", goal: "g" });
    const tonyTok = c.links!.find((l) => l.personId === tony.id)!.token;
    const { chat, release } = await heldChat(c.path);
    // Maria claimed long enough ago that her lease is already past its end, and the model is still answering her.
    says(chat, c.sessionId, maria.id, "two decisions, then a question", Date.now() - LEASE_IDLE_MS - 1000);
    await until(() => chat.session.isStreaming);
    assert.throws(() => baton.noteMessage(c.sessionId, tony.id), /Someone else is answering/, "Tony can't take over mid-reply");
    assert.equal((baton.linkAccess(tonyTok) as { reason?: string }).reason, "taken");
    assert.deepEqual(baton.lapsedLeases(), [], "the ticker sees no lapse either");
    // An entry that meets the reply is written after it, not lost.
    loadout.recordLease(chat, { n: 1, offerId: baton.batonById(c.sessionId)!.row.offerId!, event: "claimed", by: maria.id });
    const before = Date.now();
    release();
    await until(() => !chat.session.isStreaming);
    await until(() => entriesOf(c.path).filter((e) => e.customType === BATON_LEASE_ENTRY).length === 2);
    const o = baton.currentOffer(baton.batonById(c.sessionId)!.row)!;
    assert.equal(o.holder, maria.id);
    assert.ok(Date.parse(o.leaseUntil!) >= before + LEASE_IDLE_MS, "the reply's end restarted the lease");
    assert.throws(() => baton.noteMessage(c.sessionId, tony.id), /Someone else is answering/);
  });
});

describe("the operator's moves stop a reply in flight", () => {
  test("Take back mid-reply: the reply is aborted, the baton moves, the hand-off is recorded", async () => {
    const bob = person("Bob Chen");
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: bob.id, publicTitle: "Reminders", goal: "g" });
    const { chat } = await heldChat(c.path);
    says(chat, c.sessionId, bob.id, "here is a long answer");
    await until(() => chat.session.isStreaming);
    const res = await post(`/api/baton/${c.sessionId}/take`);
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(chat.session.isStreaming, false);
    const row = baton.batonById(c.sessionId)!.row;
    assert.equal(row.holder, OPERATOR);
    assert.equal(row.state, "needs-you");
    const handoffs = entriesOf(c.path).filter((e) => e.customType === BATON_HANDOFF_ENTRY);
    assert.deepEqual([handoffs.at(-1)!.data.from, handoffs.at(-1)!.data.to, handoffs.at(-1)!.data.question], [bob.id, OPERATOR, "(taken back)"]);
    const reply = entriesOf(c.path).filter((e) => e.type === "message" && e.message.role === "assistant").at(-1);
    assert.equal(reply?.message.stopReason, "aborted", "the transcript shows the reply was cut");
  });

  test("offering it on mid-reply works the same way", async () => {
    const a = person("Ana Ruiz");
    const b = person("Ben Ode");
    const c2 = person("Cy Park");
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: a.id, publicTitle: "Offer on", goal: "g" });
    const { chat } = await heldChat(c.path);
    says(chat, c.sessionId, a.id, "answering");
    await until(() => chat.session.isStreaming);
    const res = await post(`/api/baton/${c.sessionId}/offer`, { to: [b.id, c2.id] });
    assert.equal(res.status, 201, await res.clone().text());
    assert.equal(baton.batonById(c.sessionId)!.row.holder, null);
  });
});

describe("someone marked left", () => {
  test("a holder who leaves: the baton goes to the operator (Needs you), mid-reply too, and every link of theirs stops", async () => {
    const bob = person("Bo Left");
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: bob.id, publicTitle: "Held", goal: "g" });
    const { chat } = await heldChat(c.path);
    says(chat, c.sessionId, bob.id, "still typing");
    await until(() => chat.session.isStreaming);
    orgs.applyChange(org.id, bob.id, { status: "left" }, { kind: "operator" });
    assert.throws(() => baton.noteMessage(c.sessionId, bob.id), /no longer taking part/, "refused at once, before the move lands");
    await until(() => baton.batonById(c.sessionId)!.row.holder === OPERATOR);
    assert.deepEqual(baton.linkAccess(c.token!), { ok: false, status: 410 });
    const needs = baton.batonSummaryField(c.path)!.needsYou!;
    assert.deepEqual([needs.from, needs.question], ["Bo Left", "(left the organization)"]);
    assert.equal(chat.session.isStreaming, false);
  });

  test("an invitee of an open offer who leaves: the offer goes to the operator; one someone else holds carries on", async () => {
    const a = person("Al Open");
    const b = person("Bea Open");
    const open = baton.createBaton({ orgId: org.id, projectId: project.id, to: [a.id, b.id], publicTitle: "Pool", goal: "g" });
    const c = person("Cal Held");
    const d = person("Dee Held");
    const held = baton.createBaton({ orgId: org.id, projectId: project.id, to: [c.id, d.id], publicTitle: "Held offer", goal: "g" });
    baton.noteMessage(held.sessionId, c.id);
    orgs.applyChange(org.id, b.id, { status: "left" }, { kind: "operator" });
    orgs.applyChange(org.id, d.id, { status: "left" }, { kind: "operator" });
    await until(() => baton.batonById(open.sessionId)!.row.holder === OPERATOR);
    assert.equal(baton.batonSummaryField(open.path)!.needsYou!.question, "(Bea Open left the organization; offer withdrawn)");
    assert.equal(baton.batonById(held.sessionId)!.row.holder, c.id, "Cal keeps answering");
    const dTok = held.links!.find((l) => l.personId === d.id)!.token;
    assert.deepEqual(baton.linkAccess(dTok), { ok: false, status: 410 });
    // After Cal's lease lapses, Dee still can't claim it.
    assert.throws(() => baton.noteMessage(held.sessionId, d.id, Date.now() + LEASE_IDLE_MS + 1), /no longer taking part/);
    assert.throws(() => baton.rotateLink(held.sessionId, d.id), /not active/);
  });

  test("the model knows who left: the prompt says so, and proposing them as someone new is refused", async () => {
    const gone = person("Gus Gone");
    const asker = person("Ivy Asks");
    orgs.applyChange(org.id, gone.id, { status: "left" }, { kind: "operator" });
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: asker.id, publicTitle: "Who now", goal: "g" });
    const prompt = loadout.renderBatonPrompt(c.sessionId);
    const block = prompt.slice(prompt.indexOf("# People who have left"));
    assert.ok(prompt.includes("# People who have left the organization"), prompt);
    assert.doesNotMatch(prompt, /\bGate\b/, "the model is never given the org name (§app.organizations/privacy)");
    assert.match(block.slice(0, block.indexOf("# How to work")), /- Gus Gone — was Staff/);
    const tool = loadout.batonTools(c.sessionId, () => {}).find((t) => t.name === "propose_roster_edit")!;
    await assert.rejects(
      tool.execute("tc", { name: "gus gone", role: "IT", contact: { email: "gus@example.com" }, why: "knows it", quote: "ask Gus" }, undefined, undefined, undefined as never),
      /Gus Gone has left the organization/,
    );
    assert.equal(orgs.readRoster(org.id).filter((p) => p.name === "Gus Gone").length, 1, "no second Gus");
  });
});

describe("an earlier holder invited to a new offer", () => {
  test("is a never-holder of that offer: no holder's name, nothing past the card, no stream, 410 once withdrawn", async () => {
    const tony = person("To Earlier");
    const maria = person("Ma Claims");
    const carl = person("Ca Never");
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Two stretches", goal: "g" });
    baton.noteMessage(c.sessionId, tony.id);
    await loadout.moveBaton(c.sessionId, OPERATOR, "(taken back)");
    const out = await loadout.offerBaton(c.sessionId, [tony.id, maria.id, carl.id], "Next?");
    const tonyOffer = out.links.find((l) => l.personId === tony.id)!.token;
    baton.noteMessage(c.sessionId, maria.id);
    assert.equal(offerOutsider(tonyOffer), true, "gets no streaming text");
    const view = await viewForToken(tonyOffer);
    assert.ok(!("status" in view));
    assert.equal(view.holder, null, "not told who holds it");
    assert.equal(view.items.at(-1)!.kind, "offer", "sees up to the card");
    assert.equal(view.viewer!.reason, "taken");
    // Maria held it, Tony did not: withdrawn, his offer link is dead; his first hand-off's still reads.
    await loadout.moveBaton(c.sessionId, OPERATOR, "(offer withdrawn)");
    assert.deepEqual(baton.linkAccess(tonyOffer), { ok: false, status: 410 });
    assert.equal(baton.linkAccess(c.token!).ok, true);
    assert.equal(baton.linkAccess(out.links.find((l) => l.personId === maria.id)!.token).ok, true);
  });
});

describe("moves, the starting turn and the message limit together", () => {
  const holderOf = (sid: string) => baton.batonById(sid)!.row.holder;
  const lastReply = (path: string) => entriesOf(path).filter((e) => e.type === "message" && e.message.role === "assistant").at(-1);
  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

  test("Take back while a message's turn is starting: its run is stopped when it begins, and the hand-off comes after it", async () => {
    const kim = person("Kim Start");
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: kim.id, publicTitle: "Starting", goal: "g" });
    const { chat, start } = await heldChat(c.path, { holdStart: true });
    says(chat, c.sessionId, kim.id, "first words");
    await tick();
    assert.equal(chat.session.isStreaming, false, "the run has not begun");
    const took = post(`/api/baton/${c.sessionId}/take`);
    await tick();
    assert.equal(holderOf(c.sessionId), kim.id, "the move waits for the starting turn instead of slipping in before it");
    start();
    const res = await took;
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(holderOf(c.sessionId), OPERATOR);
    assert.equal(chat.session.isStreaming, false);
    const es = entriesOf(c.path);
    const lastIndex = (pred: (e: any) => boolean) => es.map(pred).lastIndexOf(true);
    const reply = lastIndex((e) => e.type === "message" && e.message.role === "assistant");
    const hand = lastIndex((e) => e.customType === BATON_HANDOFF_ENTRY);
    assert.equal(es[reply]?.message.stopReason, "aborted", "the reply that began was stopped, not written for the old holder");
    assert.ok(hand > reply, "the hand-off is recorded after the stopped reply");
  });

  test("the budget stop waits for the reply to the last allowed message, even while its turn is starting, then moves", async () => {
    const lee = person("Lee Limit");
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: lee.id, publicTitle: "Limit", goal: "g", messagesMax: 1 });
    const { chat, start, release } = await heldChat(c.path, { holdStart: true });
    says(chat, c.sessionId, lee.id, "the last one");
    await loadout.budgetStop(c.sessionId);
    assert.equal(holderOf(c.sessionId), lee.id, "not while the turn is starting");
    start();
    await until(() => chat.session.isStreaming);
    await loadout.budgetStop(c.sessionId);
    assert.equal(holderOf(c.sessionId), lee.id, "nor mid-reply");
    release();
    await until(() => holderOf(c.sessionId) === OPERATOR);
    assert.equal(lastReply(c.path)?.message.stopReason, "stop", "the reply to the last allowed message is whole");
    const h = entriesOf(c.path).filter((e) => e.customType === BATON_HANDOFF_ENTRY).at(-1)!;
    assert.deepEqual([h.data.from, h.data.to, h.data.question], [lee.id, OPERATOR, loadout.LIMIT_QUESTION]);
  });

  test("a hand-off or an offer the limit refuses leaves the reply in flight alone", async () => {
    const amy = person("Amy Cap");
    const bo = person("Bo Cap");
    const di = person("Di Cap");
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: amy.id, publicTitle: "Capped", goal: "g", messagesMax: 1 });
    const { chat, release } = await heldChat(c.path);
    says(chat, c.sessionId, amy.id, "last");
    await until(() => chat.session.isStreaming);
    const h = await post(`/api/baton/${c.sessionId}/handoff`, { to: bo.id, question: "q" });
    assert.equal(h.status, 409, await h.clone().text());
    const o = await post(`/api/baton/${c.sessionId}/offer`, { to: [bo.id, di.id] });
    assert.equal(o.status, 409, await o.clone().text());
    assert.equal(chat.session.isStreaming, true, "the reply still runs");
    release();
    await until(() => !chat.session.isStreaming);
    assert.equal(lastReply(c.path)?.message.stopReason, "stop");
  });
});
