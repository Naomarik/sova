// scripts/start-server.sh run as a program (the launcher, a node shim, a bun stub); the rules in-process are runtime-choice.test.ts.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "sova-runtime-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
/** An executable stub named `name` in its own directory; it prints its name and argv. */
function stub(name: string): string {
  const dir = join(tmp, `bin${n++}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho "${name} $*"\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("scripts/start-server.sh", () => {
  // Stub node and bun binaries: the launcher's decision step still runs on the real node, by its
  // full path (the stub's PATH is /usr/bin:/bin, which has no node on macOS).
  const realNode = process.execPath.endsWith("bun") ? spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).stdout.trim() : process.execPath;
  function run(env: Record<string, string>, args: string[] = []): { status: number; out: string; err: string } {
    const dir = join(tmp, `nodeshim${n++}`);
    mkdirSync(dir);
    const shim = join(dir, "node");
    // The decision call goes to the real node; the final exec prints instead of starting a server.
    writeFileSync(shim, `#!/bin/sh\nif [ "$1" = server/runtime-choice.ts ]; then exec "${realNode}" "$@"; fi\necho "node $* SOVA_RUNTIME=$SOVA_RUNTIME"\n`);
    chmodSync(shim, 0o755);
    const r = spawnSync(join(REPO, "scripts", "start-server.sh"), args, {
      env: { PATH: "/usr/bin:/bin", HOME: tmp, SOVA_NODE: shim, ...env },
      encoding: "utf8",
    });
    return { status: r.status ?? -1, out: r.stdout.trim(), err: r.stderr.trim() };
  }
  test("execs bun by default, node on --node or SOVA_RUNTIME=node, and fails when bun is missing", () => {
    const bun = stub("bun");
    assert.equal(run({ SOVA_BUN: bun }, ["--port", "1"]).out, "bun server/index.ts --port 1");
    assert.equal(run({ SOVA_BUN: bun }, ["--node", "--port", "1"]).out, "node --import tsx server/index.ts --port 1 SOVA_RUNTIME=node");
    assert.equal(run({ SOVA_BUN: bun, SOVA_RUNTIME: "node" }).out, "node --import tsx server/index.ts SOVA_RUNTIME=node");
    const missing = run({ SOVA_BUN: join(tmp, "missing-bun") });
    assert.equal(missing.status, 1);
    assert.equal(missing.out, "");
    assert.ok(missing.err.includes("bun not found") && missing.err.includes("missing-bun"), missing.err);
  });
});
