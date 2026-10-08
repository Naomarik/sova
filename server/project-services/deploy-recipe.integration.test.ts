import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseDefinition, type ProjectDef } from "../../shared/project-contract";
import { Deployer } from "./deploy";
import { deployReview } from "./deploy-recipe";
import { DetachedDriver } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { branchFacts } from "./observe";

/**
 * The deploy recipe's own hash (§app.project-services/deploy-plan), its rendering on this host
 * (§app.project-runtime/run-report) and each target's standing (§app.project-runtime/deploy-standing):
 * deploy is outside the definition's hash; a target main declares is declared, one only history names is
 * none. A real git repo, no target contacted (nothing runs here).
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-deploy-recipe-agent-"));

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

before(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-deploy-recipe-")));
  project = join(parent, "site");
  mkdirSync(join(project, ".sova"), { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  commitDef(DEF);
});
after(() => rmSync(parent, { recursive: true, force: true }));

// The cases here read git behaviour; deploy-recipe.test.ts holds the in-process ones.
test("deploy.status: each target's standing and main's deploy hash; a branch's facts carry its own recipe's hash", async () => {
  const deployer = new Deployer(new ProjectEngine({ driver: new DetachedDriver() }));
  const st = await deployer.run("deploy.status", { project }, op);
  assert.equal(st.ok, true, st.error?.message);
  assert.deepEqual(st.deploy!.targets!.map((t) => [t.name, t.standing, t.rollback]), [["prod", "declared", "redeploy-previous"], ["staging", "declared", { none: "Staging is rebuilt every night." }]]);
  const mainHash = st.deploy!.deployHash!;
  git(["switch", "-q", "-c", "sova/deploy-1"]);
  const moved = structuredClone(DEF);
  moved.deploy.targets.prod.steps.push({ id: "restart", run: ["ssh", "deploy@${host.PROD_HOST}", "systemctl", "--user", "restart", "site"] });
  commitDef(moved);
  git(["switch", "-q", "main"]);
  const bf = await branchFacts(project, "sova/deploy-1");
  assert.notEqual(bf.deploy!.hash, mainHash);
  const shown = deployReview(project, parse(moved).deploy!, "main");
  assert.equal(shown.deployHash, bf.deploy!.hash, "the branch's rendering is keyed by the hash its facts carry");
  git(["merge", "-q", "--ff-only", "sova/deploy-1"]);
  const after = await deployer.run("deploy.status", { project }, op);
  assert.equal(after.deploy!.deployHash, bf.deploy!.hash);
  assert.deepEqual(after.deploy!.targets!.map((t) => t.standing), ["declared", "declared"]);
  assert.equal((await deployer.run("deploy.status", { project, target: "nope" }, op)).error?.code, "not-found");
});
