import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CONTRACT_FILE } from "../../shared/project-contract";
import type { TourSource } from "../../shared/tour";
import { tourEditionAssetsFixture, tourManifestFixture, tourScriptFixture } from "../../shared/tour-fixtures";
import { stateView } from "../harness/state-view";
import { scratchRoot } from "../test-scratch";
import { tourScriptDigest } from "../tours/checks";
import type { TourToolCaller } from "../tours/tools";
import { DetachedDriver } from "./drivers";
import { readRegistry, type InstanceRecord, type Registry } from "./store";
import { resolveTourTarget } from "./tour-target";

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
async function waitFile(file: string): Promise<void> {
  for (let n = 0; n < 150; n++) { if (existsSync(file)) return; await sleep(20); }
  throw new Error(`test service did not write ${file}`);
}

// Each server is a real supervised process. Its request counter is read from disk, never polled
// through HTTP (which could accidentally satisfy the zero-request assertion).
const serve = `const fs=require('node:fs');const http=require('node:http');let n=0;fs.writeFileSync(process.argv[2],'0');const s=http.createServer((q,r)=>{fs.writeFileSync(process.argv[2],String(++n));r.end('<h1>Test copy</h1>')});s.listen(Number(process.argv[3]),'127.0.0.1',()=>fs.writeFileSync(process.argv[1],String(s.address().port)));`;

test("b2: record A, stop A, reuse its port for B; re-record refuses and B receives zero requests", { timeout: 30_000 }, async () => {
  const root = scratchRoot("tour-source-");
  const a = join(root, "copy-a");
  const b = join(root, "copy-b");
  for (const cwd of [a, b]) {
    mkdirSync(join(cwd, ".sova"), { recursive: true });
    writeFileSync(join(cwd, CONTRACT_FILE), JSON.stringify({ version: 1, services: { web: { cmd: ["web"], ports: { http: { base: 8100 } } } } }));
  }
  const driver = new DetachedDriver(100, { restart: false, procsDir: () => join(root, "procs"), logsDir: () => join(root, "logs") });
  const registryFile = join(root, "registry.json");
  const portA = join(root, "a-port");
  const countA = join(root, "a-count");
  const countB = join(root, "b-count");
  const unitOf = (id: string, service: string) => `sova-tour-test-${id}-${service}`;
  const unitA = unitOf("copy-a", "web");
  const unitB = unitOf("copy-b", "web");
  try {
    await driver.start({ unit: unitA, argv: [process.execPath, "-e", serve, portA, countA, "0"], cwd: a, env: {} });
    await waitFile(portA);
    const port = Number(readFileSync(portA, "utf8"));
    const rec: InstanceRecord = { id: "copy-a", project: root, checkout: a, branch: "a", slot: 1, generation: 1, createdBy: "operator", createdAt: new Date().toISOString(), cutWorktree: false, desired: { web: "running" }, prints: {}, data: {}, ports: { web: { http: port } } };
    const registry: Registry = { version: 1, instances: [rec], shared: [] };
    const save = () => writeFileSync(registryFile, JSON.stringify(registry));
    save();
    const source: TourSource = { kind: "project", projectId: "project", instanceId: rec.id, checkout: a, serviceId: "web", endpoint: "http" };
    const deps = { registry: () => readRegistry(registryFile), projectRoot: () => root, driver, unitOf };
    const first = await resolveTourTarget(source, deps);
    await fetch(first.origin);
    assert.equal(readFileSync(countA, "utf8"), "1", "positive control recorded A's real server");
    await driver.stop(unitA);
    rec.desired.web = "stopped";
    registry.instances.push({ ...rec, id: "copy-b", checkout: b, desired: { web: "running" } });
    save();
    const portB = join(root, "b-port");
    await driver.start({ unit: unitB, argv: [process.execPath, "-e", serve, portB, countB, String(port)], cwd: b, env: {} });
    await waitFile(portB);
    assert.equal(Number(readFileSync(portB, "utf8")), port, "B must actually reuse A's old port");
    // This is the same resolve-before-navigation seam used for each recording/re-recording.
    await assert.rejects(async () => { const target = await resolveTourTarget(source, deps); await fetch(target.origin); }, /not running/);
    assert.equal(readFileSync(countB, "utf8"), "0");
    // A stale desired-running record must not fool it either: the listener belongs to B's unit.
    rec.desired.web = "running";
    save();
    await assert.rejects(async () => { const target = await resolveTourTarget(source, deps); await fetch(target.origin); }, /another process/);
    await assert.rejects(() => first.assertCurrent(), /another process/);
    assert.equal(readFileSync(countB, "utf8"), "0", "no navigation to the other copy is allowed");
    registry.instances = registry.instances.filter((r) => r.id !== "copy-a");
    save();
    await assert.rejects(() => resolveTourTarget(source, deps), /original running copy/);
  } finally {
    await driver.stop(unitA);
    await driver.stop(unitB);
    rmSync(root, { recursive: true, force: true });
  }
});

// The same b2 scenario through the production TourRuntime: its reRecord and its queued execute
// resolve the copy each time with the real resolver; nothing reuses the edition's old address.
test("b2: TourRuntime re-record and an already-queued recording refuse once A's port belongs to B", { timeout: 60_000 }, async () => {
  const { TourRuntime } = await import("../tours/runtime");
  const { TourJobQueue } = await import("../tours/queue");
  const root = scratchRoot("tour-source-runtime-");
  const a = join(root, "copy-a"), b = join(root, "copy-b");
  for (const cwd of [a, b]) {
    mkdirSync(join(cwd, ".sova"), { recursive: true });
    writeFileSync(join(cwd, CONTRACT_FILE), JSON.stringify({ version: 1, services: { web: { cmd: ["web"], ports: { http: { base: 8100 } } } } }));
  }
  const driver = new DetachedDriver(100, { restart: false, procsDir: () => join(root, "procs"), logsDir: () => join(root, "logs") });
  const registryFile = join(root, "registry.json");
  const unitOf = (id: string, service: string) => `sova-tour-rt-${id}-${service}`;
  const unitA = unitOf("copy-a", "web"), unitB = unitOf("copy-b", "web");
  const portA = join(root, "a-port"), countA = join(root, "a-count"), countB = join(root, "b-count");
  let runtime: InstanceType<typeof TourRuntime> | undefined;
  try {
    await driver.start({ unit: unitA, argv: [process.execPath, "-e", serve, portA, countA, "0"], cwd: a, env: {} });
    await waitFile(portA);
    const port = Number(readFileSync(portA, "utf8"));
    const rec: InstanceRecord = { id: "copy-a", project: root, checkout: a, branch: "a", slot: 1, generation: 1, createdBy: "operator", createdAt: new Date().toISOString(), cutWorktree: false, desired: { web: "running" }, prints: {}, data: {}, ports: { web: { http: port } } };
    const registry: Registry = { version: 1, instances: [rec], shared: [] };
    const save = () => writeFileSync(registryFile, JSON.stringify(registry));
    save();
    const deps = { registry: () => readRegistry(registryFile), projectRoot: () => root, driver, unitOf };
    const sandboxOff = stateView([{ kind: "state", id: "sandbox", parentId: null, key: "sandbox", data: { version: 1, on: false, level: "workspace-write", enforcement: "none", backend: "test" } }] as Parameters<typeof stateView>[0]);
    const caller: TourToolCaller = { sessionId: "chat-b2", sessionFile: join(root, "chat.jsonl"), cwd: "/forged", state: stateView([]) };
    let runs = 0;
    // Gate the single recording slot so a request can really wait in line.
    let release!: () => void;
    const slot = new Promise<void>((done) => { release = done; });
    const queue = new TourJobQueue({ root: join(root, "state", "tour-jobs"), limit: 1 });
    runtime = new TourRuntime({
      root: join(root, "state"), queue,
      context: { snapshot: async () => ({ sessionId: caller.sessionId, sessionFile: caller.sessionFile, cwd: a, agentDir: join(root, "agent"), state: sandboxOff, held: { on: false, enforcement: "none" } }), registry: deps.registry, projects: async () => [{ id: "project", root }] },
      target: (source) => resolveTourTarget(source, deps),
      // Stands in for the browser only: it contacts whatever the real resolver names at launch.
      run: async (input) => {
        runs++;
        const target = await resolveTourTarget(input.script.source, deps);
        await input.beforeContact(target.origin);
        await fetch(target.origin);
        const manifest = tourManifestFixture();
        return { steps: input.dryRun ? [] : manifest.steps, assets: input.dryRun ? new Map<string, Uint8Array>() : tourEditionAssetsFixture(), contactSheets: input.dryRun ? [] : manifest.check.contactSheets, suspicious: input.dryRun ? [] : ["phone.png"], provenance: { origin: target.origin, recordedAt: manifest.recordedAt, publicOrigins: [], ...(target.generation !== undefined ? { generation: target.generation } : {}) }, scriptDigest: tourScriptDigest(input.script) };
      },
    });
    const service = runtime;
    const settled = async (id: string) => {
      for (let i = 0; i < 600; i++) {
        const job = service.queue.get(caller.sessionId, id)!;
        if (["checking", "ready", "failed", "cancelled", "needs-site-approval", "needs-test-account", "interrupted"].includes(job.phase)) return job;
        await sleep(20);
      }
      throw new Error("job did not settle");
    };
    const script = tourScriptFixture();
    script.source = { kind: "project", projectId: "project", instanceId: rec.id, checkout: a, serviceId: "web", endpoint: "http" };
    // Positive control: record, check and publish an edition of copy A through the runtime.
    const dry = await service.dryRun(caller, script, "tour-b2");
    assert.equal((await settled(dry.job.id)).phase, "checking");
    const capture = await service.record(caller, dry.job.id);
    assert.equal((await settled(capture.job.id)).phase, "checking");
    await service.inspect(caller, capture.job.id);
    await service.inspect(caller, capture.job.id, "phone.png");
    const ready = await service.check(caller, capture.job.id, { overviewReviewed: true, suspiciousCapturesReviewed: ["phone.png"], notes: "Reviewed every overview cell and the suspicious phone picture." });
    assert.equal(ready.job.phase, "ready");
    assert.ok(Number(readFileSync(countA, "utf8")) >= 3, "positive control: A's real server received the recordings");

    // A request that waits in line while A still runs...
    const blocker = queue.enqueue({ sessionId: "other-chat", tourId: "blocker", title: "Occupies the only slot", total: 1 }, async () => { await slot; });
    const queued = await service.reRecord(caller, "tour-b2");
    assert.equal(queued.phase, "queued");
    const runsBefore = runs;
    // ...then A stops and B takes its port.
    await driver.stop(unitA);
    rec.desired.web = "stopped";
    registry.instances.push({ ...rec, id: "copy-b", checkout: b, desired: { web: "running" } });
    save();
    const portB = join(root, "b-port");
    await driver.start({ unit: unitB, argv: [process.execPath, "-e", serve, portB, countB, String(port)], cwd: b, env: {} });
    await waitFile(portB);
    assert.equal(Number(readFileSync(portB, "utf8")), port, "B must actually reuse A's old port");
    release();
    assert.equal((await settled(queued.id)).phase, "failed", "the queued job resolves the copy at launch and refuses");
    assert.equal(queue.get("other-chat", blocker.id)?.phase, "checking");
    assert.equal(runs, runsBefore, "no browser attempt starts for the stale request");
    assert.equal(readFileSync(countB, "utf8"), "0");

    // Re-record now refuses before queuing anything.
    const jobs = () => service.queue.list(caller.sessionId).length;
    const before = jobs();
    await assert.rejects(() => service.reRecord(caller, "tour-b2"), /not running/);
    // A stale desired-running record must not fool it either: B's unit owns the listener.
    rec.desired.web = "running";
    save();
    await assert.rejects(() => service.reRecord(caller, "tour-b2"), /another process/);
    assert.equal(jobs(), before, "no job was queued");
    assert.equal(runs, runsBefore, "no browser attempt started");
    assert.equal(readFileSync(countB, "utf8"), "0", "B received no request");
  } finally {
    runtime?.close();
    await driver.stop(unitA);
    await driver.stop(unitB);
    rmSync(root, { recursive: true, force: true });
  }
});
