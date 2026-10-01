import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mutateRegistry, pickSlot, readRegistry, tryLock, type InstanceRecord, type Registry } from "./store";

const rec = (over: Partial<InstanceRecord>): InstanceRecord => ({
  id: "p-1",
  project: "/p",
  checkout: "/p",
  branch: null,
  slot: 0,
  generation: 0,
  createdBy: "operator",
  createdAt: "",
  cutWorktree: false,
  desired: {},
  prints: {},
  data: {},
  ports: {},
  ...over,
});

test("pickSlot takes the lowest slot whose ports nobody holds", () => {
  const r: Registry = { version: 1, instances: [rec({ slot: 0, ports: { web: { http: 4000 } } }), rec({ id: "p-2", checkout: "/p-a", slot: 1, ports: { web: { http: 4001 } } })], shared: [] };
  const ports = (slot: number) => [4000 + slot];
  assert.deepEqual(pickSlot(r, "/p", ports, [1, 2, 3], () => false), { slot: 2 });
  // Something listening on slot 2's port: skipped, never taken.
  assert.deepEqual(pickSlot(r, "/p", ports, [1, 2, 3], (p) => p === 4002), { slot: 3 });
  // Another project's instance holding slot 3's port counts too (ports are host-wide).
  r.instances.push(rec({ id: "q-1", project: "/q", checkout: "/q", slot: 0, ports: { api: { http: 4003 } } }));
  const none = pickSlot(r, "/p", ports, [1, 2, 3], (p) => p === 4002);
  assert.ok("refused" in none && /4003.*q-1/.test(none.refused), JSON.stringify(none));
  // An explicit slot is taken or refused, never moved.
  assert.deepEqual(pickSlot(r, "/p", ports, [1, 2, 3], () => false, 2), { slot: 2 });
  assert.ok("refused" in pickSlot(r, "/p", ports, [1, 2, 3], () => false, 1));
  // Another project's shared services claim their ports; this project's own do not block it.
  r.shared.push({ project: "/q", id: "q-shared", desired: {}, ports: { redis: { main: 4002 } } }, { project: "/p", id: "p-shared", desired: {}, ports: { redis: { main: 4005 } } });
  assert.ok("refused" in pickSlot(r, "/p", ports, [2], () => false));
  assert.deepEqual(pickSlot(r, "/p", ports, [5], () => false), { slot: 5 });
});

test("a lock is held against this process and taken over from a dead one", () => {
  const dir = mkdtempSync(join(tmpdir(), "sova-lock-"));
  const file = join(dir, "x.lock");
  const a = tryLock(file);
  assert.ok("release" in a);
  const b = tryLock(file);
  assert.ok("heldBy" in b && b.heldBy === process.pid, "a second caller in the same process is refused");
  a.release();
  const c = tryLock(file);
  assert.ok("release" in c, "released: free again");
  c.release();
  // A stale lock: its pid is gone.
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).stdout.toString();
  writeFileSync(file, dead);
  const d = tryLock(file);
  assert.ok("release" in d, "a dead holder's lock is taken over");
  d.release();
  rmSync(dir, { recursive: true, force: true });
});

test("mutateRegistry writes atomically and concurrent writers never lose an instance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sova-reg-"));
  const file = join(dir, "registry.json");
  // Eight processes each add one instance under the lock.
  const writer = join(dir, "writer.mts");
  writeFileSync(
    writer,
    `import { mutateRegistry } from ${JSON.stringify(new URL("./store.ts", import.meta.url).pathname)};
     const n = Number(process.argv[2]);
     mutateRegistry((r) => { r.instances.push({ id: "i-" + n, slot: n } as never); }, process.argv[3]);`,
  );
  const { spawn } = await import("node:child_process");
  const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
  await Promise.all(
    Array.from({ length: 8 }, (_, n) => new Promise<void>((ok, fail) => {
      const p = spawn(tsx, [writer, String(n), file], { stdio: "inherit" });
      p.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`writer ${n} exited ${code}`))));
    })),
  );
  const ids = readRegistry(file).instances.map((i) => i.id).sort();
  assert.deepEqual(ids, Array.from({ length: 8 }, (_, n) => `i-${n}`).sort());
  mutateRegistry((r) => void (r.instances = []), file);
  assert.equal(readRegistry(file).instances.length, 0);
  rmSync(dir, { recursive: true, force: true });
});
