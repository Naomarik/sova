import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseDefinition, type ProjectDef } from "../../shared/project-contract";
import { approveDeployRecipe, Deployer, deployNotes } from "./deploy";
import { approveDeploy, CHANGED_SINCE_SHOWN, deployHashOf, deployReview, readDeployApprovals, targetStanding } from "./deploy-trust";
import { DetachedDriver } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { branchFacts } from "./observe";
import { hostVarsFile } from "./store";
import { defHashOf } from "./trust";

/**
 * The deploy recipe's own hash and approval (§app.project-services/deploy-trust) and each target's
 * standing (§app.project-runtime/deploy-standing): deploy is outside the definition's hash; its hash is
 * approved only with every step of the Sova-rendered review ticked, on the hash shown; standing moves
 * awaiting approval → approved → stale. A real git repo, no target contacted (nothing runs here).
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-deploy-trust-agent-"));

let parent = "";
let project = "";
const op: Caller = { kind: "operator" };

const DEF = {
  version: 1,
  host: ["PROD_HOST"],
  services: { web: { cmd: ["node", "server.mjs"], ports: { http: { base: 47100 } } } },
  test: { run: ["node", "--test"], smoke: ["test"] },
  deploy: {
    targets: {
      prod: {
        about: "The public site.",
        credentials: [{ name: "prod-ssh", kind: "ssh", check: ["ssh", "deploy@${host.PROD_HOST}", "true"] }],
        steps: [{ id: "sync", run: ["rsync", "-a", "dist/", "deploy@${host.PROD_HOST}:/srv/${target}/${commit}"] }],
        verify: { http: "https://${host.PROD_HOST}/health" },
        rollback: "redeploy-previous",
      },
      staging: { about: "The staging copy.", requires: { tests: "none" }, steps: [{ id: "push", run: ["./bin/push", "$${commit}"] }], rollback: { none: "Staging is rebuilt every night." } },
    },
  },
};
const parse = (d: object): ProjectDef => parseDefinition(JSON.stringify(d));
const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project, encoding: "utf8" }).trim();
function commitDef(d: object): void {
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(d));
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "def"]);
}
const allKeys = (d: ProjectDef) => deployReview(project, d.deploy!, "main").keys;

before(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-deploy-trust-")));
  project = join(parent, "site");
  mkdirSync(join(project, ".sova"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  commitDef(DEF);
});
after(() => rmSync(parent, { recursive: true, force: true }));

test("deploy is outside the definition's hash and has its own: steps count, timeouts don't", () => {
  const { deploy: _d, ...bare } = DEF;
  assert.equal(defHashOf(parse(DEF)), defHashOf(parse(bare)), "approving the services never covers how they ship");
  const h = deployHashOf(parse(DEF).deploy!);
  const timed = structuredClone(DEF);
  (timed.deploy.targets.prod.steps[0] as Record<string, unknown>).timeout = 1200;
  assert.equal(deployHashOf(parse(timed).deploy!), h, "a timeout is tuning");
  const moved = structuredClone(DEF);
  moved.deploy.targets.prod.steps[0]!.run[3] = "deploy@${host.PROD_HOST}:/srv/other";
  assert.notEqual(deployHashOf(parse(moved).deploy!), h, "a step's argv is what is approved");
});

test("the review resolves ${host.*} on this host, keeps the deploy's own variables, and lists every tick", () => {
  const def = parse(DEF);
  const before = deployReview(project, def.deploy!, "main");
  const sync = before.targets[0]!.steps.find((s) => s.key === "steps.sync")!;
  assert.deepEqual(sync.unset, ["PROD_HOST"], "an unset host variable is shown as unset, never guessed");
  mkdirSync(join(process.env.PI_CODING_AGENT_DIR!, "sova", "project-services"), { recursive: true });
  writeFileSync(hostVarsFile(), JSON.stringify({ version: 1, projects: { [project]: { PROD_HOST: "203.0.113.7" } } }));
  const r = deployReview(project, def.deploy!, "main");
  const step = r.targets[0]!.steps.find((s) => s.key === "steps.sync")!;
  assert.deepEqual(step.argv, ["rsync", "-a", "dist/", "deploy@203.0.113.7:/srv/${target}/${commit}"]);
  assert.deepEqual(step.unset, []);
  assert.equal(r.targets[0]!.verify!.url, "https://203.0.113.7/health");
  assert.equal(r.targets[0]!.branch, "main", "no branch declared: the main checkout's");
  assert.deepEqual(r.targets[1]!.steps[0]!.argv, ["./bin/push", "${commit}"], "$$ reads as one $");
  assert.deepEqual(r.keys, ["prod/credentials.prod-ssh", "prod/steps.sync", "prod/verify", "prod/rollback", "staging/steps.push", "staging/rollback"]);
});

test("approval needs the hash shown and every tick; standing goes awaiting → approved → stale; none when undeclared", () => {
  const file = join(parent, "approvals.json");
  const def = parse(DEF);
  const h = deployHashOf(def.deploy!);
  const keys = allKeys(def);
  assert.equal(targetStanding(project, def.deploy, "prod", readDeployApprovals(file)), "awaiting-approval");
  assert.throws(() => approveDeploy(project, "sha256:00", def.deploy!, keys, file), (e: Error) => e.message === CHANGED_SINCE_SHOWN);
  assert.throws(() => approveDeploy(project, h, def.deploy!, keys.slice(1), file), /Tick every step before approving: 1 not ticked \(prod\/credentials\.prod-ssh\)/);
  assert.deepEqual(readDeployApprovals(file), {}, "a refused approval approves nothing");
  approveDeploy(project, h, def.deploy!, keys, file);
  assert.equal(targetStanding(project, def.deploy, "prod", readDeployApprovals(file)), "approved");
  const moved = structuredClone(DEF);
  moved.deploy.targets.staging.steps[0]!.run = ["./bin/push", "--fast"];
  const def2 = parse(moved);
  assert.equal(targetStanding(project, def2.deploy, "prod", readDeployApprovals(file)), "stale", "another target changed: the recipe needs approving again");
  assert.equal(targetStanding(project, def2.deploy, "staging", readDeployApprovals(file)), "stale");
  assert.equal(targetStanding(project, def2.deploy, "gone", readDeployApprovals(file)), "none");
  assert.equal(targetStanding(project, undefined, "prod", readDeployApprovals(file)), "none");
});

test("deploy.status: each target's standing, the review while unapproved; the operator's approval at a ref; the feed says so", async () => {
  const deployer = new Deployer(new ProjectEngine({ driver: new DetachedDriver() }));
  const st = await deployer.run("deploy.status", { project }, op);
  assert.equal(st.ok, true, st.error?.message);
  assert.equal(st.deploy!.approved, false);
  assert.deepEqual(st.deploy!.targets!.map((t) => [t.name, t.standing, t.rollback]), [["prod", "awaiting-approval", "redeploy-previous"], ["staging", "awaiting-approval", { none: "Staging is rebuilt every night." }]]);
  const review = st.deploy!.review!;
  assert.equal(review.deployHash, st.deploy!.deployHash);
  // A branch proposes a change; its facts carry its own deploy hash, unapproved.
  git(["switch", "-q", "-c", "sova/deploy-1"]);
  const moved = structuredClone(DEF);
  moved.deploy.targets.prod.steps.push({ id: "restart", run: ["ssh", "deploy@${host.PROD_HOST}", "systemctl", "--user", "restart", "site"] });
  commitDef(moved);
  git(["switch", "-q", "main"]);
  const bf = await branchFacts(project, "sova/deploy-1");
  assert.equal(bf.deploy!.approved, false);
  assert.notEqual(bf.deploy!.hash, review.deployHash);
  await assert.rejects(approveDeployRecipe(project, bf.deploy!.hash, "sova/deploy-1", review.keys), /Tick every step before approving: 1 not ticked \(prod\/steps\.restart\)/);
  await assert.rejects(approveDeployRecipe(project, review.deployHash, "sova/deploy-1", [...review.keys, "prod/steps.restart"]), (e: Error) => e.message === CHANGED_SINCE_SHOWN);
  await approveDeployRecipe(project, bf.deploy!.hash, "sova/deploy-1", [...review.keys.slice(0, 2), "prod/steps.restart", ...review.keys.slice(2)]);
  assert.equal((await branchFacts(project, "sova/deploy-1")).deploy!.approved, true);
  assert.match(deployNotes(project)[0]!.line, new RegExp(`^You approved the deploy recipe ${bf.deploy!.hash.slice(7, 19)} on this host\\.$`));
  // Main still has the old recipe: not approved there until the branch merges (an approval covered prod, so: stale).
  assert.equal((await deployer.run("deploy.status", { project, target: "prod" }, op)).deploy!.targets![0]!.standing, "stale");
  git(["merge", "-q", "--ff-only", "sova/deploy-1"]);
  const after = await deployer.run("deploy.status", { project }, op);
  assert.equal(after.deploy!.approved, true);
  assert.equal(after.deploy!.review, undefined, "approved: no review to tick");
  assert.deepEqual(after.deploy!.targets!.map((t) => t.standing), ["approved", "approved"]);
  assert.equal((await deployer.run("deploy.status", { project, target: "nope" }, op)).error?.code, "not-found");
});
