// Run: pnpm exec tsx --test server/baton-offers.test.ts. Slice 2 of §app/baton and
// §app/organizations: offers and leases, referrals, the wrap-up's writer, spawn-for-person, events.
// A throwaway PI_CODING_AGENT_DIR and workspace in the OS temp dir; no model is called.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import { BATON_OFFER_ENTRY, BATON_PROPOSAL_ENTRY, BATON_SENT_ENTRY, BATON_WRAPUP_ENTRY, LEASE_IDLE_MS, OPERATOR, POOL } from "../shared/baton";
import type { Person } from "../shared/orgs";
import type { SessionSummary } from "../shared/protocol";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-baton-offers-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const { onBatonEvent } = await import("./baton-events");
const { batonTools } = await import("./baton-loadout");
const { batonView } = await import("./baton-view");
const wrap = await import("./baton-wrapup");
const { registerOrgRoutes } = await import("./org-routes");
const { sessionItems } = await import("./attention");

after(() => rmSync(root, { recursive: true, force: true }));

const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
const tony = orgs.addPerson(org.id, { name: "Tony Reyes", role: "IT" });
const maria = orgs.addPerson(org.id, { name: "Maria Lopez", role: "Payroll" });
const carlos = orgs.addPerson(org.id, { name: "Carlos", role: "CEO" });
const events: { type: string; sessionId: string }[] = [];
onBatonEvent((e) => events.push({ type: e.type, sessionId: e.sessionId }));

const entriesOf = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

describe("hand_to targets", () => {
  test("a roster line copied by the model resolves to that person", () => {
    const roster = orgs.readRoster(org.id);
    for (const raw of [`Maria Lopez (id ${maria.id})`, `Maria Lopez (${maria.id})`, "maria lopez — Payroll", maria.id, "Maria Lopez"])
      assert.deepEqual(baton.resolveTarget(roster, raw, "Omar"), { ok: true, ref: maria.id }, raw);
    // An id and a name that disagree, or two ids, route nobody: the model is asked which it meant.
    assert.match((baton.resolveTarget(roster, `Mallory (${maria.id})`, "Omar") as { error: string }).error, /Maria Lopez's, but the name says Mallory/);
    assert.match((baton.resolveTarget(roster, `operator (${maria.id})`, "Omar") as { error: string }).error, /Which did you mean/);
    assert.match((baton.resolveTarget(roster, `${maria.id} ${tony.id}`, "Omar") as { error: string }).error, /more than one person/);
    // An id that is not on the roster is not taken on trust; the name decides.
    const r = baton.resolveTarget(roster, "Bob (p_zzzzzzzz)", "Omar");
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /propose_roster_edit/);
  });

  test("an offer needs two or more active people, never the operator", () => {
    const roster = orgs.readRoster(org.id);
    assert.equal(baton.resolveInvitees(roster, [tony.id], "Omar").ok, false);
    assert.equal(baton.resolveInvitees(roster, [tony.id, tony.id], "Omar").ok, false, "two different people");
    assert.equal(baton.resolveInvitees(roster, [tony.id, "operator"], "Omar").ok, false);
    assert.deepEqual(baton.resolveInvitees(roster, [tony.id, "Maria Lopez"], "Omar"), { ok: true, refs: [tony.id, maria.id] });
  });
});

describe("offers and leases", () => {
  const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: [tony.id, maria.id, carlos.id], publicTitle: "Hosting", goal: "g", question: "Who hosts?" });
  const tokenOf = (id: string) => c.links!.find((l) => l.personId === id)!.token;

  test("starting as an offer: the pool holds it, one link each, an offer entry in the transcript", () => {
    const row = baton.batonById(c.sessionId)!.row;
    assert.equal(row.holder, null);
    assert.equal(row.state, "open");
    assert.equal(c.token, undefined);
    assert.deepEqual(c.links!.map((l) => l.personId), [tony.id, maria.id, carlos.id]);
    assert.equal(row.handoffs[0]!.to, POOL);
    assert.equal(row.handoffs[0]!.offerId, row.offerId);
    const offer = entriesOf(c.path).find((e) => e.customType === BATON_OFFER_ENTRY);
    assert.deepEqual(offer.data.to, [tony.id, maria.id, carlos.id]);
    const f = baton.batonSummaryField(c.path)!;
    assert.equal(f.holder, "3 invited");
    assert.deepEqual(f.offer, { state: "open", invited: 3 });
    assert.equal(f.sendLink, undefined, "the links were handed out at the start");
    for (const l of c.links!) assert.equal((baton.linkAccess(l.token) as { canWrite: boolean }).canWrite, true);
  });

  test("the first accepted message claims it; the others are 'taken' and refused, and see nothing past the offer", () => {
    const t0 = Date.now();
    const noted = baton.noteMessage(c.sessionId, tony.id, t0);
    assert.deepEqual(noted.claimed, { n: 1, offerId: noted.row.offerId });
    const row = baton.batonById(c.sessionId)!.row;
    assert.equal(row.holder, tony.id);
    const offer = baton.currentOffer(row)!;
    assert.equal(offer.state, "held");
    assert.equal(Date.parse(offer.leaseUntil!) - t0, LEASE_IDLE_MS);
    const m = baton.linkAccess(tokenOf(maria.id), t0 + 1000);
    assert.equal(m.ok && m.reason, "taken");
    assert.throws(() => baton.noteMessage(c.sessionId, maria.id, t0 + 1000), /Someone else is answering/);
    assert.throws(() => baton.noteMessage(c.sessionId, OPERATOR, t0 + 1000), /holds the baton/);
    assert.equal(baton.batonById(c.sessionId)!.row.budget.messagesUsed, 1, "refusals are not counted");
    // The view Maria's page gets: up to the offer card, the holder unnamed.
    const branch = [
      ...entriesOf(c.path),
      { type: "message", id: "u1", message: { role: "user", content: "TONY-SAYS" } },
      { type: "custom", id: "s1", customType: BATON_SENT_ENTRY, data: { v: 1, targetId: "u1", by: tony.id } },
    ];
    const names = baton.namesOf(org.id);
    const cut = batonView({ row, branch, names, viewer: maria.id, untilOffer: 1, redact: (t) => t });
    assert.ok(!JSON.stringify(cut).includes("TONY-SAYS"));
    assert.equal(cut.holder, null);
    assert.equal(cut.items.at(-1)!.kind, "offer");
    const card = cut.items.at(-1) as { to: string[]; invited: number };
    assert.deepEqual([card.to, card.invited], [[], 3], "an invitee learns how many were asked, never who");
    const unfiltered = batonView({ row, branch, names, redact: (t) => t }).items.find((i) => i.kind === "offer") as { to: string[] };
    assert.deepEqual(unfiltered.to, ["Tony Reyes", "Maria Lopez", "Carlos"], "the view with no viewer names them");
    const full = batonView({ row, branch, names, viewer: tony.id, redact: (t) => t });
    assert.ok(JSON.stringify(full).includes("TONY-SAYS"));
  });

  test("each message and each reply renew the lease; idle past it, the pool takes it back and anyone may claim", () => {
    const t0 = Date.now();
    baton.touchLease(c.sessionId, t0 + 10 * 60_000);
    const until = Date.parse(baton.currentOffer(baton.batonById(c.sessionId)!.row)!.leaseUntil!);
    assert.equal(until, t0 + 10 * 60_000 + LEASE_IDLE_MS, "the reply renewed it");
    assert.deepEqual(baton.lapsedLeases(until - 1), []);
    assert.deepEqual(baton.lapsedLeases(until + 1), [c.sessionId]);
    // Maria's link may write as soon as it has lapsed, before any tick: the route is the lock.
    const m = baton.linkAccess(tokenOf(maria.id), until + 1);
    assert.equal(m.ok && m.canWrite, true);
    const noted = baton.noteMessage(c.sessionId, maria.id, until + 1);
    assert.equal(noted.expired?.by, tony.id);
    assert.ok(noted.claimed);
    assert.equal(baton.batonById(c.sessionId)!.row.holder, maria.id);
    assert.deepEqual(baton.batonById(c.sessionId)!.row.participants.sort(), [OPERATOR, maria.id, tony.id].sort());
    // The ticker's path: a lapse with no message returns it to the pool.
    const later = until + 1 + LEASE_IDLE_MS + 1;
    assert.equal(baton.expireLease(c.sessionId, later)?.by, maria.id);
    assert.equal(baton.expireLease(c.sessionId, later), null, "only once");
    assert.equal(baton.batonById(c.sessionId)!.row.holder, null);
    assert.equal(baton.batonSummaryField(c.path)!.holder, "3 invited");
  });

  test("handing on withdraws the offer: invitees who never held it get 410, those who did read on", () => {
    const now = Date.now() + 3 * LEASE_IDLE_MS;
    baton.noteMessage(c.sessionId, tony.id, now);
    baton.handTo(c.sessionId, OPERATOR, "Which plan?", "", new Date(now));
    const row = baton.batonById(c.sessionId)!.row;
    assert.equal(row.offerId, undefined);
    assert.equal(row.offers![0]!.state, "withdrawn");
    assert.equal(row.handoffs.at(-1)!.from, tony.id);
    assert.deepEqual(baton.linkAccess(tokenOf(carlos.id), now), { ok: false, status: 410 }, "never held it");
    const t = baton.linkAccess(tokenOf(tony.id), now);
    assert.equal(t.ok && t.reason, "needs-operator");
    const m = baton.linkAccess(tokenOf(maria.id), now);
    assert.equal(m.ok && m.canWrite, false, "Maria held it once: reads, never writes");
  });

  test("an offer from a live session; re-mint one invitee's link; an unclaimed offer taken back revokes every link", () => {
    const out = baton.startOffer(c.sessionId, [maria.id, carlos.id], "Payroll day?", "brief", new Date());
    assert.equal(out.from, OPERATOR);
    assert.equal(out.n, baton.batonById(c.sessionId)!.row.handoffs.length);
    assert.throws(() => baton.rotateLink(c.sessionId), /invitees/);
    const again = baton.rotateLink(c.sessionId, carlos.id);
    const first = out.links.find((l) => l.personId === carlos.id)!.token;
    assert.deepEqual(baton.linkAccess(first), { ok: false, status: 410 }, "the older link of that person stops");
    assert.equal((baton.linkAccess(again.token) as { canWrite: boolean }).canWrite, true);
    baton.handTo(c.sessionId, OPERATOR, "(taken back)", "", new Date());
    assert.equal(baton.batonById(c.sessionId)!.row.handoffs.at(-1)!.from, POOL);
    assert.deepEqual(baton.linkAccess(again.token), { ok: false, status: 410 }, "Carlos never held it");
  });
});

describe("referrals", () => {
  const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Bank", goal: "g" });
  const appended: { type: string; data: any }[] = [];
  const tools = batonTools(c.sessionId, (type, data) => appended.push({ type, data }));
  const propose = tools.find((t) => t.name === "propose_roster_edit")!;
  const call = (params: unknown) => propose.execute("id", params as never, undefined, undefined, undefined as never);

  test("the tool refuses until it has name, a contact channel, role, why and the referrer's words, and says what's missing", async () => {
    await assert.rejects(call({ name: "Bob Smith", role: "IT lead", contact: {}, why: "runs the bank portal", quote: "ask Bob" }), /still missing a contact channel/);
    await assert.rejects(call({ name: "Bob Smith", role: "", contact: { email: "bob@example.com" }, why: "", quote: "ask Bob" }), /role, why they were referred/);
    await assert.rejects(call({ name: "Tony Reyes", role: "x", contact: { email: "t@example.com" }, why: "y", quote: "z" }), /already on the roster/);
    assert.equal(orgs.readRoster(org.id).some((p) => p.name === "Bob Smith"), false, "nothing written");
  });

  test("complete: a proposed person referred by the holder, the transcript card, a decide item; hidden from hand_to", async () => {
    await call({ name: "Bob Smith", role: "IT lead", contact: { email: "bob@example.com" }, why: "runs the bank portal", quote: "ask Bob, he runs it", decides: ["bank access"] });
    const bob = orgs.readRoster(org.id).find((p) => p.name === "Bob Smith")!;
    assert.equal(bob.status, "proposed");
    assert.deepEqual(bob.referral, { why: "runs the bank portal", referredBy: tony.id, sessionId: c.sessionId, quote: "ask Bob, he runs it" });
    assert.ok(orgs.readHistory(org.id, bob.id).every((h) => h.by.kind === "referral"));
    assert.equal(appended.at(-1)!.type, BATON_PROPOSAL_ENTRY);
    assert.equal(appended.at(-1)!.data.by, tony.id);
    assert.ok(events.some((e) => e.type === "proposal" && e.sessionId === c.sessionId));
    const field = baton.batonSummaryField(c.path)!;
    assert.equal(field.proposals?.[0]?.name, "Bob Smith");
    assert.equal(field.proposals?.[0]?.by, "Tony Reyes");
    const items = sessionItems({ summary: { id: c.sessionId, path: c.path, title: "Bank", cwd: "/x", lastActiveAt: new Date().toISOString(), baton: field } as SessionSummary, dialogs: [], failedWorkers: 0, queued: 0 } as never, Date.now());
    const it = items.find((i) => i.kind === "roster-proposal")!;
    assert.equal(it.tier, "decide");
    assert.equal(it.detail, "Approve Bob Smith (IT lead) proposed by Tony Reyes?");
    assert.match((baton.resolveTarget(orgs.readRoster(org.id), "Bob Smith", "Omar") as { error: string }).error, /approve/);
    await assert.rejects(call({ name: "Bob Smith", role: "x", contact: { email: "b@example.com" }, why: "y", quote: "z" }), /already proposed/);
  });

  test("approve and decline: operator or project overseer, only from proposed; the wrap-up never", () => {
    const bob = orgs.readRoster(org.id).find((p) => p.name === "Bob Smith")!;
    assert.throws(() => orgs.decidePerson(org.id, bob.id, true, { kind: "wrapup" }), /may not approve/);
    assert.throws(() => orgs.applyChange(org.id, bob.id, { status: "active" }, { kind: "overseer" }), /may not write status/, "no status writes outside a decision");
    const approved = orgs.approvePerson(org.id, bob.id, { kind: "overseer", sessionId: "po-1" });
    assert.equal(approved.status, "active");
    assert.equal(orgs.readHistory(org.id, bob.id).at(-1)!.by.kind, "overseer");
    assert.throws(() => orgs.declinePerson(org.id, bob.id), /not waiting for approval/);
    assert.equal(baton.batonSummaryField(c.path)!.proposals, undefined, "no longer waiting");
    // Decline keeps the referral and marks them left.
    const eve = orgs.addPerson(org.id, { name: "Eve", status: "proposed", role: "Ops", contact: { phone: "1" }, referral: { why: "w", referredBy: tony.id } });
    const declined = orgs.declinePerson(org.id, eve.id);
    assert.equal(declined.status, "left");
    assert.equal(declined.referral?.why, "w");
    assert.match((baton.resolveTarget(orgs.readRoster(org.id), "Eve", "Omar") as { error: string }).error, /declined/);
  });
});

describe("the wrap-up's writer", () => {
  const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Wrap", goal: "g" });
  baton.handTo(c.sessionId, maria.id, "q", "", new Date());
  const branch = [
    { type: "message", id: "u1", message: { role: "user", content: "We run everything on Xero and I write SQL daily" } },
    { type: "custom", id: "m1", customType: BATON_SENT_ENTRY, data: { v: 1, targetId: "u1", by: tony.id } },
    { type: "message", id: "u2", message: { role: "user", content: [{ type: "text", text: "Hola, prefiero español por favor" }] } },
    { type: "custom", id: "m2", customType: BATON_SENT_ENTRY, data: { v: 1, targetId: "u2", by: maria.id } },
    { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "Tony is a Xero expert" }] } },
    { type: "custom", id: "w1", customType: BATON_WRAPUP_ENTRY, data: { v: 1, phase: "start" } },
    { type: "message", id: "u3", message: { role: "user", content: "[Wrap-up] Tony is also a Kubernetes admin" } },
  ];
  const tool = wrap.wrapupTool(c.sessionId);
  const run = (updates: unknown[]) => tool.execute("id", { updates } as never, undefined, undefined, { sessionManager: { getBranch: () => branch } } as never);

  test("pure helpers: a person's own words before the wrap-up; merged values", () => {
    const mine = wrap.messagesByPerson(branch);
    assert.deepEqual([...mine.keys()].sort(), [maria.id, tony.id].sort());
    assert.equal(wrap.findQuote(mine.get(tony.id), "on  XERO and i write"), "u1");
    assert.equal(wrap.findQuote(mine.get(maria.id), "on Xero and I write"), null, "not her words");
    assert.equal(wrap.findQuote(mine.get(tony.id), "Kubernetes admin"), null, "nothing after the wrap-up marker");
    assert.equal(wrap.findQuote(mine.get(tony.id), "Xero"), null, "too short to be evidence");
    const p: Person = { ...tony, skills: ["SQL"], competence: { SQL: { level: 3, n: 2 } } };
    assert.deepEqual(wrap.mergedValue(p, "skills", ["sql", "Xero"]), ["SQL", "Xero"]);
    assert.deepEqual(wrap.mergedValue(p, "competence", { SQL: 4 }), { SQL: { level: 4, n: 3 } });
    assert.throws(() => wrap.mergedValue(p, "competence", { SQL: 9 }), /1–5/);
    assert.deepEqual(wrap.mergedValue(p, "competence", '{"AWS billing": 5}'), { SQL: { level: 3, n: 2 }, "AWS billing": { level: 5, n: 1 } }, "JSON text, as models send it");
    assert.deepEqual(wrap.mergedValue(p, "skills", '["AWS"]'), ["SQL", "AWS"]);
  });

  test("a known language changes only on a stated preference; a first one may be observed", async () => {
    assert.equal(wrap.statesLanguage("Please write to me in English from now on"), true);
    assert.equal(wrap.statesLanguage("Hola, prefiero español por favor"), true);
    assert.equal(wrap.statesLanguage("We run everything on Xero and I write SQL daily"), false, "a message in English states nothing");
    const d = baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Lang", goal: "g" });
    const ana = orgs.addPerson(org.id, { name: "Ana", role: "Ops", language: "es-CO" });
    const ben = orgs.addPerson(org.id, { name: "Ben", role: "Ops" });
    baton.handTo(d.sessionId, ana.id, "q", "", new Date());
    baton.handTo(d.sessionId, ben.id, "q", "", new Date());
    const br = [
      { type: "message", id: "a1", message: { role: "user", content: "Sure, the invoices go out on Mondays." } },
      { type: "custom", id: "a2", customType: BATON_SENT_ENTRY, data: { v: 1, targetId: "a1", by: ana.id } },
      { type: "message", id: "b1", message: { role: "user", content: "Hi, the bank export runs nightly." } },
      { type: "custom", id: "b2", customType: BATON_SENT_ENTRY, data: { v: 1, targetId: "b1", by: ben.id } },
    ];
    const tool = wrap.wrapupTool(d.sessionId);
    const r = wrap.beginWrapupRun(d.sessionId);
    try {
      await tool.execute("id", { updates: [
        { personId: ana.id, field: "language", to: "en", quote: "the invoices go out on Mondays" },
        { personId: ben.id, field: "language", to: "en", quote: "the bank export runs nightly" },
      ] } as never, undefined, undefined, { sessionManager: { getBranch: () => br } } as never);
    } finally {
      wrap.endWrapupRun(d.sessionId);
    }
    const roster = orgs.readRoster(org.id);
    assert.equal(roster.find((p) => p.id === ana.id)!.language, "es-CO", "one English message does not change Ana's Spanish");
    assert.equal(roster.find((p) => p.id === ben.id)!.language, "en", "Ben had none: observed");
    assert.deepEqual(r.refused.map((x) => [x.personId, x.field]), [[ana.id, "language"]]);
  });

  test("outside a wrap-up the tool refuses", async () => {
    await assert.rejects(run([]), /no wrap-up running/);
  });

  test("writes only its four fields, only a participant's, only with their own words; everything logged", async () => {
    const r = wrap.beginWrapupRun(c.sessionId);
    try {
      await run([
        { personId: tony.id, field: "skills", to: ["Xero", "SQL"], quote: "We run everything on Xero" },
        { personId: maria.id, field: "language", to: "es-CO", quote: "prefiero español por favor" },
        { personId: tony.id, field: "role", to: "CFO", quote: "We run everything on Xero" },
        { personId: tony.id, field: "decides", to: ["payments"], quote: "We run everything on Xero" },
        { personId: maria.id, field: "voice", to: "formal", quote: "We run everything on Xero" },
        { personId: carlos.id, field: "skills", to: ["x"], quote: "We run everything on Xero" },
      ]);
    } finally {
      wrap.endWrapupRun(c.sessionId);
    }
    const roster = orgs.readRoster(org.id);
    assert.deepEqual(roster.find((p) => p.id === tony.id)!.skills, ["Xero", "SQL"]);
    assert.equal(roster.find((p) => p.id === tony.id)!.role, "IT", "role is refused for the wrap-up");
    assert.deepEqual(roster.find((p) => p.id === tony.id)!.decides, []);
    assert.equal(roster.find((p) => p.id === maria.id)!.language, "es-CO");
    assert.equal(roster.find((p) => p.id === maria.id)!.voice, "", "someone else's words are no evidence about her");
    assert.deepEqual(r.applied.map((a) => `${a.personId === tony.id ? "tony" : "maria"}.${a.field}`), ["tony.skills", "maria.language"]);
    assert.deepEqual(
      r.refused.map((x) => x.field),
      ["role", "decides", "voice", "skills"],
    );
    const line = orgs.readHistory(org.id, maria.id).at(-1)!;
    assert.deepEqual(line.by, { kind: "wrapup", sessionId: c.sessionId, entryId: "u2", quote: "prefiero español por favor" });
    // One-click revert of an autonomous change.
    orgs.revertChange(org.id, maria.id, line.at);
    assert.equal(orgs.readRoster(org.id).find((p) => p.id === maria.id)!.language, "");
    const feed = orgs.recentChanges(org.id, 3);
    assert.equal(feed[0]!.revertOf, line.at);
    assert.equal(feed[0]!.name, "Maria Lopez");
  });

  test("the outsider view ends at the wrap-up marker", () => {
    const row = baton.batonById(c.sessionId)!.row;
    const v = batonView({ row, branch, names: baton.namesOf(org.id), viewer: tony.id, redact: (t) => t });
    assert.ok(!JSON.stringify(v).includes("Kubernetes"));
    assert.equal(v.items.length, 3);
  });

  test("wantsWrapup: over, not yet run, a roster person took part", () => {
    const row = baton.batonById(c.sessionId)!.row;
    assert.equal(wrap.wantsWrapup(row), false, "still open");
    assert.equal(wrap.wantsWrapup({ ...row, state: "done" }), true);
    assert.equal(wrap.wantsWrapup({ ...row, state: "done", wrapup: { state: "done", at: "", applied: 0, refused: [] } }), false);
    assert.equal(wrap.wantsWrapup({ ...row, state: "closed", participants: [OPERATOR] }), false);
  });
});

describe("routes: spawn-for-person, owner, handoff", () => {
  const app = new Hono();
  registerOrgRoutes(app);
  const json = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

  test("POST /api/baton: an offer returns one link per invitee; owner from a request is ignored; a parent carries its project", async () => {
    const res = await json("POST", "/api/baton", { orgId: org.id, projectId: project.id, to: [tony.id, maria.id], publicTitle: "Offer", goal: "g", owner: { overseerOf: "evil" } });
    assert.equal(res.status, 201);
    const out = (await res.json()) as { sessionId: string; links: { personId: string; name: string; link: string }[] };
    assert.deepEqual(out.links.map((l) => l.name), ["Tony Reyes", "Maria Lopez"]);
    assert.match(out.links[0]!.link, /\/h\/[A-Za-z0-9_-]{43}$/);
    assert.equal(baton.batonById(out.sessionId)!.row.owner, "operator");
    const child = await json("POST", "/api/baton", { orgId: org.id, parentSessionId: out.sessionId, to: carlos.id, publicTitle: "For Carlos", goal: "g", briefing: "Tony referred you" });
    assert.equal(child.status, 201);
    const row = baton.batonById(((await child.json()) as { sessionId: string }).sessionId)!.row;
    assert.equal(row.parent, out.sessionId);
    assert.equal(row.projectId, project.id);
    assert.equal(row.handoffs[0]!.briefing, "Tony referred you");
  });

  test("in-process callers may set the owner", () => {
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: OPERATOR, publicTitle: "Conflict", goal: "g", owner: { overseerOf: project.id } });
    const row = baton.batonById(c.sessionId)!.row;
    assert.deepEqual(row.owner, { overseerOf: project.id });
    assert.ok(baton.batonSummaryField(c.path)!.needsYou, "held by the operator from the start = Needs you");
    assert.throws(() => baton.createBaton({ orgId: org.id, projectId: project.id, to: OPERATOR, publicTitle: "x", goal: "g", owner: "someone" as never }), /owner/);
  });

  test("approve/decline/changes routes; /handoff refuses a proposed person", async () => {
    const zed = orgs.addPerson(org.id, { name: "Zed", status: "proposed", role: "Ops", contact: { email: "z@example.com" }, referral: { why: "w", referredBy: OPERATOR } });
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: OPERATOR, publicTitle: "Hand", goal: "g" });
    const refused = await json("POST", `/api/baton/${c.sessionId}/handoff`, { to: zed.id, question: "q" });
    assert.equal(refused.status, 409);
    assert.equal((await json("POST", `/api/orgs/${org.id}/people/${zed.id}/approve`)).status, 200);
    const feed = (await (await json("GET", `/api/orgs/${org.id}/changes?limit=1`)).json()) as { name: string; field: string; to: unknown }[];
    assert.deepEqual([feed[0]!.name, feed[0]!.field, feed[0]!.to], ["Zed", "status", "active"]);
    const detail = (await (await json("GET", `/api/orgs/${org.id}`)).json()) as { recentChanges: unknown[] };
    assert.ok(detail.recentChanges.length > 0 && detail.recentChanges.length <= 20);
  });

  test("events: start, offer, hand-off, done, close", () => {
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Ev", goal: "g" });
    baton.startOffer(c.sessionId, [tony.id, maria.id], "q", "", new Date());
    baton.handTo(c.sessionId, OPERATOR, "q", "", new Date());
    baton.markDone(c.sessionId, new Date());
    baton.closeBaton(c.sessionId);
    assert.deepEqual(
      events.filter((e) => e.sessionId === c.sessionId).map((e) => e.type),
      ["handoff", "offer", "handoff", "done", "closed"],
    );
  });
});

describe("the operator's transcript", async () => {
  const { normalizeEntry } = await import("./transcript");
  test("every new baton entry is one info row with its mark; a malformed one renders nothing", () => {
    const row = (customType: string, data: unknown) => normalizeEntry({ type: "custom", id: "x", parentId: null, timestamp: "2026-09-26T00:00:00.000Z", customType, data });
    const shapes: [string, unknown, string][] = [
      [BATON_OFFER_ENTRY, { v: 1, n: 2, offerId: "off_a", from: OPERATOR, to: ["p_a", "p_b"], question: "q", briefing: "b" }, "offer"],
      ["sova-baton-lease", { v: 1, n: 2, offerId: "off_a", event: "claimed", by: "p_a" }, "lease"],
      [BATON_PROPOSAL_ENTRY, { v: 1, personId: "p_c", name: "Bob", role: "IT", why: "w", by: "p_a" }, "proposal"],
      [BATON_WRAPUP_ENTRY, { v: 1, phase: "start" }, "wrapup"],
      [BATON_WRAPUP_ENTRY, { v: 1, phase: "end", applied: [], refused: [] }, "wrapup"],
    ];
    for (const [type, data, kind] of shapes) {
      const items = row(type, data);
      assert.equal(items.length, 1, type);
      assert.equal(items[0]!.kind, "info");
      assert.equal(items[0]!.batonMark?.kind, kind);
    }
    assert.deepEqual(row(BATON_OFFER_ENTRY, { v: 1 }), []);
    assert.deepEqual(row("sova-baton-lease", { v: 1, n: 1, event: "stolen" }), []);
  });
});

describe("referral contacts", () => {
  test("a placeholder is no contact channel; real ones pass", () => {
    assert.deepEqual(orgs.contactProblems({ email: "ask Tony for Bob Smith's contact" }), ["the email is not an email address"]);
    assert.deepEqual(orgs.contactProblems({ phone: "unknown" }), ["the phone is not a phone number"]);
    assert.deepEqual(orgs.contactProblems({ whatsapp: "12 34" }), ["the WhatsApp is not a phone number"]);
    assert.deepEqual(orgs.contactProblems({ other: "ask around" }), ["the other channel names no handle or number"]);
    assert.deepEqual(orgs.contactProblems({ email: "bob@gate.example", phone: "+57 (300) 123-4567", other: "Slack: @bob" }), []);
    assert.throws(
      () => orgs.applyChange(org.id, null, { name: "Placeholder Pete", status: "proposed", role: "x", contact: { email: "ask Tony" }, referral: { why: "w", referredBy: tony.id } }, { kind: "referral" }),
      /real way to reach them/,
    );
  });
});

test("SOVA_BATON_LEASE_MS shortens the lease (hermetic tests only); nonsense keeps 15 minutes", () => {
  assert.equal(baton.leaseMs({}), LEASE_IDLE_MS);
  assert.equal(baton.leaseMs({ SOVA_BATON_LEASE_MS: "20000" }), 20_000);
  assert.equal(baton.leaseMs({ SOVA_BATON_LEASE_MS: "5" }), LEASE_IDLE_MS, "under a second is refused");
  assert.equal(baton.leaseMs({ SOVA_BATON_LEASE_MS: "soon" }), LEASE_IDLE_MS);
});

describe("the share hub's streaming", async () => {
  const hub = await import("./share/hub");
  test("a reply being written reaches the holder's page, never an invitee who has not held the offer", () => {
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: [tony.id, maria.id], publicTitle: "Stream", goal: "g" });
    const tokenOf = (id: string) => c.links!.find((l) => l.personId === id)!.token;
    const got: Record<string, string[]> = { tony: [], maria: [] };
    const fake = (who: "tony" | "maria") => ({ readyState: 1, OPEN: 1, send: (m: string) => got[who]!.push(m), on: () => {}, close: () => {} }) as never;
    hub.addWatcher(c.sessionId, fake("tony"), tokenOf(tony.id));
    hub.addWatcher(c.sessionId, fake("maria"), tokenOf(maria.id));
    baton.noteMessage(c.sessionId, tony.id);
    hub.streamShare(c.sessionId, "PARTIAL-REPLY");
    assert.equal(got.tony!.length, 1);
    assert.match(got.tony![0]!, /PARTIAL-REPLY/);
    assert.deepEqual(got.maria, [], "Maria is waiting in the pool: no stream");
    assert.equal(hub.offerOutsider(tokenOf(maria.id)), true);
    assert.equal(hub.offerOutsider(tokenOf(tony.id)), false);
  });
});

describe("createBaton without a link (in-process callers)", () => {
  test("mintLink: false mints nothing and the session asks the operator to send one", () => {
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Quiet", goal: "g", mintLink: false });
    assert.equal(c.token, undefined);
    assert.equal(baton.liveLinkCount(baton.batonById(c.sessionId)!.row), 0);
    assert.equal(baton.batonSummaryField(c.path)!.sendLink?.to, "Tony Reyes");
    const o = baton.createBaton({ orgId: org.id, projectId: project.id, to: [tony.id, maria.id], publicTitle: "Quiet offer", goal: "g", mintLink: false });
    assert.equal(o.links, undefined);
    assert.equal(baton.batonSummaryField(o.path)!.sendLink?.to, "Tony Reyes, Maria Lopez");
    baton.rotateLink(o.sessionId, tony.id);
    assert.equal(baton.batonSummaryField(o.path)!.sendLink?.to, "Maria Lopez", "only the invitee still without a link");
    baton.rotateLink(o.sessionId, maria.id);
    assert.equal(baton.batonSummaryField(o.path)!.sendLink, undefined, "every invitee has a link now");
    const live = baton.createBaton({ orgId: org.id, projectId: project.id, to: OPERATOR, publicTitle: "Live offer", goal: "g" });
    const out = baton.startOffer(live.sessionId, [tony.id, carlos.id], "q?", "", new Date(), false);
    assert.deepEqual(out.links, []);
    assert.equal(baton.batonSummaryField(live.path)!.sendLink?.to, "Tony Reyes, Carlos");
    // The default still mints (the HTTP route; mintLink in a request body is ignored).
    assert.ok(baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Loud", goal: "g" }).token);
  });
});

describe("regressions from the slice-2 verification", async () => {
  const { createShareServer } = await import("./share/listener");
  const { tickLeases } = await import("./baton-loadout");
  const { disposeAllChats } = await import("./chat-manager");
  const { default: WebSocket } = await import("ws");
  const server = createShareServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  after(async () => {
    server.close();
    server.closeAllConnections();
    await disposeAllChats();
  });
  const post = (token: string, text: string) => fetch(`${base}/api/h/${token}/message`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });

  test("N first messages at once on the share route: exactly one is accepted, the rest are 'taken'", async () => {
    const people = [tony, maria, carlos];
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: people.map((p) => p.id), publicTitle: "Race", goal: "g" });
    const res = await Promise.all(c.links!.map((l) => post(l.token, `me first, ${l.personId}`)));
    const bodies = await Promise.all(res.map((r) => r.json() as Promise<{ code?: string }>));
    const accepted = res.filter((r) => r.status === 202);
    assert.equal(accepted.length, 1, `statuses ${res.map((r) => r.status).join(",")}`);
    assert.deepEqual(bodies.filter((_, i) => res[i]!.status !== 202).map((b) => b.code), ["taken", "taken"]);
    const row = baton.batonById(c.sessionId)!.row;
    assert.equal(row.budget.messagesUsed, 1);
    assert.ok(people.some((p) => p.id === row.holder));
  });

  test("the share WebSocket writes nothing while taken; after the lease lapses a view that may write is pushed", async () => {
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: [tony.id, maria.id], publicTitle: "WS", goal: "g" });
    const mariaTok = c.links!.find((l) => l.personId === maria.id)!.token;
    const t0 = Date.now();
    baton.noteMessage(c.sessionId, tony.id, t0); // Tony holds a live lease
    const views: { canWrite: boolean; reason?: string }[] = [];
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws/h?token=${mariaTok}`);
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      if (m.type === "view") views.push(m.view.viewer);
    });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "prompt", text: "let me in" }));
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(views[0], { name: "Maria Lopez", canWrite: false, reason: "taken" }, "on connect: taken");
    const row = baton.batonById(c.sessionId)!.row;
    assert.equal(row.holder, tony.id, "a socket message claims nothing");
    assert.equal(row.budget.messagesUsed, 1, "and is not a message");
    await tickLeases(t0 + LEASE_IDLE_MS - 1);
    assert.equal(baton.batonById(c.sessionId)!.row.holder, tony.id, "not before the lease ends");
    await tickLeases(t0 + LEASE_IDLE_MS + 1);
    await new Promise((r) => setTimeout(r, 200));
    ws.close();
    assert.equal(baton.batonById(c.sessionId)!.row.holder, null, "back in the pool");
    assert.deepEqual(views.at(-1), { name: "Maria Lopez", canWrite: true }, "Maria's page was told she may write");
  });

  test("the wrap-up also runs on close, once, and never counts against the budget", async () => {
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Close wrap", goal: "g" });
    baton.noteMessage(c.sessionId, tony.id);
    // Tony's message, with its sender marker, as the runtime would have written them.
    const leaf = entriesOf(c.path).at(-1).id;
    const at = new Date().toISOString();
    appendFileSync(
      c.path,
      `${JSON.stringify({ type: "message", id: "tu1", parentId: leaf, timestamp: at, message: { role: "user", content: [{ type: "text", text: "The server is on AWS." }], timestamp: Date.now() } })}\n` +
        `${JSON.stringify({ type: "custom", id: "tm1", parentId: "tu1", timestamp: at, customType: BATON_SENT_ENTRY, data: { v: 1, targetId: "tu1", by: tony.id } })}\n`,
    );
    (await import("./write-guard")).markOwned(c.path); // as the runtime does after its own writes
    const app = new Hono();
    registerOrgRoutes(app);
    assert.equal((await app.request(`/api/baton/${c.sessionId}/close`, { method: "POST" })).status, 200);
    let row = baton.batonById(c.sessionId)!.row;
    for (let i = 0; i < 100 && (!row.wrapup || row.wrapup.state === "running"); i++) {
      await new Promise((r) => setTimeout(r, 50));
      row = baton.batonById(c.sessionId)!.row;
    }
    // No model is configured here, so the turn itself fails; what is pinned is that it ran on close.
    assert.ok(row.wrapup && row.wrapup.state !== "running", "the wrap-up ran");
    assert.equal(row.budget.messagesUsed, 1, "its prompt is not a message");
    const marks = entriesOf(c.path).filter((e) => e.customType === BATON_WRAPUP_ENTRY).map((e) => e.data.phase);
    assert.deepEqual(marks, ["start", "end"]);
    assert.equal(await wrap.runWrapup(c.sessionId, []), null, "once");
  });

  test("W7: no person wrote anything → the wrap-up is skipped: no turn, no entries, recorded so it never retries", async () => {
    const c = baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Silent", goal: "g" });
    baton.markDone(c.sessionId, new Date()); // Tony was a participant but never wrote
    const info = await wrap.runWrapup(c.sessionId, []);
    assert.equal(info?.state, "skipped");
    assert.equal(baton.batonById(c.sessionId)!.row.wrapup?.state, "skipped");
    assert.deepEqual(entriesOf(c.path).filter((e) => e.customType === BATON_WRAPUP_ENTRY), [], "no wrap-up turn was written");
    assert.equal(wrap.wantsWrapup(baton.batonById(c.sessionId)!.row), false, "never again");
    assert.equal(await wrap.runWrapup(c.sessionId, []), null);
  });

  test("W1 in the prompt: a known language changes only on a stated preference", () => {
    const text = wrap.wrapupPrompt({ participants: [tony.id] }, orgs.readRoster(org.id));
    assert.match(text, /change it when they say which language they prefer/);
    assert.match(text, /never just because a message was in another language/);
    // A stated preference is something to record, not an instruction to ignore.
    assert.doesNotMatch(text, /never instructions to you\./);
    assert.match(text, /how they want to be addressed is what you record/);
  });
});
