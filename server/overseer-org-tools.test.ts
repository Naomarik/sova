// Run: pnpm exec tsx --test server/overseer-org-tools.test.ts. §app.overseer/org-tools and its
// sub-claims: the global Overseer's organization tools, driven in-process through the real org,
// baton, decisions and project-overseer routes with the Overseer's sender mark. A throwaway
// PI_CODING_AGENT_DIR (this tree's pi-config extensions linked in), org workspaces and project roots
// in the OS temp dir, deleted after; ~/.pi is never touched. Every model is a stub.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import type { SovaConfirmItem } from "../shared/protocol";
import type { OverseerToolHost } from "./overseer-tools";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-oorg-")));
// A hosted runtime can still write here after after() ran (pi's catalogs, usage cache): exit is last.
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
symlinkSync(resolve(import.meta.dirname, "..", "pi-config", "extensions"), join(agentDir, "extensions"));

const { Hono } = await import("hono");
const orgs = await import("./orgs");
const baton = await import("./baton");
const po = await import("./project-overseer");
const store = await import("./project-overseer-store");
const overseer = await import("./overseer");
const tools = await import("./overseer-tools");
const view = await import("./overseer-org-view");
const confirm = await import("./overseer-confirm");
const { DEFAULT_CAPS, overseerActionsFile, writeOverseerState } = await import("./overseer-store");
const { registerOrgRoutes } = await import("./org-routes");
const { registerProjectOverseerRoutes } = await import("./project-overseer-routes");
const { registerDecisionRoutes } = await import("./decisions-routes");
const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { settled } = await import("./workspace-git");
const { canonicalPath } = await import("./paths");
const { markOwned } = await import("./write-guard");
const { getSessionSummary } = await import("./sessions-index");
const { normalizeEntries, readActiveBranch } = await import("./transcript");
const { orgLookup } = await import("./org-sessions");
const { setReconcileDeps } = await import("./reconcile");
const { OVERSEER_SENT_ENTRY } = await import("../shared/protocol");

after(async () => {
  await disposeAllChats();
  for (const ws of ["ws", "ws2", "ws3"]) await settled(join(root, ws)).catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

// The reconciler's decide seam: nothing to compare, nothing to call.
setReconcileDeps({ provider: () => ({ id: "chain", label: "fake", decide: async () => ({ answers: {}, provider: "fake", model: "fake", latencyMs: 1 }) }) as never, excluded: () => false });

// ---- the server's routes, in-process ------------------------------------------------------------------------

const app = new Hono();
registerOrgRoutes(app);
registerProjectOverseerRoutes(app);
registerDecisionRoutes(app);
/** New coding sessions: a session file of its own, as POST /api/sessions writes one. */
app.post("/api/sessions", async (c) => {
  const body = (await c.req.json()) as { cwd: string };
  const id = randomUUID();
  const dir = join(agentDir, "sessions", "--coding--");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-09-28T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: body.cwd })}\n`);
  markOwned(canonicalPath(file));
  await stubbed(canonicalPath(file));
  return c.json({ id, path: canonicalPath(file) }, 201);
});
overseer.setOverseerDispatch((path, init) => app.request(path, init));
/** The current Overseer, so the sender secret names someone (overseerSender reads the state). */
const OVERSEER_ID = "ov-test-0001";
writeOverseerState({ version: 1, current: OVERSEER_ID, history: [] });

// ---- a stub model on each runtime: records every request, replies "ok" ------------------------------------------

const STUB = {
  id: "stub", name: "stub", api: "stub", provider: "stub", baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000,
};
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const stubbedSet = new WeakSet<object>();
async function stubbed(path: string) {
  const chat = await acquireChat(path);
  const s = chat.session as unknown as { _modelRuntime: { hasConfiguredAuth(p: string): boolean }; agent: { state: { model: unknown }; getApiKey: unknown; streamFunction: unknown } };
  if (stubbedSet.has(s)) return chat;
  stubbedSet.add(s);
  s._modelRuntime.hasConfiguredAuth = () => true;
  s.agent.state.model = STUB;
  s.agent.getApiKey = async () => "stub";
  s.agent.streamFunction = async () => {
    const message = { role: "assistant", api: "stub", provider: "stub", model: "stub", timestamp: Date.now(), usage, content: [{ type: "text", text: "ok" }], stopReason: "stop" };
    return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message }; }, result: async () => message };
  };
  return chat;
}
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---- the Overseer's tools on a host whose turn and card the test sets ---------------------------------------------

let attended = true;
let card: SovaConfirmItem[] | null = null;
let caps = { ...DEFAULT_CAPS };
const limits = new tools.TurnLimits();
const host = {
  request: (path: string, init?: RequestInit) => overseer.requestAsOverseerForTest(path, init),
  overseerId: () => OVERSEER_ID,
  caps: () => caps,
  sessions: async () => [],
  session: async (ref: string) => {
    const path = ref.includes("/") ? ref : await overseer.pathOfId(ref);
    return path ? getSessionSummary(path) : null;
  },
  digest: async () => ({ items: [], counts: { act: 0, decide: 0, fyi: 0 } }),
  transcript: async (path: string) => normalizeEntries(await readActiveBranch(path)),
  insight: async () => null,
  held: () => null,
  answerDialog: () => {},
  open: async () => {},
  setModel: async () => {},
  setThinking: async () => "off",
  pinMode: async () => {},
  started: () => {},
  runningStarted: () => 0,
  counted: () => false,
  attended: () => attended,
  confirmed: () => card,
  peer: async () => null,
  peerIds: () => [],
  peerSession: async () => null,
  peerRequest: async () => new Response(null, { status: 404 }),
  startedOnPeer: () => {},
  links: {} as never,
  explorer: () => ({ backend: "claude-code", model: "opus[1m]", effort: "medium" }),
  explorerCwd: () => root,
  subagent: () => null,
} as unknown as OverseerToolHost;
const all = tools.overseerTools(host, limits);
const tool = (name: string) => all.find((t) => t.name === name)!;
let seq = 0;
type Ran = { ok: boolean; text: string; details?: unknown };
/** One call, as the model makes it: its text, or its refusal. Every output is kept for the marker check. */
const outputs: { label: string; text: string; about?: boolean }[] = [];
async function call(name: string, params: Record<string, unknown>, label = `${name} ${String(params.op ?? "")}`, about = false): Promise<Ran> {
  try {
    const out = await tool(name).execute(`tc${++seq}`, params, undefined, undefined, undefined as never);
    const text = (out.content as { text: string }[]).map((c) => c.text).join("\n");
    outputs.push({ label, text: `${text}\n${JSON.stringify(out.details ?? null)}`, about });
    return { ok: true, text, details: out.details };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    outputs.push({ label: `${label} (refused)`, text, about });
    return { ok: false, text };
  }
}
/** A card click's items for these things. */
const items = (...rows: SovaConfirmItem[]) => rows;
const projectItem = (orgId: string, id: string): SovaConfirmItem => ({ kind: "project", id, orgId, name: "", orgName: "" });
const personItem = (orgId: string, id: string): SovaConfirmItem => ({ kind: "person", id, orgId, name: "", orgName: "", status: "active" });
const sessionItem = (id: string): SovaConfirmItem => ({ kind: "session", id, title: "" });

// ---- markers ------------------------------------------------------------------------------------------------------------

const CONTACT = "marker.contact.7f3a@example.com";
const PHONE = "+57 300 555 0199";
const CONTACT_NEW = "newcontact.9b1e@example.org";
const ABOUT = "ABOUT-MARKER-4c2d. They pay late; keep Maria out of pricing.";
/** Any marker, in any form the tools could print it. */
function leaksContact(s: string): string | null {
  for (const m of [CONTACT, PHONE, "573005550199", CONTACT_NEW]) if (s.includes(m)) return m;
  return null;
}

describe("the organization tools (§app.overseer/org-tools)", async () => {
  const org = await orgs.createOrg({ name: "Qorvex Holdings", dir: join(root, "ws") });
  mkdirSync(join(root, "proj"));
  const project = await orgs.addProject(org.id, { name: "Ledger", root: join(root, "proj") });
  const tony = await orgs.addPerson(org.id, { name: "Tony Reyes", role: "IT", decides: ["servers"], contact: { email: CONTACT, phone: PHONE } });
  const maria = await orgs.addPerson(org.id, { name: "Maria Lopez", role: "Payroll", decides: ["invoicing"] });
  await orgs.patchOrg(org.id, { about: ABOUT });
  // A hand-off session with a link minted (the page's way), a person typing their own contact, and a referral call.
  const withLink = baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Servers", goal: "Where it runs" });
  const TOKEN = withLink.token!;
  const TOKEN2 = baton.rotateLink(withLink.sessionId).token;
  {
    const last = JSON.parse(readFileSync(withLink.path, "utf8").trim().split("\n").at(-1)!).id;
    const ts = new Date().toISOString();
    appendFileSync(
      withLink.path,
      [
        { type: "message", id: "aa000001", parentId: last, timestamp: ts, message: { role: "user", content: [{ type: "text", text: `Reach me at ${CONTACT} or ${PHONE}.` }] } },
        {
          type: "message",
          id: "aa000002",
          parentId: "aa000001",
          timestamp: ts,
          message: { role: "assistant", content: [{ type: "toolCall", id: "call1", name: "propose_roster_edit", arguments: { contact: { email: CONTACT }, name: "Ana Ruiz", role: "Sales", why: "w", quote: "q" } }] },
        },
      ]
        .map((l) => `${JSON.stringify(l)}\n`)
        .join(""),
    );
  }
  const secrets = () => [TOKEN, TOKEN2, "/h/", "/i/"];
  const leaks = (s: string, about: boolean): string | null => leaksContact(s) ?? secrets().find((t) => s.includes(t)) ?? (!about && (s.includes("ABOUT-MARKER") || s.includes("pay late")) ? "about" : null);

  test("reads: every org, one org in full, a project, a person; none carries contact, a link or the About text", async () => {
    const list = await call("sova_orgs", {});
    assert.ok(list.ok && list.text.includes("Qorvex Holdings") && list.text.includes(org.id), list.text);
    const full = await call("sova_orgs", { org: "qorvex holdings" });
    assert.ok(full.ok, full.text);
    assert.match(full.text, /Tony Reyes \(p_[a-z0-9]+\) · active · IT · decides: servers/);
    assert.match(full.text, /\[Servers\]\(sova:\/\/s\//);
    const projectRead = await call("sova_org_project", { org: org.id, project: "Ledger", items: true });
    assert.ok(projectRead.ok, projectRead.text);
    assert.match(projectRead.text, /Overseer: none yet/);
    const person = await call("sova_org_person", { org: org.id, person: "Tony Reyes" });
    assert.ok(person.ok, person.text);
    assert.match(person.text, /Contact: never shown to you/);
    assert.match(person.text, /contact changed|profile history/i);
    for (const r of [list, full, projectRead, person]) assert.equal(leaks(r.text, false), null, r.text.slice(0, 200));
  });

  test("the About text reaches the model only through sova_orgs {org, about: true}", async () => {
    const r = await call("sova_orgs", { org: org.id, about: true }, "sova_orgs about", true);
    assert.ok(r.text.includes("ABOUT-MARKER-4c2d"), "control: the one read carries it");
    assert.equal(leaksContact(r.text), null);
  });

  test("q13: sova_read_session and sova_session of an org session redact every roster contact value; the referral call shows no contact", async () => {
    const read = await call("sova_read_session", { session: withLink.sessionId, from: "start", items: 40, chars: 12000 });
    assert.ok(read.ok, read.text);
    assert.ok(read.text.includes("Reach me at [contact] or [contact]."), `control: the person's message is shown, redacted: ${read.text}`);
    assert.match(read.text, /→ propose_roster_edit Ana Ruiz/, "the call's first plain argument, never its contact");
    const detail = await call("sova_session", { session: withLink.sessionId });
    assert.ok(detail.ok, detail.text);
    const peer = await overseer.renderPeerRead(withLink.path, { from: "start", items: 40, chars: 12000 });
    assert.ok(peer.text.includes("[contact]"), "a peer's read of it is redacted the same way");
    for (const r of [read.text, detail.text, peer.text]) assert.equal(leaksContact(r), null, r);
  });

  test("the contact redactor: values of 5+ characters, a phone's digits too; arguments are never rewritten", () => {
    const r = view.contactRedactor(["someone@example.com", "3005550199"]);
    assert.equal(r.text("mail someone@example.com, call 3005550199"), "mail [contact], call [contact]");
    assert.deepEqual(r.deep({ a: ["someone@example.com"] }), { a: ["[contact]"] });
    assert.deepEqual(view.scrubContactArgs({ op: "add", contact: { email: "x@y.zz" }, name: "N" }), { op: "add", contact: "[contact]", name: "N" });
    assert.ok(view.contactValues().includes(CONTACT) && view.contactValues().includes("573005550199"));
  });

  test("writes act for the user, marked via the Overseer (§app.overseer/org-attribution); a request without the secret records no via", async () => {
    attended = true;
    card = null;
    limits.reset();
    assert.ok((await call("sova_org", { op: "rename", org: org.id, name: "Qorvex Holdings" })).ok);
    const about = await call("sova_org", { op: "about", org: org.id, text: `${ABOUT} Updated.` });
    assert.ok(about.ok && /characters/.test(about.text) && !about.text.includes("ABOUT-MARKER"), about.text);
    const aboutLine = orgs.readOrgHistory(org.id).at(-1)!;
    assert.deepEqual(aboutLine.by, { kind: "operator", via: "overseer", overseerId: OVERSEER_ID });
    assert.ok((await call("sova_org", { op: "revert_about", org: org.id, at: aboutLine.at })).ok);
    const add = await call("sova_roster", { op: "add", org: org.id, name: "Ana Ruiz", role: "Sales", contact: { email: CONTACT_NEW } });
    assert.ok(add.ok, add.text);
    assert.match(add.text, /contact set/);
    const ana = orgs.readRoster(org.id).find((p) => p.name === "Ana Ruiz")!;
    assert.equal(ana.contact.email, CONTACT_NEW, "the write stored what it was given");
    for (const line of orgs.readHistory(org.id, ana.id)) assert.deepEqual(line.by, { kind: "operator", via: "overseer", overseerId: OVERSEER_ID });
    const edit = await call("sova_roster", { op: "edit", org: org.id, person: "Ana Ruiz", skills: ["excel"], contact: { email: CONTACT_NEW, phone: "" } });
    assert.ok(edit.ok, edit.text);
    const proj = await call("sova_org_project", { op: "edit", org: org.id, project: project.id, stakeholder: "Maria Lopez" });
    assert.ok(proj.ok, proj.text);
    assert.equal(orgs.readProjects(org.id)[0]!.stakeholderHistory!.at(-1)!.via, "overseer");
    assert.ok((await call("sova_owner", { op: "set", org: org.id, person: "Maria Lopez" })).ok);
    assert.equal(orgs.readOrg(org.id).ownerHistory!.at(-1)!.via, "overseer");
    // The page's own request (no secret): the operator's, with no via, whatever the body says.
    const res = await app.request(`/api/orgs/${org.id}/people/${maria.id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-sova-overseer": "not-the-secret" }, body: JSON.stringify({ role: "Payroll lead" }) });
    assert.equal(res.status, 200);
    assert.deepEqual(orgs.readHistory(org.id, maria.id).at(-1)!.by, { kind: "operator" });
    const b = await app.request("/api/baton", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgId: org.id, projectId: project.id, to: "operator", publicTitle: "Mine", goal: "g", startedVia: "overseer" }) });
    assert.equal(b.status, 201);
    const row = baton.batonById(((await b.json()) as { sessionId: string }).sessionId)!.row;
    assert.equal(row.startedVia, undefined, "a request body can't claim the Overseer");
    baton.closeBaton(row.sessionId);
  });

  test("decisions: reconcile, a promotion of an unknown id refused by the route, freeze", async () => {
    assert.ok((await call("sova_project_decisions", { op: "reconcile", org: org.id, project: project.id })).ok);
    const promote = await call("sova_project_decisions", { op: "promote", org: org.id, project: project.id, ids: ["nope"] });
    assert.ok(promote.ok && /nope not promoted: unknown decision/.test(promote.text), promote.text);
    assert.ok((await call("sova_project_decisions", { op: "freeze", org: org.id, project: project.id, frozen: true })).ok);
    assert.equal((await call("sova_project_decisions", { op: "resolve", org: org.id, project: project.id, conflict: "cf_nothing", keep: "a" })).ok, false);
  });

  test("people-facing acts run only in a turn a confirm card's click opened, listing every target (§app.overseer/org-people-facing)", async () => {
    card = null;
    const start = { op: "start", org: org.id, project: project.id, to: tony.id, public_title: "Backups", question: "How are backups made?", goal: "Learn the backup routine" };
    const typed = await call("sova_gather", start);
    assert.equal(typed.ok, false);
    assert.match(typed.text, /^This reaches people or ends something: ask with sova_confirm, listing the project Ledger \(prj_[a-z0-9]+\), Tony Reyes \(p_[a-z0-9]+\) in its items, and act in the turn the user's click starts\.$/);
    card = items(projectItem(org.id, project.id));
    assert.equal((await call("sova_gather", start)).ok, false, "a card that didn't list the person");
    card = items(projectItem(org.id, project.id), personItem(org.id, tony.id));
    const before = baton.allBatons().length;
    const started = await call("sova_gather", start);
    assert.ok(started.ok, started.text);
    assert.equal(baton.allBatons().length, before + 1);
    // No link was minted, none reaches the model.
    assert.match(started.text, /No link was made: Needs you asks you to send Tony Reyes their link\./);
    const id = (started.details as { session: string }).session;
    const row = baton.batonById(id)!.row;
    assert.equal(baton.liveLinkCount(row), 0);
    assert.equal(row.startedVia, "overseer");
    assert.deepEqual(row.abilities, { draw: true, readLinks: false }, "the project's set: Automatic (§app.baton/abilities)");
    // Read links only when the project allows it: refused before the card, the cap or the session.
    const refused = await call("sova_gather", { ...start, abilities: { read_links: true } });
    assert.equal(refused.ok, false);
    assert.match(refused.text, /Reading links is off for this project's gathering sessions; the operator can allow it on the project page\./);
    assert.equal(baton.allBatons().length, before + 1, "nothing started");
    // An offer, a hand-off, take back, close: each only on the card's session and people.
    card = items(sessionItem(id), personItem(org.id, tony.id), personItem(org.id, maria.id));
    const offer = await call("sova_gather", { op: "offer", session: id, to: [tony.id, maria.id], question: "Who knows?" });
    assert.ok(offer.ok, offer.text);
    assert.equal(baton.liveLinkCount(baton.batonById(id)!.row), 0, "an offer mints none either");
    const hand = await call("sova_gather", { op: "handoff", session: id, to: "Maria Lopez", question: "Can you check?" });
    assert.ok(hand.ok, hand.text);
    assert.equal(baton.liveLinkCount(baton.batonById(id)!.row), 0, "a hand-off mints none");
    assert.ok((await call("sova_gather", { op: "extend", session: id, by: 5 })).ok);
    card = null;
    assert.equal((await call("sova_gather", { op: "take", session: id })).ok, false, "take needs a card");
    card = items(sessionItem(id));
    assert.ok((await call("sova_gather", { op: "take", session: id })).ok);
    assert.ok((await call("sova_gather", { op: "revoke_link", session: id })).ok);
    assert.ok((await call("sova_gather", { op: "close", session: id })).ok);
    // Leaving the org: a card listing the person.
    card = null;
    assert.equal((await call("sova_roster", { op: "leave", org: org.id, person: "Ana Ruiz" })).ok, false);
    card = items(personItem(org.id, orgs.readRoster(org.id).find((p) => p.name === "Ana Ruiz")!.id));
    assert.ok((await call("sova_roster", { op: "leave", org: org.id, person: "Ana Ruiz" })).ok);
    card = null;
  });

  test("the per-turn caps: organization writes and gathering sessions; a refusal takes nothing", async () => {
    limits.reset();
    caps = { ...DEFAULT_CAPS, orgWritesPerTurn: 1, gatherPerTurn: 1 };
    assert.ok((await call("sova_org", { op: "rename", org: org.id, name: "Qorvex Holdings" })).ok);
    const over = await call("sova_org", { op: "rename", org: org.id, name: "Other" });
    assert.match(over.text, /^Limit reached: at most 1 organization writes per message from the user \(1 used/);
    assert.equal(orgs.readOrg(org.id).name, "Qorvex Holdings");
    assert.equal(limits.count("org"), 1);
    limits.reset();
    // A route's refusal hands the cap back.
    assert.equal((await call("sova_org_project", { op: "add", org: org.id, name: "Bad", root: "relative/path" })).ok, false);
    assert.equal(limits.count("org"), 0);
    card = items(projectItem(org.id, project.id));
    const g = { op: "start", org: org.id, project: project.id, to: "operator", public_title: "Mine", question: "q?", goal: "g" };
    const one = await call("sova_gather", g);
    assert.ok(one.ok, one.text);
    const before = baton.allBatons().length;
    const two = await call("sova_gather", g);
    assert.match(two.text, /at most 1 gathering sessions or offers started/);
    assert.equal(baton.allBatons().length, before, "nothing started past the cap");
    baton.closeBaton((one.details as { session: string }).session);
    caps = { ...DEFAULT_CAPS };
    card = null;
    limits.reset();
  });

  test("the project overseer: start, settings with extra instructions, idea and to-do, and a message on its one route", async () => {
    assert.ok((await call("sova_project_overseer", { op: "start", org: org.id, project: project.id })).ok);
    const set = await call("sova_project_overseer", { op: "settings", org: org.id, project: project.id, extra_instructions: "Prefer short answers.", watch: false });
    assert.ok(set.ok, set.text);
    assert.equal(store.readPoSettings(store.projectOverseerPaths(org.id, project.id)).extraSystemPrompt, "Prefer short answers.");
    const tooLong = await call("sova_project_overseer", { op: "settings", org: org.id, project: project.id, extra_instructions: "x".repeat(8001) });
    assert.match(tooLong.text, /extraSystemPrompt must be text of at most 8000 characters/);
    assert.ok((await call("sova_project_overseer", { op: "idea", action: "add", org: org.id, project: project.id, id: "§gap/exports", title: "Exports" })).ok);
    const todo = await call("sova_project_overseer", { op: "todo", action: "add", org: org.id, project: project.id, text: "Ask about backups" });
    assert.ok(todo.ok, todo.text);
    const { path } = await po.ensureProjectOverseer(org.id, project.id);
    await stubbed(path);
    const sent = await call("sova_project_overseer", { op: "message", org: org.id, project: project.id, text: "Please check the backups." });
    assert.ok(sent.ok, sent.text);
    assert.match(sent.text, /Sent to \[Ledger overseer\]/);
    await (await acquireChat(path)).session.waitForIdle();
    await until(() => readFileSync(path, "utf8").includes(OVERSEER_SENT_ENTRY));
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const marker = lines.find((l) => l.customType === OVERSEER_SENT_ENTRY);
    assert.equal(marker.data.overseerId, OVERSEER_ID, "marked as the Overseer's");
    assert.equal(po.attendedForTest(org.id, project.id), true, "the run it opened is the operator's");
  });

  test("the message route: 403 without the secret; /commands, no overseer and prompt-route writes refused", async () => {
    const url = `/api/orgs/${org.id}/projects/${project.id}/overseer/message`;
    const bare = await app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
    assert.equal(bare.status, 403);
    assert.deepEqual(await bare.json(), { error: "Only the Overseer sends here. Write in the overseer's own composer." });
    const slash = await overseer.requestAsOverseerForTest(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "/clear" }) });
    assert.equal(slash.status, 400);
    assert.match(((await slash.json()) as { error: string }).error, /Send words; use op clear to clear it\./);
    const { path } = await po.ensureProjectOverseer(org.id, project.id);
    const viaPrompt = await overseer.promptSession(path, "hello", OVERSEER_ID);
    assert.deepEqual(viaPrompt, { ok: false, status: 409, error: "That is a project overseer's own conversation." });
    mkdirSync(join(root, "proj-b"), { recursive: true });
    const other = await orgs.addProject(org.id, { name: "Fresh", root: join(root, "proj-b") });
    const none = await overseer.requestAsOverseerForTest(`/api/orgs/${org.id}/projects/${other.id}/overseer/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
    assert.equal(none.status, 409);
    // The Overseer's own cap bounds repeats: at the limit nothing is sent.
    caps = { ...DEFAULT_CAPS, promptsPerTurn: 0 };
    const capped = await call("sova_project_overseer", { op: "message", org: org.id, project: project.id, text: "Again?" });
    assert.match(capped.text, /Limit reached: at most 0 prompts to other sessions/);
    caps = { ...DEFAULT_CAPS };
  });

  test("a coding session as the project's: an operator-coding row marked via the Overseer, counted as a session created", async () => {
    limits.reset();
    const made = await call("sova_project_overseer", { op: "code", org: org.id, project: project.id, prompt: "Add a CSV export", title: "CSV export" });
    assert.ok(made.ok, made.text);
    assert.equal(limits.count("create"), 1);
    const rows = store.readStarted(store.projectOverseerPaths(org.id, project.id));
    const row = rows.find((r) => r.sessionId === (made.details as { session: string }).session)!;
    assert.equal(row.kind, "operator-coding");
    assert.equal(row.via, "overseer");
    const info = await po.projectOverseerInfo(org.id, project.id);
    assert.equal(info.worktrees.sessions.find((s) => s.sessionId === row.sessionId)?.via, "overseer");
    // The page's own Start Coding Session still needs an item.
    const page = await app.request(`/api/orgs/${org.id}/projects/${project.id}/overseer/items/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "x", title: "y" }) });
    assert.equal(page.status, 400);
    await (await acquireChat(row.path!)).session.waitForIdle();
  });

  test("marker: no contact value, link token or /h/ URL in any result, refusal or action-log line; the About text only in its one read", () => {
    assert.ok(outputs.length > 30, `every surface ran (${outputs.length})`);
    for (const o of outputs) assert.equal(leaks(o.text, !!o.about), null, `${o.label}: ${o.text.slice(0, 300)}`);
    const log = readFileSync(overseerActionsFile(), "utf8");
    assert.ok(log.includes('"contact":"[contact]"'), "control: a call with contact was logged, with the value replaced");
    assert.equal(leaks(log, false), null, "the action log");
  });
});

describe("archive a project (§app.organizations/archive)", async () => {
  const org = await orgs.createOrg({ name: "Archivers", dir: join(root, "ws2") });
  mkdirSync(join(root, "proj2"));
  const project = await orgs.addProject(org.id, { name: "Old Site", root: join(root, "proj2") });
  const kim = await orgs.addPerson(org.id, { name: "Kim Park", role: "Ops" });
  // As the tool sends it: in the turn a confirm card listing the project started (the chart checks the card first).
  const archive = () =>
    overseer.requestAsOverseerForTest(`/api/orgs/${org.id}/projects/${project.id}/archive`, { method: "POST", headers: { [tools.OVERSEER_CARD_HEADER]: JSON.stringify({ projects: [project.id] }) } });

  test("refused while a gathering session is open, naming it; nothing written", async () => {
    const open = baton.createBaton({ orgId: org.id, projectId: project.id, to: kim.id, publicTitle: "Hosting", goal: "g", mintLink: false });
    const r = await archive();
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: "Stop these first: 1 gathering session open (Hosting)." });
    assert.equal(orgs.readProjects(org.id)[0]!.archived, undefined);
    baton.closeBaton(open.sessionId);
  });

  test("the tool asks first, then archives: via the Overseer, left out of counts and the Organizations region", async () => {
    attended = true;
    card = null;
    assert.equal((await call("sova_org_project", { op: "archive", org: org.id, project: "Old Site" })).ok, false);
    card = items(projectItem(org.id, project.id));
    const done = await call("sova_org_project", { op: "archive", org: org.id, project: "Old Site" });
    assert.ok(done.ok, done.text);
    card = null;
    const p = orgs.readProjects(org.id)[0]!;
    assert.equal(p.archived?.via, "overseer");
    assert.equal(orgs.orgsInfo().orgs.find((o) => o.id === org.id)!.projects, 0);
    assert.equal(orgs.orgsInfo().orgs.find((o) => o.id === org.id)!.archivedProjects, 1);
    // Its sessions carry the mark the sidebar reads.
    const sessions = baton.allBatons().filter((b) => b.projectId === project.id);
    const hit = baton.batonById(sessions[0]!.sessionId)!;
    assert.equal(orgLookup().of(baton.sessionPathOf(hit.dir, hit.row), hit.row.sessionId)?.projectArchived, true);
    const listed = await call("sova_orgs", { org: org.id });
    assert.match(listed.text, /Archived projects \(1\):\n- Old Site .* ARCHIVED/);
  });

  test("while archived: nothing new starts, its overseer is paused, its composer refuses", async () => {
    const start = await app.request("/api/baton", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgId: org.id, projectId: project.id, to: kim.id, publicTitle: "x", goal: "g" }) });
    assert.equal(start.status, 409);
    assert.deepEqual(await start.json(), { error: "Old Site is archived. Unarchive it first." });
    const startPo = await app.request(`/api/orgs/${org.id}/projects/${project.id}/overseer`, { method: "POST" });
    assert.equal(startPo.status, 409);
    assert.deepEqual(await startPo.json(), { error: "Old Site is archived. Unarchive it to use its overseer." });
    const run = await app.request(`/api/orgs/${org.id}/projects/${project.id}/overseer/run`, { method: "POST" });
    assert.equal(run.status, 409);
    const coding = await app.request(`/api/orgs/${org.id}/projects/${project.id}/overseer/coding`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(coding.status, 409, "New Coding Session too");
    assert.deepEqual(await coding.json(), { error: "Old Site is archived. Unarchive it first." });
    assert.deepEqual(await po.lookNow(org.id, project.id, true), { started: false, why: "the project is archived" });
    const msg = await overseer.requestAsOverseerForTest(`/api/orgs/${org.id}/projects/${project.id}/overseer/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
    assert.equal(msg.status, 409);
  });

  test("unarchive restores it as it was", async () => {
    const r = await call("sova_org_project", { op: "unarchive", org: org.id, project: project.id });
    assert.ok(r.ok, r.text);
    assert.equal(orgs.readProjects(org.id)[0]!.archived, undefined);
    assert.equal(orgs.orgsInfo().orgs.find((o) => o.id === org.id)!.projects, 1);
    const again = await app.request(`/api/orgs/${org.id}/projects/${project.id}/overseer`, { method: "POST" });
    assert.equal(again.status, 200);
  });

  test("its composer is closed while archived (the project overseer's own)", async () => {
    const { path } = await po.ensureProjectOverseer(org.id, project.id);
    await orgs.setProjectArchived(org.id, project.id, true);
    const chat = await acquireChat(path);
    assert.equal(chat.specialEntry?.composerClosed?.(path), "Old Site is archived. Unarchive it to use its overseer.");
    await orgs.setProjectArchived(org.id, project.id, false);
    assert.equal(chat.specialEntry?.composerClosed?.(path), null);
  });
});

describe("the confirm card: people and projects, and the click that opens a confirmed turn", async () => {
  const org = await orgs.createOrg({ name: "Cardco", dir: join(root, "ws3") });
  mkdirSync(join(root, "proj3"));
  const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj3") });
  const lee = await orgs.addPerson(org.id, { name: "Lee Chan", role: "Design" });
  const { orgConfirmLookup } = await import("./overseer-org-tools");
  const lookup = { session: async () => null, isSelf: () => false, idea: () => null, todo: () => null, ...orgConfirmLookup };
  const refusal = (m: string) => new Error(m);

  test("people and projects resolve by id or name, after ideas and todos; an unknown one refuses the card", async () => {
    const rows = await confirm.resolveConfirmItems({ projects: [{ org: "Cardco", id: "Portal", note: "Its site." }], people: [{ org: org.id, id: "lee chan" }] }, lookup, refusal);
    assert.deepEqual(rows, [
      { kind: "project", id: project.id, orgId: org.id, name: "Portal", orgName: "Cardco", note: "Its site." },
      { kind: "person", id: lee.id, orgId: org.id, name: "Lee Chan", orgName: "Cardco", status: "active" },
    ]);
    await assert.rejects(() => confirm.resolveConfirmItems({ people: [{ org: org.id, id: "Nobody" }] }, lookup, refusal), /These ids match nothing \(people: Nobody in /);
    const noOrgs = { ...lookup, person: undefined, project: undefined };
    await assert.rejects(() => confirm.resolveConfirmItems({ people: [{ org: org.id, id: "Lee Chan" }] }, noOrgs, refusal), /items takes only sessions, ideas and todos/);
    assert.match(confirm.confirmResult(rows, "user"), /Projects:\n- Portal \(prj_[a-z0-9]+\) in Cardco \(org_[a-z0-9]+\) — Its site\.\nPeople:\n- Lee Chan \(p_[a-z0-9]+, active\) in Cardco/);
  });

  test("a card that may gate a people-facing act is click-only; an ordinary card, or a project overseer's, is not", async () => {
    const summaries: Record<string, any> = { plain: { id: "plain", title: "Tidy" }, bat: { id: "bat", title: "Ask Lee", baton: {} }, off: { id: "off", title: "Offer", org: { orgId: org.id, orgName: "Cardco", kind: "offer" } } };
    const withSessions = { ...lookup, session: async (ref: string) => summaries[ref] ?? null };
    const card = async (items: unknown, l: any = withSessions) => confirm.clickOnlyCard(await confirm.resolveConfirmItems(items, l, refusal), l);
    assert.equal(await card({ people: [{ org: org.id, id: lee.id }] }), true);
    assert.equal(await card({ projects: [{ org: org.id, id: project.id }] }), true);
    assert.equal(await card({ sessions: ["bat"] }), true, "a gathering session: close, take, hand off");
    assert.equal(await card({ sessions: ["plain", "off"] }), true, "an offer among ordinary sessions");
    assert.equal(await card({ sessions: ["plain"] }), false, "archiving an ordinary session: typing still answers");
    assert.equal(await card(undefined), false);
    const po = { ...withSessions, person: undefined, project: undefined };
    assert.equal(await card({ sessions: ["bat"] }, po), false, "a project overseer's card gates nothing");
  });

  test("the card's items count only when the run's opening message is the click on it", () => {
    const details = { title: "Start?", options: [{ label: "Start", reply: "Start the session with Lee." }, { label: "Cancel" }], items: [{ kind: "person", id: lee.id, orgId: org.id, name: "Lee Chan", orgName: "Cardco", status: "active" }] };
    const branch = (...more: unknown[]) => [
      { type: "message", message: { role: "user", content: "start one with Lee" } },
      { type: "message", message: { role: "toolResult", toolCallId: "card1", toolName: "sova_confirm", details } },
      ...more,
    ];
    const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
    assert.deepEqual(overseer.confirmedItems("card1", branch(user("Start the session with Lee."))), details.items);
    assert.equal(overseer.confirmedItems(null, branch(user("Start the session with Lee."))), null, "not a click");
    assert.equal(overseer.confirmedItems("card1", branch(user("yes"))), null, "text that is no option");
    assert.equal(overseer.confirmedItems("card1", branch(user("Start the session with Lee."), user("and another"))), null, "a later message");
    assert.equal(overseer.confirmedItems("card2", branch(user("Start the session with Lee."))), null, "another card");
  });

  test("UserTurns: a click's card lasts for its own run only; a typed message opens none", () => {
    const turns = new tools.UserTurns();
    const agent = { prompt: async (_m: unknown) => {}, steer: (_m: unknown) => {}, followUp: (_m: unknown) => {} };
    turns.watch(agent as never);
    const msg = { role: "user", content: "Start the session with Lee." };
    turns.send(() => agent.prompt(msg as never), "card1");
    turns.observe({ type: "agent_start" });
    turns.observe({ type: "message_start", message: msg });
    assert.equal(turns.attended(), true);
    assert.equal(turns.confirmedCard(), "card1");
    const typed = { role: "user", content: "yes" };
    turns.send(() => agent.prompt(typed as never));
    turns.observe({ type: "agent_start" });
    turns.observe({ type: "message_start", message: typed });
    assert.equal(turns.attended(), true);
    assert.equal(turns.confirmedCard(), null);
  });
});

describe("the Overseer's file tools never open a workspace or a link store (§app.overseer/tools)", async () => {
  const deny = await import("./overseer-deny");
  const { overseerFileTools } = await import("./overseer-file-tools");
  const { stateRoot } = await import("./state-root");
  const ws = join(root, "fws", "workspace");
  mkdirSync(join(ws, "sessions"), { recursive: true });
  writeFileSync(join(ws, "roster.json"), JSON.stringify({ people: [{ contact: { email: CONTACT } }] }));
  writeFileSync(join(ws, "notes.txt"), `needle ${CONTACT}`);
  writeFileSync(join(root, "fws", "outside.txt"), "needle outside");
  symlinkSync(ws, join(root, "fws", "alias"));
  mkdirSync(stateRoot(), { recursive: true });
  writeFileSync(join(stateRoot(), "baton-links.json"), JSON.stringify({ links: [{ hash: "abc" }] }));
  const ft = overseerFileTools(root, () => new deny.OverseerGuard([ws]));
  const t = (n: string) => ft.find((x) => x.name === n)!;
  const exec = async (n: string, p: Record<string, unknown>) => {
    try {
      const out = await t(n).execute("f", p as never, undefined, undefined, { cwd: root } as never);
      return (out.content as { text?: string }[]).map((c) => c.text ?? "").join("\n");
    } catch (err) {
      return `ERR ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  test("a path inside one is refused, as written and through a symlink", async () => {
    assert.equal(await exec("read", { path: join(ws, "roster.json") }), `ERR ${deny.WORKSPACE_REFUSAL}`);
    assert.equal(await exec("read", { path: join(root, "fws", "alias", "roster.json") }), `ERR ${deny.WORKSPACE_REFUSAL}`);
    assert.equal(await exec("ls", { path: ws }), `ERR ${deny.WORKSPACE_REFUSAL}`);
  });

  test("the link stores are refused as credentials", async () => {
    assert.equal(await exec("read", { path: join(stateRoot(), "baton-links.json") }), `ERR ${deny.SECRET_REFUSAL}`);
  });

  test("a search or listing from a parent leaves the workspace out", async () => {
    const grep = await exec("grep", { pattern: "needle", path: join(root, "fws") });
    assert.match(grep, /outside\.txt/, "control: the search ran");
    assert.ok(!grep.includes(CONTACT) && !grep.includes("notes.txt"), grep);
    const ls = await exec("ls", { path: join(root, "fws") });
    assert.ok(ls.includes("outside.txt") && !ls.includes("workspace"), ls);
  });

  test("the Overseer's runtime uses it for every attached workspace", () => {
    const guard = new deny.OverseerGuard([ws]);
    assert.equal(guard.isSecret(join(ws, "sessions", "x.jsonl")), true);
    assert.equal(guard.isSecret(join(root, "fws", "outside.txt")), false);
    assert.ok(existsSync(join(root, "fws", "alias")));
  });
});
