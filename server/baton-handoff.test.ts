// Run: pnpm exec tsx --test server/baton-handoff.test.ts. §app/baton moves while a reply is being
// written, people who leave, and an earlier holder invited to a new offer. A throwaway
// PI_CODING_AGENT_DIR and workspace in the OS temp dir; the model is a stub that can hold its reply.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import { BATON_HANDOFF_ENTRY, BATON_LEASE_ENTRY, BATON_SENT_ENTRY, LEASE_IDLE_MS, OPERATOR } from "../shared/baton";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-baton-handoff-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const loadout = await import("./baton-loadout");
const { acquireChat, disposeAllChats, disposeHeldChat } = await import("./chat-manager");
const { offerOutsider, viewForToken } = await import("./share/hub");
const { registerOrgRoutes } = await import("./org-routes");
const { createShareApp } = await import("./share/routes");
const { stateRoot } = await import("./state-root");
const { hostOf } = await import("./org-engine");

after(async () => {
  await disposeAllChats();
  rmSync(root, { recursive: true, force: true });
});
// pi's model catalog and auth storage can still write here after after() ran: exit is last.
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
const person = async (name: string) => await orgs.addPerson(org.id, { name, role: "Staff" });
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
async function heldChat(path: string, opts: { holdStart?: boolean; seen?: unknown[][]; tools?: unknown[][]; script?: unknown[][] } = {}) {
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
  const seen = opts.seen;
  const tools = opts.tools;
  const script = opts.script;
  s._modelRuntime.hasConfiguredAuth = () => true;
  s.agent.state.model = STUB;
  s.agent.getApiKey = async () => "stub";
  s.agent.streamFunction = async (_m: unknown, context: { messages?: unknown[] }, opts?: { signal?: AbortSignal }) => {
    // The tools the run can call (the transcript declares them to the model), each time it is called.
    tools?.push((s.agent.state as unknown as { tools: { name: string; parameters: unknown }[] }).tools.map((t) => ({ name: t.name, parameters: structuredClone(t.parameters) })));
    // What the model reads, each time it is called.
    opts?.signal && seen?.push(structuredClone(context?.messages ?? []));
    // Aborted already when the model is called: a stop that came at the run's first event.
    const aborted = new Promise<"aborted">((r) => (opts?.signal?.aborted ? r("aborted") : opts?.signal?.addEventListener("abort", () => r("aborted"), { once: true })));
    const how = await Promise.race([gate.then(() => "done" as const), aborted]);
    // A scripted reply (tool calls) when one is queued, else "ok".
    const scripted = how === "aborted" ? undefined : script?.shift();
    const message = {
      role: "assistant", api: "stub", provider: "stub", model: "stub", timestamp: Date.now(), usage,
      content: scripted ?? [{ type: "text", text: "ok" }],
      stopReason: how === "aborted" ? "aborted" : scripted ? "toolUse" : "stop",
    };
    const end = how === "aborted" ? { type: "error", reason: "aborted", error: message } : { type: "done", reason: "stop", message };
    return { async *[Symbol.asyncIterator]() { yield end; }, result: async () => message };
  };
  return { chat, release, start };
}

/** Someone's message enters as the share route does it: the lock (its reply starts with it), then the prompt. */
function says(chat: Awaited<ReturnType<typeof heldChat>>["chat"], sessionId: string, by: string, text: string) {
  baton.noteMessage(sessionId, by);
  void chat.acceptPrompt(text, undefined, "server", undefined, { sentByBaton: { by } }).turn.catch(() => {});
}

describe("a lease never lapses while the reply to its holder is being written", () => {
  test("mid-reply a lapsed lease stays with its holder; the reply's end renews it; a lease entry waits for the reply", async () => {
    const maria = await person("Maria Lopez");
    const tony = await person("Tony Reyes");
    // A one-second lease (hermetic tests only): the statechart's own timer would lapse it mid-reply.
    process.env.SOVA_BATON_LEASE_MS = "1000";
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: [maria.id, tony.id], publicTitle: "Invoices", goal: "g" }).finally(() => delete process.env.SOVA_BATON_LEASE_MS);
    const tonyTok = c.links!.find((l) => l.personId === tony.id)!.token;
    const { chat, release } = await heldChat(c.path);
    says(chat, c.sessionId, maria.id, "two decisions, then a question");
    await until(() => chat.session.isStreaming);
    // Her lease's time passes while the model is still answering her.
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(baton.batonById(c.sessionId)!.row.holder, maria.id, "mid-reply a lapsed lease stays with its holder");
    assert.throws(() => baton.noteMessage(c.sessionId, tony.id), /Someone else is answering/, "Tony can't take over mid-reply");
    assert.equal((baton.linkAccess(tonyTok) as { reason?: string }).reason, "taken");
    const before = Date.now();
    assert.equal(hostOf(org.id).data(`baton/${org.id}/${c.sessionId}`)?.["reply"], "writing", "the runtime took the turn: the reply is being written");
    release();
    await until(() => !chat.session.isStreaming);
    // The claim's entry, which met the reply, is written after it, not lost.
    await until(() => entriesOf(c.path).some((e) => e.customType === BATON_LEASE_ENTRY && e.data.event === "claimed"));
    const o = baton.currentOffer(baton.batonById(c.sessionId)!.row)!;
    assert.equal(o.holder, maria.id);
    assert.ok(Date.parse(o.leaseUntil!) >= before + 1000, "the reply's end restarted the lease");
    assert.throws(() => baton.noteMessage(c.sessionId, tony.id), /Someone else is answering/);
  });
});

describe("the operator's moves stop a reply in flight", () => {
  test("Take back mid-reply: the reply is aborted, the baton moves, the hand-off is recorded", async () => {
    const bob = await person("Bob Chen");
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: bob.id, publicTitle: "Reminders", goal: "g" });
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
    const a = await person("Ana Ruiz");
    const b = await person("Ben Ode");
    const c2 = await person("Cy Park");
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: a.id, publicTitle: "Offer on", goal: "g" });
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
    const bob = await person("Bo Left");
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: bob.id, publicTitle: "Held", goal: "g" });
    const { chat } = await heldChat(c.path);
    says(chat, c.sessionId, bob.id, "still typing");
    await until(() => chat.session.isStreaming);
    await orgs.applyChange(org.id, bob.id, { status: "left" }, { kind: "operator" });
    assert.throws(() => baton.noteMessage(c.sessionId, bob.id), /no longer taking part/, "refused at once, before the move lands");
    await until(() => baton.batonById(c.sessionId)!.row.holder === OPERATOR);
    assert.deepEqual(baton.linkAccess(c.token!), { ok: false, status: 410 });
    const needs = baton.batonSummaryField(c.path)!.needsYou!;
    assert.deepEqual([needs.from, needs.question], ["Bo Left", "(left the organization)"]);
    assert.equal(chat.session.isStreaming, false);
  });

  test("an invitee of an open offer who leaves: the offer goes to the operator; one someone else holds carries on", async () => {
    const a = await person("Al Open");
    const b = await person("Bea Open");
    const open = await baton.createBaton({ orgId: org.id, projectId: project.id, to: [a.id, b.id], publicTitle: "Pool", goal: "g" });
    const c = await person("Cal Held");
    const d = await person("Dee Held");
    const held = await baton.createBaton({ orgId: org.id, projectId: project.id, to: [c.id, d.id], publicTitle: "Held offer", goal: "g" });
    baton.noteMessage(held.sessionId, c.id);
    await orgs.applyChange(org.id, b.id, { status: "left" }, { kind: "operator" });
    await orgs.applyChange(org.id, d.id, { status: "left" }, { kind: "operator" });
    await until(() => baton.batonById(open.sessionId)!.row.holder === OPERATOR);
    assert.equal(baton.batonSummaryField(open.path)!.needsYou!.question, "(Bea Open left the organization; offer withdrawn)");
    assert.equal(baton.batonById(held.sessionId)!.row.holder, c.id, "Cal keeps answering");
    const dTok = held.links!.find((l) => l.personId === d.id)!.token;
    assert.deepEqual(baton.linkAccess(dTok), { ok: false, status: 410 });
    // After Cal's lease lapses, Dee still can't claim it.
    assert.throws(() => baton.noteMessage(held.sessionId, d.id), /no longer taking part/);
    assert.throws(() => baton.rotateLink(held.sessionId, d.id), /not active/);
  });

  test("the model knows who left: the prompt says so, and proposing them as someone new is refused", async () => {
    const gone = await person("Gus Gone");
    const asker = await person("Ivy Asks");
    await orgs.applyChange(org.id, gone.id, { status: "left" }, { kind: "operator" });
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: asker.id, publicTitle: "Who now", goal: "g" });
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

describe("record_decision's owner areas follow the roster (§app.requirements/owner-area)", () => {
  test("an area added mid-session is offered at the next run; the conversation's tools stay exactly its own", async () => {
    const ana = await orgs.addPerson(org.id, { name: "Ana Owner", role: "Lead", decides: ["website"] });
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: ana.id, publicTitle: "Areas", goal: "g" });
    const calls: unknown[][] = [];
    const { chat, release } = await heldChat(c.path, { tools: calls });
    release();
    const enumOf = (tools: unknown[]) => (tools as { name: string; parameters: any }[]).find((t) => t.name === "record_decision")!.parameters.properties.ownerArea.enum as string[];
    says(chat, c.sessionId, ana.id, "first");
    await until(() => calls.length === 1 && !chat.session.isStreaming);
    assert.ok(enumOf(calls[0]!).includes("website"));
    assert.ok(!enumOf(calls[0]!).includes("hosting"));
    await orgs.applyChange(org.id, ana.id, { decides: ["website", "hosting"] }, { kind: "operator" });
    says(chat, c.sessionId, ana.id, "second");
    await until(() => calls.length === 2 && !chat.session.isStreaming);
    assert.ok(enumOf(calls[1]!).includes("hosting"), JSON.stringify(enumOf(calls[1]!)));
    assert.deepEqual((calls[1] as { name: string }[]).map((t) => t.name).sort(), [...loadout.BATON_TOOLS].sort(), "the wrap-up's tool stays inactive");
  });

  test("through pi's own tool call: an unknown owner area is refused naming the choices; a case variant is stored as the roster spells it", async () => {
    const kim = await orgs.addPerson(org.id, { name: "Kim Picks", role: "Lead", decides: ["finance"] });
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: kim.id, publicTitle: "Picks", goal: "g" });
    const call = (id: string, ownerArea: string) => ({ type: "toolCall", id, name: "record_decision", arguments: { area: "payroll dates", ownerArea, statement: "Pay on the 1st.", quote: "the 1st" } });
    const { chat, release } = await heldChat(c.path, { script: [[call("t1", "payroll"), call("t2", "Finance")]] });
    release();
    says(chat, c.sessionId, kim.id, "we pay on the 1st");
    await until(() => !chat.session.isStreaming && entriesOf(c.path).some((e) => e.message?.role === "toolResult" && e.message.toolCallId === "t2"));
    const results = entriesOf(c.path).filter((e) => e.message?.role === "toolResult");
    const text = (id: string) => JSON.stringify(results.find((e) => e.message.toolCallId === id)!.message.content);
    assert.match(text("t1"), /\\"payroll\\" is not an owner area\. Use one of: .*\\"finance\\".* or \\"none\\"\./, text("t1"));
    assert.doesNotMatch(text("t1"), /must be equal to one of the allowed values/);
    const decided = entriesOf(c.path).filter((e) => e.customType === "sova-baton-decision");
    assert.deepEqual(decided.map((e) => e.data.ownerArea), ["finance"], "one decision, stored as the roster spells it");
  });
});

describe("an earlier holder invited to a new offer", () => {
  test("is a never-holder of that offer: no holder's name, nothing past the card, no stream, 410 once withdrawn", async () => {
    const tony = await person("To Earlier");
    const maria = await person("Ma Claims");
    const carl = await person("Ca Never");
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Two stretches", goal: "g" });
    baton.noteMessage(c.sessionId, tony.id);
    await baton.takeBack(c.sessionId);
    const out = await baton.offerTo(c.sessionId, [tony.id, maria.id, carl.id], "Next?", "");
    const tonyOffer = out.links.find((l) => l.personId === tony.id)!.token;
    baton.noteMessage(c.sessionId, maria.id);
    assert.equal(offerOutsider(tonyOffer), true, "gets no streaming text");
    const view = await viewForToken(tonyOffer);
    assert.ok(!("status" in view));
    assert.equal(view.holder, null, "not told who holds it");
    assert.equal(view.items.at(-1)!.kind, "offer", "sees up to the card");
    assert.equal(view.viewer!.reason, "taken");
    // Maria held it, Tony did not: withdrawn, his offer link is dead; his first hand-off's still reads.
    await baton.withdrawOffer(c.sessionId);
    assert.deepEqual(baton.linkAccess(tonyOffer), { ok: false, status: 410, why: "withdrawn" });
    assert.equal(baton.linkAccess(c.token!).ok, true);
    assert.equal(baton.linkAccess(out.links.find((l) => l.personId === maria.id)!.token).ok, true);
  });

  test("his older link, from an earlier hand-off, is cut at the offer the same way until the baton comes to him directly", async () => {
    const tony = await person("To Old Link");
    const maria = await person("Ma Holds");
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Old link", goal: "g" });
    baton.noteMessage(c.sessionId, tony.id);
    await baton.takeBack(c.sessionId);
    await baton.offerTo(c.sessionId, [tony.id, maria.id], "Next?", "");
    baton.noteMessage(c.sessionId, maria.id);
    assert.equal(offerOutsider(c.token!), true, "his first hand-off's link gets no streaming text");
    const view = await viewForToken(c.token!);
    assert.ok(!("status" in view));
    assert.equal(view.holder, null, "not told who holds it");
    assert.equal(view.items.at(-1)!.kind, "offer", "sees up to the card");
    // Handed to him directly after the offer: that old link reads the whole conversation again.
    await baton.handoffTo(c.sessionId, tony.id, "Your turn again?", "");
    assert.equal(offerOutsider(c.token!), false);
    const again = await viewForToken(c.token!);
    assert.ok(!("status" in again));
    assert.equal(again.items.at(-1)!.kind, "handoff");
    assert.equal(again.holder, "To Old Link");
    assert.ok(again.items.findIndex((i) => i.kind === "offer") < again.items.length - 1, "past the offer's card");
  });

  test("the holder's older link, while a newer one of theirs holds the baton, says to use the newer one", async () => {
    const tony = await person("To Newer");
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Newer link", goal: "g" });
    await baton.takeBack(c.sessionId);
    const res = await post(`/api/baton/${c.sessionId}/handoff`, { to: tony.id, question: "Back to you" });
    assert.equal(res.status, 200);
    assert.equal(baton.batonById(c.sessionId)!.row.holder, tony.id);
    const a = baton.linkAccess(c.token!);
    assert.ok(a.ok);
    assert.equal(a.canWrite, false);
    assert.equal(a.reason, "newer-link");
  });
});

describe("moves, the starting turn and the message limit together", () => {
  const holderOf = (sid: string) => baton.batonById(sid)!.row.holder;
  const lastReply = (path: string) => entriesOf(path).filter((e) => e.type === "message" && e.message.role === "assistant").at(-1);
  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

  test("Take back while a message's turn is starting: its run is stopped when it begins, and the hand-off comes after it", async () => {
    const kim = await person("Kim Start");
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: kim.id, publicTitle: "Starting", goal: "g" });
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
    const lee = await person("Lee Limit");
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: lee.id, publicTitle: "Limit", goal: "g", messagesMax: 1 });
    const { chat, start, release } = await heldChat(c.path, { holdStart: true });
    says(chat, c.sessionId, lee.id, "the last one");
    await tick();
    assert.equal(holderOf(c.sessionId), lee.id, "not while the turn is starting");
    start();
    await until(() => chat.session.isStreaming);
    assert.equal(holderOf(c.sessionId), lee.id, "nor mid-reply");
    release();
    await until(() => holderOf(c.sessionId) === OPERATOR);
    assert.equal(lastReply(c.path)?.message.stopReason, "stop", "the reply to the last allowed message is whole");
    const h = entriesOf(c.path).filter((e) => e.customType === BATON_HANDOFF_ENTRY).at(-1)!;
    assert.deepEqual([h.data.from, h.data.to, h.data.question], [lee.id, OPERATOR, loadout.LIMIT_QUESTION]);
  });

  test("a hand-off or an offer the limit refuses leaves the reply in flight alone", async () => {
    const amy = await person("Amy Cap");
    const bo = await person("Bo Cap");
    const di = await person("Di Cap");
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: amy.id, publicTitle: "Capped", goal: "g", messagesMax: 1 });
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

describe("a move that stops a reply drops nothing queued behind it", () => {
  /** The transcript from the last stopped reply on: [who, text] per user message, "reply" / "hand-off" for the rest. */
  const after = (path: string) => {
    const es = entriesOf(path);
    const sentBy = new Map(es.filter((e) => e.customType === BATON_SENT_ENTRY).map((e) => [e.data.targetId, e.data.by]));
    const from = es.map((e) => e.type === "message" && e.message.stopReason === "aborted").lastIndexOf(true);
    return es.slice(from).flatMap((e) =>
      e.type === "message"
        ? [e.message.role === "user" ? [sentBy.get(e.id) ?? "?", e.message.content.map((c: { text?: string }) => c.text ?? "").join("")] : e.message.stopReason === "aborted" ? "stopped" : "reply"]
        : e.customType === BATON_HANDOFF_ENTRY
          ? ["hand-off"]
          : [],
    );
  };

  for (const [how, move] of [
    ["Take back", async (sid: string) => assert.equal((await post(`/api/baton/${sid}/take`)).status, 200)],
    ["someone leaving", async (sid: string, by: string) => {
      await orgs.applyChange(org.id, by, { status: "left" }, { kind: "operator" });
      await until(() => baton.batonById(sid)!.row.holder === OPERATOR);
    }],
  ] as const) {
    test(`${how} mid-reply: every message queued behind the reply enters as its sender's, before the hand-off, with no reply`, async () => {
      const kay = await person(`Kay Queue ${how}`);
      const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: kay.id, publicTitle: "Queued", goal: "g" });
      const { chat } = await heldChat(c.path);
      says(chat, c.sessionId, kay.id, "first");
      await until(() => chat.session.isStreaming);
      says(chat, c.sessionId, kay.id, "second");
      // As live: the first queued message is inside the SDK, the next waits in Sova's queue.
      await until(() => chat.session.agent.hasQueuedMessages());
      says(chat, c.sessionId, kay.id, "third");
      await move(c.sessionId, kay.id);
      assert.deepEqual(after(c.path), ["stopped", [kay.id, "second"], [kay.id, "third"], "hand-off"]);
      assert.equal(chat.queue.size, 0);
      assert.equal(chat.session.isStreaming, false, "the kept messages start no reply");
      assert.equal(baton.batonById(c.sessionId)!.row.budget.messagesUsed, 3, "each counted once, when it was accepted");
      const context = chat.session.agent.state.messages.filter((m) => m.role === "user").map((m) => (m.content as { text?: string }[]).map((b) => b.text).join(""));
      assert.deepEqual(context.slice(-2), ["second", "third"], "the model reads them with the next turn");
    });
  }
});

describe("a clean close keeps what is queued", () => {
  test("archiving a baton session mid-reply writes each queued message into the transcript as its sender's", async () => {
    const may = await person("May Close");
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: may.id, publicTitle: "Closing", goal: "g" });
    const { chat } = await heldChat(c.path);
    says(chat, c.sessionId, may.id, "CLOSE-FIRST");
    await until(() => chat.session.isStreaming);
    says(chat, c.sessionId, may.id, "CLOSE-SECOND");
    await until(() => chat.session.agent.hasQueuedMessages());
    says(chat, c.sessionId, may.id, "CLOSE-THIRD");
    assert.equal(await disposeHeldChat(c.path, "Archived"), true);
    const es = entriesOf(c.path);
    const sentBy = new Map(es.filter((e) => e.customType === BATON_SENT_ENTRY).map((e) => [e.data.targetId, e.data.by]));
    const users = es.filter((e) => e.type === "message" && e.message.role === "user");
    assert.deepEqual(
      users.map((e) => [sentBy.get(e.id), e.message.content.map((b: { text?: string }) => b.text ?? "").join("")]),
      [[may.id, "CLOSE-FIRST"], [may.id, "CLOSE-SECOND"], [may.id, "CLOSE-THIRD"]],
      "every message she sent is in the file, each as hers",
    );
    assert.equal(baton.batonById(c.sessionId)!.row.budget.messagesUsed, 3, "counted once, when accepted");
    // Reopened, the model reads them with the next turn.
    const again = await acquireChat(c.path);
    const context = again.session.agent.state.messages.filter((m) => m.role === "user").map((m) => (m.content as { text?: string }[]).map((b) => b.text).join(""));
    assert.deepEqual(context, ["CLOSE-FIRST", "CLOSE-SECOND", "CLOSE-THIRD"]);
  });
});

describe("the model reads who wrote each message", () => {
  test("after Take back with queued messages, each message in the model's context carries its own author, and the move is a line of its own", async () => {
    const kim = await person("Kim Author");
    const lee = await person("Lee Author");
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: kim.id, publicTitle: "Authors", goal: "g" });
    const seen: unknown[][] = [];
    const { chat, release } = await heldChat(c.path, { seen });
    says(chat, c.sessionId, kim.id, "KIM-FIRST");
    await until(() => chat.session.isStreaming);
    says(chat, c.sessionId, kim.id, "KIM-QUEUED");
    await until(() => chat.session.agent.hasQueuedMessages());
    assert.equal((await post(`/api/baton/${c.sessionId}/take`)).status, 200);
    const op = orgs.operatorName();
    says(chat, c.sessionId, OPERATOR, "OP-ASKS who wrote those?");
    await until(() => seen.length === 2);
    release();
    await until(() => !chat.session.isStreaming);
    assert.equal((await post(`/api/baton/${c.sessionId}/handoff`, { to: lee.id, question: "q" })).status, 200);
    says(chat, c.sessionId, lee.id, "LEE-ANSWERS");
    await until(() => seen.length === 3 && !chat.session.isStreaming);
    const users = (seen.at(-1) as { role: string; content: { type: string; text?: string }[] }[])
      .filter((m) => m.role === "user")
      .map((m) => m.content.map((b) => b.text ?? "").join(""));
    const of = (word: string) => users.find((u) => u.includes(word)) ?? "";
    assert.match(of("KIM-FIRST"), /^\[The conversation passed from .+ \(the operator\) to Kim Author\]\n\[From Kim Author\]\nKIM-FIRST$/);
    assert.equal(of("KIM-QUEUED"), "[From Kim Author]\nKIM-QUEUED", "a kept message is still Kim's");
    assert.equal(of("OP-ASKS"), `[The conversation passed from Kim Author to ${op} (the operator)]\n[From ${op} (the operator)]\nOP-ASKS who wrote those?`);
    assert.equal(of("LEE-ANSWERS"), `[The conversation passed from ${op} (the operator) to Lee Author]\n[From Lee Author]\nLEE-ANSWERS`);
    for (const [word, not] of [["KIM-QUEUED", /Lee|operator/], ["LEE-ANSWERS", /From Kim|From .*operator/], ["OP-ASKS", /From Kim|From Lee/]] as const)
      assert.doesNotMatch(of(word), not, `${word} carries nobody else's name as its author`);
    // Context only: what was written stays as the people wrote it, and earlier turns read the same.
    const file = entriesOf(c.path).filter((e) => e.type === "message" && e.message.role === "user").map((e) => e.message.content.map((b: { text?: string }) => b.text ?? "").join(""));
    assert.deepEqual(file, ["KIM-FIRST", "KIM-QUEUED", "OP-ASKS who wrote those?", "LEE-ANSWERS"]);
    const earlier = (seen[1] as { role: string; content: { text?: string }[] }[]).filter((m) => m.role === "user").map((m) => m.content.map((b) => b.text ?? "").join(""));
    assert.deepEqual(users.slice(0, earlier.length), earlier, "a later turn doesn't change an earlier message's label");
    assert.doesNotMatch(users.join("\n"), new RegExp(`${kim.id}|${lee.id}|operator"|Staff`), "no id, no role in the labels");
  });
});

describe("a dead link says why only when it expired or its question went to someone else", () => {
  const share = createShareApp();
  const gone = async (token: string) => {
    const res = await share.request(`/api/h/${token}`);
    return { status: res.status, body: (await res.json()) as { code: string; why?: string } };
  };

  test("expired: why \"expired\"; withdrawn: why \"withdrawn\"; turned off, closed or its person left: no reason", async () => {
    const ex = await person("Ex Pired");
    const e = await baton.createBaton({ orgId: org.id, projectId: project.id, to: ex.id, publicTitle: "Expired", goal: "g" });
    const file = join(stateRoot(), "baton-links.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as { links: { sessionId: string; expiresAt: string }[] };
    for (const l of raw.links) if (l.sessionId === e.sessionId) l.expiresAt = new Date(Date.now() - 1000).toISOString();
    writeFileSync(file, JSON.stringify(raw));
    assert.deepEqual(baton.linkAccess(e.token!), { ok: false, status: 410, why: "expired" });
    assert.deepEqual(await gone(e.token!), { status: 410, body: { error: "This link is no longer active.", code: "gone", why: "expired" } });

    const a = await person("Wi Holder");
    const b = await person("Wi Never");
    const w = await baton.createBaton({ orgId: org.id, projectId: project.id, to: [a.id, b.id], publicTitle: "Withdrawn", goal: "g" });
    const never = w.links!.find((l) => l.personId === b.id)!.token;
    baton.noteMessage(w.sessionId, a.id);
    await baton.withdrawOffer(w.sessionId);
    assert.equal((await gone(never)).body.why, "withdrawn");

    const off = await person("Tu Rnedoff");
    const t = await baton.createBaton({ orgId: org.id, projectId: project.id, to: off.id, publicTitle: "Off", goal: "g" });
    baton.revokeCurrent(t.sessionId);
    assert.deepEqual(await gone(t.token!), { status: 410, body: { error: "This link is no longer active.", code: "gone" } });

    const cl = await person("Cl Osed");
    const k = await baton.createBaton({ orgId: org.id, projectId: project.id, to: cl.id, publicTitle: "Closed", goal: "g" });
    await baton.closeBaton(k.sessionId);
    assert.equal((await gone(k.token!)).body.why, undefined);

    const lf = await person("Le Ft");
    const l = await baton.createBaton({ orgId: org.id, projectId: project.id, to: lf.id, publicTitle: "Left", goal: "g" });
    await orgs.applyChange(org.id, lf.id, { status: "left" }, { kind: "operator" });
    await until(() => !baton.linkAccess(l.token!).ok);
    assert.deepEqual(await gone(l.token!), { status: 410, body: { error: "This link is no longer active.", code: "gone" } });
  });
});
