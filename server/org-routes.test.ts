// Run: pnpm exec tsx --test server/org-routes.test.ts. The org routes no other test requests: the operator's
// name, detach and attach, the remote, a referral's decline, a person's history, a placed project's unarchive, and withdrawing an offer.
// Each answers from the engine host. Throwaway PI_CODING_AGENT_DIR and workspaces; no model is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";
import type { BatonInfo } from "../shared/baton";
import type { OrgDetail, OrgsInfo, ProfileChange } from "../shared/orgs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-org-routes-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const baton = await import("./baton");
const { registerOrgRoutes } = await import("./org-routes");
const { registerProjectRoutes } = await import("./projects/routes");
const { settled } = await import("./workspace-git");

after(async () => {
  for (const o of orgs.orgsInfo().orgs) await settled(o.dir);
  rmSync(root, { recursive: true, force: true });
});

const app = new Hono();
registerOrgRoutes(app);
registerProjectRoutes(app);
const call = async (method: string, path: string, body?: unknown) => {
  const r = await app.request(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const text = await r.text();
  return { status: r.status, json: JSON.parse(text) };
};

const org = await orgs.createOrg({ name: "Routes", dir: join(root, "ws") });
mkdirSync(join(root, "proj"));
const project = await orgs.addProject(org.id, { name: "Portal", root: join(root, "proj") });
const tony = await orgs.addPerson(org.id, { name: "Tony Reyes", role: "IT" });
const maria = await orgs.addPerson(org.id, { name: "Maria Lopez", role: "Payroll" });

test("PUT /api/orgs/operator sets the operator's name; an empty one is 400", async () => {
  const r = await call("PUT", "/api/orgs/operator", { name: "Omar" });
  assert.equal(r.status, 200);
  assert.equal((r.json as OrgsInfo).operator.name, "Omar");
  assert.equal((await call("PUT", "/api/orgs/operator", { name: " " })).status, 400);
});

test("PUT /api/orgs/:id/remote: a URL with spaces is 400; a URL is set, empty removes it", async () => {
  assert.equal((await call("PUT", `/api/orgs/${org.id}/remote`, { url: "not a url" })).status, 400);
  assert.equal((await call("PUT", `/api/orgs/${org.id}/remote`, { url: 5 })).status, 400);
  const set = await call("PUT", `/api/orgs/${org.id}/remote`, { url: "git@example.com:acme/ws.git" });
  assert.equal(set.status, 200);
  assert.equal((set.json as OrgDetail).git.remote, "git@example.com:acme/ws.git");
  const cleared = await call("PUT", `/api/orgs/${org.id}/remote`, { url: "" });
  assert.equal((cleared.json as OrgDetail).git.remote ?? null, null);
});

test("POST …/people/:pid/decline: a referral is declined (left, the referral kept); GET …/history lists it, newest first", async () => {
  const bob = await orgs.addPerson(org.id, { name: "Bob Ref", status: "proposed", role: "Accountant", contact: { phone: "+1 555 010 0199" }, referral: { why: "Does the books", referredBy: "operator" } });
  const r = await call("POST", `/api/orgs/${org.id}/people/${bob.id}/decline`);
  assert.equal(r.status, 200);
  const row = (r.json as OrgDetail).roster.find((p) => p.id === bob.id)!;
  assert.equal(row.status, "left");
  assert.ok(row.referral, "the referral stays on them");
  assert.equal((await call("POST", `/api/orgs/${org.id}/people/${bob.id}/decline`)).status, 409, "only a proposed person is declined");
  const history = (await call("GET", `/api/orgs/${org.id}/people/${bob.id}/history`)).json as ProfileChange[];
  assert.deepEqual([history[0]!.field, history[0]!.to], ["status", "left"]);
  assert.ok(history.every((h, i) => i === 0 || h.at <= history[i - 1]!.at), "newest first");
});

test("POST /api/projects/:pid/unarchive undoes an archive; again it changes nothing (as today); the org's list says so", async () => {
  assert.equal((await call("POST", `/api/projects/${project.id}/archive`)).status, 200);
  assert.ok(orgs.readProjects(org.id).find((p) => p.id === project.id)!.archived, "the org reads the project's own shelf");
  const r = await call("POST", `/api/projects/${project.id}/unarchive`);
  assert.equal(r.status, 200);
  assert.equal(orgs.readProjects(org.id).find((p) => p.id === project.id)!.archived, undefined);
  const again = await call("POST", `/api/projects/${project.id}/unarchive`);
  assert.equal(again.status, 200);
  assert.equal(orgs.readProjects(org.id).find((p) => p.id === project.id)!.archived, undefined);
});

test("POST /api/baton/:sid/offer/withdraw withdraws the open offer; nothing open is refused", async () => {
  const made = await baton.createBaton({ orgId: org.id, projectId: project.id, to: [tony.id, maria.id], publicTitle: "Payroll dates", goal: "g" });
  const r = await call("POST", `/api/baton/${made.sessionId}/offer/withdraw`);
  assert.equal(r.status, 200);
  assert.equal((r.json as BatonInfo).offer?.state, "withdrawn");
  assert.equal((await call("POST", `/api/baton/${made.sessionId}/offer/withdraw`)).status, 409);
  assert.equal((await call("POST", "/api/baton/nope/offer/withdraw")).status, 404);
});

test("GET /api/baton carries the session's goal, for the operator's strip", async () => {
  const goal = "Find out who signs off on payroll dates.\nAnd by when.";
  const made = await baton.createBaton({ orgId: org.id, projectId: project.id, to: tony.id, publicTitle: "Payroll sign-off", goal });
  const r = await call("GET", `/api/baton?path=${encodeURIComponent(made.path)}`);
  assert.equal(r.status, 200);
  assert.equal((r.json as BatonInfo).session.goal, goal);
});

test("DELETE /api/orgs/:id detaches it here; POST /api/orgs/attach brings the same workspace back", async () => {
  const dir = orgs.orgDir(org.id);
  await settled(dir);
  const gone = await call("DELETE", `/api/orgs/${org.id}`);
  assert.deepEqual([gone.status, gone.json], [200, { ok: true }]);
  assert.ok(!(await call("GET", "/api/orgs")).json.orgs.some((o: { id: string }) => o.id === org.id));
  assert.equal((await call("GET", `/api/orgs/${org.id}`)).status, 404);
  assert.equal((await call("POST", "/api/orgs/attach", {})).status, 400, "dir is required");
  const back = await call("POST", "/api/orgs/attach", { dir });
  assert.equal(back.status, 201, JSON.stringify(back.json));
  assert.equal((back.json as OrgDetail).id, org.id);
  assert.deepEqual((back.json as OrgDetail).roster.map((p) => p.name).sort(), ["Bob Ref", "Maria Lopez", "Tony Reyes"]);
  assert.equal((await call("POST", "/api/orgs/attach", { dir })).status, 409, "already attached here");
});
