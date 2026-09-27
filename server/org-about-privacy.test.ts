// Run: pnpm exec tsx --test server/org-about-privacy.test.ts. §app.organizations/about: the org's About
// text reaches a project overseer's prompt and nothing else. A throwaway PI_CODING_AGENT_DIR (with
// this tree's pi-config extensions linked in), an org workspace and a project root in the OS temp
// dir, deleted after; ~/.pi is never touched. Every model is a stub that records what it was sent.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { BATON_DECISION_ENTRY, BATON_SENT_ENTRY } from "../shared/baton";
import type { DecisionProvider, DecisionRequest } from "./decide";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-about-")));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
symlinkSync(resolve(import.meta.dirname, "..", "pi-config", "extensions"), join(agentDir, "extensions"));

const orgs = await import("./orgs");
const baton = await import("./baton");
const loadout = await import("./baton-loadout");
const wrap = await import("./baton-wrapup");
const po = await import("./project-overseer");
const reconcile = await import("./reconcile");
const decisions = await import("./decisions");
const overseer = await import("./overseer");
const { acquireChat, disposeAllChats, disposeHeldChat } = await import("./chat-manager");
const { readView, viewForToken } = await import("./share/hub");
const { createShareServer } = await import("./share/listener");
const { listSessions } = await import("./sessions-index");
const { WorkspaceCommitter } = await import("./workspace-commits");
const { settled } = await import("./workspace-git");
const { addTodo, readTodos } = await import("./overseer-todos");
const store = await import("./project-overseer-store");
const { canonicalPath } = await import("./paths");
const { markOwned } = await import("./write-guard");

const MARK = "ABOUT-SENTINEL-7f3a1c";
const ABOUT = `${MARK}. They pay late; keep Maria out of pricing.`;
/** Neither the marker nor a phrase of the text. */
const leaks = (s: string) => s.includes(MARK) || s.includes("pay late");

const server = createShareServer();
after(async () => {
  server.close();
  server.closeAllConnections();
  await disposeAllChats();
  await settled(join(root, "ws"));
  rmSync(root, { recursive: true, force: true });
});

// ---- a stub model on each runtime: records every request, replies "ok" -----------------------------------

const STUB = {
  id: "stub", name: "stub", api: "stub", provider: "stub", baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000,
};
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
type Chat = Awaited<ReturnType<typeof acquireChat>>;
/** Every request each session's model got, by session path, as sent (system prompt, messages, tools). */
const sent = new Map<string, string[]>();
const stubbed = new WeakSet<object>();
async function stubbedChat(path: string): Promise<Chat> {
  const chat = await acquireChat(path);
  const s = chat.session as unknown as {
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
/** The system prompt a request carried: its leading prompt and its system messages (pi 0.87 keeps
    the prompt as sections on them). */
function systemOf(request: string): string {
  const c = JSON.parse(request) as { systemPrompt?: unknown; messages?: { role: string }[] };
  return JSON.stringify({ head: c.systemPrompt ?? null, system: (c.messages ?? []).filter((m) => m.role === "system") });
}
/** One model turn: a person's message into a hand-off session (as the share route sends it), or a plain prompt. */
async function turn(path: string, text: string, by?: { sessionId: string; personId: string }): Promise<string[]> {
  const chat = await stubbedChat(path);
  const before = sent.get(path)?.length ?? 0;
  if (by) loadout.recordNoted(chat, by.personId, baton.noteMessage(by.sessionId, by.personId));
  const { turn: t } = chat.acceptPrompt(text, undefined, "server", undefined, by ? { sentByBaton: { by: by.personId } } : undefined);
  await t;
  await chat.session.waitForIdle();
  const got = (sent.get(path) ?? []).slice(before);
  assert.ok(got.length > 0, `the model was called for ${path}`);
  return got;
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
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
reconcile.setReconcileDeps({ provider: () => fake, excluded: () => false, endBaton: async (sid) => void baton.closeBaton(sid) });

/** A decision as record_decision leaves it in a transcript nobody holds open. */
let seq = 0;
function decided(file: string, by: string, area: string, statement: string): void {
  const last = JSON.parse(readFileSync(file, "utf8").trim().split("\n").at(-1)!).id;
  const id = () => `ab${(++seq).toString(16).padStart(6, "0")}`;
  const [u, s, a, d] = [id(), id(), id(), id()];
  const ts = new Date().toISOString();
  const decision = { area, statement, quote: statement };
  appendFileSync(
    file,
    [
      { type: "message", id: u, parentId: last, timestamp: ts, message: { role: "user", content: [{ type: "text", text: statement }] } },
      { type: "custom", customType: BATON_SENT_ENTRY, data: { v: 1, targetId: u, by }, id: s, parentId: u, timestamp: ts },
      { type: "message", id: a, parentId: s, timestamp: ts, message: { role: "assistant", content: [{ type: "toolCall", name: "record_decision", arguments: decision }] } },
      { type: "custom", customType: BATON_DECISION_ENTRY, data: { v: 1, ...decision, by }, id: d, parentId: a, timestamp: ts },
    ]
      .map((l) => `${JSON.stringify(l)}\n`)
      .join(""),
  );
}

describe("the About text reaches the project overseer's prompt and nothing else", async () => {
  const org = await orgs.createOrg({ name: "Qorvex Holdings", dir: join(root, "ws") });
  mkdirSync(join(root, "proj"));
  const project = orgs.addProject(org.id, { name: "Ledger", root: join(root, "proj") });
  const maria = orgs.addPerson(org.id, { name: "Maria Lopez", role: "Payroll", decides: ["invoicing"] });
  const tony = orgs.addPerson(org.id, { name: "Tony Reyes", role: "IT" });
  const ana = orgs.addPerson(org.id, { name: "Ana Ruiz", role: "Sales" });
  orgs.patchOrg(org.id, { about: ABOUT });
  await po.ensureProjectOverseer(org.id, project.id);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /** Every hand-off session this test ran, with a token for its share page when it has one. */
  const handoffs: { label: string; sessionId: string; path: string; token?: string; person: string }[] = [];

  test("positive control: the project overseer's model gets the text in its system prompt", async () => {
    const { path } = await po.ensureProjectOverseer(org.id, project.id);
    const got = await turn(path, "What is pending?");
    assert.ok(got.some((c) => c.includes(MARK) && c.includes("pay late")), "the marker is in what its model was sent");
    assert.ok(got.every((c) => systemOf(c).includes(MARK)), "in its system prompt, on every request");
  });

  test("a gathering session the overseer starts: its model never gets it", async () => {
    const tool = po.toolsForTest(org.id, project.id).find((t) => t.name === "sova_start_gathering")!;
    const out = await tool.execute("t1", { person: "Tony Reyes", public_title: "Servers", goal: "Find where the ledger runs", question: "Where does it run?" }, undefined, undefined, undefined as never);
    const id = (out.details as { id: string }).id;
    const hit = baton.batonById(id)!;
    const path = baton.sessionPathOf(hit.dir, hit.row);
    const token = baton.rotateLink(id).token;
    handoffs.push({ label: "gathering", sessionId: id, path, token, person: tony.id });
    assert.ok(!leaks(JSON.stringify(out)), "nor the tool's result");
    for (const c of await turn(path, "It runs on the office server.", { sessionId: id, personId: tony.id })) assert.ok(!leaks(c), "gathering: a model request");
  });

  test("an offer: its model never gets it", async () => {
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: [maria.id, ana.id], publicTitle: "Pricing", goal: "Who sets the prices" });
    const token = c.links!.find((l) => l.personId === ana.id)!.token;
    handoffs.push({ label: "offer", sessionId: c.sessionId, path: c.path, token, person: ana.id });
    for (const got of await turn(c.path, "I set the prices.", { sessionId: c.sessionId, personId: ana.id })) assert.ok(!leaks(got), "offer: a model request");
  });

  test("Send to person…: its model never gets it", async () => {
    const p = store.projectOverseerPaths(org.id, project.id);
    addTodo({ text: "Ask Tony about backups" }, p.todos, p.ideas);
    const todo = readTodos(p.todos).todos.at(-1)!;
    const made = await po.sendItem(org.id, project.id, { todoId: todo.id, to: tony.id, publicTitle: "Backups", question: "How are backups made?" }, (t) => `/h/${t}`);
    const token = made.links[0]!.link.slice(3);
    handoffs.push({ label: "send", sessionId: made.sessionId, path: made.path, token, person: tony.id });
    for (const got of await turn(made.path, "Nightly, to a USB disk.", { sessionId: made.sessionId, personId: tony.id })) assert.ok(!leaks(got), "send to person: a model request");
  });

  test("the reconciler: its decide calls never get it; the settle session it starts never does either", async () => {
    const s1 = baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Terms A", goal: "g", mintLink: false });
    const s2 = baton.createBaton({ orgId: org.id, projectId: project.id, to: ana.id, publicTitle: "Terms B", goal: "g", mintLink: false });
    decided(s1.path, tony.id, "invoicing", "Invoices are due 30 days after issue.");
    decided(s2.path, ana.id, "invoicing", "Invoices are due 60 days after issue.");
    const info = await reconcile.reconcileProject(org.id, project.id);
    assert.ok(requests.length > 0, "the decide seam was called");
    for (const r of requests) assert.ok(!leaks(JSON.stringify(r)), "a decide request");
    const conflict = info.conflicts.find((c) => c.state === "open" && c.batonSessionId);
    assert.ok(conflict, `a conflict was routed with a settle session (${JSON.stringify(info.conflicts)})`);
    const hit = baton.batonById(conflict!.batonSessionId!)!;
    const path = baton.sessionPathOf(hit.dir, hit.row);
    assert.equal(hit.row.holder, maria.id, "to the area's owner");
    const token = baton.rotateLink(hit.row.sessionId).token;
    handoffs.push({ label: "settle", sessionId: hit.row.sessionId, path, token, person: maria.id });
    assert.ok(!leaks(JSON.stringify(hit.row)), "nor the question it wrote");
    for (const got of await turn(path, "Thirty days.", { sessionId: hit.row.sessionId, personId: maria.id })) assert.ok(!leaks(got), "settle: a model request");
  });

  test("the wrap-up of each of them: its turn never gets it", async () => {
    for (const h of handoffs) {
      baton.markDone(h.sessionId, new Date());
      const before = sent.get(h.path)?.length ?? 0;
      await wrap.runWrapup(h.sessionId, [...loadout.BATON_TOOLS]);
      const got = (sent.get(h.path) ?? []).slice(before);
      assert.ok(got.some((c) => c.includes("[Wrap-up")), `${h.label}: the wrap-up turn ran`);
      for (const c of got) assert.ok(!leaks(c), `${h.label}: a wrap-up request`);
    }
  });

  test("share pages: the view, the token's view and the share listener's HTTP answers never carry it", async () => {
    assert.ok(handoffs.length >= 4);
    for (const h of handoffs) {
      const hit = baton.batonById(h.sessionId)!;
      assert.ok(!leaks(JSON.stringify(await readView(hit.row, hit.dir, h.person))), `${h.label}: readView`);
      if (!h.token) continue;
      assert.ok(!leaks(JSON.stringify(await viewForToken(h.token))), `${h.label}: viewForToken`);
      for (const p of [`/api/h/${h.token}`, `/h/${h.token}`]) {
        const res = await fetch(base + p);
        assert.ok(!leaks(await res.text()), `${h.label}: GET ${p} (${res.status})`);
      }
    }
  });

  test("the session list and the attention digest never carry it", async () => {
    const rows = await listSessions();
    assert.ok(rows.some((r) => r.org?.orgId === org.id), "the org's sessions are listed");
    assert.ok(!leaks(JSON.stringify(rows)), "session list rows");
    assert.ok(!leaks(JSON.stringify(await overseer.attentionDigest())), "the digest");
  });

  test("the global Overseer's model never gets it", async () => {
    const { path } = await overseer.ensureOverseer();
    for (const got of await turn(path, "What needs me?")) assert.ok(!leaks(got), "an Overseer request");
  });

  test("a coding session started from an item never gets it", async () => {
    // The route starting one calls, as the server wires it: a new session file (its first prompt is sent in-process).
    overseer.setOverseerDispatch(async (route, init) => {
      const body = JSON.parse(String(init?.body));
      if (route === "/api/sessions") {
        const id = randomUUID();
        const dir = join(agentDir, "sessions", "--coding--");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `2026-09-27T00-00-00-000Z_${id}.jsonl`);
        writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: body.cwd })}\n`);
        markOwned(canonicalPath(file));
        // Opened here, on the stub, before Sova's own open and first prompt (promptSession) reach it.
        await stubbedChat(canonicalPath(file));
        return Response.json({ id, path: canonicalPath(file) }, { status: 201 });
      }
      return Response.json({ error: "not wired in this test" }, { status: 404 });
    });
    const p = store.projectOverseerPaths(org.id, project.id);
    addTodo({ text: "Add a CSV export" }, p.todos, p.ideas);
    const todo = readTodos(p.todos).todos.at(-1)!;
    // The overseer's runtime runs the stub model, which a coding session would inherit: close it first.
    await disposeHeldChat((await po.ensureProjectOverseer(org.id, project.id)).path, "closed by the test");
    const made = await po.codeItem(org.id, project.id, { todoId: todo.id });
    assert.equal(made.notPrompted, undefined, "its first prompt was sent");
    await (await acquireChat(made.path)).session.waitForIdle();
    await until(() => (sent.get(made.path)?.length ?? 0) > 0);
    for (const got of sent.get(made.path)!) assert.ok(!leaks(got), "a coding session request");
    assert.ok(sent.get(made.path)!.some((c) => c.includes("Add a CSV export")), "control: the request carried its first prompt");
    assert.ok(!leaks(readFileSync(made.path, "utf8")), "nor its session file");
  });

  test("a workspace commit's message names about.md by path only", async () => {
    const dir = orgs.orgDir(org.id);
    orgs.patchOrg(org.id, { about: `${ABOUT} Again.` });
    await settled(dir);
    const outcome = await new WorkspaceCommitter(() => [{ id: org.id, dir }], { everyMs: 0 }).tick();
    assert.ok(outcome.some((o) => o && !("error" in o && o.error)), JSON.stringify(outcome));
    const messages = execFileSync("git", ["-C", dir, "log", "--format=%B"], { encoding: "utf8" });
    assert.match(messages, /about\.md/);
    assert.ok(!leaks(messages), "no commit message carries it");
  });

  test("control: every surface above ran, so each absence means something", () => {
    assert.deepEqual(handoffs.map((h) => h.label), ["gathering", "offer", "send", "settle"]);
  });
});

// ---- the structure: one reader -----------------------------------------------------------------------------

describe("the About text has one reader in the server", () => {
  const serverDir = resolve(import.meta.dirname);
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [join(dir, e.name)] : []));
  const sources = files(serverDir).map((f) => ({ file: relative(serverDir, f), text: readFileSync(f, "utf8") }));
  /** The server files (not tests) whose text matches. */
  const using = (re: RegExp) => sources.filter((s) => re.test(s.text)).map((s) => s.file).sort();

  test("the files are named only by the store", () => {
    assert.deepEqual(using(/about\.md|org-history\.jsonl/), ["orgs.ts"]);
  });

  test("its readers are called only by the org detail and the project overseer's prompt", () => {
    assert.deepEqual(using(/\breadOrgAbout\b/), ["orgs.ts", "project-overseer.ts"]);
    assert.deepEqual(using(/\breadOrgHistory\b/), ["orgs.ts"]);
    assert.deepEqual(using(/\borgDetail\b/), ["org-routes.ts", "orgs.ts"]);
    assert.deepEqual(using(/\borgPage\b/), ["org-routes.ts"]);
  });

  test("in the project overseer, only the prompt's render reads it, and the owner-update guard (to keep it out)", () => {
    const text = sources.find((s) => s.file === "project-overseer.ts")!.text;
    const calls = [...text.matchAll(/\breadOrgAbout\(/g)].map((m) => m.index!);
    assert.equal(calls.length, 2, "two calls");
    const within = (at: number, head: string) => {
      const start = text.indexOf(head);
      const end = text.indexOf("\n}\n", start);
      return start >= 0 && at > start && at < end;
    };
    assert.ok(within(calls[0]!, "export function renderProjectOverseerPrompt(") || within(calls[0]!, "export function ownerUpdateLeak("));
    assert.ok(within(calls[1]!, "export function ownerUpdateLeak(") || within(calls[1]!, "export function renderProjectOverseerPrompt("));
    assert.ok(within(calls[0]!, "export function renderProjectOverseerPrompt(") !== within(calls[1]!, "export function renderProjectOverseerPrompt("), "one in each");
    // The guard only answers which source a text repeats: it returns a label, never the text.
    const guard = text.slice(text.indexOf("export function ownerUpdateLeak("), text.indexOf("\n}\n", text.indexOf("export function ownerUpdateLeak(")));
    assert.match(guard, /: string \| null \{/);
    for (const r of guard.matchAll(/return ([^;]+);/g)) assert.match(r[1]!, /^(null|what|true|false|PRIVATE|OTHER|"[^"]*")$/, `returns ${r[1]}`);
  });
});
