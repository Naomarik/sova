// Run: node scripts/run-tests.mjs server/org-history-surfaces.test.ts. §app.org-history/readers: an
// org's history, words recorded only there (a recorded reason, a quote, an option, an overseer's own
// decision through sova_decide), reaches the operator's History reads and the project overseer's
// sova_history for its own project, and none of the surfaces that never read it: the share page (/h/),
// the owner page (/i/), a hand-off session (gathering, offer, Send to person…, settle) and its wrap-up,
// the reconciler's decide calls, a coding session, the session list, the attention digest and the
// global Overseer's prompt. The same harness as org-about-privacy.test.ts: a throwaway
// PI_CODING_AGENT_DIR (with this tree's pi-config extensions linked in), an org workspace and a project
// root in the OS temp dir, deleted after; every model is a stub that records what it was sent.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import { BATON_SENT_ENTRY } from "../shared/baton";
import type { HistoryInput } from "../shared/org-history";
import type { DecisionProvider, DecisionRequest } from "./decide";
import { piSession } from "./harness/pi/testing/handle";
import { scratchRoot } from "./test-scratch";

// In no repository: the project is a plain folder, so its coding session cuts no worktree.
const root = scratchRoot("sova-history-surfaces-");
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
symlinkSync(resolve(import.meta.dirname, "..", "pi-config", "extensions"), join(agentDir, "extensions"));

const orgs = await import("./orgs");
const baton = await import("./baton");
const loadout = await import("./baton-loadout");
const po = await import("./project-overseer");
const reconcile = await import("./reconcile");
const decisions = await import("./decisions");
const overseer = await import("./overseer");
const owner = await import("./owner");
const historyTools = await import("./org-history-tools");
const { ownerView } = await import("./owner-page");
const { handleOf } = await import("./person-links");
const { acquireChat, disposeAllChats, disposeHeldChat } = await import("./chat-manager");
const { readView, viewForToken } = await import("./share/hub");
const { createShareApp } = await import("./share/routes");
const { listSessions } = await import("./sessions-index");
const { hostOf, envelopeFor } = await import("./org-engine");
const { registerOrgHistoryRoutes } = await import("./org-history-routes");
const { settled } = await import("./workspace-git");
const { addTodo, readTodos } = await import("./overseer-todos");
const store = await import("./project-overseer-store");
const { recordDecision } = await import("./org-test-fixtures");
const { canonicalPath } = await import("./paths");
const { markOwned } = await import("./write-guard");

/** Words that exist only in the org's history: a recorded reason, a quote, an option, a headline. */
const MARK = "HISTORY-SENTINEL-4c9e2b";
/** The project overseer's own decision's words (sova_decide), also only in the history. */
const DECIDE = "HISTORY-DECIDE-SENTINEL-81d0";
const leaks = (s: string) => s.includes(MARK) || s.includes(DECIDE);

const share = createShareApp();
const historyApp = new Hono();
registerOrgHistoryRoutes(historyApp);
after(async () => {
  await disposeAllChats();
  await settled(join(root, "ws"));
  rmSync(root, { recursive: true, force: true });
});

// ---- a stub model on each runtime: records every request, replies "ok" (as org-about-privacy.test.ts) ------

const STUB = {
  id: "stub", name: "stub", api: "stub", provider: "stub", baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000,
};
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
type Chat = Awaited<ReturnType<typeof acquireChat>>;
const sent = new Map<string, string[]>();
const stubbed = new WeakSet<object>();
async function stubbedChat(path: string): Promise<Chat> {
  const chat = await acquireChat(path);
  const s = piSession(chat) as unknown as {
    _modelRuntime: { hasConfiguredAuth(p: string): boolean };
    agent: { state: { model: unknown }; getApiKey: unknown; streamFunction: unknown };
  };
  if (stubbed.has(s)) return chat;
  stubbed.add(s);
  s._modelRuntime.hasConfiguredAuth = () => true;
  s.agent.state.model = STUB;
  s.agent.getApiKey = async () => "stub";
  s.agent.streamFunction = async (_m: unknown, context: unknown) => {
    sent.set(path, [...(sent.get(path) ?? []), JSON.stringify(context)]);
    const message = { role: "assistant", api: "stub", provider: "stub", model: "stub", timestamp: Date.now(), usage, content: [{ type: "text", text: "ok" }], stopReason: "stop" };
    return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; }, result: async () => message };
  };
  return chat;
}
async function turn(path: string, text: string, by?: { sessionId: string; personId: string }): Promise<string[]> {
  const chat = await stubbedChat(path);
  const before = sent.get(path)?.length ?? 0;
  if (by) baton.noteMessage(by.sessionId, by.personId);
  const { turn: t } = chat.acceptPrompt(text, undefined, "server", undefined, by ? { sentByBaton: { by: by.personId } } : undefined);
  await t;
  await piSession(chat).waitForIdle();
  const got = (sent.get(path) ?? []).slice(before);
  assert.ok(got.length > 0, `the model was called for ${path}`);
  return got;
}
async function until(cond: () => boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---- the reconciler's decide seam: a fake that records every request and makes one conflict ------------------

const requests: DecisionRequest[] = [];
const days = (s: string) => /(\d+) days/.exec(s)?.[1];
const fake: DecisionProvider = {
  id: "chain",
  label: "fake",
  async decide(req) {
    requests.push(req);
    const state = req.state as any;
    const answers: Record<string, any> = {};
    for (const [qid, q] of Object.entries(req.questions)) {
      const ids = [...JSON.stringify(q.instructions).matchAll(/D\d+/g)].map((m) => m[0]);
      const contra = () => ids.length >= 2 && days(state.decisions[ids[0]!].statement) !== days(state.decisions[ids[1]!].statement);
      if (q.type === "choice" && qid.startsWith("pair")) {
        const c = contra() ? 0.93 : 0.05;
        answers[qid] = { type: "choice", choice: c > 0.5 ? "conflict" : "different", probabilities: { conflict: c, same: 0, different: 1 - c }, confidence: 1 };
      } else if (qid === "restates") answers[qid] = { type: "boolean", p: 0 };
      else if (q.type === "boolean") answers[qid] = { type: "boolean", p: contra() ? 0.93 : 0.05 };
      else if (q.type === "choice" && qid === "outcome") answers[qid] = { type: "choice", choice: "a", probabilities: { a: 1 }, confidence: 1 };
      else if (q.type === "choice") {
        const choice = decisions.areaKeyOf(state.new[qid].name);
        answers[qid] = { type: "choice", choice, probabilities: { [choice]: 1 }, confidence: 1 };
      }
    }
    return { answers, provider: "jev", model: "fake", latencyMs: 1 };
  },
};
reconcile.setReconcileDeps({ provider: () => fake, excluded: () => false });

let seq = 0;
async function decided(file: string, by: string, area: string, statement: string): Promise<void> {
  const last = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!).id;
  const id = () => `hs${(++seq).toString(16).padStart(6, "0")}`;
  const [u, s, a] = [id(), id(), id()];
  const ts = new Date().toISOString();
  const decision = { area, statement, quote: statement };
  appendFileSync(
    file,
    [
      { type: "message", id: u, parentId: last, timestamp: ts, message: { role: "user", content: [{ type: "text", text: statement }] } },
      { type: "custom", customType: BATON_SENT_ENTRY, data: { v: 1, targetId: u, by }, id: s, parentId: u, timestamp: ts },
      { type: "message", id: a, parentId: s, timestamp: ts, message: { role: "assistant", content: [{ type: "toolCall", name: "record_decision", arguments: decision }] } },
    ]
      .map((l) => `${JSON.stringify(l)}\n`)
      .join(""),
  );
  await recordDecision(file, { ...decision, ownerArea: area });
}

describe("an org's history reaches its readers and none of the surfaces that never read it", async () => {
  const org = await orgs.createOrg({ name: "Qorvex Holdings", dir: join(root, "ws") });
  mkdirSync(join(root, "proj"));
  const project = await orgs.addProject(org.id, { name: "Ledger", root: join(root, "proj") });
  const sp = store.projectOverseerPaths(project.id);
  store.writePoSettings(sp, { ...store.readPoSettings(sp), holdMin: 0 });
  const maria = await orgs.addPerson(org.id, { name: "Maria Lopez", role: "Payroll", decides: ["invoicing"] });
  const tony = await orgs.addPerson(org.id, { name: "Tony Reyes", role: "IT" });
  const ana = await orgs.addPerson(org.id, { name: "Ana Ruiz", role: "Sales" });
  await owner.setOwner(org.id, maria.id);
  await po.ensureProjectOverseer(project.id);
  const host = hostOf(org.id);

  /** A person's decision recorded with its private words (the history's own record, as a capture writes it). */
  const marked = (key: string, sessionId?: string): HistoryInput => ({
    kind: "decision.recorded",
    outcome: "deferred",
    projects: { primary: project.id },
    entities: sessionId ? [{ type: "session", id: sessionId }] : [],
    actors: { decidedBy: { kind: "person", id: maria.id }, recordedBy: { kind: "model" }, executedBy: { kind: "sova" } },
    source: { adapter: "surfaces-test", version: 1, key },
    decision: { disposition: "defer", options: [{ id: "bank", outcome: "deferred" }, { id: "csv", outcome: "selected" }], authority: { kind: "person", id: maria.id } },
    ...(sessionId ? { evidence: [{ n: 1, kind: "transcript" as const, session: sessionId, entry: "none", check: "unchecked" as const }] } : {}),
    rationale: {
      what: `Bank sync deferred ${MARK}`,
      reason: { text: `The ledger export is not approved ${MARK}`, author: { kind: "person", id: maria.id }, contemporaneous: true },
      options: [
        { id: "bank", label: `Direct bank API ${MARK}`, condition: `until ${MARK} is approved` },
        { id: "csv", label: "Weekly CSV", reason: `fewer steps ${MARK}` },
      ],
      quotes: [{ n: 1, text: `Not yet ${MARK}` }],
    },
  });
  const [first] = await host.record([marked("surfaces:first")]);

  /** Every hand-off session this test ran, with a token for its share page when it has one. */
  const handoffs: { label: string; sessionId: string; path: string; token?: string; person: string }[] = [];

  test("positive control: the operator's History reads and routes carry the words, and they are in the history's files", async () => {
    const op = { role: "operator" } as const;
    const d = host.history.event(op, first!)!;
    assert.ok(JSON.stringify(d).includes(MARK), "the event's detail");
    assert.ok(host.history.search(op, { text: MARK }).items.some((i) => i.id === first), "a literal search finds it");
    const res = await historyApp.request(`/api/orgs/${org.id}/history/events/${first}`);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes(MARK), "GET …/history/events/:eid");
    const files = readdirSync(host.history.paths.rationale);
    assert.ok(files.some((f) => readFileSync(join(host.history.paths.rationale, f), "utf8").includes(MARK)), "a rationale file holds them");
  });

  test("positive control: the project overseer's sova_history reads its own project's words; sova_decide records its own only in the history", async () => {
    const ctx = {
      engine: org.id,
      projectId: project.id,
      attended: () => false,
      overseerId: () => "conv1",
      effective: () => ({ autonomy: "L0" as const }),
      envelope: () => envelopeFor(org.id, project.id, { by: "overseer", attended: false }),
      read: (run: (p: any) => Promise<any>) => (_id: string, p: any) => run(p ?? {}),
      act: (_name: string, run: (p: any, id: string) => Promise<any>) => (id: string, p: any) => run(p ?? {}, id),
      heldText: () => "",
    } as never;
    const list = historyTools.historyTools(org.id, ctx);
    const run = async (name: string, params: Record<string, unknown>) =>
      ((await (list.find((t) => t.name === name)!.execute as any)(`tc${++seq}`, params)) as { content: { text: string }[] }).content[0]!.text;
    assert.ok((await run("sova_history", { action: "event", event: first })).includes(MARK), "sova_history event");
    await run("sova_decide", { disposition: "do-not-do", what: `Leave the payroll export alone ${DECIDE}`, reason: `It is owned by finance ${DECIDE}` });
    assert.ok(host.history.search({ role: "operator" }, { text: DECIDE }).total >= 1, "sova_decide's words are in the history");
    // Its runtime on the stub, as a coding session it starts inherits its model (setup, not a check).
    await turn((await po.ensureProjectOverseer(project.id)).path, "What is pending?");
  });

  test("a gathering session the overseer starts: its model never gets them", async () => {
    const tool = po.toolsForTest(project.id).find((t) => t.name === "sova_start_gathering")!;
    const out = await tool.execute("t1", { gap: "none", person: "Tony Reyes", why: "Nobody has said this yet.", public_title: "Servers", goal: "Find where the ledger runs", question: "Where does it run?" }, undefined, undefined, undefined as never);
    const id = (out.details as { id: string }).id;
    const hit = baton.batonById(id)!;
    const path = baton.sessionPathOf(hit.dir, hit.row);
    const token = baton.rotateLink(id).token;
    handoffs.push({ label: "gathering", sessionId: id, path, token, person: tony.id });
    // The history now cites this very session, with its words: a session-keyed read would find them.
    await host.record([marked(`surfaces:${id}`, id)]);
    assert.ok(!leaks(JSON.stringify(out)), "nor the tool's result");
    assert.ok(!leaks(loadout.renderBatonPrompt(id)), "its system prompt");
    for (const c of await turn(path, "It runs on the office server.", { sessionId: id, personId: tony.id })) assert.ok(!leaks(c), "gathering: a model request");
  });

  test("an offer: its model never gets them", async () => {
    const c = await baton.createBaton({ orgId: org.id, projectId: project.id, to: [maria.id, ana.id], publicTitle: "Pricing", goal: "Who sets the prices" });
    const token = c.links!.find((l) => l.personId === ana.id)!.token;
    handoffs.push({ label: "offer", sessionId: c.sessionId, path: c.path, token, person: ana.id });
    await host.record([marked(`surfaces:${c.sessionId}`, c.sessionId)]);
    for (const got of await turn(c.path, "I set the prices.", { sessionId: c.sessionId, personId: ana.id })) assert.ok(!leaks(got), "offer: a model request");
  });

  test("Send to person…: its model never gets them", async () => {
    const p = store.projectOverseerPaths(project.id);
    addTodo({ text: "Ask Tony about backups" }, p.todos, p.ideas);
    const todo = readTodos(p.todos).todos.at(-1)!;
    const made = await (await import("./overseer-org-part")).sendItem(org.id, project.id, { todoId: todo.id, to: tony.id, publicTitle: "Backups", question: "How are backups made?" }, (t: string) => `/h/${t}`);
    const token = made.links[0]!.link.slice(3);
    handoffs.push({ label: "send", sessionId: made.sessionId, path: made.path, token, person: tony.id });
    await host.record([marked(`surfaces:${made.sessionId}`, made.sessionId)]);
    for (const got of await turn(made.path, "Nightly, to a USB disk.", { sessionId: made.sessionId, personId: tony.id })) assert.ok(!leaks(got), "send to person: a model request");
  });

  test("the reconciler: its decide calls never get them; the settle session it starts never does either", async () => {
    const s1 = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Terms A", goal: "g" }, { mintLink: false });
    const s2 = await baton.createBaton({ orgId: org.id, projectId: project.id, to: ana.id, publicTitle: "Terms B", goal: "g" }, { mintLink: false });
    await host.record([marked(`surfaces:${s1.sessionId}`, s1.sessionId)]);
    await decided(s1.path, tony.id, "invoicing", "Invoices are due 30 days after issue.");
    await decided(s2.path, ana.id, "invoicing", "Invoices are due 60 days after issue.");
    const info = await reconcile.reconcileProject(org.id, project.id);
    assert.ok(requests.length > 0, "the decide seam was called");
    for (const r of requests) assert.ok(!leaks(JSON.stringify(r)), "a decide request");
    const conflict = info.conflicts.find((c) => c.state === "open" && c.batonSessionId);
    assert.ok(conflict, `a conflict was routed with a settle session (${JSON.stringify(info.conflicts)})`);
    const hit = baton.batonById(conflict!.batonSessionId!)!;
    const path = baton.sessionPathOf(hit.dir, hit.row);
    const token = baton.rotateLink(hit.row.sessionId).token;
    handoffs.push({ label: "settle", sessionId: hit.row.sessionId, path, token, person: maria.id });
    assert.ok(!leaks(JSON.stringify(hit.row)), "nor the question it wrote");
    for (const got of await turn(path, "Thirty days.", { sessionId: hit.row.sessionId, personId: maria.id })) assert.ok(!leaks(got), "settle: a model request");
  });

  test("the wrap-up of each of them: its turn never gets them", async () => {
    for (const h of handoffs) {
      const before = sent.get(h.path)?.length ?? 0;
      await baton.markDone(h.sessionId);
      const state = () => baton.batonById(h.sessionId)!.row.wrapup?.state;
      for (let i = 0; i < 1000 && state() !== "done" && state() !== "failed"; i++) await new Promise((r) => setTimeout(r, 10));
      const got = (sent.get(h.path) ?? []).slice(before);
      assert.ok(got.some((c) => c.includes("[Wrap-up")), `${h.label}: the wrap-up turn ran`);
      for (const c of got) assert.ok(!leaks(c), `${h.label}: a wrap-up request`);
    }
  });

  test("share pages (/h/): the view, the token's view and the share routes' answers never carry them", async () => {
    assert.ok(handoffs.length >= 4);
    for (const h of handoffs) {
      const hit = baton.batonById(h.sessionId)!;
      assert.ok(!leaks(JSON.stringify(await readView(hit.row, hit.dir, h.person))), `${h.label}: readView`);
      if (!h.token) continue;
      assert.ok(!leaks(JSON.stringify(await viewForToken(h.token))), `${h.label}: viewForToken`);
      for (const p of [`/api/h/${h.token}`, `/h/${h.token}`]) {
        const res = await share.request(p);
        assert.ok(!leaks(await res.text()), `${h.label}: GET ${p} (${res.status})`);
      }
    }
  });

  test("the owner page (/i/): its home, project and conversation views and the share routes' answers never carry them", async () => {
    const home = await ownerView(org.id);
    assert.ok(!leaks(JSON.stringify(home)), "home");
    assert.ok(!leaks(JSON.stringify(await ownerView(org.id, { project: handleOf("q", project.id) }))), "project");
    let conversations = 0;
    for (const h of handoffs) {
      const conv = await ownerView(org.id, { conversation: handleOf("k", h.sessionId) }).then(
        (v) => (conversations++, v),
        (err: unknown) => ({ refused: String(err) }),
      );
      assert.ok(!leaks(JSON.stringify(conv)), `${h.label}: conversation`);
    }
    assert.ok(conversations > 0, "control: a conversation view answered");
    const { token } = owner.ownerLinkFor(org.id);
    let answered = 0;
    const paths = [`/i/${token}`, `/api/i/${token}`, `/api/i/${token}/p/${handleOf("q", project.id)}`, ...handoffs.map((h) => `/api/i/${token}/c/${handleOf("k", h.sessionId)}`)];
    for (const p of paths) {
      const res = await share.request(p);
      if (res.status === 200) answered++;
      assert.ok(!leaks(await res.text()), `GET ${p} (${res.status})`);
    }
    assert.ok(answered > 0, "control: an /i/ route answered");
  });

  test("the session list and the attention digest never carry them", async () => {
    const rows = await listSessions();
    assert.ok(rows.some((r) => r.org?.orgId === org.id), "the org's sessions are listed");
    assert.ok(!leaks(JSON.stringify(rows)), "session list rows");
    assert.ok(!leaks(JSON.stringify(await overseer.attentionDigest())), "the digest");
  });

  test("the global Overseer's prompt never carries them (it reads history only through sova_org_history, asked)", async () => {
    const { path } = await overseer.ensureOverseer();
    for (const got of await turn(path, "What needs me?")) assert.ok(!leaks(got), "an Overseer request");
  });

  test("a coding session started from an item never gets them", async (t) => {
    const { setBuildSessionMakerForTest } = await import("./build-loadout");
    setBuildSessionMakerForTest(async (cwd, id) => {
      const dir = join(agentDir, "sessions", "--coding--");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `2026-09-27T00-00-00-000Z_${id}.jsonl`);
      writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd })}\n`);
      markOwned(canonicalPath(file));
      await stubbedChat(canonicalPath(file));
      return canonicalPath(file);
    });
    t.after(() => setBuildSessionMakerForTest(null));
    const p = store.projectOverseerPaths(project.id);
    addTodo({ text: "Add a CSV export" }, p.todos, p.ideas);
    const todo = readTodos(p.todos).todos.at(-1)!;
    await disposeHeldChat((await po.ensureProjectOverseer(project.id)).path, "closed by the test");
    const made = await po.codeItem(project.id, { todoId: todo.id });
    assert.equal(made.notPrompted, undefined, "its first prompt was sent");
    await piSession(await acquireChat(made.path)).waitForIdle();
    await until(() => (sent.get(made.path)?.length ?? 0) > 0);
    for (const got of sent.get(made.path)!) {
      assert.ok(!leaks(got), "a coding session request");
      assert.ok(!/"sova_history"|"sova_decide"|"sova_org_history"/.test(got), "no history tool in its loadout");
    }
    assert.ok(sent.get(made.path)!.some((c) => c.includes("Add a CSV export")), "control: the request carried its first prompt");
    assert.ok(!leaks(readFileSync(made.path, "utf8")), "nor its session file");
  });

  test("no hand-off session's model was offered a history tool", () => {
    for (const h of handoffs) for (const c of sent.get(h.path) ?? []) assert.ok(!/"sova_history"|"sova_decide"|"sova_org_history"/.test(c), `${h.label}: its loadout`);
  });

  test("control: every surface above ran, so each absence means something", () => {
    assert.deepEqual(handoffs.map((h) => h.label), ["gathering", "offer", "send", "settle"]);
    assert.ok(host.history.search({ role: "operator" }, { text: MARK }).total >= 5, "the words were in the history the whole time");
  });
});
