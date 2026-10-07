// Share links to a running copy (§app.project-services/share, §mesh.public/preview), over real sockets: a running
// copy's endpoints really answer the share's dial, a static copy's dial guard, and conform's share-endpoint check.
// The verbs' decisions (who may, the link's life, refusals) run on a host in memory in share.test.ts. Real processes under the detached driver in the OS temp dir; a temp PI_CODING_AGENT_DIR;
// the preview address pinned by env; ~/.pi untouched.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DefinitionError, isVerbResult, parseDefinition, type VerbResult } from "../../shared/project-contract";
import { reservePorts } from "../test-ports";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "sova-share-agent-"));
process.env.SOVA_SHARE_PREVIEW_URL = "https://*.preview.example.invalid";

const { staticServes, stopStaticServe } = await import("../preview-serve");
const { DetachedDriver } = await import("./drivers");
const { ProjectEngine } = await import("./engine");
type Caller = import("./engine").Caller;
const { readRegistry, sharedIdOf } = await import("./store");
const { approve, defHashOf } = await import("./trust");
const links = await import("../preview-links");
const { keptPreview } = await import("../preview-kept");
const { previewDialable } = await import("../share/preview-proxy");
const { sensitivePortRefusal } = await import("./sensitive");
const { endpointAnswers, linksOf } = await import("./share");
const { renderResult } = await import("./tools");

const op: Caller = { kind: "operator" };
// Below the kernel's ephemeral range (32768+), where any outgoing connection on the box can hold a port.
const BASE = await reservePorts(50);
const PORTS = { web: BASE, site: BASE + 20, db: BASE + 40 };
const PID = "prj_sharetst";

const DEF = {
  version: 1,
  services: {
    db: { cmd: ["node", "db.mjs"], scope: "shared", ports: { tcp: { fixed: PORTS.db } } },
    web: { cmd: ["node", "web.mjs"], ports: { http: { base: PORTS.web }, admin: { base: PORTS.web + 10 } }, ready: { http: "http", timeout: 20 } },
    site: { static: "public", ports: { http: { base: PORTS.site } } },
  },
  share: { endpoints: ["web.http", "site.http"], maxDays: 5 },
};
const FILES: Record<string, string> = {
  "db.mjs": `import { createServer } from "node:net"; createServer((s) => s.end()).listen(Number(process.env.SOVA_PORT_TCP), "127.0.0.1");`,
  // Every declared port listens (§app.project-services/contract): admin too, though it is never shared.
  "web.mjs": `import { createServer } from "node:http"; createServer((q, r) => r.end("web")).listen(Number(process.env.SOVA_PORT_HTTP), "127.0.0.1"); createServer((q, r) => r.end("admin")).listen(Number(process.env.SOVA_PORT_ADMIN), "127.0.0.1");`,
  "public/index.html": "<h1>site</h1>",
};

let parent = "";
let project = "";
let registered: string | null = PID;
const engine = new ProjectEngine({ driver: new DetachedDriver(3_000), pollMs: 100, projectIdOf: async () => registered, sovaPorts: async () => new Set<number>() });
const git = (args: string[], cwd = project) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const shaped = (r: VerbResult) => {
  assert.ok(isVerbResult(r), `result shape: ${JSON.stringify(r).slice(0, 400)}`);
  return r;
};
const write = (def: unknown) => writeFileSync(join(project, ".sova", "project.json"), JSON.stringify(def, null, 2));
const approveNow = (dir = project) => {
  const h = defHashOf(parseDefinition(JSON.stringify(DEF)));
  approve(dir, h, h);
};

before(() => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), "sova-share-proj-")));
  project = join(parent, "demo");
  mkdirSync(join(project, ".sova"), { recursive: true });
  mkdirSync(join(project, "public"));
  for (const [f, body] of Object.entries(FILES)) writeFileSync(join(project, f), body);
  write(DEF);
  git(["init", "-q", "-b", "main"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "fixture"]);
  approveNow();
});

after(async () => {
  for (const i of readRegistry().instances) if (i.slot !== 0) await engine.run("teardown", { instance: i.id, confirm: true }, op);
  for (const s of staticServes()) await stopStaticServe(s.id);
  await engine.driver.stop(engine.unitOf(sharedIdOf(project), "db"));
  rmSync(parent, { recursive: true, force: true });
  rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true });
});

let a: VerbResult;

test("a running copy's endpoints answer the share's dial; a static copy's link dials only while its own serve holds the port", async () => {
  a = shaped(await engine.run("create", { project, branch: "sova/a" }, op));
  const stopped = shaped(await engine.run("share", { instance: a.instance, endpoint: "web.http", confirm: true }, op));
  assert.match(stopped.error?.message ?? "", /isn't running web: start it first/);
  assert.equal(shaped(await engine.run("up", { instance: a.instance }, op)).ok, true);
  const web = shaped(await engine.run("share", { instance: a.instance, endpoint: "web.http", confirm: true }, op));
  assert.equal(web.ok, true, JSON.stringify(web.error));
  const made = shaped(await engine.run("share", { instance: a.instance, endpoint: "site.http" }, { kind: "project-overseer", id: "po1", root: project, act: async () => undefined }));
  assert.equal(made.ok, true, JSON.stringify(made.error));
  assert.deepEqual(keptPreview(made.links[0]!.id)?.target, { kind: "instance", instance: a.instance, endpoint: "site.http", generation: 1, serve: engine.unitOf(a.instance!, "site") });
  const site = linksOf(a.instance!).find((l) => l.endpoint === "site.http")!;
  const record = links.listPreviews({}).find((v) => v.id === site.id)! as unknown as Parameters<typeof previewDialable>[0];
  assert.equal(previewDialable(record), true);
  await stopStaticServe(engine.unitOf(a.instance!, "site"));
  assert.equal(previewDialable(record), false);
  assert.equal(shaped(await engine.run("up", { instance: a.instance }, op)).ok, true);
  assert.equal(previewDialable(record), true);
});

test("conform's share-endpoint check: an answer below 500 through the proxy's request path; a 5xx, nothing listening or a Sova port fails", async () => {
  const { createServer } = await import("node:http");
  const serve = (handler: (res: import("node:http").ServerResponse) => void) =>
    new Promise<{ port: number; close: () => Promise<void> }>((ok) => {
      const srv = createServer((_q, res) => handler(res));
      srv.listen(0, "127.0.0.1", () => ok({ port: (srv.address() as { port: number }).port, close: () => new Promise((d) => srv.close(() => d())) }));
    });
  const good = await serve((res) => res.end("hi"));
  const bad = await serve((res) => ((res.statusCode = 500), res.end()));
  const sova = await serve((res) => (res.setHeader("X-Sova-Server", "1"), res.end("sova")));
  try {
    assert.deepEqual(await endpointAnswers(good.port), { ok: true, detail: "GET / through the preview proxy answered 200" });
    assert.equal((await endpointAnswers(bad.port)).ok, false);
    assert.deepEqual(await endpointAnswers(sova.port), { ok: false, detail: "GET / through the preview proxy answered 502" });
  } finally {
    await Promise.all([good.close(), bad.close(), sova.close()]);
  }
  assert.equal((await endpointAnswers(good.port)).ok, false, "nothing listens any more");
});
