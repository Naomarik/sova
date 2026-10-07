import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Deployer, deployRoot } from "./deploy";
import { DetachedDriver } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { hostVarsFile } from "./store";

/**
 * deploy.check (§app.project-services/deploy-check): the recipe at a ref, proven offline in a fresh
 * checkout of that commit: it parses, each step's program resolves there or on PATH, each host
 * variable and env credential is set on this host (presence only). No step runs, nothing is
 * contacted, and the checkout is gone afterwards. Every program here would leave a marker if run.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-deploy-check-agent-"));

let parent = "";
let project = "";
let deployer: Deployer;
const op: Caller = { kind: "operator" };
const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project, encoding: "utf8" }).trim();

const DEF = {
  version: 1,
  host: ["PROD_HOST"],
  services: { web: { cmd: ["node", "server.mjs"], ports: { http: { base: 47300 } } } },
  deploy: {
    targets: {
      prod: {
        about: "The public site.",
        requires: { tests: "none" },
        credentials: [
          { name: "DEPLOY_TOKEN", kind: "env", check: ["./bin/check-token"] },
          { name: "prod-ssh", kind: "ssh", check: ["node", "-e", "require('fs').writeFileSync('RAN-CHECK','')"] },
        ],
        build: [{ id: "bundle", run: ["./bin/build"] }],
        steps: [
          { id: "ship", run: ["./bin/ship", "${host.PROD_HOST}", "${commit}"] },
          { id: "local", run: ["./bin/uncommitted"] },
          { id: "tool", run: ["definitely-not-a-program-sova"] },
        ],
        verify: { http: "https://${host.PROD_HOST}/health" },
        rollback: "redeploy-previous",
      },
    },
  },
};

before(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-deploy-check-")));
  project = join(parent, "site");
  mkdirSync(join(project, ".sova"), { recursive: true });
  mkdirSync(join(project, "bin"));
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  for (const f of ["ship", "build", "check-token"]) writeFileSync(join(project, "bin", f), `#!/bin/sh\ntouch "$(dirname "$0")/../RAN-${f}"\n`, { mode: 0o755 });
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(DEF));
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "def"]);
  // The main checkout's working tree is not the commit: a script only there doesn't count, one deleted there still does.
  writeFileSync(join(project, "bin", "uncommitted"), "#!/bin/sh\n", { mode: 0o755 });
  unlinkSync(join(project, "bin", "build"));
  deployer = new Deployer(new ProjectEngine({ driver: new DetachedDriver() }));
});
after(() => rmSync(parent, { recursive: true, force: true }));

const byId = (r: { checks?: { id: string; ok: boolean; detail: string }[] }) => Object.fromEntries((r.checks ?? []).map((c) => [c.id, c]));

test("a ref: a branch's recipe is checked; refusals for no deploy, an invalid one, no such ref", async () => {
  git(["switch", "-q", "-c", "sova/deploy-x"]);
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify({ version: 1, services: DEF.services }));
  git(["commit", "-q", "-am", "no deploy"]);
  git(["switch", "-q", "main"]);
  assert.equal((await deployer.run("deploy.check", { project, ref: "sova/deploy-x" }, op)).error?.code, "not-found");
  assert.equal((await deployer.run("deploy.check", { project, ref: "nope" }, op)).error?.code, "not-found");
  const session: Caller = { kind: "session", id: "s1", root: project, own: [] };
  assert.equal((await deployer.run("deploy.check", { project }, session)).error, undefined, "a playbook's session may check its project");
  assert.equal((await deployer.run("deploy.check", { project }, { kind: "session", id: "s2", root: "/elsewhere", own: [] })).error?.code, "forbidden");
});
