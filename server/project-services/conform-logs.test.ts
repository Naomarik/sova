import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CONFORM_LOG_LINES, parseDefinition } from "../../shared/project-contract";
import { conformer } from "./conform";
import { DetachedDriver } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { readRegistry } from "./store";
import { approve, defHashOf } from "./trust";

/**
 * A failed conformance run keeps its evidence (§app.project-services/conform): the last lines of every
 * service that was not ready (and of a failed step), read into the report before teardown removes them.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-conform-logs-agent-"));

const op: Caller = { kind: "operator" };
const BASE = 30_000 + Math.floor(Math.random() * 20_000);
let parent = "";
let project = "";
let engine: ProjectEngine;
const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project, encoding: "utf8" });

function commitDef(d: object) {
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(d, null, 2));
  const hash = defHashOf(parseDefinition(JSON.stringify(d)));
  approve(project, hash, hash);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "def"]);
}

before(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-conform-logs-proj-")));
  project = join(parent, "demo");
  mkdirSync(join(project, ".sova"), { recursive: true });
  // Never listens: it prints its trouble, many lines of it, and keeps running.
  writeFileSync(join(project, "web.mjs"), `for (let i = 0; i < 200; i++) console.log("resolving dep " + i); console.log("Error building classpath: repo1.maven.org"); setInterval(() => {}, 1000);`);
  writeFileSync(join(project, "setup.mjs"), `console.log("setup says why"); process.exit(3);`);
  git(["init", "-q", "-b", "main"]);
  engine = new ProjectEngine({ driver: new DetachedDriver(3_000), pollMs: 100 });
  engine.conformer = conformer(engine);
});

after(async () => {
  for (const i of readRegistry().instances) await engine.run("teardown", { instance: i.id }, op);
  rmSync(parent, { recursive: true, force: true });
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
});

test("a service that never gets ready: the report keeps its last lines", async () => {
  commitDef({ version: 1, slots: { cap: 1 }, services: { web: { cmd: ["node", "web.mjs"], ports: { http: { base: BASE } }, ready: { tcp: "http", timeout: 2 } } } });
  const r = await engine.run("conform", { project }, op);
  assert.equal(r.ok, false);
  assert.equal(r.conform?.checks.find((c) => !c.ok)?.id, "up-a");
  const web = r.conform?.logs?.find((l) => l.label === "A" && l.service === "web");
  assert.ok(web, JSON.stringify(r.conform?.logs));
  assert.equal(web.lines.length, CONFORM_LOG_LINES);
  assert.equal(web.lines.at(-1), "Error building classpath: repo1.maven.org");
  assert.deepEqual(r.conform?.leaks, [], "and teardown still removed everything");
});

test("a failed setup step: the report keeps that step's output", async () => {
  commitDef({ version: 1, slots: { cap: 1 }, setup: [{ id: "locals", run: ["node", "setup.mjs"] }], services: { web: { cmd: ["node", "web.mjs"] } } });
  const r = await engine.run("conform", { project }, op);
  assert.equal(r.ok, false);
  const step = r.conform?.logs?.find((l) => l.service === "step:setup-locals");
  assert.ok(step, JSON.stringify(r.conform?.logs));
  assert.deepEqual(step.lines, ["setup says why"]);
});

test("a run that passes carries no logs", async () => {
  writeFileSync(join(project, "ok.mjs"), `import { createServer } from "node:net"; createServer((s) => { s.on("error", () => {}); s.end(); }).listen(Number(process.env.SOVA_PORT_HTTP), "127.0.0.1"); console.log("up");`);
  commitDef({ version: 1, slots: { cap: 1 }, services: { web: { cmd: ["node", "ok.mjs"], ports: { http: { base: BASE + 50 } } } } });
  const r = await engine.run("conform", { project }, op);
  assert.equal(r.ok, true, JSON.stringify(r.conform?.checks.filter((c) => !c.ok)));
  assert.equal(r.conform?.logs, undefined);
});
