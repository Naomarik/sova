import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const rounds = 6;
  const takers = 8;
  // Each taker runs every round: it says it is ready, waits for the round's go file, tries the lock
  // once, and one that gets it holds it 50 ms and logs that interval before it says it is done.
  const taker = join(dir, "taker.mts");
  writeFileSync(
    taker,
    `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
     import { join } from "node:path";
     import { tryLock } from ${JSON.stringify(new URL("./store.ts", import.meta.url).pathname)};
     const [dir, file, n, rounds] = process.argv.slice(2);
     for (let r = 0; r < Number(rounds); r++) {
       writeFileSync(join(dir, "ready-" + r + "-" + n), "");
       const until = Date.now() + 10_000;
       while (!existsSync(join(dir, "go-" + r))) if (Date.now() > until) process.exit(3);
       const l = tryLock(file);
       if ("release" in l) {
         const from = performance.timeOrigin + performance.now();
         Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
         appendFileSync(join(dir, "log-" + r), from + " " + (performance.timeOrigin + performance.now()) + "\\n");
         l.release();
       }
       writeFileSync(join(dir, "done-" + r + "-" + n), "");
     }`,
  );
  const { spawn } = await import("node:child_process");
  const runtime = process.versions.bun ? [process.execPath] : [join(process.cwd(), "node_modules", ".bin", "tsx")];
  const procs = Array.from({ length: takers }, (_, n) => spawn(runtime[0]!, [taker, dir, file, String(n), String(rounds)], { stdio: "inherit" }));
  const exits = procs.map((p, n) => new Promise<void>((ok, fail) => p.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`taker ${n} exited ${code}`))))));
  exits.forEach((e) => e.catch(() => {}));
  const all = async (prefix: string) => {
    const until = Date.now() + 20_000;
    while (Array.from({ length: takers }, (_, n) => existsSync(join(dir, `${prefix}-${n}`))).includes(false)) {
      if (Date.now() > until) throw new Error(`takers never all reached ${prefix}`);
      await new Promise((r) => setTimeout(r, 2));
    }
  };
  try {
    for (let round = 0; round < rounds; round++) {
      await all(`ready-${round}`);
      writeFileSync(file, String(DEAD_PID));
      writeFileSync(join(dir, `go-${round}`), "");
      await all(`done-${round}`);
      const log = join(dir, `log-${round}`);
      const holds = (existsSync(log) ? readFileSync(log, "utf8") : "").trim().split("\n").filter(Boolean).map((l) => l.split(" ").map(Number) as [number, number]);
      assert.ok(holds.length >= 1, `round ${round}: someone took the dead holder's lock`);
      holds.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < holds.length; i++) assert.ok(holds[i]![0] >= holds[i - 1]![1], `round ${round}: two takers held the lock at once: ${JSON.stringify(holds)}`);
    }
    await Promise.all(exits);
  } finally {
    for (const p of procs) p.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
