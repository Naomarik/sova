import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { listPlaybooks } from "../playbooks";
// @ts-expect-error: a plain .mjs script, no types
import * as pd from "../../playbooks/project-deploy/scripts/project-deploy.mjs";

/**
 * The Project deploy playbook (§app.project-runtime/deploy-playbook): a verb playbook that approves
 * `deploy`, asks before it writes, and only reads: its driver lists the repository's deploy
 * candidates without running one, and its check refuses what Sova's parser can't see (a literal
 * address, a shell string, a secret-looking value).
 */

const PLAYBOOK = fileURLToPath(new URL("../../playbooks/project-deploy/", import.meta.url));
const SCRIPT = join(PLAYBOOK, "scripts", "project-deploy.mjs");
const dir = mkdtempSync(join(tmpdir(), "project-deploy-playbook-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=main", ...a], { cwd, stdio: "pipe", encoding: "utf8" });
const run = (...a: string[]) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent") } });

const DEF = {
  version: 1,
  host: ["PROD_HOST"],
  services: { web: { cmd: ["node", "server.js"], ports: { http: { base: 4100 } } } },
  deploy: {
    targets: {
      prod: {
        about: "The public site.",
        requires: { tests: "none" },
        steps: [{ id: "sync", run: ["rsync", "-a", "dist/", "deploy@${host.PROD_HOST}:/srv/site/"] }],
        verify: { http: "https://${host.PROD_HOST}/health" },
        rollback: "redeploy-previous",
      },
    },
  },
};

function repo(name: string, def?: object): string {
  const r = join(dir, name);
  mkdirSync(join(r, ".sova"), { recursive: true });
  git(r, "init", "-q");
  // Each entrypoint would leave a marker if anything ran it.
  writeFileSync(join(r, "package.json"), JSON.stringify({ scripts: { dev: "node server.js", deploy: "touch RAN-DEPLOY && ./deploy.sh" } }));
  writeFileSync(join(r, "deploy.sh"), "#!/bin/sh\ntouch RAN-DEPLOY-SH\n", { mode: 0o755 });
  if (def) writeFileSync(join(r, ".sova", "project.json"), JSON.stringify(def));
  git(r, "add", "-A");
  git(r, "commit", "-qm", "base");
  return r;
}

// The cases here run real programs or read git behaviour; deploy-playbook.test.ts holds the in-process ones.
test("candidates quote the repository's deploy entrypoints and run none of them", () => {
  const r = repo("cand", DEF);
  const res = run("candidates", "--root", r, "--json");
  assert.equal(res.status, 0, res.stderr);
  const j = JSON.parse(res.stdout);
  assert.ok(j.entrypoints.some((d: string) => d === "package.json script deploy: touch RAN-DEPLOY && ./deploy.sh"), j.entrypoints.join("\n"));
  assert.ok(j.entrypoints.includes("deploy.sh"));
  assert.deepEqual(j.host, ["PROD_HOST"]);
  assert.deepEqual(j.targets, ["prod"]);
  assert.equal(existsSync(join(r, "RAN-DEPLOY")) || existsSync(join(r, "RAN-DEPLOY-SH")), false, "nothing ran");
});

test("check: Sova's parser, the canonical form, and no literal address, shell string or secret in a step", () => {
  const clean = repo("clean", DEF);
  assert.equal(run("fmt", "--root", clean).status, 0);
  const ok = run("check", "--root", clean);
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /ok — targets prod/);

  const bad = structuredClone(DEF);
  bad.deploy.targets.prod.steps = [
    { id: "sync", run: ["rsync", "-a", "dist/", "deploy@203.0.113.7:/srv/site/"] },
    { id: "restart", run: ["sh", "-c", "ssh admin@example.org service site restart"] },
    { id: "notify", run: ["curl", "-H", "token=abcdef0123456789", "https://${host.PROD_HOST}/hook"] },
  ];
  const r = repo("bad", bad);
  run("fmt", "--root", r);
  const res = run("check", "--root", r);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /prod\.steps\.sync: a literal IP address/);
  assert.match(res.stdout, /prod\.steps\.restart: a shell string inside an argv/);
  assert.match(res.stdout, /prod\.steps\.restart: a literal user@host/);
  assert.match(res.stdout, /prod\.steps\.notify: a value that looks like a secret/);

  const none = repo("none", { version: 1, services: DEF.services });
  assert.match(run("check", "--root", none).stdout, /\$\.deploy: the definition declares no deploy/);
  assert.deepEqual(pd.deployProblems({ deploy: { targets: { prod: { ...DEF.deploy.targets.prod, verify: { http: "https://example.org/health" } } } } }).problems, ["prod.verify.http: a literal address (https://example.org/health); use https://${host.NAME}/…"]);
});
