import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mutateRegistry, readRegistry } from "./store";

/** Above any pid the kernel hands out (Linux's pid_max is at most 2^22): never a live process. */
const DEAD_PID = 2 ** 22 + 1;

/** The registry's lock across real processes; its rules in one process are in store.test.ts. */

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
  // Each writer on this runtime: bun runs the .mts itself; under Node, tsx does.
  const runtime = process.versions.bun ? [process.execPath] : [join(process.cwd(), "node_modules", ".bin", "tsx")];
  await Promise.all(
    Array.from({ length: 8 }, (_, n) => new Promise<void>((ok, fail) => {
      const p = spawn(runtime[0]!, [writer, String(n), file], { stdio: "inherit" });
      p.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`writer ${n} exited ${code}`))));
    })),
  );
  const ids = readRegistry(file).instances.map((i) => i.id).sort();
  assert.deepEqual(ids, Array.from({ length: 8 }, (_, n) => `i-${n}`).sort());
  mutateRegistry((r) => void (r.instances = []), file);
  assert.equal(readRegistry(file).instances.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("a dead holder's lock is taken over by one caller only, however many race for it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sova-lock-"));
  const file = join(dir, "x.lock");
  const log = join(dir, "log");
  writeFileSync(log, "");
  // Each taker tries once; one that gets the lock logs its hold interval and keeps it ~200 ms.
  const taker = join(dir, "taker.mts");
  writeFileSync(
    taker,
    `import { appendFileSync } from "node:fs";
     import { tryLock } from ${JSON.stringify(new URL("./store.ts", import.meta.url).pathname)};
     const [file, log, start] = process.argv.slice(2);
     while (Date.now() < Number(start)) {}
     const l = tryLock(file);
     if ("release" in l) {
       const from = Date.now();
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
       appendFileSync(log, from + " " + Date.now() + "\\n");
       l.release();
     }`,
  );
  const { spawn } = await import("node:child_process");
  const runtime = process.versions.bun ? [process.execPath] : [join(process.cwd(), "node_modules", ".bin", "tsx")];
  for (let round = 0; round < 3; round++) {
    writeFileSync(file, String(DEAD_PID));
    writeFileSync(log, "");
    const start = String(Date.now() + 1_500);
    await Promise.all(
      Array.from({ length: 8 }, (_, n) => new Promise<void>((ok, fail) => {
        const p = spawn(runtime[0]!, [taker, file, log, start], { stdio: "inherit" });
        p.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`taker ${n} exited ${code}`))));
      })),
    );
    const holds = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split(" ").map(Number) as [number, number]);
    assert.ok(holds.length >= 1, "someone took the dead holder's lock");
    holds.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < holds.length; i++) assert.ok(holds[i]![0] >= holds[i - 1]![1], `two takers held the lock at once: ${JSON.stringify(holds)}`);
  }
  rmSync(dir, { recursive: true, force: true });
});
