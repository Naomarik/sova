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

// The cases here run real programs or read git behaviour; deploy-check.test.ts holds the in-process ones.
test("each program resolves in a fresh checkout of the commit or on PATH; host names and env credentials by presence", async () => {
  const r = await deployer.run("deploy.check", { project }, op);
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.ok, false, "a failed check makes ok false, like doctor");
  const c = byId(r);
  assert.match(c["schema"]!.detail, /parses: 1 target \(prod\)/);
  assert.equal(c["program:prod/steps.ship"]!.ok, true);
  assert.equal(c["program:prod/build.bundle"]!.ok, true, "deleted in main's working tree, there in the commit");
  assert.deepEqual([c["program:prod/steps.local"]!.ok, c["program:prod/steps.local"]!.detail], [false, "./bin/uncommitted is not in a fresh checkout of the commit"]);
  assert.deepEqual([c["program:prod/steps.tool"]!.ok, c["program:prod/steps.tool"]!.detail], [false, "definitely-not-a-program-sova is not on PATH"]);
  assert.equal(c["program:prod/credentials.prod-ssh"]!.ok, true, "node, on PATH");
  assert.deepEqual([c["host:PROD_HOST"]!.ok, c["credential:prod/DEPLOY_TOKEN"]!.ok], [false, false]);
  assert.match(c["credential:prod/prod-ssh"]!.detail, /its check runs at plan, never here/);

  mkdirSync(join(process.env.PI_CODING_AGENT_DIR!, "sova", "project-services"), { recursive: true });
  writeFileSync(hostVarsFile(), JSON.stringify({ version: 1, projects: { [project]: { PROD_HOST: "deploy.example.test", DEPLOY_TOKEN: "s3cr3t-value" } } }));
  const again = byId(await deployer.run("deploy.check", { project }, op));
  assert.equal(again["host:PROD_HOST"]!.ok, true);
  assert.equal(again["credential:prod/DEPLOY_TOKEN"]!.detail, "DEPLOY_TOKEN is set on this host (its value is never shown)");
  assert.ok(!JSON.stringify(again).includes("s3cr3t-value"), "a credential's value never appears");
});

test("nothing ran, nothing was left: no marker, no checkout, no worktree", async () => {
  await deployer.run("deploy.check", { project }, op);
  for (const f of ["ship", "build", "check-token"]) assert.equal(existsSync(join(project, `RAN-${f}`)), false, f);
  assert.equal(existsSync(join(project, "RAN-CHECK")), false);
  assert.deepEqual(readdirSync(join(deployRoot(), "checkouts")), []);
  assert.equal(git(["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree ")).length, 1);
});
