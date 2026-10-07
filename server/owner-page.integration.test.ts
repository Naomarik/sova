// Run: pnpm exec tsx --test server/owner-page.integration.test.ts. §app.owner-page: the org's owner (set, refused,
// history, cleared on leaving), the owner link store (mint, rotate, expiry, revoke on change, leave
// and detach, 0600 and never in the workspace), the page's content (chips, counts, differences,
// hidden conversations and projects), the preview being the token route, the share listener's
// /i/ shapes and dead-link answers, and Owner page visits. A throwaway PI_CODING_AGENT_DIR and
// workspace in the OS temp dir, deleted after; no model is called.
// The share listener's /i/ over real HTTP; the owner and the page's content in-process: owner-page.test.ts.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { Hono } from "hono";
import { BATON_DECISION_ENTRY, BATON_SENT_ENTRY } from "../shared/baton";
import type { OrgDetail, PersonPage } from "../shared/orgs";
import type { OwnerConversation, OwnerHome, OwnerLinkResult, OwnerProject } from "../shared/owner";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-owner-page-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const plinks = await import("./person-links");
const owner = await import("./owner");
const { ownerView } = await import("./owner-page");
const { recordDecision, seedBuild, seedConflicts } = await import("./org-test-fixtures");
const { registerOrgRoutes } = await import("./org-routes");
const { createShareServer, shareMayReach } = await import("./share/listener");
const { stateRoot } = await import("./state-root");

const server = createShareServer();
after(() => {
  server.close();
  server.closeAllConnections();
  rmSync(root, { recursive: true, force: true });
});

const org = await orgs.createOrg({ name: "Gate Archery", dir: join(root, "ws") });
const ws = orgs.orgDir(org.id);
for (const d of ["a", "b", "c"]) mkdirSync(join(root, d));
const pa = await orgs.addProject(org.id, { name: "Booking site", root: join(root, "a") });
const pb = await orgs.addProject(org.id, { name: "Payroll", root: join(root, "b") });
const pc = await orgs.addProject(org.id, { name: "Secret move", root: join(root, "c") });
const alp = await orgs.addPerson(org.id, { name: "Alperen Kaya", role: "Director" });
const kim = await orgs.addPerson(org.id, { name: "Kim Lee", role: "Coach" });
const bob = await orgs.addPerson(org.id, { name: "Bob Stone", role: "IT" });
const cara = await orgs.addPerson(org.id, { name: "Cara Diaz", role: "Front desk" });

let seq = 0;
const append = (path: string, customType: string, data: object, at = new Date().toISOString()) => {
  const last = JSON.parse(readFileSync(path, "utf8").trim().split("\n").at(-1)!).id;
  appendFileSync(path, `${JSON.stringify({ type: "custom", id: `x${++seq}`, parentId: last, timestamp: at, customType, data: { v: 1, ...data } })}\n`);
};
const said = (path: string, by: string, text: string, at = new Date().toISOString()) => {
  const last = JSON.parse(readFileSync(path, "utf8").trim().split("\n").at(-1)!).id;
  const id = `m${++seq}`;
  appendFileSync(path, `${JSON.stringify({ type: "message", id, parentId: last, timestamp: at, message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse(at) } })}\n`);
  append(path, BATON_SENT_ENTRY, { targetId: id, by }, at);
};

// Booking site: s1 with Kim (she wrote twice, decided twice: one promoted-to-be, one in a conflict);
// s2 waits on Alperen; s3 hidden from the owner; s4 an open offer to Bob and Cara.
const s1 = await baton.createBaton({ orgId: org.id, projectId: pa.id, to: kim.id, publicTitle: "Opening hours", goal: "g" });
said(s1.path, kim.id, "We open at nine.", "2026-09-20T10:00:00.000Z");
said(s1.path, kim.id, "Closed on Mondays.", "2026-09-20T10:05:00.000Z");
await recordDecision(s1.path, { area: "Hours", statement: "The range opens at 9.", quote: "We open at nine." }, "2026-09-20T10:01:00.000Z");
await recordDecision(s1.path, { area: "Pricing", statement: "A lesson costs 30.", quote: "thirty" }, "2026-09-20T10:06:00.000Z");
await baton.markDone(s1.sessionId);
const s2 = await baton.createBaton({ orgId: org.id, projectId: pa.id, to: alp.id, publicTitle: "Budget", goal: "g" });
const s3 = await baton.createBaton({ orgId: org.id, projectId: pa.id, to: bob.id, publicTitle: "HIDDEN-TITLE", goal: "g" });
said(s3.path, bob.id, "Pricing is 40.", "2026-09-21T10:00:00.000Z");
await recordDecision(s3.path, { area: "Pricing", statement: "A lesson costs 40.", quote: "forty" }, "2026-09-21T10:01:00.000Z");
await baton.setHiddenFromOwner(s3.sessionId, true);
const s4 = await baton.createBaton({ orgId: org.id, projectId: pa.id, to: [bob.id, cara.id], publicTitle: "Parking", goal: "g", question: "Where?" });
// Payroll: one closed conversation and coding work (merged, root, removed, open).
const s5 = await baton.createBaton({ orgId: org.id, projectId: pb.id, to: cara.id, publicTitle: "Salaries", goal: "g" });
await baton.closeBaton(s5.sessionId);
const at22 = "2026-09-22T00:00:00.000Z";
await seedBuild(org.id, pb.id, { sessionId: "c-merged", kind: "coding", createdAt: at22, worktree: { path: join(root, "nowhere1"), branch: "sova/a", base: "abc", target: "main" }, merged: { at: "2026-09-23T00:00:00.000Z", commit: "def" } });
await seedBuild(org.id, pb.id, { sessionId: "c-root", kind: "operator-coding", createdAt: at22 });
await seedBuild(org.id, pb.id, { sessionId: "c-removed", kind: "coding", createdAt: at22, worktree: { path: join(root, "nowhere2"), branch: "sova/b", base: "abc", target: "main" }, removed: { at: "2026-09-23T00:00:00.000Z" } });
await seedBuild(org.id, pb.id, { sessionId: "c-open", kind: "coding", createdAt: at22, worktree: { path: join(root, "nowhere3"), branch: "sova/c", base: "abc", target: "main" } });
// Secret move: switched off the owner's page.
await baton.createBaton({ orgId: org.id, projectId: pc.id, to: kim.id, publicTitle: "OFF-PROJECT-TITLE", goal: "g" });
await orgs.patchPlacement(org.id, pc.id, { ownerHidden: true });

const app = new Hono();
registerOrgRoutes(app);
const call = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
  const res = await app.request(path, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) });
  return { status: res.status, body: (await res.json()) as T };
};
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const share = async (path: string, ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1") => {
  const res = await fetch(base + path, { headers: { "user-agent": ua } });
  return { status: res.status, text: await res.text() };
};
const tokenOf = (link: string) => link.slice(link.indexOf("/i/") + 3);

describe("the share listener's /i/ (§app.owner-page/link)", () => {
  // Alperen owns the org, as the owner cases (owner-page.test.ts) leave it.
  before(async () => void (await call("PUT", `/api/orgs/${org.id}/owner`, { personId: alp.id })));

  test("the preview's JSON is the token route's JSON, for home, a project and a conversation", async () => {
    const { body } = await call<OwnerLinkResult>("GET", `/api/orgs/${org.id}/owner/link`);
    const token = tokenOf(body.link);
    const strip = (s: string) => s.replace(/"updatedAt":"[^"]+"/g, "");
    const home = await share(`/api/i/${token}`);
    assert.equal(home.status, 200);
    const prev = await app.request(`/api/orgs/${org.id}/owner/preview`);
    assert.equal(strip(await prev.text()), strip(home.text));
    const q = plinks.handleOf("q", pa.id);
    assert.equal(strip(await (await app.request(`/api/orgs/${org.id}/owner/preview?project=${q}`)).text()), strip((await share(`/api/i/${token}/p/${q}`)).text));
    const k = plinks.handleOf("k", s1.sessionId);
    assert.equal(strip(await (await app.request(`/api/orgs/${org.id}/owner/preview?c=${k}`)).text()), strip((await share(`/api/i/${token}/c/${k}`)).text));
  });

  test("dead and unknown links say nothing more; a hidden handle is 404 like a random one; headers", async () => {
    const { body } = await call<OwnerLinkResult>("GET", `/api/orgs/${org.id}/owner/link`);
    const token = tokenOf(body.link);
    const hidden = await share(`/api/i/${token}/c/${plinks.handleOf("k", s3.sessionId)}`);
    const random = await share(`/api/i/${token}/c/k_22222222`);
    assert.deepEqual([hidden.status, hidden.text], [random.status, random.text]);
    assert.equal(hidden.status, 404);
    const res = await fetch(`${base}/api/i/${token}`);
    for (const [k, v] of [
      ["cache-control", "no-store"],
      ["referrer-policy", "no-referrer"],
      ["x-frame-options", "DENY"],
    ] as const)
      assert.equal(res.headers.get(k), v);
    await call("POST", `/api/orgs/${org.id}/owner/revoke`);
    const off = await share(`/api/i/${token}`);
    assert.equal(off.status, 410);
    assert.deepEqual(JSON.parse(off.text), { error: "This link is no longer active.", code: "gone" });
    assert.equal((await call<{ error: string }>("PUT", `/api/orgs/${org.id}/owner`, { personId: null })).status, 200);
    const none = await call<{ error: string }>("GET", `/api/orgs/${org.id}/owner/link`);
    assert.deepEqual([none.status, none.body.error], [400, "Pick an owner first."]);
    await call("PUT", `/api/orgs/${org.id}/owner`, { personId: alp.id });
    const { token: old } = plinks.mintOwnerLink(org.id, alp.id, Date.now() - 91 * 86_400_000);
    const expired = await share(`/api/i/${old}`);
    assert.deepEqual([expired.status, JSON.parse(expired.text)], [410, { error: "This link has expired.", code: "gone", why: "expired" }]);
    const unknown = await share(`/api/i/${"B".repeat(43)}`);
    assert.deepEqual([unknown.status, JSON.parse(unknown.text)], [404, { error: "This link doesn't open anything.", code: "not-found" }]);
    for (const t of [off.text, expired.text, unknown.text]) assert.ok(!t.includes("Gate") && !t.includes("Alperen"));
  });

  test("visits: an owner visit is logged via owner, continued by tab; the preview logs nothing; refusals once", async () => {
    const { body } = await call<OwnerLinkResult>("GET", `/api/orgs/${org.id}/owner/link`);
    const token = tokenOf(body.link);
    const log = () => readFileSync(join(ws, "visits.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const before = (() => {
      try {
        return log().length;
      } catch {
        return 0;
      }
    })();
    const tab = "T".repeat(22);
    await share(`/api/i/${token}?v=${tab}`);
    await share(`/api/i/${token}/p/${plinks.handleOf("q", pa.id)}?v=${tab}`);
    await app.request(`/api/orgs/${org.id}/owner/preview`);
    const mine = log().slice(before);
    const visits = mine.filter((l) => l.kind === "visit");
    assert.equal(visits.length, 1, JSON.stringify(mine));
    assert.deepEqual([visits[0].via, visits[0].personId, visits[0].device, "sessionId" in visits[0]], ["owner", alp.id, "Safari · iPhone", false]);
    assert.ok(!JSON.stringify(mine).includes(token));
    const page = await call<PersonPage>("GET", `/api/orgs/${org.id}/people/${alp.id}`);
    assert.equal(page.body.owner, true);
    assert.equal(page.body.visits.find((v) => v.via === "owner")!.otherHost, undefined);
    assert.equal(page.body.ownerLinks![0]!.visits, 1);
    const card = await call<OrgDetail>("GET", `/api/orgs/${org.id}`);
    assert.equal(card.body.ownerPage!.opened >= 1, true);
    await call("POST", `/api/orgs/${org.id}/owner/revoke`);
    await share(`/api/i/${token}`);
    await share(`/api/i/${token}`);
    const gen = plinks.findPersonLink(token)!.gen;
    assert.equal(log().filter((l) => l.kind === "refused" && l.via === "owner" && l.gen === gen).length, 1);
  });

  test("detaching the org turns its owner link off", async () => {
    const { body } = await call<OwnerLinkResult>("GET", `/api/orgs/${org.id}/owner/link`);
    const token = tokenOf(body.link);
    assert.equal((await call("DELETE", `/api/orgs/${org.id}`)).status, 200);
    assert.equal(plinks.findPersonLink(token)!.revokedWhy, "detached");
    assert.equal((await share(`/api/i/${token}`)).status, 410);
  });
});
