import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseDefinition, type VerbResult } from "../../shared/project-contract";
import { approveDeployRecipe, Deployer, deployAttention, deployNotes } from "./deploy";
import { deployItems } from "./deploy-attention";
import { deployReview } from "./deploy-trust";
import { DetachedDriver } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { hostVarsFile } from "./store";

/**
 * deploy.status, deploy.logs, deploy.rollback and deploy.request (§app.project-services/deploy-status):
 * the history per target, the redacted log, a rollback the way the target declares it, an overseer's
 * request, and the act-tier attention items a failed deploy and a request make. Fake target: a local
 * folder; a bare local remote; no verify server needed (these targets declare none).
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-deploy-status-agent-"));

let parent = "";
let project = "";
let target = "";
let deployer: Deployer;
const op: Caller = { kind: "operator" };
const overseer: Caller = { kind: "overseer", id: "ov" };
const TOKEN = "tok-status-987654";
const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project, encoding: "utf8" }).trim();

const SHIP = `import { writeFileSync } from "node:fs";
const [dir, commit, fail] = process.argv.slice(2);
console.log("using " + process.env.DEPLOY_TOKEN);
if (fail === "fail") { console.error("the target refused"); process.exit(3); }
writeFileSync(dir + "/version", commit);
`;
const step = (extra: string[] = []) => [{ id: "ship", run: ["node", ".sova/bin/ship.mjs", "${host.TARGET_DIR}", "${commit}", ...extra] }];
const DEF = {
  version: 1,
  host: ["TARGET_DIR"],
  services: { site: { static: "site", ports: { http: { base: 47500 } } } },
  deploy: {
    targets: {
      prod: { about: "Fake.", requires: { tests: "none" }, credentials: [{ name: "DEPLOY_TOKEN", kind: "env", check: ["node", "-e", "0"] }], steps: step(), rollback: "redeploy-previous" },
      undo: { about: "Fake, with its own rollback.", requires: { tests: "none" }, steps: step(), rollback: { steps: [{ id: "back", run: ["node", "-e", "require('fs').writeFileSync(process.argv[1] + '/rolled-back', '')", "${host.TARGET_DIR}"] }] } },
      never: { about: "Fake, can't be undone.", requires: { tests: "none" }, steps: step(), rollback: { none: "The schema migrates forward only." } },
      bad: { about: "Fake, always refused.", requires: { tests: "none" }, steps: step(["fail"]), rollback: "redeploy-previous" },
    },
  },
};

function commitPush(msg: string): string {
  writeFileSync(join(project, "site", "index.html"), msg);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", msg]);
  git(["push", "-q", "origin", "main"]);
  return git(["rev-parse", "HEAD"]);
}
async function ship(t: string, confirm = true): Promise<VerbResult> {
  const p = await deployer.run("deploy.plan", { project, target: t }, op);
  assert.equal(p.error, undefined, p.error?.message);
  const r = await deployer.run("deploy.run", { project, plan: p.deploy!.plan!.planId, confirm }, op);
  if (r.deploy?.record) await deployer.settled(r.deploy.record.id, 30_000);
  return r;
}

before(async () => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-deploy-status-")));
  project = join(parent, "site");
  target = join(parent, "target");
  mkdirSync(target);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", join(parent, "remote.git")]);
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  mkdirSync(join(project, ".sova", "bin"), { recursive: true });
  mkdirSync(join(project, "site"));
  writeFileSync(join(project, ".sova", "bin", "ship.mjs"), SHIP);
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(DEF));
  git(["remote", "add", "origin", join(parent, "remote.git")]);
  writeFileSync(join(project, "site", "index.html"), "v0");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "v0"]);
  git(["push", "-q", "-u", "origin", "main"]);
  mkdirSync(join(process.env.PI_CODING_AGENT_DIR!, "sova", "project-services"), { recursive: true });
  writeFileSync(hostVarsFile(), JSON.stringify({ version: 1, projects: { [project]: { TARGET_DIR: target, DEPLOY_TOKEN: TOKEN } } }));
  const review = deployReview(project, parseDefinition(JSON.stringify(DEF)).deploy!, "main");
  await approveDeployRecipe(project, review.deployHash, "HEAD", review.keys);
  deployer = new Deployer(new ProjectEngine({ driver: new DetachedDriver() }), { watchMs: 50 });
});
after(() => rmSync(parent, { recursive: true, force: true }));

test("status keeps each target's history; logs read the redacted log; redeploy-previous ships the last verified commit before", async () => {
  const v1 = commitPush("v1");
  await ship("prod");
  const v2 = commitPush("v2");
  await ship("prod");
  assert.equal(readFileSync(join(target, "version"), "utf8"), v2);
  const st = await deployer.run("deploy.status", { project, target: "prod" }, { kind: "session", id: "s", root: project, own: [] });
  assert.equal(st.error, undefined, "a session reads its project's deploys");
  const prod = st.deploy!.targets![0]!;
  assert.deepEqual([prod.last!.commit, prod.last!.state, prod.verifiedCommit, prod.standing], [v2, "succeeded", v2, "approved"]);
  assert.deepEqual(st.deploy!.history!.map((h) => h.commit), [v2, v1]);
  const logs = await deployer.run("deploy.logs", { project, target: "prod" }, op);
  assert.ok(logs.lines!.some((l) => l.service === "steps.ship" && l.text === "using [redacted:DEPLOY_TOKEN]"), JSON.stringify(logs.lines));
  assert.ok(!JSON.stringify(logs).includes(TOKEN));
  assert.equal((await deployer.run("deploy.rollback", { project, target: "prod" }, op)).error?.code, "needs-confirm");
  assert.equal((await deployer.run("deploy.rollback", { project, target: "prod", confirm: true }, overseer)).error?.code, "forbidden");
  const back = await deployer.run("deploy.rollback", { project, target: "prod", confirm: true }, op);
  assert.equal(back.error, undefined, back.error?.message);
  assert.equal(back.deploy!.record!.kind, "rollback");
  assert.equal(back.deploy!.record!.commit, v1);
  assert.equal((await deployer.settled(back.deploy!.record!.id, 30_000))!.state, "succeeded");
  assert.equal(readFileSync(join(target, "version"), "utf8"), v1, "the previous verified commit is live again");
  assert.match(deployNotes(project)[0]!.line, new RegExp(`^Rolled back ${v1.slice(0, 7)} to prod\\.$`));
});

test("rollback: a target's own steps run at the commit it runs; one that can't be undone says why", async () => {
  await ship("undo");
  const r = await deployer.run("deploy.rollback", { project, target: "undo", confirm: true }, op);
  assert.equal(r.error, undefined, r.error?.message);
  assert.deepEqual(r.deploy!.plan!.steps.map((s) => s.key), ["rollback.back"]);
  await deployer.settled(r.deploy!.record!.id, 30_000);
  assert.ok(existsSync(join(target, "rolled-back")));
  const never = await deployer.run("deploy.rollback", { project, target: "never", confirm: true }, op);
  assert.equal(never.error?.code, "unsupported");
  assert.equal(never.error!.message, "never can't be rolled back: The schema migrates forward only.");
});

test("a failed deploy is an act-tier item until a later deploy of the target succeeds", async () => {
  const r = await ship("bad");
  const rec = (await deployer.run("deploy.status", { project, target: "bad" }, op)).deploy!.targets![0]!.last!;
  assert.deepEqual([rec.state, rec.detail], ["failed", "steps.ship exited with 3"]);
  assert.equal(rec.id, r.deploy!.record!.id);
  const facts = deployAttention().filter((a) => a.root === project);
  assert.deepEqual(facts.map((f) => [f.kind, f.target]), [["deploy-failed", "bad"]]);
  const items = deployItems(facts, () => ({ id: "p1", name: "Site" }));
  assert.deepEqual([items[0]!.tier, items[0]!.kind, items[0]!.path, items[0]!.href], ["act", "deploy-failed", "", "#/projects/p1"]);
  assert.match(items[0]!.detail!, /^Deploy of [0-9a-f]{7} to bad failed: steps\.ship exited with 3$/);
  assert.match((await deployer.run("deploy.logs", { project, deploy: rec.id }, op)).lines!.map((l) => l.text).join("\n"), /the target refused/);
});

test("deploy.request: an overseer's ask (never a deploy), one per target; the operator's plan or dismiss clears it", async () => {
  const session: Caller = { kind: "session", id: "s", root: project, own: [] };
  const po: Caller = { kind: "project-overseer", id: "po", root: project, act: async () => {} };
  assert.equal((await deployer.run("deploy.request", { project, target: "prod", why: "x" }, session)).error?.code, "forbidden");
  assert.equal((await deployer.run("deploy.plan", { project, target: "prod" }, po)).error?.code, "forbidden", "the project overseer asks instead");
  const asked = await deployer.run("deploy.request", { project, target: "prod", commit: "HEAD", why: "The fix for the login bug is merged." }, po);
  assert.equal(asked.error, undefined, asked.error?.message);
  assert.equal(asked.deploy!.request!.by, "project-overseer:po");
  assert.match(deployNotes(project)[0]!.line, /^The project overseer asks you to deploy [0-9a-f]{7} to prod: The fix for the login bug is merged\.$/);
  const st = await deployer.run("deploy.status", { project, target: "prod" }, op);
  assert.equal(st.deploy!.targets![0]!.request!.why, "The fix for the login bug is merged.");
  assert.ok(deployAttention().some((a) => a.kind === "deploy-request" && a.target === "prod"));
  assert.equal((await deployer.run("deploy.request", { project, target: "prod", dismiss: true }, po)).error?.code, "forbidden", "only the operator clears it");
  await deployer.run("deploy.plan", { project, target: "prod" }, op);
  assert.ok(!deployAttention().some((a) => a.kind === "deploy-request"), "the operator's plan answers it");
  await deployer.run("deploy.request", { project, target: "never", why: "ship it" }, overseer);
  assert.equal((await deployer.run("deploy.request", { project, target: "never", dismiss: true }, op)).error, undefined);
  assert.match(deployNotes(project)[0]!.line, /^You dismissed the request to deploy never\.$/);
});
