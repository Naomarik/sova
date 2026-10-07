// The Project verbs playbook (playbooks/project-verbs): its contract reference and its driver's
// canonical order can't fall behind the parser, its examples parse, and its driver's reads (inspect,
// plan, check, fmt, ram) answer as PLAYBOOK.md says, on throwaway repositories only.
// The driver script run as a program (inspect, plan, check, the entry point) against a real repo: onboard-playbook.integration.test.ts.
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

test("every key the parser accepts is in the driver's canonical order and in references/contract.md, and no other", () => {
  const parserKeys = new Set<string>(Object.values(DEFINITION_KEYS).flat(2) as string[]);
  const ordered = new Set(Object.values(ORDER).flat());
  for (const k of parserKeys) {
    assert.ok(ordered.has(k), `the driver's ORDER lacks "${k}"`);
    assert.ok(CONTRACT_DOC.includes(`\`${k}\``), `references/contract.md never names \`${k}\``);
  }
  for (const k of ordered) assert.ok(parserKeys.has(k), `the driver orders "${k}", which the parser refuses`);
  // Each of the driver's per-object orders covers that object's keys exactly.
  const flat = (v: readonly unknown[]) => [...new Set(v.flat() as string[])].sort();
  assert.deepEqual([...ORDER.top!].sort(), flat(DEFINITION_KEYS.top));
  assert.deepEqual([...ORDER.service!].sort(), flat(DEFINITION_KEYS.service));
  assert.deepEqual([...ORDER.test!].sort(), flat(DEFINITION_KEYS.test));
  assert.deepEqual([...ORDER.isolation!].sort(), flat(DEFINITION_KEYS.isolation));
  assert.deepEqual([...ORDER.data!].sort(), flat(DEFINITION_KEYS.data));
  assert.deepEqual([...ORDER.port!].sort(), flat(DEFINITION_KEYS.port));
  assert.deepEqual([...ORDER.ready!].sort(), flat(DEFINITION_KEYS.ready));
});

test("references/contract.md names every error code and isolation method", () => {
  for (const c of ERROR_CODES) assert.ok(CONTRACT_DOC.includes(`\`${c}\``), `error code ${c}`);
  for (const m of ISOLATION_METHODS) assert.ok(CONTRACT_DOC.includes(`\`${m}\``), `isolation method ${m}`);
  for (const v of ["slot", "instance", "project", "checkout", "main", "branch", "data", "data.<resource>", "ports.<service>.<port>", "host.<NAME>"]) assert.ok(CONTRACT_DOC.includes(`\${${v}}`), `template \${${v}}`);
});

test("each example parses, records isolation on every service and sources, and is in canonical form", () => {
  const ex = join(PLAYBOOK, "references", "examples");
  const files = readdirSync(ex).filter((f) => f.endsWith(".json"));
  assert.deepEqual(files.sort(), ["motorsaif-like.json", "node-app.json", "static.json"]);
  for (const f of files) {
    const text = readFileSync(join(ex, f), "utf8");
    const def = parseDefinition(text);
    assert.ok(def.sources?.length, `${f}: sources`);
    for (const s of def.services) assert.ok(s.isolation?.why, `${f}: ${s.name}.isolation`);
    // Every example has a page, so each names its entry point (PLAYBOOK.md: required wherever there is a page).
    assert.ok(def.open, `${f}: open`);
    assert.equal(pv.formatText(text), text, `${f} is canonical`);
  }
});

test("fmt orders keys as the contract does, keeps names in declaration order, and is stable", () => {
  const messy = JSON.stringify({
    services: { web: { isolation: { why: "w", method: "ports" }, ports: { http: { stride: 10, base: 4000 } }, cmd: ["node", "a.js"] }, api: { cmd: ["x"] } },
    sources: ["package.json"],
    version: 1,
  });
  const once = pv.formatText(messy);
  assert.equal(pv.formatText(once), once);
  const back = JSON.parse(once);
  assert.deepEqual(Object.keys(back), ["version", "sources", "services"]);
  assert.deepEqual(Object.keys(back.services), ["web", "api"]);
  assert.deepEqual(Object.keys(back.services.web), ["cmd", "ports", "isolation"]);
  assert.deepEqual(Object.keys(back.services.web.ports.http), ["base", "stride"]);
  assert.deepEqual(Object.keys(back.services.web.isolation), ["method", "why"]);
  assert.match(once, /"cmd": \["node", "a\.js"\]/);
  assert.ok(once.endsWith("}\n"));
});

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

test("ram reads a unit's memory from its cgroup, and a pid tree's from /proc", () => {
  const cg = join(dir, "cgroup", "user.slice", "user@1000.service", "sova-services.slice", "sova-svc-abc123-proj-1234abcd-web.service");
  mkdirSync(cg, { recursive: true });
  writeFileSync(join(cg, "memory.current"), "104857600\n");
  writeFileSync(join(cg, "memory.peak"), "209715200\n");
  const r = pv.ram({ instances: ["proj-1234abcd"], pids: [process.pid], cgroupRoot: join(dir, "cgroup") });
  const unit = r.rows.find((x: { unit: string }) => x.unit === "sova-svc-abc123-proj-1234abcd-web");
  assert.deepEqual([unit.current, unit.peak, unit.source], [104857600, 209715200, "cgroup"]);
  const self = r.rows.find((x: { unit: string }) => x.unit === `pid ${process.pid}`);
  // A pid tree's memory is read from /proc: Linux only (null elsewhere, e.g. macOS).
  if (process.platform === "linux") assert.ok(self.current > 0);
  else assert.equal(self.current, null);
});
