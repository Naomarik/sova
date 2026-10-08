import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CONFORM_LOG_LINES } from "../../shared/project-contract";
import { conformer } from "./conform";
import { SystemdDriver, type Exec } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { FakeHost } from "./fake-host";
import { readRegistry } from "./store";

/**
 * A failed conformance run keeps its evidence (§app.project-services/conform): the last lines of every
 * service that was not ready (and of a failed step), read into the report before teardown removes them.
 * On a host in memory (fake-host.ts) whose clock the ready wait steps; the systemd cases on a faked exec.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-conform-logs-agent-"));

const op: Caller = { kind: "operator" };
const BASE = 21_000;
const host = new FakeHost();
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
  // web.mjs never listens: it prints its trouble, many lines of it, and keeps running; setup.mjs says why and fails.
  host.driver.behave = (spec) =>
    spec.argv[1] === "web.mjs" ? { ports: [], logs: [...Array.from({ length: 200 }, (_, i) => `resolving dep ${i}`), "Error building classpath: repo1.maven.org"] } : {};
  host.driver.once = (spec, print) => {
    if (spec.argv[1] !== "setup.mjs") return { code: 0 };
    print("setup says why");
    return { code: 3 };
  };
  engine = new ProjectEngine(host.deps());
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
  const e = new ProjectEngine(host.deps({ driver: new SystemdDriver(exec) }));
  e.conformer = conformer(e);
  return { e, runs };
}

test("systemd: a setup step systemd-run could not start fails with systemd-run's message, which the report's logs keep", async () => {
  commitDef({ version: 1, slots: { cap: 1 }, setup: [{ id: "deps", run: [".sova/bin/setup"] }], services: { web: { cmd: ["node", "web.mjs"] } } });
  const { e, runs } = onSystemd({ code: 1, stderr: "Failed to start transient service unit: Unit sova-hook-x.service already exists.\n" }, []);
  const r = await e.run("conform", { project }, op);
  assert.equal(r.ok, false);
  const failed = r.conform?.checks.find((c) => !c.ok);
  assert.equal(failed?.id, "create-a");
  assert.match(failed?.detail ?? "", /setup-deps could not be started: systemd-run could not start .*already exists/);
  assert.doesNotMatch(failed?.detail ?? "", /exited with/, "never read as the hook's exit");
  const step = r.conform?.logs?.find((l) => l.service === "step:setup-deps");
  assert.deepEqual(step?.lines, ["systemd-run: Failed to start transient service unit: Unit sova-hook-x.service already exists."], JSON.stringify(r.conform?.logs));
  const argv = runs[0]!;
  const cmd = argv.slice(argv.indexOf("--") + 1)[0]!;
  assert.ok(cmd.startsWith("/") && cmd.endsWith("/.sova/bin/setup"), `the relative command is made absolute against the checkout: ${cmd}`);
});

test("systemd: a setup step that ran and failed keeps its exit, and the report keeps its journal lines", async () => {
  commitDef({ version: 1, slots: { cap: 1 }, setup: [{ id: "deps", run: [".sova/bin/setup", "ci"] }], services: { web: { cmd: ["node", "web.mjs"] } } });
  const { e } = onSystemd({ code: 1, stderr: "Running as unit: sova-hook-x.service; invocation ID: 01\nFinished with result: exit-code\n" }, ["npm ci", "npm ERR! missing package-lock.json"]);
  const r = await e.run("conform", { project }, op);
  assert.match(r.conform?.checks.find((c) => !c.ok)?.detail ?? "", /setup-deps exited with 1/);
  assert.deepEqual(r.conform?.logs?.find((l) => l.service === "step:setup-deps")?.lines, ["npm ci", "npm ERR! missing package-lock.json"], JSON.stringify(r.conform?.logs));
});
