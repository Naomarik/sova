import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DetachedDriver } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";

/**
 * A project that declares no services (a library, or one the merge queue only checks): its definition is valid, up
 * and down are clean no-ops beyond setup, and its test command runs.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-no-services-agent-"));
const op: Caller = { kind: "operator" };
let parent = "";
let project = "";
let engine: ProjectEngine;

before(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-no-services-")));
  project = join(parent, "lib");
  mkdirSync(join(project, ".sova"), { recursive: true });
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify({ version: 1, setup: [{ id: "mark", run: ["node", "-e", "require('fs').writeFileSync('.setup-ran','1')"] }], test: { run: ["node", "t.mjs"], smoke: ["a"] }, merge: { checks: [{ id: "unit", run: ["node", "t.mjs"] }] } }));
  writeFileSync(join(project, "t.mjs"), "console.log('tests ran')\n");
  writeFileSync(join(project, ".gitignore"), ".setup-ran\n");
  execFileSync("git", ["init", "-q", "-b", "main", project]);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: project });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "lib"], { cwd: project });
  engine = new ProjectEngine({ driver: new DetachedDriver() });
});
after(() => rmSync(parent, { recursive: true, force: true }));

test("doctor finds the definition valid; up runs setup and starts nothing; down is a no-op", async () => {
  const doc = await engine.run("doctor", { project }, op);
  assert.notEqual(doc.error?.code, "invalid-definition", JSON.stringify(doc.error));
  const up = await engine.run("up", { project }, op);
  assert.equal(up.ok, true, JSON.stringify(up.error));
  assert.deepEqual(up.services, []);
  assert.ok(up.steps.some((s) => s.id === "setup:mark" && s.result === "done"), JSON.stringify(up.steps));
  const down = await engine.run("down", { instance: up.instance }, op);
  assert.equal(down.ok, true, JSON.stringify(down.error));
  assert.deepEqual(down.services, []);
});

test("its test command runs", async () => {
  const t = await engine.run("test", { project }, op);
  assert.equal(t.ok, true, JSON.stringify(t.error));
});
