import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CONFORM_LOG_LINES } from "../../shared/project-contract";
import { conformer } from "./conform";
import { DetachedDriver, SystemdDriver, type Exec } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { readRegistry } from "./store";
import { reservePorts } from "../test-ports";

/**
 * A failed conformance run keeps its evidence (§app.project-services/conform): the last lines of every
 * service that was not ready (and of a failed step), read into the report before teardown removes them.
 * A real service that never gets ready here; every case runs on a host in memory in conform-logs.test.ts.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-conform-logs-agent-"));

const op: Caller = { kind: "operator" };
// Below the ephemeral range (32768+), so no probe's own client port can take a port a service is about to bind.
const BASE = await reservePorts(60);
let parent = "";
let project = "";
let engine: ProjectEngine;
const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project, encoding: "utf8" });

function commitDef(d: object) {
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(d, null, 2));
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

/** The engine on a systemd whose `systemd-run` answers `hookRun` for setup steps and whose journal holds `journal` for them. */
function onSystemd(hookRun: { code: number; stderr: string }, journal: string[]) {
  const runs: string[][] = [];
  const exec: Exec = async (file, args) => {
    if (file === "systemd-run") {
      runs.push(args);
      return { stdout: "", ...hookRun };
    }
    if (file === "journalctl" && args.some((a) => /^sova-hook-.*-setup-deps\.service$/.test(a)))
      return { code: 0, stdout: journal.map((m) => JSON.stringify({ __REALTIME_TIMESTAMP: String(Date.now() * 1000), MESSAGE: m })).join("\n"), stderr: "" };
    if (file === "systemctl" && args[1] === "show") return { code: 0, stdout: "LoadState=not-found\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const e = new ProjectEngine({ driver: new SystemdDriver(exec), pollMs: 100 });
  e.conformer = conformer(e);
  return { e, runs };
}
