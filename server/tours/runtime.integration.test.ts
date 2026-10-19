import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { tourScriptFixture } from "../../shared/tour-fixtures";
import { normalizeTourCardDetails, RECORD_TOUR_TOOL, SHOW_TOUR_TOOL } from "../../shared/tour";
import type { ToolResult } from "../../shared/harness";
import { createSessionFile } from "../harness/pi/state";
import { MODE, SANDBOX } from "../harness/state-kinds";
import { scratchRoot } from "../test-scratch";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// No model prompt, injected runtime, context resolver, queue, runner, browser or edition store.
// Only the explained UI is a deterministic, short-lived local HTTP fixture.
test("served tour tools record, inspect, check and show a real installed-browser edition from their owning file context", { timeout: 120_000 }, async () => {
  const root = scratchRoot("tour-served-flow-");
  const envNames = ["PI_CODING_AGENT_DIR", "SOVA_AUTH", "SOVA_TOKEN", "HOST", "SOVA_ALLOWED_HOSTS", "SOVA_ALLOWED_ORIGINS"];
  const previous = new Map(envNames.map(name => [name, process.env[name]]));
  const agent = join(root, "agent"), cwd = join(root, "checkout"), sessions = join(agent, "sessions");
  mkdirSync(cwd, { recursive: true }); mkdirSync(sessions, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agent;
  for (const name of envNames.slice(1)) delete process.env[name];
  const heldRequest = deferred(), heldSocketClosed = deferred();
  let requests = 0, writes = 0;
  const server = createServer((req, res) => {
    requests++;
    if (req.method !== "GET") writes++;
    if (req.url === "/hold") {
      res.once("close", heldSocketClosed.resolve);
      heldRequest.resolve(); // Only a real browser navigation can reach this barrier.
      return; // No response until cancellation closes the browser's socket.
    }
    res.setHeader("content-type", "text/html");
    res.end("<!doctype html><html><head><style>body{margin:24px;font:18px sans-serif}main{max-width:40em}h1{font-size:30px}</style></head><body><main><h1>Saved drafts</h1><p>A made-up review draft waits here. Nothing has been sent.</p></main></body></html>");
  });
  let runtime: import("./runtime").TourRuntime | undefined;
  let mainServer: Server | undefined, sessionId: string | undefined;
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const session = createSessionFile({ cwd, sessionsDir: sessions, seed: [
      [SANDBOX, { version: 1, on: false, level: "workspace-write", enforcement: "none", backend: "none" }],
      [MODE, { active: { version: 1, mode: "normal", strict: false, minorModes: ["vis"] } }],
    ] });
    sessionId = session.id;
    const { deliverServerToolCall, fileSnapshot, servedToolsFor, setChatRouter } = await import("../chat-handle");
    // Stands in for the process holding this chat: recording follows the sandbox state it reports.
    setChatRouter({
      ready: async () => {}, all: () => [], acquire: async () => { throw new Error("not in this test"); }, close: async () => false,
      get: (path: string) => path === session.path ? ({ mirror: { cwd }, sandboxInfo: async () => ({ on: false, state: "subagents", enforcement: "none", status: "Sandbox subagents only" }) } as unknown as import("../chat-handle").ChatHandle) : undefined,
    });
    const { ensureTourToolRuntime } = await import("./runtime");
    runtime = ensureTourToolRuntime();
    const service = runtime;
    service.approvals.approve(origin);
    const declarations = servedToolsFor(session.path, session.id, () => "Tour integration fixture");
    assert.ok(declarations.some(d => d.name === RECORD_TOUR_TOOL));
    assert.ok(declarations.some(d => d.name === SHOW_TOUR_TOOL));
    const snapshot = await fileSnapshot(session.path, { sessionId: session.id });
    assert.equal(snapshot.ctx.cwd, cwd);
    assert.equal(snapshot.ctx.state().latest(SANDBOX)?.data.on, false);
    assert.deepEqual(snapshot.ctx.state().latest(MODE)?.data.active.minorModes, ["vis"]);
    const call = async (name: string, params: unknown) => {
      const id = randomUUID();
      return deliverServerToolCall({ effectId: id, chatId: session.path, toolCallId: id, name, params, attended: true, card: null }, {
        signal: undefined, onUpdate: undefined, ctx: snapshot.ctx,
        chat: { branch: () => snapshot.ctx.branch(), entries: snapshot.entries, append: async () => { throw new Error("This tour flow must not modify the transcript."); }, tool: () => undefined },
      });
    };
    const success = async (name: string, params: unknown): Promise<ToolResult> => {
      const outcome = await call(name, params);
      assert.equal(outcome.ok, true, JSON.stringify(outcome));
      if (!outcome.ok) throw new Error("The served tour call failed.");
      return outcome.result;
    };
    const wait = async (id: string) => {
      await service.queue.waitForSessionIdle(session.id);
      const job = service.queue.get(session.id, id);
      assert.equal(job?.phase, "checking", JSON.stringify(job));
    };
    const script = tourScriptFixture(); script.source = { kind: "site", origin };
    const view = script.steps[0]!.views[0]!;
    assert.equal(view.kind, "page"); if (view.kind !== "page") throw new Error("Fixture view");
    view.route = "/";
    // Where the time goes, if this ever stalls.
    // A passing file prints one line under run-tests, so the lines also go to .cache/runtime-integration-phases.txt.
    const phasesFile = resolve(import.meta.dirname, "../../.cache/runtime-integration-phases.txt");
    mkdirSync(dirname(phasesFile), { recursive: true }); writeFileSync(phasesFile, "");
    const t0 = Date.now(); const phase = (name: string) => { const line = `[runtime.integration] ${name} at ${Date.now() - t0} ms`; console.log(line); appendFileSync(phasesFile, `${line}\n`); };
    phase("dry run");
    const dry = normalizeTourCardDetails((await success(RECORD_TOUR_TOOL, { op: "dry-run", script, tourId: "served-tour" })).details)!;
    assert.ok(dry.jobId); await wait(dry.jobId!);
    assert.equal(service.artifacts.read(session.id, dry.jobId!)?.dryRunPassed, true);
    assert.equal(service.store.latestEdition(session.id, "served-tour"), null);
    phase("record");
    const capture = normalizeTourCardDetails((await success(RECORD_TOUR_TOOL, { op: "record", dryRunId: dry.jobId })).details)!;
    assert.ok(capture.jobId); await wait(capture.jobId!);
    assert.equal((await call(SHOW_TOUR_TOOL, { tourId: "served-tour" })).ok, false, "staging is never shown as an edition");
    const premature = await call(RECORD_TOUR_TOOL, { op: "check", jobId: capture.jobId, verification: { overviewReviewed: true, suspiciousCapturesReviewed: [], notes: "No inspection receipts yet." } });
    assert.equal(premature.ok, false, "a claimed review without returned pictures is not a receipt");
    if (!premature.ok) assert.match(premature.error.message, /Inspect every overview/);
    const inspection = await success(RECORD_TOUR_TOOL, { op: "inspect", jobId: capture.jobId });
    const reportBlock = inspection.content[0]; assert.equal(reportBlock?.type, "text");
    if (reportBlock?.type !== "text") throw new Error("Missing recording report");
    const report = JSON.parse(reportBlock.text) as { contactSheets: string[]; suspicious: string[]; captures: string[] };
    assert.equal(report.contactSheets.length, 1); assert.equal(report.captures.length, 2);
    assert.equal(inspection.content.filter(c => c.type === "image").length, report.contactSheets.length);
    for (const file of report.suspicious) {
      const closeup = await success(RECORD_TOUR_TOOL, { op: "inspect", jobId: capture.jobId, capture: file });
      assert.equal(closeup.content.filter(c => c.type === "image").length, 1);
    }
    // Check actual returned capture bytes too, not merely tool/card text or an invented image name.
    const attempt = service.artifacts.read(session.id, capture.jobId!)!;
    for (const size of ["desktop", "phone"] as const) {
      const image = attempt.manifest!.steps[0]!.views[0]!.captures[size]!.image;
      const bytes: Buffer = service.artifacts.readImage(session.id, capture.jobId!, image)!;
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(bytes.readUInt32BE(16), size === "desktop" ? 1440 : 390);
      assert.equal(bytes.readUInt32BE(20), size === "desktop" ? 960 : 844);
    }
    phase("check");
    const ready = normalizeTourCardDetails((await success(RECORD_TOUR_TOOL, { op: "check", jobId: capture.jobId, verification: {
      overviewReviewed: true, suspiciousCapturesReviewed: report.suspicious,
      notes: "Deterministic fixture checker received every overview and suspicious closeup; both actual PNG viewport dimensions were verified.",
    } })).details)!;
    assert.equal(ready.status, "ready"); assert.ok(ready.editionId);
    const shown = normalizeTourCardDetails((await success(SHOW_TOUR_TOOL, { tourId: "served-tour", editionId: ready.editionId })).details)!;
    assert.equal(shown.editionId, ready.editionId);
    assert.equal(service.store.latestEdition(session.id, "served-tour")?.manifest.editionId, shown.editionId);
    assert.ok(requests >= 6, "the original dry run, launch dry run and capture each navigate both sizes");
    assert.equal(writes, 0);
    assert.ok(!JSON.stringify(shown).includes("contact-sheet"));

    // Exercise deletion through the assembled runtime while an actual child/browser is navigating.
    // This is additional evidence beyond the unit deferred-runner and direct-runner cancellation tests.
    const { buildApp } = await import("../app");
    const { getRequestListener } = await import("@hono/node-server");
    const { AUTH_COOKIE, initAuthToken, setAuthPort, setAuthHosts, sovaToken } = await import("../auth");
    const { removeSessionTours } = await import("./lifecycle");
    const { TourRuntime } = await import("./runtime");
    const { procfsTable } = await import("../project-services/proctable");
    const { app } = buildApp({ extensionEntriesOf: async () => [] });
    initAuthToken(); setAuthHosts(() => ({ own: [], peers: [] }));
    mainServer = createServer(getRequestListener(app.fetch));
    mainServer.listen(0, "127.0.0.1"); await once(mainServer, "listening");
    const mainPort = (mainServer.address() as { port: number }).port; setAuthPort(mainPort);
    const mainOrigin = `http://127.0.0.1:${mainPort}`;
    const ownerHeaders = { Cookie: `${AUTH_COOKIE}=${sovaToken()}`, Origin: mainOrigin, "Sec-Fetch-Site": "same-origin" };
    const editionRoute = `${mainOrigin}/api/tours/${session.id}/served-tour/editions/${ready.editionId}`;
    const readable = await fetch(editionRoute, { headers: ownerHeaders });
    assert.equal(readable.status, 200); await readable.arrayBuffer();
    const account = service.accounts.save({ origin, username: "fixture-reviewer", password: "fake-pw-18", testAccount: true });
    const heldScript = tourScriptFixture(); heldScript.source = { kind: "site", origin };
    const heldView = heldScript.steps[0]!.views[0]!;
    if (heldView.kind !== "page") throw new Error("Fixture view"); heldView.route = "/hold";
    phase("held recording");
    const held = normalizeTourCardDetails((await success(RECORD_TOUR_TOOL, { op: "dry-run", script: heldScript, tourId: "active-delete-tour" })).details)!;
    assert.ok(held.jobId); await heldRequest.promise;
    phase("held request reached the fixture");
    const observed = new Map<number, string>(), controllers = new Set<number>(); let temporary: string | undefined;
    if (process.platform === "linux") {
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const env = readFileSync(`/proc/${name}/environ`, "utf8").split("\0");
          if (!env.includes(`PI_SESSION_FILE=${session.path}`)) continue;
          const pid = Number(name), stamp = procfsTable.startOf(pid); if (!stamp) continue;
          observed.set(pid, stamp);
          if (readFileSync(`/proc/${name}/cmdline`, "utf8").includes("runner-child.ts")) controllers.add(pid);
          const tmp = env.find(v => v.startsWith("TMPDIR="))?.slice(7); if (tmp && /\/st-[^/]+$/.test(tmp)) temporary = tmp;
        } catch { /* an unrelated process exited during observation */ }
      }
      assert.ok(observed.size >= 2, "observe the actual controller and browser, not a job cancellation flag");
      assert.ok(controllers.size); assert.ok(temporary); assert.ok(existsSync(temporary));
    }
    const privateDir = join(service.artifacts.root, session.id);
    const jobFile = join(agent, "sova", "tour-jobs", `${held.jobId}.json`);
    const editionDir = join(service.store.root, session.id, "served-tour", "editions", ready.editionId!);
    assert.ok(existsSync(privateDir)); assert.ok(existsSync(jobFile)); assert.ok(existsSync(editionDir));
    let settledBeforeRemoval = false;
    // Register first so this observer sees the real task settlement BEFORE the queue's deletion waiter.
    const idle = service.queue.waitForSessionIdle(session.id).then(() => {
      settledBeforeRemoval = true;
      assert.ok(existsSync(privateDir), "private artifacts must remain until actual task cleanup settles");
      assert.ok(existsSync(jobFile), "job persistence must remain until actual task cleanup settles");
      assert.ok(existsSync(editionDir), "the previous checked edition remains until actual task cleanup settles");
      if (process.platform === "linux") {
        assert.equal(existsSync(temporary!), false, "the actual runner already disposed its browser/profile tree");
        for (const pid of controllers) assert.ok(procfsTable.startOf(pid) !== observed.get(pid) || procfsTable.get(pid)?.zombie, "the real recording controller has exited");
      }
    });
    unlinkSync(session.path);
    const deletion = removeSessionTours(session.id); // No await between irreversible unlink and default revocation/barrier.
    phase("deleting during the held recording");
    void idle.then(() => phase("task settled")); void deletion.then(() => phase("deletion done")); void heldSocketClosed.promise.then(() => phase("held socket closed"));
    await Promise.all([idle, deletion, heldSocketClosed.promise]);
    phase("held recording settled and removed");
    assert.equal(settledBeforeRemoval, true);
    assert.equal(existsSync(privateDir), false); assert.equal(existsSync(jobFile), false); assert.equal(existsSync(editionDir), false);
    assert.deepEqual(service.queue.list(session.id), []);
    assert.equal(service.approvals.isApproved(origin), true);
    assert.equal(service.accounts.resolve(account.id, origin)?.credentials().password, "fake-pw-18");
    if (process.platform === "linux") {
      for (let i = 0; i < 100 && [...observed].some(([pid, stamp]) => procfsTable.startOf(pid) === stamp && !procfsTable.get(pid)?.zombie); i++) await new Promise(resolve => setTimeout(resolve, 20));
      for (const [pid, stamp] of observed) assert.ok(procfsTable.startOf(pid) !== stamp || procfsTable.get(pid)?.zombie, "the recorded browser process tree stopped");
    }
    const gone = await fetch(editionRoute, { headers: ownerHeaders });
    assert.equal(gone.status, 404); await gone.arrayBuffer();
    const after = await call(RECORD_TOUR_TOOL, { op: "dry-run", script });
    assert.equal(after.ok, false); if (!after.ok) assert.match(after.error.message, /deleted/);
    const reopened = new TourRuntime({ root: join(agent, "sova") });
    try { await assert.rejects(reopened.show({ sessionId: session.id, sessionFile: session.path, cwd, state: snapshot.ctx.state() }, "served-tour"), /deleted/); }
    finally { reopened.close(); }
    assert.equal(existsSync(privateDir), false, "late responses and refused submissions cannot resurrect private state");
    assert.equal(writes, 0);
  } finally {
    (await import("../chat-handle")).setChatRouter(null);
    if (mainServer) { mainServer.closeAllConnections(); await new Promise<void>(resolve => mainServer!.close(() => resolve())); }
    runtime?.close(); if (runtime && sessionId) await runtime.queue.waitForSessionIdle(sessionId);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [name, value] of previous) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    rmSync(root, { recursive: true, force: true });
  }
});
