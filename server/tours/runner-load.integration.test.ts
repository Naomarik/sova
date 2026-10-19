import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tourScriptFixture } from "../../shared/tour-fixtures";
import { hostPortOwner } from "../project-services/proctable";
import { parseDefinition } from "../../shared/project-contract";
import { resolveTourTarget } from "../project-services/tour-target";
import type { InstanceRecord, Registry } from "../project-services/store";
import { runTourAttempt, type TourAttemptOptions } from "./runner";
import type { TourRecordingContext } from "./sandbox";

// A project tour of a built app, as the Sova-copy run met it: a page that loads many scripts from a
// running copy in ANOTHER process, through the attempt's own proxy (sandbox off). A project source's
// identity check scans this host's processes synchronously (proctable); run once per contact, page
// requests and proxy connections each, it held the server's event loop, its in-process proxy
// included, past the page's 15 s load deadline (the copy then sat in SYN-RECV: dialled, never sent a
// byte). Stood in here by a check that blocks the loop for a fixed time.
const SCRIPTS = 40;

async function copyProcess() {
  const script = `const http = require("node:http");
const s = http.createServer((q, r) => {
  const p = new URL(q.url, "http://x").pathname;
  if (p.startsWith("/m/")) { r.setHeader("content-type", "text/javascript"); r.end("export const ok = 1;"); return; }
  r.setHeader("content-type", "text/html");
  r.end("<!doctype html><html><head>" + Array.from({ length: ${SCRIPTS} }, (_, i) => '<script type="module" src="/m/' + i + '.js"></script>').join("") + "</head><body><main><h1>Saved drafts</h1></main></body></html>");
});
s.listen(0, "127.0.0.1", () => console.log(s.address().port));`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<number>((ok, fail) => { child.stdout!.once("data", (b: Buffer) => ok(Number(b.toString().trim()))); child.once("error", fail); child.once("exit", () => fail(new Error("the copy stand-in exited"))); });
  return { origin: `http://127.0.0.1:${port}`, port, pid: child.pid!, close: () => { child.kill("SIGKILL"); } };
}

// One recording of the page, dry run: both sizes, every request and proxy connection checked by the
// given identity check. Resolves with the outcome rather than throwing, so a failure names its cause.
type Copy = Awaited<ReturnType<typeof copyProcess>>;
async function record(copy: Copy, root: string, assertCurrent: () => Promise<void>, target?: TourAttemptOptions["target"]) {
  const context: TourRecordingContext = { sessionId: "load", sessionFile: join(root, "chat.jsonl"), cwd: root, agentDir: join(root, "agent"), sandbox: { on: false } };
  const script = tourScriptFixture();
  script.source = { kind: "project", projectId: "sova", instanceId: "copy-s", checkout: root, serviceId: "server", endpoint: "http" };
  const view = script.steps[0]!.views[0]!;
  if (view.kind !== "page") throw new Error("fixture");
  view.route = "/";
  const started = performance.now();
  const outcome = await runTourAttempt({
    context, script, tourId: "load", editionId: "load-edition", dryRun: true, beforeContact: async () => {},
    target: target ?? (async () => ({ origin: copy.origin, generation: 1, assertCurrent })),
  }).then(() => "recorded", (e: unknown) => `failed: ${e instanceof Error ? e.message : String(e)}`);
  return { outcome, ms: Math.round(performance.now() - started) };
}

async function withCopy(run: (copy: Copy, root: string) => Promise<void>) {
  const copy = await copyProcess();
  const root = mkdtempSync(join(tmpdir(), "tour-load-"));
  try { await run(copy, root); } finally { copy.close(); rmSync(root, { recursive: true, force: true }); }
}

// Positive control: the same page, a cheap check. Passes with or without shared checks, so a failure
// of the next test is the blocking check, not this page, the proxy or the copy.
test("control: the same page with a cheap identity check records through the proxy", { timeout: 180_000 }, async () => {
  await withCopy(async (copy, root) => {
    let checks = 0;
    const { outcome, ms } = await record(copy, root, async () => { checks++; });
    console.log(`[runner-load] control: ${outcome} in ${ms} ms with ${checks} identity checks`);
    assert.equal(outcome, "recorded");
  });
});

// A blocking stand-in for the old per-contact host scan (200 ms; the real one took ~650 ms). On HEAD,
// every contact ran its own (~89 per size: 17.8 s) and the page missed its 15 s load deadline (a goto
// timeout); shared, ~48 per size (9.6 s) fit inside it. A check that
// blocks finishes before it yields, so no caller ever finds one running to share: this case proves
// the hang fixed (records within the goto budget), not the sharing bound, which the async case holds.
test("a project page with many scripts records through the proxy while its identity check blocks the server", { timeout: 180_000 }, async () => {
  await withCopy(async (copy, root) => {
    // What the old whole-host scan costs on this host (logged, not asserted: host-dependent).
    const t = performance.now(); hostPortOwner(copy.port);
    console.log(`[runner-load] one real port-owner host scan took ${Math.round(performance.now() - t)} ms`);
    let checks = 0;
    const block = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* a synchronous scan */ } };
    const { outcome, ms } = await record(copy, root, async () => { checks++; block(200); });
    console.log(`[runner-load] blocking check: ${outcome} in ${ms} ms with ${checks} identity checks`);
    assert.equal(outcome, "recorded");
  });
});

// A slow check that yields (the shape of the real one now): a burst of contacts shares it.
test("a slow asynchronous identity check is shared across a burst of contacts", { timeout: 180_000 }, async () => {
  await withCopy(async (copy, root) => {
    let checks = 0;
    const { outcome, ms } = await record(copy, root, async () => { checks++; await new Promise(r => setTimeout(r, 250)); });
    console.log(`[runner-load] async 250 ms check: ${outcome} in ${ms} ms with ${checks} identity checks`);
    assert.equal(outcome, "recorded");
    // Each size loads 1 page + ${SCRIPTS} scripts, each a checked request and a proxy connection.
    assert.ok(checks < 2 * (SCRIPTS + 1), `identity checks are shared across a burst of contacts (${checks})`);
  });
});

// The real check, no stand-in: resolveTourTarget's Linux probe against the copy process's own pid
// (registry, definition and driver stubbed; the driver names the real pid). Discovery once, then a
// live socket re-verify at every contact. The event loop's worst drift is sampled for the whole run.
test("the real identity check records the page quickly without holding the event loop", { timeout: 180_000, skip: process.platform !== "linux" && "the probe is Linux only" }, async () => {
  await withCopy(async (copy, root) => {
    const checkout = realpathSync(root);
    const rec: InstanceRecord = { id: "copy-s", project: checkout, checkout, branch: "s", slot: 1, generation: 1, createdBy: "operator", createdAt: new Date().toISOString(), cutWorktree: false, desired: { server: "running" }, prints: {}, data: {}, ports: { server: { http: copy.port } } };
    const registry: Registry = { version: 1, instances: [rec], shared: [] };
    const deps = {
      registry: () => registry, projectRoot: () => checkout, unitOf: (id: string, s: string) => `${id}-${s}`,
      definition: () => parseDefinition(JSON.stringify({ version: 1, services: { server: { cmd: ["server"], ports: { http: { base: copy.port } } } } })),
      driver: { status: async () => ({ state: "active" as const, pid: copy.pid }), owns: (_u: string, pid: number) => pid === copy.pid },
    };
    let drift = 0, last = performance.now();
    const sampler = setInterval(() => { const now = performance.now(); drift = Math.max(drift, now - last - 10); last = now; }, 10);
    try {
      let checks = 0, checkMs = 0, discoveries = 0, discoveryMs = 0;
      const target: TourAttemptOptions["target"] = async source => {
        const t0 = performance.now();
        const resolved = await resolveTourTarget(source, deps);
        discoveries++; discoveryMs += performance.now() - t0;
        return { ...resolved, assertCurrent: async () => { const t = performance.now(); try { await resolved.assertCurrent(); } finally { checks++; checkMs += performance.now() - t; } } };
      };
      const { outcome, ms } = await record(copy, checkout, async () => {}, target);
      console.log(`[runner-load] real check: ${outcome} in ${ms} ms; ${discoveries} discovery ${Math.round(discoveryMs / Math.max(discoveries, 1))} ms; ${checks} re-verifies, ${(checkMs / Math.max(checks, 1)).toFixed(1)} ms each; worst event-loop drift ${Math.round(drift)} ms`);
      assert.equal(outcome, "recorded");
      assert.ok(ms < 5_000, `records in under 5 s (${ms} ms)`);
      assert.ok(drift < 100, `the event loop is never held 100 ms or more (${Math.round(drift)} ms)`);
    } finally { clearInterval(sampler); }
  });
});
