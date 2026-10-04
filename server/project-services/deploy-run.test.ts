import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseDefinition } from "../../shared/project-contract";
import { approveDeployRecipe, Deployer, deployLogFile, deployNotes, readPlan, readRecord } from "./deploy";
import { deployReview } from "./deploy-trust";
import { DetachedDriver } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { hostVarsFile } from "./store";
import { approve, defHashOf } from "./trust";

/**
 * deploy.plan and deploy.run (§app.project-services/deploy-plan, /deploy-run) against a fake target: a
 * local folder the steps copy into, a local bare repository as the git remote, and a local HTTP server
 * as verify. No real target is ever contacted. Real processes under the detached driver.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-deploy-run-agent-"));

let parent = "";
let project = "";
let target = "";
let server: Server;
let port = 0;
let deployer: Deployer;
const op: Caller = { kind: "operator" };
const TOKEN = "tok-5ecret-123456";
const git = (args: string[], cwd = project) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

const SHIP = `import { cpSync, writeFileSync } from "node:fs";
const [dir, commit, wait] = process.argv.slice(2);
console.log("shipping with token " + process.env.DEPLOY_TOKEN);
if (wait) await new Promise((r) => setTimeout(r, Number(wait)));
cpSync("site", dir, { recursive: true });
writeFileSync(dir + "/version", commit);
console.log("shipped " + commit);
`;

const DEF = () => ({
  version: 1,
  host: ["TARGET_DIR", "VERIFY_PORT"],
  services: { site: { static: "site", ports: { http: { base: 47400 } } } },
  test: { run: ["node", ".sova/bin/test.mjs"], smoke: ["smoke"] },
  deploy: {
    targets: {
      prod: {
        about: "The fake target: a local folder.",
        requires: { tests: "none" },
        credentials: [{ name: "DEPLOY_TOKEN", kind: "env", check: ["node", "-e", `process.exit(process.env.DEPLOY_TOKEN === "${TOKEN}" ? 0 : 1)`] }],
        plan: [{ id: "dry", run: ["node", "-e", "console.log('would copy site/')"] }],
        steps: [{ id: "ship", run: ["node", ".sova/bin/ship.mjs", "${host.TARGET_DIR}", "${commit}"] }],
        verify: { http: "http://127.0.0.1:${host.VERIFY_PORT}/health", timeout: 5 },
        rollback: "redeploy-previous",
      },
      slow: {
        about: "The fake target, slowly.",
        requires: { tests: "none" },
        steps: [{ id: "ship", run: ["node", ".sova/bin/ship.mjs", "${host.TARGET_DIR}", "${commit}", "4000"] }],
        rollback: { none: "It is a test." },
      },
      broken: {
        about: "Verify never answers 200.",
        requires: { tests: "smoke" },
        steps: [{ id: "ship", run: ["node", ".sova/bin/ship.mjs", "${host.TARGET_DIR}", "${commit}"] }],
        verify: { http: "http://127.0.0.1:${host.VERIFY_PORT}/nope", timeout: 2 },
        rollback: "redeploy-previous",
      },
    },
  },
});

function commitAll(msg: string): string {
  git(["add", "-A"]);
  git(["commit", "-q", "-m", msg]);
  return git(["rev-parse", "HEAD"]);
}
function setHost(extra: Record<string, string> = {}): void {
  mkdirSync(join(process.env.PI_CODING_AGENT_DIR!, "sova", "project-services"), { recursive: true });
  writeFileSync(hostVarsFile(), JSON.stringify({ version: 1, projects: { [project]: { TARGET_DIR: target, VERIFY_PORT: String(port), DEPLOY_TOKEN: TOKEN, ...extra } } }));
}

before(async () => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-deploy-run-")));
  project = join(parent, "site");
  target = join(parent, "target");
  mkdirSync(target);
  server = createServer((q, s) => {
    const ok = q.url === "/health" && existsSync(join(target, "version"));
    s.statusCode = ok ? 200 : 503;
    s.end(ok ? readFileSync(join(target, "version")) : "no");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", join(parent, "remote.git")]);
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  mkdirSync(join(project, ".sova", "bin"), { recursive: true });
  mkdirSync(join(project, "site"));
  writeFileSync(join(project, "site", "index.html"), "<h1>v1</h1>\n");
  writeFileSync(join(project, ".sova", "bin", "ship.mjs"), SHIP);
  writeFileSync(join(project, ".sova", "bin", "test.mjs"), `import { existsSync } from "node:fs";\nprocess.exit(existsSync("RED") ? 1 : 0);\n`);
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(DEF()));
  commitAll("v1");
  git(["remote", "add", "origin", join(parent, "remote.git")]);
  git(["push", "-q", "-u", "origin", "main"]);
  const def = parseDefinition(JSON.stringify(DEF()));
  approve(project, defHashOf(def), defHashOf(def));
  setHost();
  deployer = new Deployer(new ProjectEngine({ driver: new DetachedDriver() }), { watchMs: 50 });
});
after(async () => {
  await new Promise((r) => server.close(r));
  rmSync(parent, { recursive: true, force: true });
});

async function approveMain(): Promise<void> {
  const review = deployReview(project, parseDefinition(git(["show", "HEAD:.sova/project.json"])).deploy!, "main");
  await approveDeployRecipe(project, review.deployHash, "HEAD", review.keys);
}

test("plan: refused until the recipe is approved; the commit must be on the branch and pushed", async () => {
  assert.equal((await deployer.run("deploy.plan", { project, target: "prod" }, op)).error?.code, "not-approved");
  await approveMain();
  // A commit only on a side branch: not on main.
  git(["switch", "-q", "-c", "side"]);
  writeFileSync(join(project, "site", "side.html"), "x");
  const side = commitAll("side");
  git(["switch", "-q", "main"]);
  const off = await deployer.run("deploy.plan", { project, target: "prod", commit: side }, op);
  assert.equal(off.error?.code, "deploy-refused");
  assert.match(off.error!.message, /is not on main, the branch prod ships from/);
  // On main, not pushed.
  writeFileSync(join(project, "site", "index.html"), "<h1>v2</h1>\n");
  commitAll("v2");
  const unpushed = await deployer.run("deploy.plan", { project, target: "prod" }, op);
  assert.equal(unpushed.error?.code, "deploy-refused");
  assert.match(unpushed.error!.message, /is not pushed to origin\/main: push it first/);
  git(["push", "-q", "origin", "main"]);
});

test("plan: a failed credential check is refused for good; main's dirty tree and failing tests need a typed reason, which the feed records", async () => {
  setHost({ DEPLOY_TOKEN: "wrong-token" });
  const bad = await deployer.run("deploy.plan", { project, target: "prod" }, op);
  assert.equal(bad.error?.code, "deploy-refused");
  assert.match(bad.error!.message, /credential check credentials\.DEPLOY_TOKEN failed/);
  assert.ok(!JSON.stringify(bad).includes("wrong-token"), "a credential's value never appears");
  setHost();
  writeFileSync(join(project, "site", "index.html"), "<h1>edited, not committed</h1>\n");
  const dirty = await deployer.run("deploy.plan", { project, target: "prod" }, op);
  assert.equal(dirty.error?.code, "needs-override");
  assert.match(dirty.error!.message, /main's tree has 1 uncommitted change \(give overrideDirty: your reason\)/);
  const through = await deployer.run("deploy.plan", { project, target: "prod", overrideDirty: "the edit is a draft for tomorrow" }, op);
  assert.equal(through.error, undefined, through.error?.message);
  assert.deepEqual(through.deploy!.plan!.overrides, { dirty: "the edit is a draft for tomorrow" });
  assert.match(deployNotes(project)[0]!.line, /through with main's tree dirty: "the edit is a draft for tomorrow"$/);
  git(["checkout", "--", "site/index.html"]);
  // broken requires the smoke tests: red at the commit, so a reason is needed.
  writeFileSync(join(project, "RED"), "");
  commitAll("red");
  git(["push", "-q", "origin", "main"]);
  await approveMain();
  const red = await deployer.run("deploy.plan", { project, target: "broken" }, op);
  assert.equal(red.error?.code, "needs-override", red.error?.message);
  assert.match(red.error!.message, /the required tests failed: the smoke selection/);
  const overseer = await deployer.run("deploy.plan", { project, target: "broken", overrideTests: "x" }, { kind: "overseer", id: "o1" });
  assert.equal(overseer.error?.code, "needs-override", "only the operator lets a plan through");
  git(["rm", "-q", "RED"]);
  commitAll("green");
  git(["push", "-q", "origin", "main"]);
});

test("run: the operator's only, confirmed; ships the plan's commit to the fake target, verifies, redacts the secret", async () => {
  const head = git(["rev-parse", "HEAD"]);
  const planned = await deployer.run("deploy.plan", { project, target: "prod" }, op);
  assert.equal(planned.error, undefined, planned.error?.message);
  const plan = planned.deploy!.plan!;
  assert.equal(plan.commit, head);
  assert.deepEqual(plan.checks.map((c) => [c.id, c.ok]), [["branch", true], ["pushed", true], ["dirty", true], ["host", true], ["tests", true], ["credentials.DEPLOY_TOKEN", true], ["plan.dry", true]]);
  assert.deepEqual(plan.steps, [{ key: "steps.ship", argv: ["node", ".sova/bin/ship.mjs", target, head] }]);
  assert.equal(Date.parse(plan.expiresAt) - Date.parse(plan.createdAt), 15 * 60_000);
  for (const c of [{ kind: "overseer", id: "o" }, { kind: "project-overseer", id: "p", root: project, act: async () => {} }, { kind: "session", id: "s", root: project, own: [] }] as Caller[])
    assert.equal((await deployer.run("deploy.run", { project, plan: plan.planId, confirm: true }, c)).error?.code, "forbidden", c.kind);
  assert.equal((await deployer.run("deploy.run", { project, plan: plan.planId }, op)).error?.code, "needs-confirm");
  const started = await deployer.run("deploy.run", { project, plan: plan.planId, confirm: true }, op);
  assert.equal(started.error, undefined, started.error?.message);
  assert.equal(started.deploy!.record!.state, "running");
  const done = await deployer.settled(started.deploy!.record!.id, 30_000);
  assert.equal(done!.state, "succeeded", done!.detail);
  assert.equal(readFileSync(join(target, "version"), "utf8"), head, "the plan's commit shipped");
  assert.deepEqual([done!.verify!.ok, done!.verify!.status], [true, 200]);
  assert.deepEqual(done!.steps.map((s) => [s.key, s.exit]), [["steps.ship", 0]]);
  const log = readFileSync(deployLogFile(done!.id), "utf8");
  assert.ok(!log.includes(TOKEN), "the secret never reaches the log");
  assert.match(log, /shipping with token \[redacted:DEPLOY_TOKEN\]/);
  assert.match((await deployer.run("deploy.run", { project, plan: plan.planId, confirm: true }, op)).error?.message ?? "", /already ran: plan again|no plan/, "a plan runs once");
  for (let i = 0; i < 100 && readPlan(plan.planId); i++) await new Promise((ok) => setTimeout(ok, 50));
  assert.equal(readPlan(plan.planId), null, "then it is gone, its checkout with it");
  assert.equal((await deployer.run("deploy.run", { project, plan: plan.planId, confirm: true }, op)).error?.code, "not-found");
  for (let i = 0; i < 100 && !deployNotes(project)[0]!.line.startsWith("Deployed"); i++) await new Promise((ok) => setTimeout(ok, 50));
  assert.match(deployNotes(project)[0]!.line, new RegExp(`^Deployed ${head.slice(0, 7)} to prod; http://127\\.0\\.0\\.1:\\d+/health answered 200\\.$`));
});

test("run: one at a time per target; an expired plan, a changed host value or recipe is refused", async () => {
  const p1 = (await deployer.run("deploy.plan", { project, target: "slow" }, op)).deploy!.plan!;
  const first = await deployer.run("deploy.run", { project, plan: p1.planId, confirm: true }, op);
  assert.equal(first.error, undefined, first.error?.message);
  writeFileSync(join(project, "site", "more.html"), "x");
  commitAll("v3");
  git(["push", "-q", "origin", "main"]);
  const p2 = (await deployer.run("deploy.plan", { project, target: "slow" }, op)).deploy!.plan!;
  const second = await deployer.run("deploy.run", { project, plan: p2.planId, confirm: true }, op);
  assert.equal(second.error?.code, "busy");
  assert.match(second.error!.message, /slow is deploying now/);
  assert.equal((await deployer.settled(first.deploy!.record!.id, 30_000))!.state, "succeeded");
  // The plan is tied to this host's values: a changed one is refused.
  setHost({ TARGET_DIR: join(parent, "elsewhere") });
  assert.match((await deployer.run("deploy.run", { project, plan: p2.planId, confirm: true }, op)).error!.message, /values for the recipe changed since the plan/);
  setHost();
  const later = new Deployer(deployer.engine, { now: () => Date.now() + 16 * 60_000 });
  assert.match((await later.run("deploy.run", { project, plan: p2.planId, confirm: true }, op)).error!.message, /expired at/);
});

test("a failed verify is verify-failed; a runner killed mid-deploy reads as interrupted, and the target is free again", async () => {
  const p = (await deployer.run("deploy.plan", { project, target: "broken" }, op)).deploy!.plan!;
  const r = await deployer.run("deploy.run", { project, plan: p.planId, confirm: true }, op);
  const done = await deployer.settled(r.deploy!.record!.id, 30_000);
  assert.equal(done!.state, "verify-failed");
  assert.match(done!.detail!, /\/nope answered 503, expected 200/);
  const s = (await deployer.run("deploy.plan", { project, target: "slow", commit: "HEAD~1" }, op)).deploy!.plan!;
  const run = await deployer.run("deploy.run", { project, plan: s.planId, confirm: true }, op);
  const id = run.deploy!.record!.id;
  let pid: number | undefined;
  for (let i = 0; i < 50 && !pid; i++) {
    await new Promise((ok) => setTimeout(ok, 100));
    pid = readRecord(id)?.pid;
  }
  process.kill(pid!, "SIGKILL");
  const cut = await deployer.settled(id, 10_000);
  assert.equal(cut!.state, "interrupted");
  const again = (await deployer.run("deploy.plan", { project, target: "slow" }, op)).deploy!.plan!;
  assert.equal((await deployer.run("deploy.run", { project, plan: again.planId, confirm: true }, op)).error, undefined, "the lock went with the dead runner");
  await deployer.settled(readPlan(again.planId)!.deployId!, 30_000);
});
