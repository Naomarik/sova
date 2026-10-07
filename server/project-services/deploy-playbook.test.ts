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

test("the playbook is listed as a verb playbook that approves deploy", async () => {
  const cat = await listPlaybooks(dir);
  const pb = cat.playbooks.find((p) => p.id === "project-deploy");
  assert.ok(pb, "shipped");
  assert.equal(pb!.title, "Project deploy");
  assert.equal(pb!.approves, "deploy");
});

test("its text: interview first, the only verbs it calls are the two that read, and it never runs a deploy", () => {
  const text = readFileSync(join(PLAYBOOK, "PLAYBOOK.md"), "utf8");
  const verbs = new Set([...text.matchAll(/verb: "(deploy\.[a-z]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...verbs].sort(), ["deploy.check", "deploy.status"]);
  assert.match(text, /you write nothing until it is answered/);
  assert.match(text, /## Never\n- Run a deploy, plan, build, rollback, verify or credential check/);
});
