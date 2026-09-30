// Run: pnpm exec tsx --test server/owner-page.test.ts. §app.owner-page: the org's owner (set, refused,
// history, cleared on leaving), the owner link store (mint, rotate, expiry, revoke on change, leave
// and detach, 0600 and never in the workspace), the page's content (chips, counts, differences,
// hidden conversations and projects), the preview being the token route, the share listener's
// /i/ shapes and dead-link answers, and Owner page visits. A throwaway PI_CODING_AGENT_DIR and
// workspace in the OS temp dir, deleted after; no model is called.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
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
await orgs.patchProject(org.id, pc.id, { ownerHidden: true });

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

describe("the owner (§app.owner-page/owner)", () => {
  test("only an active roster person; proposed and unknown refused", async () => {
    const pat = await orgs.addPerson(org.id, { name: "Pat", role: "Finance", status: "proposed", contact: { email: "pat@example.test" }, referral: { why: "x", referredBy: kim.id } }, { kind: "referral" });
    for (const personId of [pat.id, "p_nobody00", 42]) {
      const r = await call<{ error: string }>("PUT", `/api/orgs/${org.id}/owner`, { personId });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "Only an active person on the roster can be the owner.");
    }
    assert.equal((await call("PUT", `/api/orgs/${org.id}/owner`, {})).status, 400, "personId is required");
  });

  test("the operator sets it; history kept; the card shows no link yet", async () => {
    const r = await call<OrgDetail>("PUT", `/api/orgs/${org.id}/owner`, { personId: kim.id });
    assert.equal(r.status, 200);
    assert.equal(r.body.owner, kim.id);
    assert.deepEqual(r.body.ownerPage, { person: { id: kim.id, name: "Kim Lee" }, link: null, opened: 0 });
    const again = await call<OrgDetail>("PUT", `/api/orgs/${org.id}/owner`, { personId: alp.id });
    assert.deepEqual(
      again.body.ownerHistory!.map((h) => [h.from, h.to, h.why]),
      [
        [null, kim.id, "operator"],
        [kim.id, alp.id, "operator"],
      ],
    );
  });

  test("Get Owner Link mints; Get again turns the older off at once; the store is 0600 and host-local", async () => {
    const a = await call<OwnerLinkResult>("GET", `/api/orgs/${org.id}/owner/link`);
    assert.equal(a.status, 200);
    assert.match(a.body.link, /\/i\/[A-Za-z0-9_-]{43}$/);
    assert.ok(a.body.linkWarning, "no share listener bound in this process");
    assert.equal(Date.parse(a.body.expiresAt) - Date.parse(a.body.createdAt), 90 * 86_400_000);
    const first = tokenOf(a.body.link);
    assert.equal(owner.ownerAccess(first).ok, true);
    const b = await call<OwnerLinkResult>("GET", `/api/orgs/${org.id}/owner/link`);
    const second = tokenOf(b.body.link);
    assert.deepEqual(owner.ownerAccess(first), { ok: false, status: 410, link: plinks.findPersonLink(first)! });
    assert.equal(owner.ownerAccess(second).ok, true);
    const file = join(stateRoot(), "person-links.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const text = readFileSync(file, "utf8");
    assert.ok(!text.includes(first) && !text.includes(second), "tokens are never stored");
    assert.ok(!file.startsWith(ws));
    // The org's snapshot and every other file of the workspace repo (q1: no org.json any more).
    const hash = plinks.findPersonLink(second)!.hash;
    for (const f of readdirSync(ws, { recursive: true, encoding: "utf8" }))
      if (!f.startsWith(".git") && statSync(join(ws, f)).isFile()) assert.ok(!readFileSync(join(ws, f), "utf8").includes(hash), `no hash in the workspace (${f})`);
    assert.deepEqual(plinks.ownerLinksOf(org.id).map((l) => [l.gen, l.revokedWhy ?? "live"]), [
      [1, "rotated"],
      [2, "live"],
    ]);
  });

  test("expiry at 90 days, named as expired; an unknown token is 404", () => {
    const { token } = plinks.mintOwnerLink(org.id, alp.id, Date.now() - 90 * 86_400_000 - 1);
    assert.deepEqual(owner.ownerAccess(token), { ok: false, status: 410, why: "expired", link: plinks.findPersonLink(token)! });
    assert.deepEqual(owner.ownerAccess("A".repeat(43)), { ok: false, status: 404 });
    assert.deepEqual(owner.ownerAccess("short"), { ok: false, status: 404 });
  });

  test("a change of owner turns the old owner's link off; a link whose person isn't the owner answers 410 even if live", async () => {
    const { token } = plinks.mintOwnerLink(org.id, alp.id);
    await call("PUT", `/api/orgs/${org.id}/owner`, { personId: kim.id });
    assert.equal(plinks.findPersonLink(token)!.revokedWhy, "owner-changed");
    // Forged live record for a non-owner: the scope check still refuses it.
    const stray = plinks.mintOwnerLink(org.id, bob.id);
    assert.equal(owner.ownerAccess(stray.token).ok, false);
    await call("PUT", `/api/orgs/${org.id}/owner`, { personId: alp.id });
  });

  test("leaving clears the owner (with ownerCleared) and turns their link off; setting again clears ownerCleared", async () => {
    const tmp = await orgs.addPerson(org.id, { name: "Temp Owner" });
    await call("PUT", `/api/orgs/${org.id}/owner`, { personId: tmp.id });
    const { token } = plinks.mintOwnerLink(org.id, tmp.id);
    await orgs.applyChange(org.id, tmp.id, { status: "left" }, { kind: "operator" });
    const o = orgs.readOrg(org.id);
    assert.equal(o.owner, undefined);
    assert.equal(o.ownerCleared?.personId, tmp.id);
    assert.deepEqual(o.ownerHistory!.at(-1)!.why, "left");
    assert.equal(plinks.findPersonLink(token)!.revokedWhy, "left");
    assert.equal(owner.ownerAccess(token).ok, false);
    await call("PUT", `/api/orgs/${org.id}/owner`, { personId: alp.id });
    assert.equal(orgs.readOrg(org.id).ownerCleared, undefined);
  });

  test("Turn Off Owner Link", async () => {
    const { body } = await call<OwnerLinkResult>("GET", `/api/orgs/${org.id}/owner/link`);
    const r = await call<OrgDetail>("POST", `/api/orgs/${org.id}/owner/revoke`);
    assert.equal(r.body.ownerPage!.link!.state, "off");
    assert.equal(owner.ownerAccess(tokenOf(body.link)).ok, false);
  });

  test("Needs you counts an owner link about to expire", () => {
    plinks.mintOwnerLink(org.id, alp.id, Date.now() - 85 * 86_400_000);
    assert.equal(owner.ownerLinkNeeds(org.id), 1);
    plinks.mintOwnerLink(org.id, alp.id);
    assert.equal(owner.ownerLinkNeeds(org.id), 0);
  });
});

describe("the page's content (§app.owner-page/content)", () => {
  test("home: projects shown, chips derived, counts, waiting on you; a switched-off project is absent", async () => {
    const home = (await ownerView(org.id)) as OwnerHome;
    assert.equal(home.org.name, "Gate Archery");
    assert.deepEqual(home.owner, { name: "Alperen Kaya", first: "Alperen" });
    assert.deepEqual(
      home.projects.map((p) => p.name).sort(),
      ["Booking site", "Payroll"],
    );
    const book = home.projects.find((p) => p.name === "Booking site")!;
    const pay = home.projects.find((p) => p.name === "Payroll")!;
    assert.equal(book.status, "waiting-on-you");
    assert.equal(pay.status, "building");
    assert.deepEqual([pay.finished, pay.inProgress], [2, 1], "merged + root finished, open in progress, removed not counted");
    assert.equal(book.decisions, 2, "the hidden conversation's decision is not counted");
    assert.equal(book.conversations, 3);
    assert.deepEqual(home.waiting.map((w) => w.publicTitle), ["Budget"]);
    assert.match(book.id, /^q_[a-z2-9]{8}$/);
    assert.ok(!JSON.stringify(home).includes("OFF-PROJECT-TITLE") && !JSON.stringify(home).includes("Secret move"));
  });

  test("a project: people, decisions, differences, conversations; the hidden one is gone everywhere", async () => {
    const home = (await ownerView(org.id)) as OwnerHome;
    // A conflict between Kim's (shown) and Bob's (hidden) decision on pricing: hidden with it.
    const { listDecisions } = await import("./reconcile");
    const decisions = listDecisions(org.id, pa.id).decisions;
    const kimPrice = decisions.find((d) => d.statement === "A lesson costs 30.")!;
    const kimHours = decisions.find((d) => d.statement === "The range opens at 9.")!;
    const bobPrice = decisions.find((d) => d.statement === "A lesson costs 40.")!;
    await seedConflicts(org.id, pa.id, [
      { id: "cf_aaaaaaaa", orgId: org.id, projectId: pa.id, areaKey: "pricing", a: kimPrice.id, b: bobPrice.id, p: 0.9, routedTo: alp.id, routeReason: "self-asserted", state: "open", createdAt: "2026-09-21T00:00:00.000Z" },
      { id: "cf_bbbbbbbb", orgId: org.id, projectId: pa.id, areaKey: "hours", a: kimHours.id, b: kimPrice.id, p: 0.9, routedTo: "operator", routeReason: "nobody decides hours", state: "open", createdAt: "2026-09-21T00:00:00.000Z" },
    ]);
    const p = (await ownerView(org.id, { project: home.projects.find((x) => x.name === "Booking site")!.id })) as OwnerProject;
    const text = JSON.stringify(p);
    assert.ok(!text.includes("HIDDEN-TITLE") && !text.includes("costs 40"));
    assert.ok(!text.includes("self-asserted") && !text.includes("nobody decides"), "routing reasons never show");
    assert.deepEqual(
      p.conversations.map((c) => [c.publicTitle, c.status.kind]).sort(),
      [
        ["Budget", "waiting-on-you"],
        ["Opening hours", "done"],
        ["Parking", "offered"],
      ],
    );
    assert.deepEqual(p.conversations.find((c) => c.publicTitle === "Parking")!.status, { kind: "offered", count: 2 });
    assert.equal(p.conversations.find((c) => c.publicTitle === "Opening hours")!.messages, 2);
    const kimRow = p.people.find((x) => x.name === "Kim Lee")!;
    assert.deepEqual([kimRow.conversations, kimRow.lastWroteAt, kimRow.isYou], [1, "2026-09-20T10:05:00.000Z", false]);
    assert.ok(p.people.find((x) => x.name === "Alperen Kaya")!.isYou);
    assert.deepEqual(p.people.find((x) => x.name === "Bob Stone")!.conversations, 1, "the hidden conversation adds nothing");
    assert.deepEqual(p.decisions.map((d) => [d.topic, d.state, d.by.first]).sort(), [
      ["Hours", "needs-choice", "Kim"],
      ["Pricing", "needs-choice", "Kim"],
    ]);
    assert.deepEqual(p.differences, [{ topic: "Hours", between: ["Kim Lee"], chooser: { kind: "operator", name: "Operator", first: "Operator" } }], "the pricing difference has a hidden side");
    assert.ok(!("sessionId" in (p.conversations[0] as object)));
  });

  test("a conversation: the owner's thread, whole; a hidden one answers 404 exactly like a random handle", async () => {
    const p = (await ownerView(org.id, { project: ((await ownerView(org.id)) as OwnerHome).projects.find((x) => x.name === "Booking site")!.id })) as OwnerProject;
    const c = (await ownerView(org.id, { conversation: p.conversations.find((x) => x.publicTitle === "Opening hours")!.id })) as OwnerConversation;
    assert.equal(c.projectName, "Booking site");
    assert.deepEqual(
      c.items.filter((i) => i.kind === "message").map((i) => [i.by, i.text]),
      [
        ["person-1", "We open at nine."],
        ["person-1", "Closed on Mondays."],
      ],
    );
    assert.equal(c.viewer!.canWrite, false);
    const budget = (await ownerView(org.id, { conversation: p.conversations.find((x) => x.publicTitle === "Budget")!.id })) as OwnerConversation;
    assert.equal(budget.yourTurn, true);
    const hidden = plinks.handleOf("k", s3.sessionId);
    const refused = async (conversation: string) => {
      try {
        await ownerView(org.id, { conversation });
        return "answered";
      } catch (err) {
        return `${(err as { status?: number }).status} ${(err as Error).message}`;
      }
    };
    assert.equal(await refused(hidden), "404 Not found");
    assert.equal(await refused("k_22222222"), "404 Not found");
    assert.equal(await refused(plinks.handleOf("k", s4.sessionId)), "answered");
  });

  test("Hide From and Show To through the strip route; the project switch through PATCH", async () => {
    const r = await call<{ session: { hiddenFromOwner?: boolean }; owner: { name: string } }>("POST", `/api/baton/${s3.sessionId}/owner`, { hidden: false });
    assert.equal(r.body.session.hiddenFromOwner, undefined);
    assert.deepEqual(r.body.owner, { name: "Alperen Kaya" });
    assert.ok(JSON.stringify(await ownerView(org.id, { project: plinks.handleOf("q", pa.id) })).includes("HIDDEN-TITLE"));
    await call("POST", `/api/baton/${s3.sessionId}/owner`, { hidden: true });
    assert.ok(!JSON.stringify(await ownerView(org.id, { project: plinks.handleOf("q", pa.id) })).includes("HIDDEN-TITLE"));
    assert.equal((await call("POST", `/api/baton/${s3.sessionId}/owner`, { hidden: "yes" })).status, 400);
    const off = await call<OrgDetail>("PATCH", `/api/orgs/${org.id}/projects/${pb.id}`, { ownerHidden: true });
    assert.equal(off.body.projectList.find((x) => x.id === pb.id)!.ownerHidden, true);
    await assert.rejects(() => ownerView(org.id, { project: plinks.handleOf("q", pb.id) }), /Not found/);
    await call("PATCH", `/api/orgs/${org.id}/projects/${pb.id}`, { ownerHidden: false });
    assert.equal(orgs.readProjects(org.id).find((x) => x.id === pb.id)!.ownerHidden, undefined);
  });
});

describe("the share listener's /i/ (§app.owner-page/link)", () => {
  test("the shapes pass; near-misses, POST and a socket path do not", () => {
    const t = "A".repeat(43);
    for (const p of [`/i/${t}`, `/api/i/${t}`, `/api/i/${t}/p/q_abcdefgh`, `/api/i/${t}/c/k_23456789`]) assert.ok(shareMayReach("GET", p), p);
    for (const [m, p] of [
      ["GET", `/i/${t}/`],
      ["GET", `/api/i/${t}/`],
      ["GET", `/api/i/${t}/p/q_ABCDEFGH`],
      ["GET", `/api/i/${t}/p/k_abcdefgh`],
      ["GET", `/api/i/${t}/c/k_abcdefg`],
      ["GET", `/api/i/${t}/x/q_abcdefgh`],
      ["GET", `/api/i/${t}%2F`],
      ["POST", `/api/i/${t}`],
      ["POST", `/api/i/${t}/message`],
      ["GET", `/ws/i`],
      ["GET", `/api/i/${"A".repeat(42)}`],
    ] as const)
      assert.ok(!shareMayReach(m, p), `${m} ${p}`);
  });

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
