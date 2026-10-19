import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseDefinition } from "../../shared/project-contract";
import type { TourSource } from "../../shared/tour";
import type { InstanceRecord, Registry } from "./store";
import { resolveTourTarget } from "./tour-target";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tour-target-")));
  const checkout = join(root, "copy-a");
  mkdirSync(checkout);
  const rec: InstanceRecord = { id: "copy-a", project: root, checkout, branch: "a", slot: 1, generation: 1, createdBy: "operator", createdAt: new Date().toISOString(), cutWorktree: false, desired: { web: "running" }, prints: {}, data: {}, ports: { web: { http: 8142 } } };
  const registry: Registry = { version: 1, instances: [rec], shared: [] };
  const source: TourSource = { kind: "project", projectId: "project", instanceId: rec.id, checkout, serviceId: "web", endpoint: "http" };
  const deps = { registry: () => registry, projectRoot: () => root, definition: () => parseDefinition(JSON.stringify({ version: 1, services: { web: { cmd: ["web"], ports: { http: { base: 8141 } } } } })), unitOf: (id: string, service: string) => `${id}-${service}`, driver: { status: async () => ({ state: "active" as const, pid: 42 }), owns: (_unit: string, pid: number) => pid === 42 }, portOwner: () => ({ pid: 42, cwd: checkout }) };
  return { root, rec, registry, source, deps };
}

test("identity resolution refuses a reused slot/port even if it is listening", async () => {
  const f = fixture();
  try {
    const target = await resolveTourTarget(f.source, f.deps);
    assert.equal(target.origin, "http://127.0.0.1:8142");
    f.registry.instances = [{ ...f.rec, id: "copy-b" }];
    await assert.rejects(() => resolveTourTarget(f.source, f.deps), /original running copy/);
    await assert.rejects(() => target.assertCurrent(), /original running copy/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("ownership and generation are rechecked, not just registry desired state", async () => {
  const f = fixture();
  try {
    await assert.rejects(() => resolveTourTarget(f.source, { ...f.deps, portOwner: () => ({ pid: 43, cwd: f.rec.checkout }) }), /another process/);
    const target = await resolveTourTarget(f.source, f.deps);
    f.rec.generation++;
    await assert.rejects(() => target.assertCurrent(), /changed during/);
    f.rec.desired.web = "stopped";
    await assert.rejects(() => resolveTourTarget(f.source, f.deps), /not running/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("external-site spelling cannot bypass managed identity, including stopped reserved ports", async () => {
  const f = fixture();
  try {
    f.rec.desired.web = "stopped";
    for (const host of ["localhost", "127.0.0.1", "127.4.3.2", "127.1", "[::1]", "[::ffff:127.0.0.1]", "app.localhost"]) {
      const origin = new URL(`http://${host}:8142`).origin;
      await assert.rejects(() => resolveTourTarget({ kind: "site", origin }, f.deps), /canonical checkout, instance and service identity/);
    }
    const target = await resolveTourTarget({ kind: "site", origin: "http://127.0.0.1:8143" }, f.deps);
    await target.assertCurrent();
    f.rec.ports.web!.http = 8143;
    await assert.rejects(() => target.assertCurrent(), /managed running copy/);
    // The rule is scoped to loopback, not an unrelated site's coincidentally equal port.
    await (await resolveTourTarget({ kind: "site", origin: "https://example.invalid:8143" }, f.deps)).assertCurrent();
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("unknown ownership refuses rather than probing a page", async () => {
  const f = fixture();
  try { await assert.rejects(() => resolveTourTarget(f.source, { ...f.deps, portOwner: () => "unknown" }), /another process/); }
  finally { rmSync(f.root, { recursive: true, force: true }); }
});
