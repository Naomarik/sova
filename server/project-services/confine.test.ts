import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { isVerbResult, parseDefinition, type VerbResult } from "../../shared/project-contract";
import { staticServes, stopStaticServe } from "../preview-serve";
import { conformer, readStamp } from "./conform";
import { openConfinement } from "./confine";
import { DetachedDriver } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { readRegistry, sharedIdOf } from "./store";
import { defHashOf, isApproved } from "./trust";

/**
 * Confined conformance (§app.project-services/confined) with the real sandbox: bwrap, nsenter and
 * a private network namespace per run. Skipped where this host can't make user namespaces.
 */

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-confine-agent-"));
const agentDir = process.env.PI_CODING_AGENT_DIR;
const which = (p: string) => spawnSync("sh", ["-c", `command -v ${p}`]).status === 0;
const canConfine = process.platform === "linux" && which("bwrap") && which("nsenter") && which("socat") && spawnSync("unshare", ["-Urn", "true"]).status === 0;
const skip = canConfine ? false : "needs Linux with bwrap, nsenter, socat and unprivileged user namespaces";

const op: Caller = { kind: "operator" };
const BASE = 30_000 + Math.floor(Math.random() * 20_000);
const PORTS = { web: BASE, bus: BASE + 40, site: BASE + 80 };
const git = (args: string[], cwd: string) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

// The bus is shared and on a fixed port; web reaches it inside the run; the probe writes its token in the instance's data.
const DEF = {
  version: 1,
  slots: { cap: 2 },
  setup: [{ id: "mark", run: ["node", "setup.mjs"], inputs: ["setup.mjs"] }],
  data: { store: { kind: "dir" } },
  services: {
    bus: { cmd: ["node", "bus.mjs"], scope: "shared", ports: { tcp: { fixed: PORTS.bus } } },
    web: { cmd: ["node", "web.mjs"], ports: { http: { base: PORTS.web } }, requires: ["bus"], ready: { http: "http", path: "/health", timeout: 20 } },
    site: { static: "public", ports: { http: { base: PORTS.site } } },
  },
  hooks: { probe: { run: ["node", "probe.mjs"] } },
  sources: ["package.json"],
};

const FILES: Record<string, string> = {
  "setup.mjs": `import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync(process.env.SOVA_DATA, { recursive: true }); writeFileSync(process.env.SOVA_DATA + "/setup-ran", "yes");`,
  "bus.mjs": `import { createServer } from "node:net"; createServer((s) => { s.on("error", () => {}); s.end("bus"); }).listen(Number(process.env.SOVA_PORT_TCP), "127.0.0.1"); console.log("bus up");`,
  // Healthy only while the bus answers: proof that the run's units share one network.
  "web.mjs": `import { createServer } from "node:http"; import { connect } from "node:net";
const bus = () => new Promise((ok) => { const s = connect(Number(process.env.SOVA_PORT_BUS_TCP), "127.0.0.1"); s.once("data", () => { s.destroy(); ok(true); }); s.once("error", () => ok(false)); });
const leak = []; for (let i = 0; i < 20; i++) leak.push(Buffer.alloc(1 << 20, 1));
createServer(async (q, r) => { if (q.url === "/health") { r.statusCode = (await bus()) ? 200 : 503; r.end(); } else r.end("web"); }).listen(Number(process.env.SOVA_PORT_HTTP), "127.0.0.1", () => console.log("web up", leak.length));`,
  "probe.mjs": `import { existsSync, writeFileSync } from "node:fs"; const [op, token] = process.argv.slice(2); const f = process.env.SOVA_DATA + "/store/" + token; if (op === "write") writeFileSync(f, "1"); else process.exit(existsSync(f) ? 0 : 1);`,
  "public/index.html": "<h1>site</h1>",
  "package.json": "{}\n",
};

let parent = "";
let project = "";
let engine: ProjectEngine;

before(() => {
  if (skip) return;
  mkdirSync(join(agentDir, "sandbox-policy", "linux"), { recursive: true });
  writeFileSync(
    join(agentDir, "sandbox-policy", "linux", "policy.json"),
    JSON.stringify({ version: 1, level: "workspace-write", defaultOn: false, writable: [], shadowed: [], hidden: ["~/.ssh"], readOnlyWithinWritable: [], proxy: { allow: ["registry.npmjs.org"] }, env: { allow: [] }, acceptPartial: false }),
  );
  mkdirSync(join(homedir(), ".ssh"), { recursive: true });
  writeFileSync(join(homedir(), ".ssh", "id_test"), "secret");
  // Outside /tmp: a confined unit's /tmp is a tmp of its own, so a checkout under the host's /tmp would be out of its sight.
  mkdirSync(join(process.cwd(), "tmp"), { recursive: true });
  parent = realpathSync(mkdtempSync(join(process.cwd(), "tmp", "sova-confine-proj-")));
  project = join(parent, "demo");
  mkdirSync(join(project, ".sova"), { recursive: true });
  mkdirSync(join(project, "public"), { recursive: true });
  for (const [f, body] of Object.entries(FILES)) writeFileSync(join(project, f), body);
  writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(DEF, null, 2));
  git(["init", "-q", "-b", "main"], project);
  git(["add", "-A"], project);
  git(["commit", "-q", "-m", "fixture"], project);
  engine = new ProjectEngine({ driver: new DetachedDriver(3_000), pollMs: 100 });
  engine.conformer = conformer(engine);
});

after(async () => {
  if (skip) return;
  for (const i of readRegistry().instances) await engine.run("teardown", { instance: i.id }, op).catch(() => undefined);
  for (const s of staticServes()) await stopStaticServe(s.id);
  await engine.driver.stop(engine.unitOf(sharedIdOf(project), "bus"));
  rmSync(parent, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
});

const tcpFromHost = (port: number) =>
  new Promise<boolean>((done) => {
    const s = connect({ host: "127.0.0.1", port });
    s.once("connect", () => (s.destroy(), done(true)));
    s.once("error", () => done(false));
  });

test("a confined run's namespace: its listener is seen inside, never from the host; its units write only their own checkout", { skip }, async () => {
  const c = await openConfinement({ project });
  assert.ok(!("refused" in c), "refused" in c ? c.refused : "");
  if ("refused" in c) return;
  try {
    const port = BASE + 300;
    const scratch = mkdtempSync(join(parent, "scratch-"));
    const w = await c.wrap({ argv: ["node", "-e", `require("node:net").createServer(()=>{}).listen(${port},"127.0.0.1")`], cwd: scratch, env: { PATH: process.env.PATH!, HOME: homedir() }, checkout: scratch, dataDir: scratch, tmpKey: "t1" });
    const child = spawn(w.argv[0]!, w.argv.slice(1), { env: w.env, stdio: "ignore", detached: true });
    for (let i = 0; i < 50 && !(await c.tcp(port)); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(await c.tcp(port), true, "inside the run");
    assert.equal(await tcpFromHost(port), false, "never from the host");
    const owner = c.portOwner(port);
    assert.ok(typeof owner === "object", `the run's port owner is read in its namespace: ${JSON.stringify(owner)}`);
    process.kill(-child.pid!, "SIGKILL");
    const probe = await c.wrap({
      argv: ["sh", "-c", `echo x > "${project}/escape" 2>/dev/null; echo main=$?; cat "${homedir()}/.ssh/id_test" 2>/dev/null; echo ssh=$?; echo ok > "${scratch}/mine"; echo own=$?`],
      cwd: scratch,
      env: { PATH: process.env.PATH!, HOME: homedir() },
      checkout: scratch,
      dataDir: scratch,
      tmpKey: "t2",
    });
    const out = spawnSync(probe.argv[0]!, probe.argv.slice(1), { env: probe.env, encoding: "utf8" }).stdout;
    assert.match(out, /main=[1-9]/, "the main checkout is read-only");
    assert.doesNotMatch(out, /secret/, "a hidden path reads as nothing");
    assert.match(out, /own=0/, "its own checkout is writable");
    assert.ok(!existsSync(join(project, "escape")));
    assert.equal(readFileSync(join(scratch, "mine"), "utf8"), "ok\n");
  } finally {
    await c.close();
  }
});

test("an unapproved definition conforms confined: it passes, never touches the host's shared bus, measures memory and stamps confined", { skip }, async () => {
  const hash = defHashOf(parseDefinition(readFileSync(join(project, ".sova/project.json"), "utf8")));
  assert.equal(isApproved(project, hash), false);
  const r: VerbResult = await engine.run("conform", { project }, op);
  assert.ok(isVerbResult(r));
  assert.equal(r.ok, true, `${r.error?.message}\n${JSON.stringify(r.conform?.checks, null, 1)}`);
  assert.equal(r.conform?.confined, true);
  assert.deepEqual(r.conform?.leaks, []);
  assert.match(r.conform!.checks.find((x) => x.id === "isolation")!.detail, /read in main skipped \(confined\)/);
  // The host's shared bus was never started: the run's bus was its own.
  assert.equal((await engine.driver.status(engine.unitOf(sharedIdOf(project), "bus"))).state, "missing");
  assert.equal(readRegistry().shared.length, 0, "the registry's shared record is the host's, untouched");
  assert.equal(readRegistry().instances.length, 0);
  const mem = r.conform!.memory!;
  assert.deepEqual(mem.instances.map((i) => i.label), ["A", "B"]);
  for (const i of mem.instances) {
    const web = i.services.find((s) => s.name === "web")!;
    assert.ok((web.peakBytes ?? 0) > 20 * 1024 * 1024, `web's peak counts its 20 MB (${i.label}: ${web.peakBytes})`);
    assert.ok((web.steadyBytes ?? 0) > 0 && (i.steadyBytes ?? 0) >= (web.steadyBytes ?? 0));
    assert.ok((i.peakBytes ?? 0) >= (web.peakBytes ?? 0));
  }
  assert.equal(readStamp(project, hash), null, "no unconfined stamp: a confined pass registers nothing");
  const stamp = readStamp(project, hash, { confined: true });
  assert.equal(stamp?.pass, true);
  assert.equal(stamp?.confined, true);
  assert.equal(isApproved(project, hash), false, "a confined pass approves nothing");
  assert.equal(existsSync(join(parent, ".worktrees", "demo-conform")), false);
});

test("what confinement can't hold is refused before anything starts: a container service, a data folder copied from outside the project", { skip }, async () => {
  const branch = (name: string, def: object) => {
    git(["checkout", "-q", "-b", name, "main"], project);
    writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(def, null, 2));
    git(["commit", "-qam", name], project);
    git(["checkout", "-q", "main"], project);
  };
  branch("with-container", { ...DEF, services: { ...DEF.services, db: { cmd: ["docker", "run", "--rm", "--name", "db-${instance}", "redis"], container: { name: "db-${instance}" } } } });
  const outside = mkdtempSync(join(tmpdir(), "sova-confine-outside-"));
  branch("with-outside-from", { ...DEF, data: { store: { kind: "dir" }, copy: { kind: "dir", from: outside } } });
  const before = readRegistry().instances.length;
  const c1 = await engine.run("conform", { project, ref: "with-container" }, op);
  assert.equal(c1.error?.code, "not-approved");
  assert.match(c1.error!.message, /a container service runs only after approval: approve this definition to conform it/);
  const c2 = await engine.run("conform", { project, ref: "with-outside-from" }, op);
  assert.equal(c2.error?.code, "not-approved");
  assert.match(c2.error!.message, /outside the project/);
  assert.equal(readRegistry().instances.length, before, "nothing was made");
  assert.equal(git(["branch", "--list", "sova/conform-*"], project).trim(), "");
  rmSync(outside, { recursive: true, force: true });
});
