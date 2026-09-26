// Run: pnpm exec tsx --test server/decisions-routes.test.ts. A throwaway PI_CODING_AGENT_DIR in the
// OS temp dir, deleted after; the decide seam is a fake that never finds a contradiction.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import type { DecisionProvider } from "./decide";

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-decisions-routes-")));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
mkdirSync(join(tmp, "agent", "sessions"), { recursive: true });

const orgs = await import("./orgs");
const reconcile = await import("./reconcile");
const { registerDecisionRoutes } = await import("./decisions-routes");
const { settled } = await import("./workspace-git");

const never: DecisionProvider = {
  id: "chain",
  label: "fake",
  async decide(req) {
    const answers: Record<string, any> = {};
    for (const [id, q] of Object.entries(req.questions))
      answers[id] = q.type === "boolean" ? { type: "boolean", p: 0 } : { type: "choice", choice: Object.keys((q as any).options).pop(), probabilities: {}, confidence: 0 };
    return { answers, provider: "jev", model: "fake", latencyMs: 1 };
  },
};
let enabled = true;
reconcile.setReconcileDeps({ provider: () => never, enabled: () => enabled });

const app = new Hono();
registerDecisionRoutes(app);
after(async () => {
  reconcile.watchResolutions()();
  for (const o of orgs.readIndex().orgs) await settled(o.dir);
  rmSync(tmp, { recursive: true, force: true });
});

const call = async (method: string, path: string, body?: unknown) => {
  const r = await app.request(path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  const text = await r.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json };
};

describe("decisions routes", async () => {
  const a = await orgs.createOrg({ name: "Org A", dir: join(tmp, "wa") });
  const b = await orgs.createOrg({ name: "Org B", dir: join(tmp, "wb") });
  mkdirSync(join(tmp, "pa"));
  mkdirSync(join(tmp, "pb"));
  const pa = orgs.addProject(a.id, { name: "A", root: join(tmp, "pa") });
  const pb = orgs.addProject(b.id, { name: "B", root: join(tmp, "pb") });

  test("an unknown org or project is 404, and a project is reachable only under its own org", async () => {
    assert.equal((await call("GET", `/api/orgs/org_nope/projects/${pa.id}/decisions`)).status, 404);
    assert.equal((await call("GET", `/api/orgs/${a.id}/projects/prj_nope/decisions`)).status, 404);
    assert.equal((await call("GET", `/api/orgs/${a.id}/projects/${pb.id}/decisions`)).status, 404);
    assert.equal((await call("POST", `/api/orgs/${a.id}/projects/${pb.id}/reconcile`)).status, 404);
    assert.equal((await call("PATCH", `/api/orgs/${a.id}/projects/${pb.id}/spec`, { frozen: true })).status, 404);
    const ok = await call("GET", `/api/orgs/${a.id}/projects/${pa.id}/decisions`);
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.decisions, []);
    assert.equal(ok.json.spec.exists, false);
  });

  test("bodies of the wrong shape are 400", async () => {
    const base = `/api/orgs/${a.id}/projects/${pa.id}`;
    assert.equal((await call("POST", `${base}/promote`, "not json")).status, 400);
    assert.equal((await call("POST", `${base}/promote`, { ids: [] })).status, 400);
    assert.equal((await call("POST", `${base}/promote`, { ids: [5] })).status, 400);
    assert.equal((await call("POST", `${base}/promote`, { ids: ["x"], bulk: "yes" })).status, 400);
    assert.equal((await call("PATCH", `${base}/spec`, { frozen: "yes" })).status, 400);
    assert.equal((await call("POST", `${base}/conflicts/cf_x/resolve`, { keep: "c" })).status, 400);
    assert.equal((await call("POST", `${base}/conflicts/cf_x/route`, { to: 5 })).status, 400);
  });

  test("ids of another project are refused, never promoted; an unknown conflict is 404", async () => {
    const r = await call("POST", `/api/orgs/${b.id}/projects/${pb.id}/promote`, { ids: ["someone-elses:decision"] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.promoted, []);
    assert.deepEqual(r.json.refused, [{ id: "someone-elses:decision", reason: "unknown decision" }]);
    assert.equal((await call("POST", `/api/orgs/${a.id}/projects/${pa.id}/conflicts/cf_nope/resolve`, { keep: "a" })).status, 404);
    assert.equal((await call("POST", `/api/orgs/${a.id}/projects/${pa.id}/conflicts/cf_nope/route`, {})).status, 404);
  });

  test("with the switch off, Reconcile is 409 with the reason; with it on, it runs", async () => {
    enabled = false;
    const off = await call("POST", `/api/orgs/${a.id}/projects/${pa.id}/reconcile`);
    assert.equal(off.status, 409);
    assert.match(off.json.error, /Turn on Reconcile decisions in Settings → Decisions/);
    enabled = true;
    const on = await call("POST", `/api/orgs/${a.id}/projects/${pa.id}/reconcile`);
    assert.equal(on.status, 200);
    assert.equal(on.json.lastRun.error, undefined);
  });

  test("frozen round-trips through the project", async () => {
    const r = await call("PATCH", `/api/orgs/${a.id}/projects/${pa.id}/spec`, { frozen: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.frozen, true);
    assert.equal((await call("GET", `/api/orgs/${a.id}/projects/${pa.id}/spec`)).json.frozen, true);
    assert.equal((await call("GET", `/api/orgs/${b.id}/projects/${pb.id}/spec`)).json.frozen, false);
  });
});
