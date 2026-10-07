import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mutateRegistry, readRegistry } from "./store";

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
