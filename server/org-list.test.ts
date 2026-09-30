// Run: pnpm exec tsx --test server/org-list.test.ts. GET /api/orgs's per-org extras for the cards
// on #/orgs (§app.organizations/org-cards): needsYou and lastActivityAt. A throwaway
// PI_CODING_AGENT_DIR and workspaces in the OS temp dir, deleted after; no model is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import { OPERATOR } from "../shared/baton";
import type { Conflict } from "../shared/decisions";
import type { OrgDetail, OrgsInfo } from "../shared/orgs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-org-list-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const { seedConflicts } = await import("./org-test-fixtures");
const { registerOrgRoutes, latestTime } = await import("./org-routes");
const { settled } = await import("./workspace-git");

// Milestone commits run after each write: let them finish before the dirs go.
after(async () => {
  for (const o of orgs.orgsInfo().orgs) await settled(o.dir);
  rmSync(root, { recursive: true, force: true });
});

const app = new Hono();
registerOrgRoutes(app);
const list = async () => ((await (await app.request("/api/orgs")).json()) as OrgsInfo).orgs;

test("latestTime: the newest of ISO times and epoch ms, skipping the unreadable", () => {
  assert.equal(latestTime([]), "");
  assert.equal(latestTime([undefined, "nope", ""]), "");
  assert.equal(latestTime(["2026-01-02T00:00:00.000Z", Date.parse("2026-01-03T00:00:00.000Z"), "2026-01-01T00:00:00.000Z"]), "2026-01-03T00:00:00.000Z");
});

describe("GET /api/orgs: needsYou and lastActivityAt", async () => {
  const quiet = await orgs.createOrg({ name: "Quiet", dir: join(root, "ws-quiet") });
  const busy = await orgs.createOrg({ name: "Busy", dir: join(root, "ws-busy") });
  mkdirSync(join(root, "proj"));
  const project = await orgs.addProject(busy.id, { name: "Portal", root: join(root, "proj") });
  const tony = await orgs.addPerson(busy.id, { name: "Tony Reyes", role: "IT" });

  test("a fresh org waits on nothing and was last active when created (or its first roster write)", async () => {
    const q = (await list()).find((o) => o.id === quiet.id)!;
    assert.deepEqual(q.needsYou, { replies: 0, links: 0, proposals: 0, conflicts: 0, stakeholders: 0, ownerLink: 0, held: 0 });
    assert.ok(q.lastActivityAt && Date.parse(q.lastActivityAt) >= Date.parse(quiet.createdAt));
  });

  test("a reply, a link to send and a proposed person each count, per org", async () => {
    await baton.createBaton({ orgId: busy.id, projectId: project.id, to: OPERATOR, publicTitle: "Mine", goal: "g" });
    await baton.createBaton({ orgId: busy.id, projectId: project.id, to: tony.id, publicTitle: "No link", goal: "g" }, { mintLink: false });
    await baton.createBaton({ orgId: busy.id, projectId: project.id, to: tony.id, publicTitle: "Linked", goal: "g" });
    await orgs.addPerson(busy.id, { name: "Bob Ref", status: "proposed", role: "Accountant", contact: { phone: "+1 555 010 0199" }, referral: { why: "Does the books", referredBy: "operator" } });
    const all = await list();
    const b = all.find((o) => o.id === busy.id)!;
    assert.deepEqual(b.needsYou, { replies: 1, links: 1, proposals: 1, conflicts: 0, stakeholders: 0, ownerLink: 0, held: 0 });
    assert.equal(b.openBatons, 3);
    assert.deepEqual(all.find((o) => o.id === quiet.id)!.needsYou, { replies: 0, links: 0, proposals: 0, conflicts: 0, stakeholders: 0, ownerLink: 0, held: 0 }, "another org's items stay there");
  });

  test("a closed session no longer counts, and activity moves forward", async () => {
    const before = (await list()).find((o) => o.id === busy.id)!;
    const mine = baton.allBatons().find((r) => r.orgId === busy.id && r.publicTitle === "Mine")!;
    await new Promise((r) => setTimeout(r, 5));
    await baton.closeBaton(mine.sessionId);
    const b = (await list()).find((o) => o.id === busy.id)!;
    assert.equal(b.needsYou!.replies, 0);
    assert.ok(Date.parse(b.lastActivityAt!) > Date.parse(before.lastActivityAt!), "closedAt is newer");
  });

  test("an open conflict routed to the operator with no session counts; routed to a person, asked in a session, or resolved does not", async () => {
    const c = (id: string, extra: Partial<Conflict>): Conflict => ({ id, orgId: busy.id, projectId: project.id, areaKey: "invoicing", a: "d1", b: "d2", p: 0.9, routedTo: OPERATOR, routeReason: "Nobody decides invoicing.", state: "open", createdAt: new Date().toISOString(), ...extra });
    await seedConflicts(busy.id, project.id, [c("cf_1", {}), c("cf_2", { routedTo: tony.id }), c("cf_3", { batonSessionId: "s-x" }), c("cf_4", { state: "resolved" })]);
    const b = (await list()).find((o) => o.id === busy.id)!;
    assert.equal(b.needsYou!.conflicts, 1);
  });

  test("GET /api/orgs/:id: needsYou, each baton's waiting, projectConflicts", async () => {
    const d = (await (await app.request(`/api/orgs/${busy.id}`)).json()) as OrgDetail;
    // cf_3's settle session asks the operator (the conflict chart started it): a reply waits on them.
    assert.deepEqual(d.needsYou, { replies: 1, links: 1, proposals: 1, conflicts: 1, stakeholders: 0, ownerLink: 0, held: 0 });
    const by = Object.fromEntries(d.batons.map((r) => [r.publicTitle, r.waiting]));
    assert.deepEqual(by, { "No link": "link", Linked: undefined, Mine: undefined, "Settle: invoicing": "reply" });
    assert.deepEqual(d.projectConflicts, { [project.id]: 1 });
    const q = (await (await app.request(`/api/orgs/${quiet.id}`)).json()) as OrgDetail;
    assert.deepEqual(q.projectConflicts, {});
  });
});

test("a project whose main stakeholder left counts once in its org's needsYou, until the operator saves the select", async () => {
  const org = await orgs.createOrg({ name: "Left", dir: join(root, "ws-left") });
  mkdirSync(join(root, "proj-left"));
  const pr = await orgs.addProject(org.id, { name: "Site", root: join(root, "proj-left") });
  const alp = await orgs.addPerson(org.id, { name: "Alperen", role: "Owner" });
  await orgs.patchProject(org.id, pr.id, { stakeholder: alp.id });
  const count = async () => (await list()).find((o) => o.id === org.id)!.needsYou?.stakeholders;
  assert.equal(await count(), 0);
  await orgs.applyChange(org.id, alp.id, { status: "left" }, { kind: "operator" });
  assert.equal(await count(), 1);
  await orgs.patchProject(org.id, pr.id, { stakeholder: null });
  assert.equal(await count(), 0);
});
