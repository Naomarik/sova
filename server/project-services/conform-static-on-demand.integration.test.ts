import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { conformer } from "./conform";
import { DetachedDriver } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { readRegistry } from "./store";
import { reservePorts } from "../test-ports";

/**
 * Conform on a project whose `up` starts nothing that logs (§app.project-services/conform): a static
 * site, served in-process, and an on-demand REPL that only the test run starts. `logs-a` must pass on
 * it (engine.test.ts and test-verb.test.ts keep a process service up, where it still demands lines).
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-conform-static-agent-"));

const op: Caller = { kind: "operator" };

const RUNNER = `
import { connect } from "node:net";
import { writeFileSync } from "node:fs";
const s = connect(Number(process.env.SOVA_PORT_REPL_NREPL), "127.0.0.1");
s.on("error", () => process.exit(2));
s.on("connect", () => { s.end(); writeFileSync(process.env.SOVA_OUT, JSON.stringify({ passed: Math.max(process.argv.length - 2, 1), failed: 0 })); process.exit(0); });
`;

let parent = "";
let project = "";
let engine: ProjectEngine;

before(async () => {
  const base = await reservePorts(15);
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-conform-static-proj-")));
  project = join(parent, "demo");
  mkdirSync(join(project, ".sova"), { recursive: true });
  mkdirSync(join(project, "public"));
  writeFileSync(join(project, "public", "index.html"), "<p>site</p>");
  writeFileSync(join(project, "repl.mjs"), `import { createServer } from "node:net"; createServer((s) => { s.on("error", () => {}); s.end("ok\\n"); }).listen(Number(process.env.SOVA_PORT_NREPL), "127.0.0.1"); console.log("repl up");`);
  writeFileSync(join(project, "runner.mjs"), RUNNER);
  const d = {
    version: 1,
    slots: { cap: 2 },
    services: {
      site: { static: "public", ports: { http: { base } } },
      repl: { cmd: ["node", "repl.mjs"], start: "on-demand", ports: { nrepl: { base: base + 10 } }, ready: { tcp: "nrepl", timeout: 10 } },
    },
    test: { run: ["node", "runner.mjs"], requires: ["repl"], timeout: 20, smoke: ["unit/a", "unit/b"] },
  };
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(d, null, 2));
  const git = (args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: project });
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  engine = new ProjectEngine({ driver: new DetachedDriver(3_000), pollMs: 100 });
  engine.conformer = conformer(engine);
});

after(async () => {
  for (const i of readRegistry().instances) await engine.run(i.slot === 0 ? "down" : "teardown", { instance: i.id }, op);
  for (const i of readRegistry().instances) await engine.driver.stop(engine.unitOf(i.id, "repl"));
  rmSync(parent, { recursive: true, force: true });
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
});

test("conform passes a static site plus an on-demand repl: logs-a asks for no lines while nothing that logs has started", async () => {
  const r = await engine.run("conform", { project }, op);
  assert.equal(r.ok, true, `${r.error?.message}\n${JSON.stringify(r.conform?.checks, null, 1)}`);
  const logs = r.conform!.checks.find((c) => c.id === "logs-a")!;
  assert.ok(logs.ok);
  assert.match(logs.detail, /nothing started that logs/);
  for (const id of ["on-demand-idle", "test-a", "test-a-again", "down-a", "no-leaks"]) assert.ok(r.conform!.checks.some((c) => c.id === id && c.ok), id);
});
