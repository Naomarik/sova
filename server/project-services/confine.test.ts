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
import { shadowSource } from "../../pi-config/extensions/sandbox/backend.ts";
import { MAVEN_SETTINGS, openConfinement, whyExited } from "./confine";
import { DetachedDriver } from "./drivers";
import { ProjectEngine, type Caller } from "./engine";
import { mutateRegistry, readRegistry, sharedIdOf } from "./store";
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
// Below the ephemeral range (32768+), so no probe's own client port can take a port a service is about to bind.
const BASE = 20_000 + Math.floor(Math.random() * 12_000);
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

test("after a server start, a unit of a confined run that ended is stopped and marked stopped, never started", async () => {
  const id = "demo-c0ffee00";
  const checkout = mkdtempSync(join(tmpdir(), "sova-confine-ended-"));
  const eng = engine ?? new ProjectEngine({ driver: new DetachedDriver(3_000), pollMs: 100 });
  mutateRegistry((r) => {
    r.instances.push({ id, project: checkout, checkout, branch: null, slot: 5, generation: 1, createdBy: "conform:x", createdAt: new Date().toISOString(), cutWorktree: false, confined: "0ended0", desired: { web: "running", idle: "running" }, prints: {}, data: {}, ports: {} });
  });
  const unit = eng.unitOf(id, "web");
  await eng.driver.start({ unit, argv: ["sleep", "30"], cwd: checkout, env: { PATH: process.env.PATH! } });
  assert.equal((await eng.driver.status(unit)).state, "active");
  const did = await eng.reconcile();
  assert.ok(did.includes(`${id}: stopped web (its confined conformance run ended)`), did.join("\n"));
  assert.notEqual((await eng.driver.status(unit)).state, "active");
  assert.deepEqual(readRegistry().instances.find((i) => i.id === id)?.desired, { web: "stopped", idle: "stopped" });
  assert.equal((await eng.driver.status(eng.unitOf(id, "idle"))).state, "missing", "nothing was started");
  mutateRegistry((r) => {
    r.instances = r.instances.filter((i) => i.id !== id);
  });
  rmSync(checkout, { recursive: true, force: true });
});

test("a run under a long agent dir still opens: the probe socket's path stays within a Unix socket's 107 bytes", { skip }, async () => {
  const long = join(agentDir, "a-rather-long-hermetic-agent-directory-name", "under-a-worktree-checkout-of-some-length", "agent");
  mkdirSync(join(long, "sandbox-policy", "linux"), { recursive: true });
  writeFileSync(join(long, "sandbox-policy", "linux", "policy.json"), readFileSync(join(agentDir, "sandbox-policy", "linux", "policy.json")));
  const was = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = long;
  try {
    const c = await openConfinement({ project });
    assert.ok(!("refused" in c), "refused" in c ? c.refused : "");
    if (!("refused" in c)) await c.close();
  } finally {
    process.env.PI_CODING_AGENT_DIR = was;
  }
});

test("a dead anchor is named by its first error line, not Node's stack or version banner", () => {
  const stderr = [
    "node:net:1937",
    "      throw new ErrnoException(err, 'listen');",
    "      ^",
    "",
    "Error: listen EINVAL: invalid argument /very/long/net.sock",
    "    at Server.setupListenHandle [as _listen2] (node:net:1937:21)",
    "    at listenInCluster (node:net:2016:12) {",
    "  errno: -22,",
    "}",
    "",
    "Node.js v25.2.1",
  ].join("\n");
  assert.equal(whyExited(stderr).split("; ")[0], "Error: listen EINVAL: invalid argument /very/long/net.sock");
  assert.doesNotMatch(whyExited(stderr), /Node\.js v|^\s*at /);
  assert.equal(whyExited("bwrap: Can't chdir to /x: No such file or directory\n"), "bwrap: Can't chdir to /x: No such file or directory");
});

test("a shadowed ~/.m2 gets a settings file naming the run's proxy (Maven ignores HTTP(S)_PROXY), never over one that exists", { skip }, async () => {
  const dir = join(agentDir, "m2-agent");
  mkdirSync(join(dir, "sandbox-policy", "linux"), { recursive: true });
  const policy = JSON.parse(readFileSync(join(agentDir, "sandbox-policy", "linux", "policy.json"), "utf8"));
  writeFileSync(join(dir, "sandbox-policy", "linux", "policy.json"), JSON.stringify({ ...policy, shadowed: ["~/.m2"] }));
  const settings = join(shadowSource(dir, join(homedir(), ".m2")), "settings.xml");
  const was = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const c = await openConfinement({ project });
    assert.ok(!("refused" in c), "refused" in c ? c.refused : "");
    if (!("refused" in c)) await c.close();
    assert.equal(readFileSync(settings, "utf8"), MAVEN_SETTINGS);
    assert.match(MAVEN_SETTINGS, /<host>127\.0\.0\.1<\/host><port>3128<\/port>/);
    writeFileSync(settings, "<settings>mine</settings>");
    const again = await openConfinement({ project });
    if (!("refused" in again)) await again.close();
    assert.equal(readFileSync(settings, "utf8"), "<settings>mine</settings>");
  } finally {
    process.env.PI_CODING_AGENT_DIR = was;
  }
});

test("inside a run, listeners on 127.0.0.1, ::1 and ::ffff:127.0.0.1 (a JVM bound to localhost) all have their owner", { skip }, async () => {
  const c = await openConfinement({ project });
  assert.ok(!("refused" in c), "refused" in c ? c.refused : "");
  if ("refused" in c) return;
  const [p4, p6, pm] = [BASE + 400, BASE + 401, BASE + 402];
  const scratch = mkdtempSync(join(parent, "listen-"));
  try {
    const py = `import socket,time
a=socket.socket(socket.AF_INET); a.bind(("127.0.0.1",${p4})); a.listen()
b=socket.socket(socket.AF_INET6); b.bind(("::1",${p6})); b.listen()
m=socket.socket(socket.AF_INET6); m.bind(("::ffff:127.0.0.1",${pm})); m.listen()
time.sleep(30)`;
    const w = await c.wrap({ argv: ["python3", "-c", py], cwd: scratch, env: { PATH: process.env.PATH!, HOME: homedir() }, checkout: scratch, dataDir: scratch, tmpKey: "l" });
    const child = spawn(w.argv[0]!, w.argv.slice(1), { env: w.env, stdio: "ignore", detached: true });
    try {
      for (let i = 0; i < 50 && typeof c.portOwner(pm) !== "object"; i++) await new Promise((r) => setTimeout(r, 100));
      for (const p of [p4, p6, pm]) assert.equal(typeof c.portOwner(p), "object", `port ${p}: ${JSON.stringify(c.portOwner(p))}`);
    } finally {
      process.kill(-child.pid!, "SIGKILL");
    }
  } finally {
    await c.close();
  }
});

test("a confined unit writes the Clojure CLI's user cache and git libraries as private copies; the user's ~/.clojure config stays read-only", { skip }, async () => {
  const c = await openConfinement({ project });
  assert.ok(!("refused" in c), "refused" in c ? c.refused : "");
  if ("refused" in c) return;
  const scratch = mkdtempSync(join(parent, "tools-"));
  mkdirSync(join(homedir(), ".clojure"), { recursive: true });
  writeFileSync(join(homedir(), ".clojure", "deps.edn"), "{:aliases {}}");
  try {
    const w = await c.wrap({
      argv: ["sh", "-c", `echo cp > ~/.clojure/.cpcache/x.cp && echo cpcache=ok; mkdir -p ~/.gitlibs/libs && echo gitlibs=ok; cat ~/.clojure/deps.edn; echo x >> ~/.clojure/deps.edn 2>/dev/null || echo config=ro`],
      cwd: scratch,
      env: { PATH: process.env.PATH!, HOME: homedir() },
      checkout: scratch,
      dataDir: scratch,
      tmpKey: "tools",
    });
    const out = await new Promise<string>((done) => {
      const p = spawn(w.argv[0]!, w.argv.slice(1), { env: w.env });
      let o = "";
      p.stdout.on("data", (d) => (o += d));
      p.stderr.on("data", (d) => (o += d));
      p.on("close", () => done(o));
    });
    assert.match(out, /cpcache=ok/);
    assert.match(out, /gitlibs=ok/);
    // The test home sits under /tmp, which a unit sees as its own tmp: the config is out of its sight there, never writable.
    if (!homedir().startsWith("/tmp/")) {
      assert.match(out, /\{:aliases \{\}\}/, "the user's config is still read");
      assert.match(out, /config=ro/);
    }
    assert.equal(readFileSync(join(homedir(), ".clojure", "deps.edn"), "utf8"), "{:aliases {}}");
    assert.ok(!existsSync(join(homedir(), ".clojure", ".cpcache", "x.cp")), "the cache went to the sandbox's copy, not the host's");
    assert.ok(existsSync(join(shadowSource(agentDir, join(homedir(), ".clojure", ".cpcache")), "x.cp")));
  } finally {
    await c.close();
  }
});
