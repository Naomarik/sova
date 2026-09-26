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
const { writeConflicts } = await import("./decisions");
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
  const project = orgs.addProject(busy.id, { name: "Portal", root: join(root, "proj") });
  const tony = orgs.addPerson(busy.id, { name: "Tony Reyes", role: "IT" });

  test("a fresh org waits on nothing and was last active when created (or its first roster write)", async () => {
    const q = (await list()).find((o) => o.id === quiet.id)!;
    assert.deepEqual(q.needsYou, { replies: 0, links: 0, proposals: 0, conflicts: 0 });
    assert.ok(q.lastActivityAt && Date.parse(q.lastActivityAt) >= Date.parse(quiet.createdAt));
  });

  test("a reply, a link to send and a proposed person each count, per org", async () => {
    baton.createBaton({ orgId: busy.id, projectId: project.id, to: OPERATOR, publicTitle: "Mine", goal: "g" });
    baton.createBaton({ orgId: busy.id, projectId: project.id, to: tony.id, publicTitle: "No link", goal: "g", mintLink: false });
    baton.createBaton({ orgId: busy.id, projectId: project.id, to: tony.id, publicTitle: "Linked", goal: "g" });
    orgs.addPerson(busy.id, { name: "Bob Ref", status: "proposed", role: "Accountant", contact: { phone: "+1 555 010 0199" }, referral: { why: "Does the books", referredBy: "operator" } });
    const all = await list();
    const b = all.find((o) => o.id === busy.id)!;
    assert.deepEqual(b.needsYou, { replies: 1, links: 1, proposals: 1, conflicts: 0 });
    assert.equal(b.openBatons, 3);
    assert.deepEqual(all.find((o) => o.id === quiet.id)!.needsYou, { replies: 0, links: 0, proposals: 0, conflicts: 0 }, "another org's items stay there");
  });

  test("a closed session no longer counts, and activity moves forward", async () => {
    const before = (await list()).find((o) => o.id === busy.id)!;
    const mine = baton.allBatons().find((r) => r.orgId === busy.id && r.publicTitle === "Mine")!;
    await new Promise((r) => setTimeout(r, 5));
    baton.closeBaton(mine.sessionId);
    const b = (await list()).find((o) => o.id === busy.id)!;
    assert.equal(b.needsYou!.replies, 0);
    assert.ok(Date.parse(b.lastActivityAt!) > Date.parse(before.lastActivityAt!), "closedAt is newer");
  });

  test("an open conflict routed to the operator with no session counts; routed to a person, asked in a session, or resolved does not", async () => {
    const c = (id: string, extra: Partial<Conflict>): Conflict => ({ id, orgId: busy.id, projectId: project.id, areaKey: "invoicing", a: "d1", b: "d2", p: 0.9, routedTo: OPERATOR, routeReason: "Nobody decides invoicing.", state: "open", createdAt: new Date().toISOString(), ...extra });
    writeConflicts(busy.id, project.id, [c("cf_1", {}), c("cf_2", { routedTo: tony.id }), c("cf_3", { batonSessionId: "s-x" }), c("cf_4", { state: "resolved" })]);
    const b = (await list()).find((o) => o.id === busy.id)!;
    assert.equal(b.needsYou!.conflicts, 1);
  });

  test("GET /api/orgs/:id: needsYou, each baton's waiting, projectConflicts", async () => {
    const d = (await (await app.request(`/api/orgs/${busy.id}`)).json()) as OrgDetail;
    assert.deepEqual(d.needsYou, { replies: 0, links: 1, proposals: 1, conflicts: 1 });
    const by = Object.fromEntries(d.batons.map((r) => [r.publicTitle, r.waiting]));
    assert.deepEqual(by, { "No link": "link", Linked: undefined, Mine: undefined });
    assert.deepEqual(d.projectConflicts, { [project.id]: 1 });
    const q = (await (await app.request(`/api/orgs/${quiet.id}`)).json()) as OrgDetail;
    assert.deepEqual(q.projectConflicts, {});
  });
});
