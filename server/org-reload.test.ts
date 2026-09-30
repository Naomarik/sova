// Run: pnpm exec tsx --test server/org-reload.test.ts. The Workspace tab's Reload (POST /api/orgs/:id/reload): a
// snapshot that doesn't load refuses every act on its session with "Fix or restore it, then reload."; once the file is
// restored, Reload loads it and the act goes through. Throwaway workspace; no model is called.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";
import type { OrgDetail } from "../shared/orgs";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-org-reload-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const { registerOrgRoutes } = await import("./org-routes");
const { closeOrgHost, hostOf } = await import("./org-engine");
const { scanSnapshots } = await import("./org-host/store");
const { settled } = await import("./workspace-git");

after(async () => {
  for (const o of orgs.orgsInfo().orgs) await settled(o.dir);
  rmSync(root, { recursive: true, force: true });
});

const app = new Hono();
registerOrgRoutes(app);
const call = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });

test("a broken snapshot is refused until it is restored and reloaded; Reload answers the problems left", async () => {
  const org = await orgs.createOrg({ name: "Reload", dir: join(root, "ws") });
  const sam = await orgs.addPerson(org.id, { name: "Sam Okafor", role: "Pricing" });
  const sid = `person/${org.id}/${sam.id}`;
  await closeOrgHost(org.id);
  const file = scanSnapshots(join(orgs.orgDir(org.id), "charts")).find((s) => s.sid === sid)!.file;
  const good = readFileSync(file, "utf8");
  writeFileSync(file, "<<<<<<< HEAD\n{:broken");
  await orgs.openAttachedOrgs();
  assert.deepEqual(hostOf(org.id).problems().map((p) => [p.kind, p.sessionId]), [["snapshot", sid]]);
  const page = (await (await call("GET", `/api/orgs/${org.id}`)).json()) as OrgDetail;
  assert.equal(page.problems.length, 1);
  const refused = await call("PATCH", `/api/orgs/${org.id}/people/${sam.id}`, { role: "Prices" });
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as { error: string }).error, /can't be read\. Fix or restore it, then reload\.$/);
  // Reloading a file still broken changes nothing and says so.
  const still = await call("POST", `/api/orgs/${org.id}/reload`);
  assert.equal(still.status, 200);
  assert.equal(((await still.json()) as OrgDetail).problems.length, 1);
  writeFileSync(file, good);
  const r = await call("POST", `/api/orgs/${org.id}/reload`);
  assert.equal(r.status, 200);
  assert.deepEqual(((await r.json()) as OrgDetail).problems, []);
  assert.equal((await call("PATCH", `/api/orgs/${org.id}/people/${sam.id}`, { role: "Prices" })).status, 200);
  assert.equal(orgs.findPerson(org.id, sam.id)!.role, "Prices");
  assert.equal((await call("POST", "/api/orgs/org_nope0000/reload")).status, 404);
});

test("a broken org snapshot: the page still opens (id, problems, Reload), every act is refused, and Reload restores it", async () => {
  const org = await orgs.createOrg({ name: "Broken", dir: join(root, "ws-org") });
  await orgs.addPerson(org.id, { name: "Lina Haddad", role: "Ops" });
  const sid = `org/${org.id}`;
  await closeOrgHost(org.id);
  const file = scanSnapshots(join(orgs.orgDir(org.id), "charts")).find((s) => s.sid === sid)!.file;
  const good = readFileSync(file, "utf8");
  writeFileSync(file, "<<<<<<< HEAD\n{:broken");
  await orgs.openAttachedOrgs();
  const r = await call("GET", `/api/orgs/${org.id}`);
  assert.equal(r.status, 200, await r.clone().text());
  const page = (await r.json()) as OrgDetail;
  assert.equal(page.id, org.id);
  assert.equal(page.problems.length, 1);
  assert.match(page.problems[0]!, /can't be read/);
  assert.equal(page.roster.length, 1, "what still loads is shown");
  assert.ok((await call("GET", "/api/orgs")).status === 200, "the list still opens");
  // Every org-level act answers the workspace sentence (never "no readable organization").
  mkdirSync(join(root, "proj-org"), { recursive: true });
  const lina = page.roster[0]!;
  for (const [method, path, body] of [
    ["PATCH", `/api/orgs/${org.id}`, { name: "Renamed" }],
    ["PATCH", `/api/orgs/${org.id}`, { about: "We make invoices." }],
    ["POST", `/api/orgs/${org.id}/about/revert`, { at: new Date().toISOString() }],
    ["PUT", `/api/orgs/${org.id}/owner`, { personId: lina.id }],
    ["POST", `/api/orgs/${org.id}/projects`, { name: "Site", root: join(root, "proj-org") }],
    ["POST", `/api/orgs/${org.id}/people`, { name: "New Person", role: "Ops" }],
    ["POST", `/api/orgs/${org.id}/commit`, undefined],
  ] as const) {
    const r = await call(method, path, body);
    const text = await r.text();
    assert.equal(r.status, 409, `${method} ${path}: ${text}`);
    assert.match((JSON.parse(text) as { error: string }).error, /^The workspace repo has a problem: .* can't be read\. Fix or restore it, then reload\.$/, `${method} ${path}`);
  }
  writeFileSync(file, good);
  const back = (await (await call("POST", `/api/orgs/${org.id}/reload`)).json()) as OrgDetail;
  assert.deepEqual([back.name, back.problems], ["Broken", []]);
  assert.equal((await call("PATCH", `/api/orgs/${org.id}`, { name: "Renamed" })).status, 200);
});
