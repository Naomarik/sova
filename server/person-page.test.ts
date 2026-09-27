// Run: pnpm exec tsx --test server/person-page.test.ts. §app.organizations/person-page: one
// person's sessions (every relation), messages, decisions across projects, routed conflicts,
// links and their states, visits, Preview as, and the routes. A throwaway PI_CODING_AGENT_DIR and
// workspace in the OS temp dir; no model is called.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import { BATON_DECISION_ENTRY, BATON_LEASE_ENTRY, BATON_SENT_ENTRY } from "../shared/baton";
import type { OrgDetail, PersonPage, PersonPreview } from "../shared/orgs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-person-page-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const links = await import("./baton-links");
const visits = await import("./visits");
const { writeConflicts } = await import("./decisions");
const { personPage, previewAs } = await import("./person-page");
const { registerOrgRoutes } = await import("./org-routes");

after(() => rmSync(root, { recursive: true, force: true }));

const org = await orgs.createOrg({ name: "Gate", dir: join(root, "ws") });
mkdirSync(join(root, "a"));
mkdirSync(join(root, "b"));
const pa = orgs.addProject(org.id, { name: "Portal", root: join(root, "a") });
const pb = orgs.addProject(org.id, { name: "Payroll", root: join(root, "b") });
const kim = orgs.addPerson(org.id, { name: "Kim", role: "Ops" });
const bob = orgs.addPerson(org.id, { name: "Bob", role: "IT" });
const cara = orgs.addPerson(org.id, { name: "Cara", role: "CEO" });
const dee = orgs.addPerson(org.id, { name: "Dee", role: "Legal" });

let seq = 0;
const append = (path: string, customType: string, data: object, at = new Date().toISOString()) => {
  const last = JSON.parse(readFileSync(path, "utf8").trim().split("\n").at(-1)!).id;
  appendFileSync(path, `${JSON.stringify({ type: "custom", id: `x${++seq}`, parentId: last, timestamp: at, customType, data: { v: 1, ...data } })}\n`);
};

// s1 (Portal): started with Kim, who writes twice and passes it on to Bob; a conflict asks Kim about it.
const s1 = baton.createBaton({ orgId: org.id, projectId: pa.id, to: kim.id, publicTitle: "Hosting", goal: "g" });
const kimS1 = links.findLink(s1.token!)!;
append(s1.path, BATON_SENT_ENTRY, { targetId: "m1", by: kim.id }, "2026-09-20T10:00:00.000Z");
append(s1.path, BATON_SENT_ENTRY, { targetId: "m2", by: kim.id }, "2026-09-20T10:05:00.000Z");
append(s1.path, BATON_DECISION_ENTRY, { area: "Hosting", statement: "We host on our own box.", quote: "our box", by: kim.id }, "2026-09-20T10:06:00.000Z");
baton.handTo(s1.sessionId, bob.id, "Which box?", "");
const bobS1 = baton.rotateLink(s1.sessionId).token;
// Kim proposed Pat from s1.
const pat = orgs.applyChange(org.id, null, { name: "Pat", role: "Finance", status: "proposed", contact: { email: "pat@example.test" }, referral: { why: "knows invoices", referredBy: kim.id, sessionId: s1.sessionId } }, { kind: "referral", sessionId: s1.sessionId });
writeConflicts(org.id, pa.id, [
  { id: "cf_aaaaaaaa", orgId: org.id, projectId: pa.id, areaKey: "hosting", a: `${s1.sessionId}:x3`, b: "other", p: 0.9, routedTo: kim.id, routeReason: "Kim decides hosting", batonSessionId: s1.sessionId, state: "open", createdAt: "2026-09-21T00:00:00.000Z" },
]);

// s2 (Payroll): an offer to Kim, Bob and Cara; Bob took it and his lease lapsed; Kim never held it.
const s2 = baton.createBaton({ orgId: org.id, projectId: pb.id, to: [kim.id, bob.id, cara.id], publicTitle: "Invoices", goal: "g", question: "Who knows?" });
baton.noteMessage(s2.sessionId, bob.id);
{
  const last = JSON.parse(readFileSync(s2.path, "utf8").trim().split("\n").at(-1)!).id;
  appendFileSync(s2.path, `${JSON.stringify({ type: "message", id: "m3", parentId: last, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "BOB-SAYS-HELLO" }], timestamp: Date.now() } })}\n`);
}
append(s2.path, BATON_SENT_ENTRY, { targetId: "m3", by: bob.id });
append(s2.path, BATON_LEASE_ENTRY, { n: 1, offerId: baton.batonById(s2.sessionId)!.row.offerId, event: "expired", by: bob.id });
append(s2.path, BATON_DECISION_ENTRY, { area: "Invoices", statement: "Invoices go out on Fridays.", quote: "Fridays", by: kim.id }, "2026-09-22T10:00:00.000Z");

// s3: Dee only; s4 closed with Kim.
baton.createBaton({ orgId: org.id, projectId: pa.id, to: dee.id, publicTitle: "Contracts", goal: "g" });
const s4 = baton.createBaton({ orgId: org.id, projectId: pb.id, to: kim.id, publicTitle: "Old", goal: "g", parentSessionId: s1.sessionId });
baton.closeBaton(s4.sessionId);

const app = new Hono();
registerOrgRoutes(app);
const get = async <T>(path: string): Promise<{ status: number; body: T }> => {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as T };
};

describe("a person's sessions", () => {
  const page = personPage(org.id, kim.id);
  const byTitle = (t: string, p: PersonPage = page) => p.sessions.find((s) => s.publicTitle === t)!;

  test("every session of theirs across projects, none of anyone else's", () => {
    assert.deepEqual(page.sessions.map((s) => s.publicTitle).sort(), ["Hosting", "Invoices", "Old"]);
    assert.equal(byTitle("Invoices").projectName, "Payroll");
  });

  test("relations: started with, passed on, proposed, asked to settle; messages from the sent markers", () => {
    const h = byTitle("Hosting");
    assert.deepEqual(h.relations, [
      { kind: "started-with" },
      { kind: "passed-on", n: 2, to: [{ id: bob.id, name: "Bob" }] },
      { kind: "proposed", person: { id: pat.id, name: "Pat" } },
      { kind: "conflict", conflictId: "cf_aaaaaaaa", area: "hosting" },
    ]);
    assert.equal(h.messages, 2);
    assert.equal(h.lastWroteAt, "2026-09-20T10:05:00.000Z");
    assert.deepEqual(h.holder, { id: bob.id, name: "Bob" });
    assert.equal(h.holdsNow, false);
    assert.deepEqual(byTitle("Old").parent, { sessionId: s1.sessionId, publicTitle: "Hosting" });
  });

  test("an invitee who never held the offer reads 'offered' only; the one who took it, 'took' and 'lapsed'", () => {
    const k = byTitle("Invoices");
    assert.deepEqual(k.relations, [{ kind: "offered", n: 1, others: 2 }]);
    assert.equal(k.offer?.includesThem, true);
    const b = byTitle("Invoices", personPage(org.id, bob.id));
    assert.deepEqual(b.relations, [{ kind: "offered", n: 1, others: 2 }, { kind: "took-offer", n: 1 }, { kind: "lease-lapsed", n: 1 }]);
    assert.equal(b.messages, 1);
    const bh = byTitle("Hosting", personPage(org.id, bob.id));
    assert.deepEqual(bh.relations, [{ kind: "handed-to", n: 2, from: { id: kim.id, name: "Kim" } }]);
    assert.equal(bh.holdsNow, true);
  });

  test("the referred person: 'referred here by'", () => {
    const p = personPage(org.id, pat.id);
    assert.deepEqual(p.sessions.map((s) => [s.publicTitle, s.relations]), [["Hosting", [{ kind: "referred-here", by: { id: kim.id, name: "Kim" } }]]]);
  });
});

describe("decisions, conflicts, links, visits", () => {
  test("decisions across both projects, newest first; the conflict routed to them", () => {
    const page = personPage(org.id, kim.id);
    assert.deepEqual(
      page.decisions.map((d) => [d.statement, d.projectName, d.publicTitle]),
      [
        ["Invoices go out on Fridays.", "Payroll", "Invoices"],
        ["We host on our own box.", "Portal", "Hosting"],
      ],
    );
    assert.deepEqual(
      page.conflicts.map((c) => [c.id, c.state, c.projectName, c.publicTitle]),
      [["cf_aaaaaaaa", "open", "Portal", "Hosting"]],
    );
    assert.deepEqual(personPage(org.id, bob.id).decisions, []);
  });

  test("link states: reads after the baton moved on, writes for the holder, closed, and an offer's", () => {
    const kimLinks = personPage(org.id, kim.id).links;
    const hosting = kimLinks.find((l) => l.sessionId === s1.sessionId)!;
    assert.equal(hosting.state, "reads");
    assert.equal(hosting.reason, "moved-on");
    assert.equal(hosting.current, false);
    assert.equal(kimLinks.find((l) => l.sessionId === s4.sessionId)!.state, "closed");
    assert.equal(kimLinks.find((l) => l.sessionId === s2.sessionId)!.state, "reads", "Bob holds the offer: taken");
    const bobHosting = personPage(org.id, bob.id).links.find((l) => l.sessionId === s1.sessionId)!;
    assert.equal(bobHosting.state, "writes");
    assert.equal(bobHosting.current, true);
    assert.ok(!JSON.stringify(kimLinks).includes(kimS1.hash), "never a hash");
    assert.ok(!JSON.stringify(personPage(org.id, bob.id)).includes(bobS1), "never a token");
  });

  test("visits: folded newest first with session titles, counted per link; scanners not counted; another host's link flagged", () => {
    const t = Date.now() - 3600_000;
    visits.recordOpen(kimS1, { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1", now: t });
    visits.recordOpen(kimS1, { userAgent: "curl/8", now: t + 1000 });
    visits.recordOpen({ ...kimS1, sessionId: "gone-session", n: 9 }, { userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36", now: t + 2000 });
    const page = personPage(org.id, kim.id);
    assert.equal(page.opened, 2);
    assert.equal(page.lastOpenedAt, new Date(t + 2000).toISOString());
    assert.deepEqual(
      page.visits.map((v) => [v.publicTitle, v.device, !!v.bot, !!v.otherHost]),
      [
        ["", "Chrome · Windows", false, true],
        ["Hosting", "Script", true, false],
        ["Hosting", "Safari · iPhone", false, false],
      ],
    );
    assert.equal(page.links.find((l) => l.sessionId === s1.sessionId)!.visits, 1);
  });
});

describe("routes", () => {
  test("GET the page; 404 for an unknown person; the org page's Last opened", async () => {
    const ok = await get<PersonPage>(`/api/orgs/${org.id}/people/${kim.id}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.person.name, "Kim");
    assert.equal(ok.body.org.name, "Gate");
    assert.equal((await get(`/api/orgs/${org.id}/people/p_zzzzzzzz`)).status, 404);
    const detail = await get<OrgDetail>(`/api/orgs/${org.id}`);
    assert.equal(detail.body.lastOpened?.[kim.id]?.minted, true);
    assert.ok(detail.body.lastOpened?.[kim.id]?.at);
    assert.deepEqual(detail.body.lastOpened?.[cara.id], { minted: true }, "a link, never opened");
  });

  test("Preview as: the share page's view, read-only, no visit; cut at an offer they never held; an uninvited session is 404; a closed one opens no link", async () => {
    const pv = await get<PersonPreview>(`/api/orgs/${org.id}/people/${kim.id}/preview?session=${s1.sessionId}`);
    assert.equal(pv.status, 200);
    assert.equal(pv.body.viewer?.canWrite, false);
    assert.equal(pv.body.linkOpens, true);
    assert.ok(!JSON.stringify(pv.body).includes(kim.id), "no roster ids in the view");
    assert.equal((await get(`/api/orgs/${org.id}/people/${kim.id}/preview?session=${[...baton.allBatons()].find((r) => r.publicTitle === "Contracts")!.sessionId}`)).status, 404);
    const closed = await previewAs(org.id, kim.id, s4.sessionId);
    assert.equal(closed.linkOpens, false);
    const before = readFileSync(join(orgs.orgDir(org.id), visits.VISITS_FILE), "utf8");
    // Cara was invited and never held the offer: her view stops at it; Bob, who took it, sees his message.
    assert.ok(!JSON.stringify(await previewAs(org.id, cara.id, s2.sessionId)).includes("BOB-SAYS-HELLO"));
    assert.ok(JSON.stringify(await previewAs(org.id, bob.id, s2.sessionId)).includes("BOB-SAYS-HELLO"));
    assert.equal(readFileSync(join(orgs.orgDir(org.id), visits.VISITS_FILE), "utf8"), before, "a preview records no visit");
  });

  test("revoke one link, then all of them", async () => {
    const post = (body?: object) => app.request(`/api/orgs/${org.id}/people/${bob.id}/links/revoke`, { method: "POST", ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) });
    const one = await post({ sessionId: s1.sessionId, n: 2 });
    assert.equal(one.status, 200);
    const after1 = (await one.json()) as PersonPage;
    assert.equal(after1.links.find((l) => l.sessionId === s1.sessionId)!.state, "off");
    assert.equal(after1.links.find((l) => l.sessionId === s2.sessionId)!.state, "writes", "the other link stays");
    assert.equal((await post({ sessionId: s1.sessionId, n: 2 })).status, 409, "already off");
    assert.equal((await post({ sessionId: s1.sessionId })).status, 400);
    const all = (await (await post()).json()) as PersonPage;
    assert.ok(all.links.every((l) => l.state === "off"));
    assert.equal(links.linksOfPerson(org.id, kim.id).filter((l) => !l.revokedAt).length > 0, true, "nobody else's");
  });
});
