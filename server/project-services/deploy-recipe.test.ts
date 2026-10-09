import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseDefinition, type ProjectDef } from "../../shared/project-contract";
import { deployReview, targetStanding } from "./deploy-recipe";
import { defHashOf, deployHashOf } from "./def-hash";
import { hostVarsFile } from "./store";

/**
 * The deploy recipe's own hash (§app.project-services/deploy-plan), its rendering on this host
 * (§app.project-runtime/run-report) and each target's standing (§app.project-runtime/deploy-standing):
 * deploy is outside the definition's hash; a target main declares is declared, one only history names is
 * none. A real git repo, no target contacted (nothing runs here).
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-deploy-recipe-agent-"));

let parent = "";
let project = "";

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

test("deploy is outside the definition's hash and has its own: steps count, timeouts don't", () => {
  const { deploy: _d, ...bare } = DEF;
  assert.equal(defHashOf(parse(DEF)), defHashOf(parse(bare)), "the services' hash never covers how they ship");
  const h = deployHashOf(parse(DEF).deploy!);
  const timed = structuredClone(DEF);
  (timed.deploy.targets.prod.steps[0] as Record<string, unknown>).timeout = 1200;
  assert.equal(deployHashOf(parse(timed).deploy!), h, "a timeout is tuning");
  const moved = structuredClone(DEF);
  moved.deploy.targets.prod.steps[0]!.run[3] = "deploy@${host.PROD_HOST}:/srv/other";
  assert.notEqual(deployHashOf(parse(moved).deploy!), h, "a step's argv changes the hash");
});

test("the rendering resolves ${host.*} on this host and keeps the deploy's own variables", () => {
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
  assert.equal(r.deployHash, deployHashOf(def.deploy!));
});

test("standing: declared while main's deploy declares the target, none otherwise", () => {
  const def = parse(DEF);
  assert.equal(targetStanding(def.deploy, "prod"), "declared");
  assert.equal(targetStanding(def.deploy, "staging"), "declared");
  assert.equal(targetStanding(def.deploy, "gone"), "none");
  assert.equal(targetStanding(undefined, "prod"), "none");
});
