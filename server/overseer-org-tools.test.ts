// Run: pnpm exec tsx --test server/overseer-org-tools.test.ts. §app.overseer/org-tools and its
// sub-claims: the global Overseer's organization tools, driven in-process through the real org,
// baton, decisions and project-overseer routes with the Overseer's sender mark. A throwaway
// PI_CODING_AGENT_DIR (this tree's pi-config extensions linked in), org workspaces and project roots
// in the OS temp dir, deleted after; ~/.pi is never touched. Every model is a stub.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import type { SovaConfirmItem } from "../shared/protocol";
import type { OverseerToolHost } from "./overseer-tools";
import { piSession } from "./harness/pi/testing/handle";
import { scratchRoot } from "./test-scratch";

// In no repository: the plain project folders below are themselves, so a coding session cuts no worktree.
const root = scratchRoot("sova-oorg-");
// A hosted runtime can still write here after after() ran (pi's catalogs, usage cache): exit is last.
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
symlinkSync(resolve(import.meta.dirname, "..", "pi-config", "extensions"), join(agentDir, "extensions"));

const { Hono } = await import("hono");
// fd and rg in-process (server/search-tools-fake.ts; overseer-file-tools.integration.test.ts runs the real ones).
(await import("./overseer-file-tools")).setSearchSpawnForTest((await import("./search-tools-fake")).fakeSearchSpawn());
const orgs = await import("./orgs");
const { setProjectArchived } = await import("./projects/spaces");
const baton = await import("./baton");
const po = await import("./project-overseer");
const store = await import("./project-overseer-store");
const overseer = await import("./overseer");
const sessionPrompt = await import("./session-prompt");
const tools = await import("./overseer-tools");
const { UserTurns } = await import("./user-turns");
const { harnessEventOf } = await import("./harness/pi/session");
const { watchUserMessages } = await import("./harness/pi/turns");
const { historyOf } = await import("./harness/pi/reader");
const view = await import("./overseer-org-view");
const confirm = await import("./overseer-confirm");
const { applyCardCall, cardLines } = await import("../shared/overseer-card");
const { DEFAULT_CAPS, overseerActionsFile, writeOverseerState } = await import("./overseer-store");
const { registerOrgRoutes } = await import("./org-routes");
const { registerProjectOverseerRoutes } = await import("./project-overseer-routes");
const { registerProjectRoutes } = await import("./projects/routes");
const { registerDecisionRoutes } = await import("./decisions-routes");
const { acquireChat, disposeAllChats } = await import("./chat-manager");
const { settled } = await import("./workspace-git");
const { canonicalPath } = await import("./paths");
const { markOwned } = await import("./write-guard");
const { getSessionSummary } = await import("./sessions-index");
const { normalizeEntries } = await import("./transcript");
const { readActiveBranch } = await import("./harness/pi/reader");
const { orgLookup } = await import("./org-sessions");
const { readBuilds, setBuildSessionMakerForTest } = await import("./build-loadout");
const { setReconcileDeps } = await import("./reconcile");
const { OVERSEER_SENT_ENTRY } = await import("../shared/protocol");
const { hostOf } = await import("./org-engine");
const { batonData, startedOf } = await import("./baton-told");
const { readOverseerState } = await import("./overseer-store");

after(async () => {
  await disposeAllChats();
  for (const ws of ["ws", "ws2", "ws3", "ws4"]) await settled(join(root, ws)).catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

// The reconciler's decide seam: nothing to compare, nothing to call.
setReconcileDeps({ provider: () => ({ id: "chain", label: "fake", decide: async () => ({ answers: {}, provider: "fake", model: "fake", latencyMs: 1 }) }) as never, excluded: () => false });

// ---- the server's routes, in-process ------------------------------------------------------------------------

const app = new Hono();
registerOrgRoutes(app);
(await import("./outreach/routes")).mountOutreach(app);
registerProjectOverseerRoutes(app);
registerProjectRoutes(app);
registerDecisionRoutes(app);
/** New coding sessions: a session file of its own, as POST /api/sessions writes one, on a stub runtime. */
async function codingSessionFile(cwd: string, id: string): Promise<string> {
  const dir = join(agentDir, "sessions", "--coding--");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-09-28T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd })}\n`);
  markOwned(canonicalPath(file));
  await stubbed(canonicalPath(file));
  return canonicalPath(file);
}
app.post("/api/sessions", async (c) => {
  const body = (await c.req.json()) as { cwd: string };
  const id = randomUUID();
  return c.json({ id, path: await codingSessionFile(body.cwd, id) }, 201);
});
// A project's builds make theirs the same way (server/build-loadout.ts).
setBuildSessionMakerForTest(codingSessionFile);
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
  const s = piSession(chat) as unknown as { _modelRuntime: { hasConfiguredAuth(p: string): boolean }; agent: { state: { model: unknown }; getApiKey: unknown; streamFunction: unknown } };
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
async function until(cond: () => boolean, ms = 30_000): Promise<void> {
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
    const path = ref.includes("/") ? ref : await sessionPrompt.pathOfId(ref);
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
  const withLink = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Servers", goal: "Where it runs" });
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
    await baton.closeBaton(row.sessionId);
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
    const start = { op: "start", org: org.id, project: project.id, to: tony.id, why: "Nobody has said this yet.", public_title: "Backups", question: "How are backups made?", goal: "Learn the backup routine" };
    const typed = await call("sova_gather", start);
    assert.equal(typed.ok, false);
    assert.match(typed.text, /^This reaches people or ends something: ask with sova_card, listing the project Ledger \(prj_[a-z0-9]+\), Tony Reyes \(p_[a-z0-9]+\) in its items, and act in the turn the user's click starts\.$/);
    card = items(projectItem(org.id, project.id));
    assert.equal((await call("sova_gather", start)).ok, false, "a card that didn't list the person");
    card = items(projectItem(org.id, project.id), personItem(org.id, tony.id));
    const before = baton.allBatons().length;
    // A start says why (§app.baton/told): refused without one, after the card, and nothing starts.
    const { why: _why, ...noWhy } = start;
    const unexplained = await call("sova_gather", noWhy);
    assert.equal(unexplained.ok, false);
    assert.equal(unexplained.text, "Say why you start it (why): one or two sentences for the user, never shown to the person.");
    assert.equal(baton.allBatons().length, before, "nothing started without a why");
    const started = await call("sova_gather", start);
    assert.ok(started.ok, started.text);
    assert.equal(baton.allBatons().length, before + 1);
    // No link was minted, none reaches the model.
    assert.match(started.text, /No link was made: Needs you asks you to send Tony Reyes their link\./);
    const id = (started.details as { session: string }).session;
    const row = baton.batonById(id)!.row;
    assert.equal(baton.liveLinkCount(row), 0);
    assert.equal(row.startedVia, "overseer");
    // Its statechart records who started it, the Overseer's conversation and the why (§app.baton/goal-and-loadout).
    assert.deepEqual(hostOf(org.id).data(baton.batonSid(org.id, id))?.["started"], { by: "overseer", overseerId: OVERSEER_ID, why: "Nobody has said this yet." });
    assert.deepEqual(startedOf(row, batonData(row)), { who: "overseer", at: row.createdAt, why: "Nobody has said this yet.", overseer: { id: OVERSEER_ID, current: readOverseerState()?.current === OVERSEER_ID } });
    assert.deepEqual(row.abilities, { draw: true, readLinks: false, drawHtml: false }, "the project's set: Automatic (§app.baton/abilities)");
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
    // send_link (§app.outreach/decisions): behind a card listing the session and the person; refused
    // with its reason, and no link or number reaches the model.
    card = items(sessionItem(id));
    const unlisted = await call("sova_gather", { op: "send_link", session: id });
    assert.equal(unlisted.ok, false, "the card doesn't list Maria");
    card = items(sessionItem(id), personItem(org.id, maria.id));
    const sent = await call("sova_gather", { op: "send_link", session: id });
    assert.equal(sent.ok, false);
    // No public address here: a link nobody outside could open is refused before anything is minted.
    assert.match(sent.text, /^This link can't be opened from outside yet\. Turn on public links in Settings → Public links\.$/);
    assert.equal(baton.liveLinkCount(baton.batonById(id)!.row), 0, "nothing minted");
    assert.doesNotMatch(sent.text, /\/h\/|\d{7}/);
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
    const g = { op: "start", org: org.id, project: project.id, to: "operator", why: "Nobody has said this yet.", public_title: "Mine", question: "q?", goal: "g" };
    const one = await call("sova_gather", g);
    assert.ok(one.ok, one.text);
    const before = baton.allBatons().length;
    const two = await call("sova_gather", g);
    assert.match(two.text, /at most 1 gathering sessions or offers started/);
    assert.equal(baton.allBatons().length, before, "nothing started past the cap");
    await baton.closeBaton((one.details as { session: string }).session);
    caps = { ...DEFAULT_CAPS };
    card = null;
    limits.reset();
  });

  test("the project overseer: start, settings with extra instructions, idea and to-do, and a message on its one route", async () => {
    assert.ok((await call("sova_project_overseer", { op: "start", org: org.id, project: project.id })).ok);
    const set = await call("sova_project_overseer", { op: "settings", org: org.id, project: project.id, extra_instructions: "Prefer short answers.", watch: false });
    assert.ok(set.ok, set.text);
    assert.equal(store.readPoSettings(store.projectOverseerPaths(project.id)).extraSystemPrompt, "Prefer short answers.");
    const tooLong = await call("sova_project_overseer", { op: "settings", org: org.id, project: project.id, extra_instructions: "x".repeat(8001) });
    assert.match(tooLong.text, /extraSystemPrompt must be text of at most 8000 characters/);
    assert.ok((await call("sova_project_overseer", { op: "idea", action: "add", org: org.id, project: project.id, id: "§gap/exports", title: "Exports" })).ok);
    const todo = await call("sova_project_overseer", { op: "todo", action: "add", org: org.id, project: project.id, text: "Ask about backups" });
    assert.ok(todo.ok, todo.text);
    const { path } = await po.ensureProjectOverseer(project.id);
    await stubbed(path);
    const sent = await call("sova_project_overseer", { op: "message", org: org.id, project: project.id, text: "Please check the backups." });
    assert.ok(sent.ok, sent.text);
    assert.match(sent.text, /Sent to \[Ledger overseer\]/);
    await piSession(await acquireChat(path)).waitForIdle();
    await until(() => readFileSync(path, "utf8").includes(OVERSEER_SENT_ENTRY));
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const marker = lines.find((l) => l.customType === OVERSEER_SENT_ENTRY);
    assert.equal(marker.data.overseerId, OVERSEER_ID, "marked as the Overseer's");
    assert.equal(po.attendedForTest(project.id), true, "the run it opened is the operator's");
  });

  test("the message route: 403 without the secret; /commands, no overseer and prompt-route writes refused", async () => {
    const url = `/api/projects/${project.id}/overseer/message`;
    const bare = await app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
    assert.equal(bare.status, 403);
    assert.deepEqual(await bare.json(), { error: "Only the Overseer sends here. Write in the overseer's own composer." });
    const slash = await overseer.requestAsOverseerForTest(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "/clear" }) });
    assert.equal(slash.status, 400);
    assert.match(((await slash.json()) as { error: string }).error, /Send words; use op clear to clear it\./);
    const { path } = await po.ensureProjectOverseer(project.id);
    const viaPrompt = await sessionPrompt.promptSession(path, "hello", OVERSEER_ID);
    assert.deepEqual(viaPrompt, { ok: false, status: 409, error: "That is a project overseer's own conversation." });
    mkdirSync(join(root, "proj-b"), { recursive: true });
    const other = await orgs.addProject(org.id, { name: "Fresh", root: join(root, "proj-b") });
    const none = await overseer.requestAsOverseerForTest(`/api/projects/${other.id}/overseer/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
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
    const rows = readBuilds(project.id);
    const row = rows.find((r) => r.sessionId === (made.details as { session: string }).session)!;
    assert.equal(row.kind, "operator-coding");
    assert.equal(row.via, "overseer");
    const info = await po.projectOverseerInfo(project.id);
    assert.equal(info.worktrees.sessions.find((s) => s.sessionId === row.sessionId)?.via, "overseer");
    // The page's own Start Coding Session still needs an item.
    const page = await app.request(`/api/projects/${project.id}/overseer/items/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "x", title: "y" }) });
    assert.equal(page.status, 400);
    await piSession(await acquireChat(row.path!)).waitForIdle();
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
  // As the tool sends it: in the turn a confirm card listing the project started (the statechart checks the card first).
  const archive = () =>
    overseer.requestAsOverseerForTest(`/api/projects/${project.id}/archive`, { method: "POST", headers: { [tools.OVERSEER_CARD_HEADER]: JSON.stringify({ projects: [project.id] }) } });

  test("refused while a gathering session is open, naming it; nothing written", async () => {
    const open = await baton.createBaton({ orgId: org.id, projectId: project.id, to: kim.id, publicTitle: "Hosting", goal: "g" }, { mintLink: false });
    const r = await archive();
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: "Stop these first: 1 gathering session open (Hosting)." });
    assert.equal(orgs.readProjects(org.id)[0]!.archived, undefined);
    await baton.closeBaton(open.sessionId);
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
    const startPo = await app.request(`/api/projects/${project.id}/overseer`, { method: "POST" });
    assert.equal(startPo.status, 409);
    assert.deepEqual(await startPo.json(), { error: "Old Site is archived. Unarchive it to use its overseer." });
    const run = await app.request(`/api/projects/${project.id}/overseer/run`, { method: "POST" });
    assert.equal(run.status, 409);
    const coding = await app.request(`/api/projects/${project.id}/overseer/coding`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(coding.status, 409, "New Coding Session too");
    assert.deepEqual(await coding.json(), { error: "Old Site is archived. Unarchive it first." });
    assert.deepEqual(await po.lookNow(project.id, true), { started: false, why: "the project is archived" });
    const msg = await overseer.requestAsOverseerForTest(`/api/projects/${project.id}/overseer/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
    assert.equal(msg.status, 409);
  });

  test("unarchive restores it as it was", async () => {
    const r = await call("sova_org_project", { op: "unarchive", org: org.id, project: project.id });
    assert.ok(r.ok, r.text);
    assert.equal(orgs.readProjects(org.id)[0]!.archived, undefined);
    assert.equal(orgs.orgsInfo().orgs.find((o) => o.id === org.id)!.projects, 1);
    const again = await app.request(`/api/projects/${project.id}/overseer`, { method: "POST" });
    assert.equal(again.status, 200);
  });

  test("its composer is closed while archived (the project overseer's own)", async () => {
    const { path } = await po.ensureProjectOverseer(project.id);
    await setProjectArchived(project.id, true);
    const chat = await acquireChat(path);
    assert.equal(chat.specialEntry?.composerClosed?.(path), "Old Site is archived. Unarchive it to use its overseer.");
    await setProjectArchived(project.id, false);
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
    const echo = cardLines({ id: "c_1", title: "t", options: [{ label: "Go" }], items: rows.map(({ choices: _own, ...it }, i) => ({ ...it, n: i + 1 })), phase: "open", rev: 1, createdAt: "x", updatedAt: "x" }, "").join("\n");
    assert.match(echo, /  1\. project Portal \(prj_[a-z0-9]+\) in Cardco \(org_[a-z0-9]+\) — Its site\.\n  2\. Lee Chan \(p_[a-z0-9]+, active\) in Cardco/);
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

  test("the card's items count only when the run's opening message is a click on it while it is open", () => {
    const person = { kind: "person", id: lee.id, orgId: org.id, name: "Lee Chan", orgName: "Cardco", status: "active" } as const;
    const bob = { kind: "person", id: "p_bob", orgId: org.id, name: "Bob", orgName: "Cardco", status: "active" } as const;
    const created = applyCardCall(
      [],
      { ops: [{ op: "create", title: "Start?", options: [{ label: "Start", reply: "Start the session with Lee." }, { label: "Cancel" }], choices: ["Start", "Skip"] }] },
      { now: "2026-09-30T10:00:00.000Z", prepared: { items: [person, bob], hrefs: [], clickOnly: true } },
    ).details;
    const result = (details: unknown, id = "k1") => ({ type: "message", message: { role: "toolResult", toolCallId: id, toolName: "sova_card", details } });
    const user = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
    const branch = (...more: unknown[]) => historyOf([user("start one with Lee"), result(created), ...more]);
    const bare = (items: readonly { n?: number }[]) => items.map(({ n: _n, ...it }) => it);
    // An unrelated message before the click leaves the card open: the click still approves.
    assert.deepEqual(overseer.confirmedItems("c_1", branch(user("what's Lee working on?"), user("c_1 a: Start the session with Lee."))), bare(created.card!.items));
    assert.equal(overseer.confirmedItems(null, branch(user("c_1 a: Start the session with Lee."))), null, "not a click");
    assert.equal(overseer.confirmedItems("c_1", branch(user("yes"))), null, "typed text");
    assert.equal(overseer.confirmedItems("c_1", branch(user("c_1 a: start it"))), null, "text that only looks like a click");
    assert.equal(overseer.confirmedItems("c_1", branch(user("c_1 a: Start the session with Lee."), user("and another"))), null, "a later message");
    assert.equal(overseer.confirmedItems("c_2", branch(user("c_1 a: Start the session with Lee."))), null, "another card");
    assert.equal(overseer.confirmedItems("k1", branch(user("c_1 a: Start the session with Lee."))), null, "a tool call id approves nothing");
    // A per-item Apply approves only the items it gave a choice.
    assert.deepEqual(overseer.confirmedItems("c_1", branch(user("c_1: 1a Start"))), [person]);
    // A card no longer open when the click arrived approves nothing.
    const dropped = applyCardCall([created.card!], { card: "c_1", ops: [{ op: "drop", reason: "Lee left." }] }, { now: "2026-09-30T10:01:00.000Z" }).details;
    assert.equal(overseer.confirmedItems("c_1", branch(result(dropped, "k2"), user("c_1 a: Start the session with Lee."))), null, "a dropped card");
    // The model recording the answer later in the same run doesn't take the approval away.
    const answered = applyCardCall([created.card!], { card: "c_1", ops: [{ op: "answer", text: "start", option: "a" }] }, { now: "2026-09-30T10:02:00.000Z" }).details;
    assert.deepEqual(overseer.confirmedItems("c_1", branch(user("c_1 a: Start the session with Lee."), result(answered, "k3"))), bare(created.card!.items), "recorded after the click");
  });

  test("UserTurns: a click's card lasts for its own run only; a typed message opens none", () => {
    const turns = new UserTurns();
    const agent = { prompt: async (_m: unknown) => {}, steer: (_m: unknown) => {}, followUp: (_m: unknown) => {} };
    turns.watch({ onUserMessage: (claim) => watchUserMessages(agent, claim) });
    const msg = { role: "user", content: "Start the session with Lee." };
    turns.send(() => agent.prompt(msg as never), "card1");
    turns.observe(harnessEventOf({ type: "agent_start" }));
    turns.observe(harnessEventOf({ type: "message_start", message: msg }));
    assert.equal(turns.attended(), true);
    assert.equal(turns.confirmedCard(), "card1");
    const typed = { role: "user", content: "yes" };
    turns.send(() => agent.prompt(typed as never));
    turns.observe(harnessEventOf({ type: "agent_start" }));
    turns.observe(harnessEventOf({ type: "message_start", message: typed }));
    assert.equal(turns.attended(), true);
    assert.equal(turns.confirmedCard(), null);
  });

  test("UserTurns: the open-cards note is state, not input; any other extension message still ends the user's part", () => {
    const turns = new UserTurns();
    const agent = { prompt: async (_m: unknown) => {}, steer: (_m: unknown) => {}, followUp: (_m: unknown) => {} };
    turns.watch({ onUserMessage: (claim) => watchUserMessages(agent, claim) });
    const msg = { role: "user", content: "c_1 a: Start the session with Lee." };
    turns.send(() => agent.prompt(msg as never), "c_1");
    turns.observe(harnessEventOf({ type: "agent_start" }));
    turns.observe(harnessEventOf({ type: "message_start", message: msg }));
    turns.observe(harnessEventOf({ type: "message_start", message: { role: "assistant", content: [] } }));
    // After the model replied (a compaction's note steered in mid-run): the run stays the user's.
    turns.observe(harnessEventOf({ type: "message_start", message: { role: "custom", customType: "overseer-cards", content: "[cards] …", display: false } }));
    assert.equal(turns.attended(), true);
    assert.equal(turns.confirmedCard(), "c_1");
    turns.observe(harnessEventOf({ type: "message_start", message: { role: "custom", customType: "worker-report", content: "done", display: true } }));
    assert.equal(turns.attended(), false);
    // A run a brief starts is not made the user's by the note either.
    turns.observe(harnessEventOf({ type: "agent_start" }));
    turns.observe(harnessEventOf({ type: "message_start", message: { role: "custom", customType: "overseer-cards", content: "[cards] …", display: false } }));
    assert.equal(turns.attended(), false);
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

describe("any registered project, org optional (sova_projects, sova_org_project)", async () => {
  const { registerProjectIn } = await import("./projects/spaces");
  mkdirSync(join(root, "solo"), { recursive: true });
  const solo = (await registerProjectIn("standalone", join(root, "solo"), { name: "Solo Tool", origin: "folder" })).project;

  test("sova_projects lists a standalone project with no org; a read needs none", async () => {
    const list = await call("sova_projects", {});
    assert.ok(list.ok, list.text);
    assert.match(list.text, new RegExp(`- Solo Tool \\(${solo.id}\\) · in no organization · root `));
    const read = await call("sova_org_project", { project: solo.id });
    assert.ok(read.ok, read.text);
    assert.match(read.text, /# Solo Tool .*\(in no organization\)/);
    assert.doesNotMatch(read.text, /Gathering sessions|Decisions:|Last owner update/, "no org part for a standalone project");
  });

  test("its org part is refused with why; an add of an existing project's folder is refused as the page refuses", async () => {
    attended = true;
    const edit = await call("sova_org_project", { op: "edit", project: solo.id, stakeholder: "none" });
    assert.equal(edit.ok, false);
    assert.match(edit.text, /Solo Tool is in no organization/);
    card = items({ kind: "folder", id: join(root, "solo") });
    const add = await call("sova_org_project", { op: "add", name: "x", root: join(root, "solo") });
    card = null;
    assert.equal(add.ok, false);
    assert.match(add.text, /is already the project Solo Tool/);
  });
});

// ---- §app.overseer/org-project-add -------------------------------------------------------------------------------

/** The org-engine log rows of `sid` for `event`, wherever they were written (workspace, project dir, host-local). */
function logRows(sid: string, event: string): Record<string, any>[] {
  const out: Record<string, any>[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== "sessions" && e.name !== ".git") walk(p);
      } else if (e.isFile() && e.name.endsWith(".jsonl"))
        for (const line of readFileSync(p, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const r = JSON.parse(line);
            if (r?.session === sid && r?.event === event) out.push(r);
          } catch {
            // a torn line
          }
        }
    }
  };
  walk(root);
  return out;
}
const folderItem = (path: string, orgId?: string, name?: string): SovaConfirmItem => ({ kind: "folder", id: path, ...(orgId ? { orgId, orgName: "" } : {}), ...(name ? { name } : {}) });
const orgItem = (id: string): SovaConfirmItem => ({ kind: "org", id, name: "" });
const asOverseer = (path: string, method: string, body: unknown, cardRows?: unknown) =>
  overseer.requestAsOverseerForTest(path, { method, headers: { "content-type": "application/json", ...(cardRows ? { [tools.OVERSEER_CARD_HEADER]: JSON.stringify(cardRows) } : {}) }, body: JSON.stringify(body) });
const projectByRoot = (r: string) => listProjects().find((p) => p.root === r);
const { listProjects, readProject } = await import("./projects/spaces");
const { orgConfirmLookup: addLookup } = await import("./overseer-org-tools");
const { GUARDED_FOLDER } = await import("./overseer-folders");
const { targetsRoot } = await import("./targets");
const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/** A session file of this host whose folder is `cwd`, as the tools find it by id. */
function sessionIn(cwd: string): string {
  const id = randomUUID();
  const dir = join(agentDir, "sessions", "--add--");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `2026-10-01T00-00-00-000Z_${id}.jsonl`), `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd })}\n`);
  return id;
}

describe("adding projects and attaching organizations for the user (§app.overseer/org-project-add)", async () => {
  const org = await orgs.createOrg({ name: "Addco", dir: join(root, "ws4") });
  const base = join(root, "adds");
  for (const f of ["plain", "other", "inorg", "viasession"]) mkdirSync(join(base, f), { recursive: true });
  // A checkout: a subfolder of it registers as its root.
  mkdirSync(join(base, "repo", "sub"), { recursive: true });
  gitIn(join(base, "repo"), "init", "-q", "-b", "main");

  test("a folder without a card, or with a card naming another path or an org, is refused and adds nothing; a refusal takes no org write", async () => {
    attended = true;
    limits.reset();
    card = null;
    const before = listProjects().length;
    const bare = await call("sova_org_project", { op: "add", root: join(base, "plain") });
    assert.equal(bare.ok, false);
    assert.equal(bare.text, `This adds a project: ask with sova_card, listing the folder ${join(base, "plain")} (standalone) in its items, and act in the turn the user's click starts.`);
    card = items(folderItem(join(base, "other")));
    assert.match((await call("sova_org_project", { op: "add", root: join(base, "plain") })).text, /^This adds a project: ask with sova_card/);
    card = items(folderItem(join(base, "plain"), org.id));
    assert.match((await call("sova_org_project", { op: "add", root: join(base, "plain") })).text, /^This adds a project/, "a row into an org approves no standalone add");
    card = items(folderItem(join(base, "plain"), undefined, "Named"));
    assert.match((await call("sova_org_project", { op: "add", root: join(base, "plain"), name: "Other name" })).text, /^This adds a project/, "the row's name is the one the click approved");
    card = items(projectItem(org.id, "prj_nothing0"));
    assert.match((await call("sova_org_project", { op: "add", root: join(base, "plain") })).text, /^This adds a project/, "another kind of row");
    card = null;
    assert.equal(listProjects().length, before);
    assert.equal(limits.count("org"), 0);
  });

  test("with the card's folder row: added standalone, recorded as the user's via the Overseer, one org write", async () => {
    limits.reset();
    card = items(folderItem(join(base, "plain"), undefined, "Plain"));
    const r = await call("sova_org_project", { op: "add", root: join(base, "plain") });
    card = null;
    assert.ok(r.ok, r.text);
    const made = projectByRoot(join(base, "plain"))!;
    assert.equal(made.name, "Plain", "the card row's name");
    assert.equal(r.text, `Added Plain (${made.id}): ${join(base, "plain")}.`);
    assert.equal(limits.count("org"), 1);
    assert.equal(orgs.orgOfProject(made.id), null);
    assert.equal(hostOf(made.id).data(`project/${made.id}`)?.via, "overseer", "its data");
    const start = logRows(`project/${made.id}`, "sova/started");
    assert.equal(start.length, 1);
    assert.deepEqual([start[0]!.envelope.via, start[0]!.envelope.overseerId], ["overseer", OVERSEER_ID], "its start row");
    const logged = readFileSync(overseerActionsFile(), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.tool === "sova_org_project" && l.args?.op === "add");
    assert.equal(logged.at(-1).outcome, "ok");
  });

  test("into an org: placed there through Add Project, the placement marked via the Overseer", async () => {
    card = items(folderItem(join(base, "inorg"), org.id));
    const r = await call("sova_org_project", { op: "add", root: join(base, "inorg"), org: "Addco", name: "Inside" });
    assert.ok(r.ok, r.text);
    // The row named no name: any name the call gives is the user's.
    card = null;
    const made = projectByRoot(join(base, "inorg"))!;
    assert.equal(orgs.orgOfProject(made.id), org.id);
    assert.equal(r.text, `Added Inside (${made.id}) in Addco: ${join(base, "inorg")}.`);
    assert.equal(hostOf(org.id).data(`project/${made.id}`)?.via, "overseer");
    const place = logRows(`org/${org.id}`, "project/place").filter((x) => JSON.stringify(x).includes(made.id));
    assert.ok(place.length && place.every((x) => x.via === "overseer"), JSON.stringify(place));
  });

  test("a card's folder row: the checkout root (the folder asked for when it differs), ~/ expanded; a guarded or unknown folder matches nothing", async () => {
    const row = await addLookup.folder(join(base, "repo", "sub"), "Addco", "Repo");
    assert.deepEqual(row, { kind: "folder", id: join(base, "repo"), asked: join(base, "repo", "sub"), orgId: org.id, orgName: "Addco", name: "Repo" });
    const home = realpathSync(homedir());
    const mine = join(home, `oadd-${randomUUID().slice(0, 8)}`);
    mkdirSync(mine);
    try {
      assert.equal((await addLookup.folder(`~/${basename(mine)}`, null))?.id, mine);
      card = items(folderItem(mine));
      const r = await call("sova_org_project", { op: "add", root: `~/${basename(mine)}` });
      assert.ok(r.ok, r.text);
      assert.ok(projectByRoot(mine));
    } finally {
      card = null;
    }
    mkdirSync(join(home, ".ssh", "keys"), { recursive: true });
    assert.equal(await addLookup.folder(join(home, ".ssh", "keys"), null), null, "credentials");
    assert.equal(await addLookup.folder(join(root, "ws4", "sessions"), null), null, "an org workspace");
    assert.equal(await addLookup.folder("relative/path", null), null);
    assert.equal(await addLookup.folder(join(base, "plain"), "No Such Org"), null);
    const rows = await confirm.resolveConfirmItems({ folders: [{ root: join(base, "repo", "sub"), note: "The repo." }], orgs: [{ id: "Addco" }] }, { session: async () => null, isSelf: () => false, idea: () => null, todo: () => null, ...addLookup }, (m) => new Error(m));
    assert.deepEqual(rows.map((x) => x.kind), ["org", "folder"], "orgs, then folders");
    assert.equal(await confirm.clickOnlyCard(rows, { session: async () => null, isSelf: () => false, idea: () => null, todo: () => null, ...addLookup }), true);
    await assert.rejects(
      () => confirm.resolveConfirmItems({ folders: [{ root: join(home, ".ssh", "keys") }] }, { session: async () => null, isSelf: () => false, idea: () => null, todo: () => null, ...addLookup }, (m) => new Error(m)),
      /folders: .*\.ssh\/keys.*A folder must be an absolute folder of this host/,
    );
    // Even with a row for it (a forged card), the tool and the route refuse a guarded folder.
    card = items(folderItem(join(home, ".ssh", "keys")));
    assert.equal((await call("sova_org_project", { op: "add", root: join(home, ".ssh", "keys") })).text, GUARDED_FOLDER);
    card = null;
    const res = await asOverseer("/api/projects", "POST", { root: join(home, ".ssh", "keys") }, { folders: [{ root: join(home, ".ssh", "keys"), org: null }] });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, GUARDED_FOLDER);
    assert.equal(projectByRoot(join(home, ".ssh", "keys")), undefined);
  });

  test("a subfolder adds its checkout root and says so", async () => {
    card = items(folderItem(join(base, "repo")));
    const r = await call("sova_org_project", { op: "add", root: join(base, "repo", "sub") });
    card = null;
    assert.ok(r.ok, r.text);
    assert.match(r.text, new RegExp(`: ${join(base, "repo")}, the checkout root of ${join(base, "repo", "sub")}\\.$`));
  });

  test("a session's folder: a local one is added as the session's; a remote one is refused", async () => {
    const local = sessionIn(join(base, "viasession"));
    card = items(folderItem(join(base, "viasession")));
    const r = await call("sova_org_project", { op: "add", session: local });
    assert.ok(r.ok, r.text);
    assert.equal(readProject(projectByRoot(join(base, "viasession"))!.id).origin, "session");
    const remote = sessionIn(join(targetsRoot(), "box", "srv", "app"));
    const far = await call("sova_org_project", { op: "add", session: remote });
    card = null;
    assert.equal(far.text, "That session's folder is on box; only a folder on this host becomes a project here.");
    assert.match((await call("sova_org_project", { op: "add", root: join(base, "other"), session: local })).text, /exactly one of root/);
  });

  test("the routes check the card themselves: a sender-marked add without the row is refused (403); a forged header records no via", async () => {
    const no = await asOverseer("/api/projects", "POST", { root: join(base, "other") });
    assert.equal(no.status, 403);
    const wrongOrg = await asOverseer(`/api/orgs/${org.id}/projects`, "POST", { root: join(base, "other") }, { folders: [{ root: join(base, "other"), org: null }] });
    assert.equal(wrongOrg.status, 403);
    assert.equal(projectByRoot(join(base, "other")), undefined);
    // Not the secret: the page's own add, the operator's with no via, whatever the headers say.
    const forged = await app.request("/api/projects", { method: "POST", headers: { "content-type": "application/json", "x-sova-overseer": "not-the-secret", [tools.OVERSEER_CARD_HEADER]: "{}" }, body: JSON.stringify({ root: join(base, "other") }) });
    assert.equal(forged.status, 201);
    const made = projectByRoot(join(base, "other"))!;
    assert.equal(hostOf(made.id).data(`project/${made.id}`)?.via, undefined);
    assert.equal(logRows(`project/${made.id}`, "sova/started")[0]!.envelope.via, undefined);
  });

  test("clone: only https without credentials, ssh, user@host:path or owner/name; checked before git runs; standalone; one at a time; no card", async () => {
    limits.reset();
    card = null;
    const parent = join(base, "clones");
    mkdirSync(parent);
    const src = join(base, "src", "widget");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "README.md"), "hi\n");
    gitIn(src, "init", "-q", "-b", "main");
    gitIn(src, "add", "README.md");
    gitIn(src, "commit", "-q", "-m", "init");
    for (const repo of [`file://${src}`, `git://example.invalid/x.git`, `http://example.invalid/x.git`, `https://user:tok@example.invalid/x.git`, `https://tok@example.invalid/x.git`, src, `ext::sh -c touch% /tmp/x`, `git@localhost:${src}`, `ssh://127.0.0.1${src}`]) {
      const r = await call("sova_org_project", { op: "add", clone: { repo, parent, folder: "nope" } });
      assert.equal(r.ok, false, repo);
      assert.equal(existsSync(join(parent, "nope")), false, `nothing made for ${repo}`);
    }
    assert.equal(limits.count("org"), 0, "refusals take nothing");
    assert.match((await call("sova_org_project", { op: "add", clone: { repo: "https://example.invalid/x.git", parent }, org: org.id })).text, /^A clone lands in no organization; import it after\.$/);
    // A destination inside an org workspace is refused before git runs.
    const ws = await asOverseer("/api/projects", "POST", { clone: { repo: "https://git.example.test/widget", parent: join(root, "ws4"), folder: "copy" } });
    assert.equal(ws.status, 400);
    assert.equal(existsSync(join(root, "ws4", "copy")), false);
    // An https URL git resolves to the local source (no network in tests), as the Overseer would ask for a hosted repo.
    const env = { GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT, GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0, GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0 };
    Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${join(base, "src")}/.insteadOf`, GIT_CONFIG_VALUE_0: "https://git.example.test/" });
    try {
      const [one, two] = await Promise.all([
        asOverseer("/api/projects", "POST", { clone: { repo: "https://git.example.test/widget", parent, folder: "w1" } }),
        asOverseer("/api/projects", "POST", { clone: { repo: "https://git.example.test/widget", parent, folder: "w2" } }),
      ]);
      assert.deepEqual([one.status, two.status], [201, 409]);
      assert.equal(((await two.json()) as { error: string }).error, "A clone is already running; try again when it ends.");
      assert.equal(existsSync(join(parent, "w2")), false);
      const r = await call("sova_org_project", { op: "add", clone: { repo: "https://git.example.test/widget", parent, folder: "w3" }, name: "Widget" });
      assert.ok(r.ok, r.text);
      const made = projectByRoot(join(parent, "w3"))!;
      assert.equal(r.text, `Cloned https://git.example.test/widget and added Widget (${made.id}), in no organization: ${join(parent, "w3")}.`);
      assert.equal(readProject(made.id).remote, "https://git.example.test/widget");
      assert.equal(orgs.orgOfProject(made.id), null);
      assert.equal(hostOf(made.id).data(`project/${made.id}`)?.via, "overseer");
      assert.equal(limits.count("org"), 1);
    } finally {
      for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("import: only on a card listing the project; the route 403s a sender-marked import without it; placed via the Overseer", async () => {
    const solo = projectByRoot(join(base, "plain"))!;
    card = null;
    const none = await call("sova_org_project", { op: "import", project: solo.id, org: org.id });
    assert.equal(none.text, `This reaches people or ends something: ask with sova_card, listing the project Plain (${solo.id}) in its items, and act in the turn the user's click starts.`);
    card = items(projectItem(org.id, "prj_other000"));
    assert.equal((await call("sova_org_project", { op: "import", project: solo.id, org: org.id })).ok, false);
    card = null;
    const route = await asOverseer(`/api/orgs/${org.id}/projects/import`, "POST", { projectId: solo.id, confirm: true });
    assert.equal(route.status, 403);
    const forged = await app.request(`/api/orgs/${org.id}/projects/import`, { method: "POST", headers: { "content-type": "application/json", "x-sova-overseer": "not-the-secret" }, body: JSON.stringify({ projectId: solo.id, confirm: true }) });
    assert.equal(forged.status, 403);
    assert.equal(orgs.orgOfProject(solo.id), null, "nothing moved");
    card = items({ kind: "project", id: solo.id, name: "Plain" });
    const done = await call("sova_org_project", { op: "import", project: "Plain", org: "Addco" });
    card = null;
    assert.ok(done.ok, done.text);
    assert.equal(orgs.orgOfProject(solo.id), org.id);
    const place = logRows(`org/${org.id}`, "project/place").filter((x) => JSON.stringify(x).includes(solo.id));
    assert.ok(place.length && place.every((x) => x.via === "overseer"), JSON.stringify(place));
  });

  test("detach: only on a card listing the org (the route 403s without it); attach never takes an org over from another host", async () => {
    const remote = join(root, "addco.git");
    gitIn(root, "init", "-q", "--bare", "-b", "main", remote);
    const dir = orgs.orgDir(org.id);
    await settled(dir);
    gitIn(dir, "remote", "add", "origin", remote);
    card = null;
    const none = await call("sova_org", { op: "detach", org: org.id });
    assert.match(none.text, /^This reaches people or ends something: ask with sova_card, listing the organization Addco/);
    card = items(orgItem("org_other0000"));
    assert.equal((await call("sova_org", { op: "detach", org: org.id })).ok, false);
    card = null;
    assert.equal((await asOverseer(`/api/orgs/${org.id}`, "DELETE", {})).status, 403);
    assert.ok(orgs.readIndex().orgs.some((o) => o.id === org.id), "still attached");
    card = items(orgItem(org.id));
    const off = await call("sova_org", { op: "detach", org: "Addco" });
    card = null;
    assert.ok(off.ok, off.text);
    assert.equal(off.text, "Detached Addco: it left this host, and its owner's link, if it had one, was turned off. Its workspace repo is untouched.");
    assert.equal(orgs.readIndex().orgs.some((o) => o.id === org.id), false);
    await settled(dir);
    const detachRow = logRows(`residence/${org.id}`, "org/detach").at(-1)!;
    assert.equal(detachRow.via, "overseer");
    // Attached again from its repo: no card, recorded via the Overseer.
    const back = await call("sova_org", { op: "attach", dir });
    assert.ok(back.ok, back.text);
    assert.match(back.text, /^Attached Addco \(org_[a-z0-9]+\) from /);
    const start = logRows(`residence/${org.id}`, "sova/started").at(-1)!;
    assert.deepEqual([start.envelope.via, start.envelope.overseerId], ["overseer", OVERSEER_ID]);
    await settled(dir);
    gitIn(dir, "push", "-q", "origin", "main");
    // Held by another host (a clone whose holder is someone else): refused, nothing attached, never confirmed for it.
    const { OrgHost } = await import("./org-host");
    const lapDir = join(root, "lap-held");
    mkdirSync(join(lapDir, "sessions"), { recursive: true });
    gitIn(root, "init", "-q", "-b", "main", lapDir);
    writeFileSync(join(lapDir, "sessions", ".gitkeep"), "");
    const lap = await OrgHost.open({ orgId: "org_lapheld01", workspaceDir: lapDir, stateDir: join(root, "lap-state"), durable: false });
    await lap.start("org/org_lapheld01", "org", { id: "org_lapheld01", name: "Harbor", slug: "harbor", createdAt: Date.parse("2026-09-27T10:00:00.000Z") }, { by: "operator" });
    await lap.act("org/org_lapheld01", "holder/claim", { hostId: "h_laptop00", hostName: "laptop", since: Date.parse("2026-09-27T10:00:00.000Z") }, { by: "system" });
    gitIn(lapDir, "add", "-A");
    gitIn(lapDir, "commit", "-q", "-m", "laptop");
    await lap.close();
    const held = await call("sova_org", { op: "attach", dir: lapDir });
    assert.equal(held.ok, false);
    assert.match(held.text, /^Not attached: laptop holds this organization .* Only the user can attach it anyway, taking it over from that host, on the Organizations page \(sova_navigate \{page: "orgs"\}\)\.$/);
    assert.equal(orgs.readIndex().orgs.some((o) => o.id === "org_lapheld01"), false);
    // The route ignores confirm on the Overseer's call.
    const forcedRes = await asOverseer("/api/orgs/attach", "POST", { dir: lapDir, confirm: true });
    assert.equal(forcedRes.status, 409);
    assert.equal(((await forcedRes.json()) as { code?: string }).code, "held");
    assert.equal(orgs.readIndex().orgs.some((o) => o.id === "org_lapheld01"), false);
  });

  test("an unattended turn adds, clones, imports, attaches and detaches nothing", async () => {
    attended = false;
    try {
      for (const [name, params] of [
        ["sova_org_project", { op: "add", root: join(base, "other") }],
        ["sova_org_project", { op: "add", clone: { repo: "o/r", parent: base } }],
        ["sova_org_project", { op: "import", project: "x", org: "y" }],
        ["sova_org", { op: "attach", dir: base }],
        ["sova_org", { op: "detach", org: "Addco" }],
      ] as const) {
        const r = await call(name, params as Record<string, unknown>);
        assert.match(r.text, /^This turn was not started by the user/, `${name} ${params.op}`);
      }
    } finally {
      attended = true;
    }
  });

  test("marker: no contact value, link or About text in any of these results", () => {
    const mine = outputs.filter((o) => /add|import|attach|detach/.test(o.label));
    assert.ok(mine.length > 20, `${mine.length}`);
    for (const o of mine) assert.equal(leaksContact(o.text), null, o.label);
    for (const o of mine) assert.ok(!o.text.includes("ABOUT-MARKER") && !o.text.includes("/h/") && !o.text.includes("/i/"), o.label);
  });
});
