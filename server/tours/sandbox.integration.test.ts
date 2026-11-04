import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { tourScriptFixture } from "../../shared/tour-fixtures";
import { assertTourBrowserTempPath, discoverTourBrowser } from "./browser";
import { macConfinedBrowserSkip } from "./mac-browser.integration.fixture";
import { runTourAttempt } from "./runner";
import { spawnTourCommand, killTourChild, type TourRecordingContext } from "./sandbox";
import { TourCaptureFailure } from "./targets";

const fixture = resolve(import.meta.dirname, "sandbox-probe.integration.fixture.ts");
const macSkip = macConfinedBrowserSkip();
if (macSkip) console.warn(`sandbox.integration: SKIPPED: ${macSkip}`);

async function probe(context: TourRecordingContext, executable: string, url: string, mode: string): Promise<string> {
  const handle = await spawnTourCommand(context, [process.execPath, fixture, executable, url, mode]);
  let output = "";
  let errors = "";
  handle.process.stdout!.on("data", (b) => { output += String(b); });
  handle.process.stderr!.on("data", (b) => { errors += String(b); });
  const timeout = setTimeout(() => killTourChild(handle.process, "SIGKILL"), 30_000);
  try {
    const [code] = await once(handle.process, "exit");
    assert.equal(code, 0, `controller failed before a containment verdict: ${errors}\n${output}`);
    assert.match(output, /browser-ready/, "a failed browser launch must not count as containment");
    return output;
  } finally {
    clearTimeout(timeout);
    killTourChild(handle.process, "SIGKILL");
    await handle.dispose();
  }
}

test("b1: real recording browser cannot reach a non-allowlisted loopback port, including redirects and subresources", { timeout: 120_000, skip: macSkip }, async () => {
  // The backend's write probe must target a real read-only host path, not a path under /tmp
  // that the sandbox intentionally remaps to its writable private tmp. Keep this fixture and
  // its isolated HOME outside /tmp. This test registers no project/repository.
  const cache = resolve(import.meta.dirname, "../../.cache/guided-tours/recorder");
  mkdirSync(cache, { recursive: true });
  const root = realpathSync(mkdtempSync(join(cache, "containment-")));
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  const agentDir = join(root, "agent");
  const cwd = join(root, "checkout");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(agentDir, "sandbox-policy", process.platform), { recursive: true });
  const policy = JSON.parse(readFileSync(resolve(import.meta.dirname, `../../pi-config/sandbox-policy/${process.platform}/policy.json`), "utf8"));
  policy.proxy.allow = ["tour-probe.invalid"];
  policy.writable = [];
  policy.shadowed = [];
  // macOS: the headless shell's Seatbelt rules, so the confined recorder can run it (§chat.sandbox/what-on-enforces).
  if (process.platform === "darwin") policy.browser = "headless-shell";
  writeFileSync(join(agentDir, "sandbox-policy", process.platform, "policy.json"), JSON.stringify(policy));
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.end("<h1>Private loopback page</h1>"); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/private`;
  const context: TourRecordingContext = { sessionId: "containment", sessionFile: join(agentDir, "session.jsonl"), cwd, agentDir, home: root, sandbox: { on: false } };
  try {
    const executable = discoverTourBrowser();
    const positive = await probe(context, executable, url, "navigation");
    assert.match(positive, /"refused":false/, "positive control must really reach the test page");
    assert.ok(requests > 0, "request counter must distinguish a broken confinement boundary");
    for (const mode of ["navigation", "redirect", "subresource"]) {
      requests = 0;
      const output = await probe({ ...context, sandbox: { on: true } }, executable, url, mode);
      assert.match(output, /"refused":true/, mode);
      assert.equal(requests, 0, `${mode}: the loopback server must receive no request at all`);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    rmSync(root, { recursive: true, force: true });
  }
});

// b1 again, through the production recorder: a real tour script, runTourAttempt and the trusted
// TourRuntime path. The probe above proves the OS boundary; these prove the recorder actually uses it.
async function confinedFixture() {
  const cache = resolve(import.meta.dirname, "../../.cache/guided-tours/recorder");
  mkdirSync(cache, { recursive: true });
  const root = realpathSync(mkdtempSync(join(cache, "tour-b1-")));
  const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  const agentDir = join(root, "agent"), cwd = join(root, "checkout");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(agentDir, "sandbox-policy", process.platform), { recursive: true });
  const policy = JSON.parse(readFileSync(resolve(import.meta.dirname, `../../pi-config/sandbox-policy/${process.platform}/policy.json`), "utf8"));
  policy.proxy.allow = ["tour-probe.invalid"];
  policy.writable = [];
  policy.shadowed = [];
  // macOS: the headless shell's Seatbelt rules, so the confined recorder can run it (§chat.sandbox/what-on-enforces).
  if (process.platform === "darwin") policy.browser = "headless-shell";
  writeFileSync(join(agentDir, "sandbox-policy", process.platform, "policy.json"), JSON.stringify(policy));
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let requests = 0, connections = 0;
  const page = "<!doctype html><html><body><main><h1>Saved drafts</h1><p>Made-up private loopback page.</p></main></body></html>";
  const server = createServer((_req, res) => { requests++; res.setHeader("content-type", "text/html"); res.end(page); });
  server.on("connection", () => { connections++; });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const script = tourScriptFixture();
  script.source = { kind: "site", origin };
  const view = script.steps[0]!.views[0]!;
  if (view.kind !== "page") throw new Error("fixture");
  view.route = "/private";
  return {
    root, agentDir, cwd, origin, script,
    counts: () => ({ requests, connections }),
    reset: () => { requests = 0; connections = 0; },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// macOS's default temp folders are too long for Chromium's sockets, confined or not, whatever the session id.
test("macOS: a recording's temp folder is its own, short enough for Chromium's sockets and its proxy's, and goes with the attempt", { timeout: 60_000, skip: process.platform !== "darwin" ? "macOS only" : false }, async () => {
  const f = await confinedFixture();
  const context: TourRecordingContext = { sessionId: "01a1a2df-ab7d-7770-b24b-4c3a8387f7a2", sessionFile: join(f.agentDir, "session.jsonl"), cwd: f.cwd, agentDir: f.agentDir, home: f.root, sandbox: { on: false } };
  try {
    for (const on of [false, true]) {
      const handle = await spawnTourCommand({ ...context, sandbox: { on } }, [process.execPath, "-e", "process.stdout.write(JSON.stringify({ tmp: process.env.TMPDIR, proxy: process.env.HTTP_PROXY }))"]);
      let output = "";
      handle.process.stdout!.on("data", (b) => { output += String(b); });
      const [code] = await once(handle.process, "close"); // close, not exit: all of its output has arrived
      assert.equal(code, 0, `sandbox ${on ? "on" : "off"}`);
      const { tmp, proxy } = JSON.parse(output) as { tmp: string; proxy?: string };
      assert.match(tmp, /^(\/private)?\/tmp\/st-/, `sandbox ${on ? "on" : "off"}: ${tmp}`);
      // A proxy socket that doesn't fit would mean no network, silently, and every b1 tour above still passes.
      if (on) assert.match(proxy ?? "", /^http:\/\/127\.0\.0\.1:\d+$/, "the confined attempt really has its proxy, whatever TMPDIR is");
      assert.ok(Buffer.byteLength(assertTourBrowserTempPath(tmp)) <= 100);
      assert.ok(existsSync(tmp), "the attempt's temp folder is really there");
      await handle.dispose();
      assert.ok(!existsSync(tmp.replace(/\/t\/?$/, "")), "and goes with the attempt");
    }
  } finally { await f.close(); }
});

test("b1: a tour recorded with the chat's sandbox on cannot reach a non-allowlisted loopback port", { timeout: 120_000, skip: macSkip }, async () => {
  const f = await confinedFixture();
  const context: TourRecordingContext = { sessionId: "containment-tour", sessionFile: join(f.agentDir, "session.jsonl"), cwd: f.cwd, agentDir: f.agentDir, home: f.root, sandbox: { on: false } };
  const attempt = (sandbox: TourRecordingContext["sandbox"], progress: string[]) => runTourAttempt({
    context: { ...context, sandbox }, script: f.script, tourId: "containment-tour", editionId: "containment-edition", dryRun: true,
    beforeContact: async () => {}, onProgress: (p) => { if (p.stepId) progress.push(p.stepId); },
  });
  try {
    // Positive control: the same script, unconfined, really reaches the page.
    const open: string[] = [];
    await attempt({ on: false }, open);
    assert.ok(f.counts().requests > 0, "the request counter must distinguish an unconfined recorder");
    assert.ok(open.includes("find-draft"));
    f.reset();
    const confined: string[] = [];
    await assert.rejects(() => attempt({ on: true }, confined), (error: unknown) =>
      // A failed browser launch has no step: only an attempt that really navigated counts as containment.
      error instanceof TourCaptureFailure && error.failure.stepId === "find-draft" && !/could not launch/.test(error.message));
    assert.ok(confined.includes("find-draft"), "the confined browser launched and reached the step");
    assert.deepEqual(f.counts(), { requests: 0, connections: 0 }, "the loopback server receives no request and no connection");
  } finally { await f.close(); }
});

// Q1: with the chat's sandbox on, the attempt's own proxy admits exactly this attempt's verified running
// copy (one loopback host:port, re-checked on every contact); any other loopback port stays unreachable.
test("sandbox on: a project tour reaches its own verified running copy through the attempt proxy; another loopback port gets nothing", { timeout: 180_000, skip: macSkip }, async () => {
  const f = await confinedFixture();
  let other = 0, otherConnections = 0, own = 0, changed = false;
  const otherServer = createServer((_req, res) => { other++; res.end("x"); });
  otherServer.on("connection", () => { otherConnections++; });
  otherServer.listen(0, "127.0.0.1"); await once(otherServer, "listening");
  const otherOrigin = `http://127.0.0.1:${(otherServer.address() as { port: number }).port}`;
  const ownServer = createServer((_req, res) => { own++; res.setHeader("content-type", "text/html"); res.end(`<!doctype html><html><body><main><h1>Saved drafts</h1><p>Made-up page of this checkout's own copy.</p><img alt="" src="${otherOrigin}/pixel.png"></main></body></html>`); });
  ownServer.listen(0, "127.0.0.1"); await once(ownServer, "listening");
  const ownOrigin = `http://127.0.0.1:${(ownServer.address() as { port: number }).port}`;
  const script = structuredClone(f.script);
  script.source = { kind: "project", projectId: "project", instanceId: "copy-a", checkout: f.cwd, serviceId: "web", endpoint: "http" };
  // Stands in for the registry resolver: the copy's live endpoint, and its identity re-check.
  const target = async () => ({ origin: ownOrigin, generation: 1, assertCurrent: async () => { if (changed) throw new TourCaptureFailure({ message: "This running copy changed during recording.", guidance: "Retry against the same copy." }); } });
  const context: TourRecordingContext = { sessionId: "own-copy-tour", sessionFile: join(f.agentDir, "session.jsonl"), cwd: f.cwd, agentDir: f.agentDir, home: f.root, sandbox: { on: false } };
  const attempt = (on: boolean) => runTourAttempt({ context: { ...context, sandbox: { on } }, script, tourId: "own-copy-tour", editionId: "own-copy-edition", dryRun: true, target, beforeContact: async () => {} });
  try {
    // Positive control: unconfined, the page really loads its other-port picture.
    await attempt(false);
    assert.ok(own > 0 && other > 0, `positive control: own ${own}, other ${other}`);
    own = 0; other = 0; otherConnections = 0;
    const confined = await attempt(true);
    assert.ok(own > 0, "the confined recorder reached its own running copy through the attempt proxy");
    assert.deepEqual(confined.provenance.publicOrigins, [], "proxy mode attests nothing");
    assert.deepEqual({ other, otherConnections }, { other: 0, otherConnections: 0 }, "another loopback port receives no request and no connection");
    // The copy's identity changes (B took the port): the next attempt is refused before any page request.
    own = 0; changed = true;
    await assert.rejects(() => attempt(true));
    assert.equal(own, 0, "a changed copy receives no request");
  } finally {
    for (const s of [ownServer, otherServer]) { s.closeAllConnections(); await new Promise<void>((done) => s.close(() => done())); }
    await f.close();
  }
});
