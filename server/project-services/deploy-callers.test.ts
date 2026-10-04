import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEPLOY_VERBS, ordered, type DeployVerb } from "../../shared/project-contract";
import { authorizeDeploy, DeployFailure } from "./deploy";
import type { Caller, ProjectEngine } from "./engine";
import { overseerVerbsTool, projectVerbsTool, type LooseExec } from "./tools";

/**
 * Who may call which deploy verb (§app.project-services/deploy-callers): reads are anyone's in scope;
 * a plan is the operator's or the global Overseer's (its act wrapper keeps that to a turn the user
 * started); run and rollback are the operator's alone, confirmed; an overseer may only ask
 * (deploy.request); a coding session's project_verbs gets forbidden for everything but the reads.
 * And the CLI's deploy flags reach the route as the deploy verbs' keys.
 */

const root = "/srv/project";
const op: Caller = { kind: "operator" };
const overseer: Caller = { kind: "overseer", id: "o" };
const po: Caller = { kind: "project-overseer", id: "p", root, act: async () => {} };
const session: Caller = { kind: "session", id: "s", root, own: [] };

function outcome(verb: DeployVerb, c: Caller, req: Record<string, unknown> = {}): string {
  try {
    authorizeDeploy(verb, c, root, req);
    return "ok";
  } catch (err) {
    return err instanceof DeployFailure ? err.code : String(err);
  }
}

test("the matrix: reads anyone's in scope; plan operator and Overseer; run and rollback the operator's, confirmed; request the overseers'", () => {
  const want: Record<DeployVerb, [string, string, string, string]> = {
    //                     operator         overseer     project-overseer  session
    "deploy.status": ["ok", "ok", "ok", "ok"],
    "deploy.logs": ["ok", "ok", "ok", "ok"],
    "deploy.check": ["ok", "ok", "ok", "ok"],
    "deploy.plan": ["ok", "ok", "forbidden", "forbidden"],
    "deploy.run": ["ok", "forbidden", "forbidden", "forbidden"],
    "deploy.rollback": ["ok", "forbidden", "forbidden", "forbidden"],
    "deploy.request": ["invalid-request", "ok", "ok", "forbidden"],
  };
  assert.deepEqual(Object.keys(want).sort(), [...DEPLOY_VERBS].sort());
  for (const [verb, row] of Object.entries(want) as [DeployVerb, string[]][])
    assert.deepEqual([op, overseer, po, session].map((c) => outcome(verb, c, { confirm: true })), row, verb);
  assert.equal(outcome("deploy.run", op), "needs-confirm");
  assert.equal(outcome("deploy.rollback", op), "needs-confirm");
  assert.equal(outcome("deploy.request", op, { dismiss: true }), "ok");
  assert.equal(outcome("deploy.request", overseer, { dismiss: true }), "forbidden");
  // Out of scope: another project's session or project overseer reads nothing.
  assert.equal(outcome("deploy.status", { ...session, root: "/srv/other" }), "forbidden");
  assert.equal(outcome("deploy.status", { kind: "conform", id: "c" }), "forbidden");
  assert.equal(outcome("deploy.status", { kind: "system", id: "on-merge" }), "forbidden");
});

/** An engine that answers what the deployer would, through the real authorization. */
const fakeEngine = {
  async run(verb: string, body: Record<string, unknown>, caller: Caller) {
    let error: { code: "forbidden"; message: string } | undefined;
    try {
      authorizeDeploy(verb as DeployVerb, caller, root, body);
    } catch (err) {
      error = { code: (err as DeployFailure).code as "forbidden", message: (err as Error).message };
    }
    return ordered({ v: 1, verb: verb as DeployVerb, project: root, instance: null, slot: null, generation: null, checkout: null, branch: null, ok: !error, changed: false, state: "absent", steps: [], services: [], data: [], links: [], ...(error ? { error } : {}), defHash: null, approved: false, at: "" });
  },
} as unknown as ProjectEngine;

test("project_verbs: a coding session reads deploys and is refused the rest; the global Overseer's reads skip its act wrapper", async () => {
  const tool = projectVerbsTool({ name: "project_verbs", label: "", description: "", promptSnippet: "", engine: () => fakeEngine, caller: async () => session, defaultProject: async () => root });
  const text = async (params: Record<string, unknown>) => ((await tool.execute("t", params, undefined, undefined, { sessionId: "s", cwd: "/", leafId: () => null, rawBranch: () => [] } as never)) as { content: { text: string }[] }).content[0]!.text;
  assert.doesNotMatch(await text({ verb: "deploy.status" }), /failed/);
  assert.match(await text({ verb: "deploy.run", plan: "pl_0123456789abcdef" }), /^deploy\.run failed \(exit 2\): forbidden: Only the operator ships/);
  assert.match(await text({ verb: "deploy.request", target: "prod", why: "x" }), /forbidden/);
  let wrapped: string[] = [];
  const wrap = (exec: LooseExec): LooseExec => (id, p, ...rest) => {
    wrapped.push(String(p.verb));
    return exec(id, p, ...rest);
  };
  const ov = overseerVerbsTool(() => fakeEngine, () => "o", wrap);
  for (const verb of ["deploy.status", "deploy.logs", "deploy.check", "deploy.plan", "deploy.request"]) await ov.execute("t", { verb, project: root, target: "prod" }, undefined, undefined, { sessionId: "s", cwd: "/", leafId: () => null, rawBranch: () => [] } as never);
  assert.deepEqual(wrapped, ["deploy.plan", "deploy.request"], "only acts go through the turn the user started");
});

const dir = realpathSync(mkdtempSync(join(tmpdir(), "sova-deploy-cli-")));
after(() => rmSync(dir, { recursive: true, force: true }));

test("the CLI: deploy.run --plan <id> --confirm posts the deploy keys, and exits with the result's class", async () => {
  const seen: { path: string; body: Record<string, unknown> }[] = [];
  const srv = createServer((q, s) => {
    let b = "";
    q.on("data", (c) => (b += c));
    q.on("end", () => {
      seen.push({ path: q.url ?? "", body: JSON.parse(b) });
      s.setHeader("content-type", "application/json");
      s.statusCode = 409;
      s.end(JSON.stringify({ v: 1, verb: "deploy.run", error: { code: "deploy-refused", message: "expired" } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const cli = fileURLToPath(new URL("../../scripts/sova-project.mjs", import.meta.url));
  const code = await new Promise<number | null>((done) => {
    const p = spawn(process.execPath, [cli, "deploy.run", "--project", dir, "--plan", "pl_0123456789abcdef", "--confirm", "--url", url], { env: { ...process.env, SOVA_TOKEN: "t" }, stdio: "ignore" });
    p.on("exit", done);
  });
  srv.close();
  assert.equal(code, 2, "deploy-refused is a refusal");
  assert.deepEqual(seen, [{ path: "/api/project-services/deploy.run", body: { project: dir, plan: "pl_0123456789abcdef", confirm: true } }]);
});
