import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseDefinition } from "../../shared/project-contract";
import { approveDeployRecipe, Deployer, deployNotes } from "./deploy";
import { deployReview } from "./deploy-trust";
import { ProjectEngine, type Caller } from "./engine";
import { FakeHost } from "./fake-host";
import { hostVarsFile } from "./store";
import { approve, defHashOf } from "./trust";

/**
 * deploy.plan and deploy.run (§app.project-services/deploy-plan, /deploy-run) against a fake target: a
 * local folder the steps copy into, a local bare repository as the git remote, and a local HTTP server
 * as verify. No real target is ever contacted. The plan's refusals on a host in memory (fake-host.ts), its
 * checks the fake driver's runs; the runs themselves are in deploy-run.integration.test.ts.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-deploy-run-agent-"));

let parent = "";
let project = "";
let target = "";
const port = 1;
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
  const host = new FakeHost();
  // The credential check and the smoke tests as the real ones decide: the token's value, a RED file.
  host.driver.once = (spec) => {
    if (spec.argv[1] === "-e" && spec.argv[2]!.includes("DEPLOY_TOKEN")) return { code: spec.env.DEPLOY_TOKEN === TOKEN ? 0 : 1 };
    if (spec.argv[1] === ".sova/bin/test.mjs") return { code: existsSync(join(spec.cwd, "RED")) ? 1 : 0 };
    return { code: 0 };
  };
  deployer = new Deployer(new ProjectEngine(host.deps()), { watchMs: 50 });
});
after(async () => {
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
