// The Project verbs playbook (playbooks/project-verbs): its contract reference and its driver's
// canonical order can't fall behind the parser, its examples parse, and its driver's reads (inspect,
// plan, check, fmt, ram) answer as PLAYBOOK.md says, on throwaway repositories only.
// The driver script run as a program; the parser, contract, examples and fmt in-process are onboard-playbook.test.ts.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DEFINITION_KEYS, ERROR_CODES, ISOLATION_METHODS, parseDefinition } from "../../shared/project-contract";
// @ts-expect-error: a plain .mjs script, no types
import * as pv from "../../playbooks/project-verbs/scripts/project-verbs.mjs";

const PLAYBOOK = fileURLToPath(new URL("../../playbooks/project-verbs/", import.meta.url));
const SCRIPT = join(PLAYBOOK, "scripts", "project-verbs.mjs");
const CONTRACT_DOC = readFileSync(join(PLAYBOOK, "references", "contract.md"), "utf8");
const ORDER = pv.ORDER as Record<string, string[]>;

const dir = mkdtempSync(join(tmpdir(), "project-verbs-playbook-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=master", ...a], { cwd, stdio: "pipe", encoding: "utf8" });
const run = (...a: string[]) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent") } });

const DEF = {
  version: 1,
  sources: ["package.json"],
  services: {
    web: {
      cmd: ["node", "server.js"],
      env: { PORT: "${ports.web.http}" },
      ports: { http: { base: 41000, stride: 10 } },
      about: "The app: http://127.0.0.1:${ports.web.http}/",
      isolation: { method: "ports", why: "Stateless server; its own port per copy." },
    },
  },
};

function repo(name: string): string {
  const r = join(dir, name);
  mkdirSync(r, { recursive: true });
  git(r, "init", "-q");
  writeFileSync(join(r, "package.json"), JSON.stringify({ scripts: { dev: "node server.js", test: "node --test", deploy: "./deploy.sh", "clone-prod": "./bin/pull-db" } }));
  writeFileSync(join(r, "server.js"), "const port = process.env.PORT ?? 3000;\n");
  writeFileSync(join(r, "CLAUDE.md"), "Run `node server.js`; the app is on http://localhost:3000.\n");
  writeFileSync(join(r, ".gitignore"), ".locals.json\n");
  writeFileSync(join(r, ".locals.json"), "{}\n");
  git(r, "add", "-A");
  git(r, "commit", "-qm", "base");
  return r;
}

test("inspect reads the stack at HEAD: scripts, tests, deploy entrypoints, port literals, ignored local files; exit 1 with no definition", () => {
  const r = repo("inspect");
  const res = run("inspect", "--root", r, "--json");
  assert.equal(res.status, 1, res.stderr);
  const j = JSON.parse(res.stdout);
  assert.equal(j.definition.state, "absent");
  assert.ok(j.stack.includes("package.json"));
  assert.ok(j.tests.some((t: string) => t.includes("script test")));
  assert.ok(j.deploy.some((d: string) => d.includes("script deploy")));
  assert.deepEqual(j.prodData, ["package.json script clone-prod: ./bin/pull-db"]);
  assert.ok(j.literals.some((l: { port: number; refs: string[] }) => l.port === 3000 && l.refs.includes("server.js:1")));
  assert.ok(j.ignored.some((i: { path: string }) => i.path === ".locals.json"));
  // An uncommitted edit is not the project: HEAD is read.
  writeFileSync(join(r, "server.js"), "const port = 3999;\n");
  const again = JSON.parse(run("inspect", "--root", r, "--json").stdout);
  assert.ok(!again.literals.some((l: { port: number }) => l.port === 3999));
});

test("plan: no definition is work; a committed canonical one with unchanged sources is nothing to do; a changed source is work, by name", () => {
  const r = repo("plan");
  assert.equal(run("plan", "--root", r).status, 1);
  mkdirSync(join(r, ".sova"));
  writeFileSync(join(r, ".sova", "project.json"), pv.formatText(JSON.stringify(DEF)));
  git(r, "add", "-A");
  git(r, "commit", "-qm", "Project verbs");
  const quiet = run("plan", "--root", r);
  assert.equal(quiet.status, 0, quiet.stdout);
  assert.match(quiet.stdout, /Nothing points at a change/);
  writeFileSync(join(r, "package.json"), JSON.stringify({ scripts: { dev: "node server.js", worker: "node worker.js" } }));
  git(r, "commit", "-qam", "a worker");
  const drift = run("plan", "--root", r, "--json");
  assert.equal(drift.status, 1);
  assert.deepEqual(JSON.parse(drift.stdout).changed, ["package.json"]);
});

test("check: the parser's refusal, a fixed port on a checkout service, and a service without isolation are problems", () => {
  const r = repo("check");
  const f = join(r, "def.json");
  writeFileSync(f, pv.formatText(JSON.stringify(DEF)));
  assert.equal(run("check", f, "--root", r).status, 0);
  const fixed = structuredClone(DEF) as { services: { web: Record<string, unknown> } };
  fixed.services.web.ports = { http: { fixed: 41000 } };
  delete fixed.services.web.isolation;
  writeFileSync(f, pv.formatText(JSON.stringify(fixed)));
  const res = run("check", f, "--root", r);
  assert.equal(res.status, 1);
  assert.match(res.stdout, /fixed port on a checkout service/);
  assert.match(res.stdout, /isolation: record \{method, why\}/);
  writeFileSync(f, JSON.stringify({ version: 1, services: { web: { cmd: "node server.js" } } }));
  assert.match(run("check", f, "--root", r).stdout, /\$\.services\.web\.cmd: must be an argv/);
});

test("the entry point: plan points at a page with no `open` and check notes it; declaring one quiets both", () => {
  const r = repo("entry");
  const paged = structuredClone(DEF) as typeof DEF & { open?: unknown; services: { web: Record<string, unknown> } };
  paged.services.web.ready = { http: "http" };
  mkdirSync(join(r, ".sova"));
  const f = join(r, ".sova", "project.json");
  writeFileSync(f, pv.formatText(JSON.stringify(paged)));
  git(r, "add", "-A");
  git(r, "commit", "-qm", "Project verbs");
  const plan = run("plan", "--root", r, "--json");
  assert.equal(plan.status, 1, plan.stdout);
  assert.ok(JSON.parse(plan.stdout).why.some((w: string) => w.includes("no entry point (`open`)")));
  const c = run("check", f, "--root", r);
  assert.match(c.stdout, /\$\.open: name the app's entry point/);
  paged.open = { endpoint: "web.http" };
  writeFileSync(f, pv.formatText(JSON.stringify(paged)));
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(f, "utf8"))), ["version", "sources", "services", "open"], "open sits after services");
  git(r, "commit", "-qam", "entry");
  assert.equal(run("plan", "--root", r).status, 0);
  assert.doesNotMatch(run("check", f, "--root", r).stdout, /\$\.open/);
});
