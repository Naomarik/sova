import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chosenRuntime, launch, resolveBun, runtimeInfo } from "./runtime-choice";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "sova-runtime-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshRoot = () => {
  const root = join(tmp, `root${n++}`);
  mkdirSync(root, { recursive: true });
  return root;
};
/** An executable stub named `name` in its own directory; it prints its name and argv. */
function stub(name: string): string {
  const dir = join(tmp, `bin${n++}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho "${name} $*"\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("chosenRuntime", () => {
  test("node only when SOVA_RUNTIME=node; anything else is bun", () => {
    assert.equal(chosenRuntime({ SOVA_RUNTIME: "node" }), "node");
    assert.equal(chosenRuntime({ SOVA_RUNTIME: " node\n" }), "node");
    for (const v of [undefined, "", "bun", "Node", "deno"]) assert.equal(chosenRuntime({ SOVA_RUNTIME: v }), "bun", String(v));
  });
  test("a runtime.json in the agent dir is not read", () => {
    const root = freshRoot();
    writeFileSync(join(root, "runtime.json"), '{"runtime":"node"}');
    assert.equal(chosenRuntime({ PI_CODING_AGENT_DIR: dirname(root) }), "bun");
  });
});

describe("resolveBun", () => {
  const noMise = () => null;
  test("SOVA_BUN is the only candidate when set", () => {
    const bun = stub("bun");
    const other = stub("bun");
    assert.deepEqual(resolveBun({ SOVA_BUN: bun, PATH: dirname(other) }, noMise), { path: bun });
    const r = resolveBun({ SOVA_BUN: join(tmp, "nope"), PATH: dirname(other) }, noMise);
    assert.ok("missing" in r && r.missing.includes("SOVA_BUN"));
  });
  test("then PATH, then mise", () => {
    const onPath = stub("bun");
    const viaMise = stub("bun");
    assert.deepEqual(resolveBun({ PATH: `/nonexistent:${dirname(onPath)}` }, () => viaMise), { path: onPath });
    assert.deepEqual(resolveBun({ PATH: "/nonexistent" }, () => viaMise), { path: viaMise });
    assert.ok("missing" in resolveBun({ PATH: "/nonexistent" }, noMise));
  });
  test("a non-executable file is not bun", () => {
    const dir = join(tmp, `plain${n++}`);
    mkdirSync(dir);
    writeFileSync(join(dir, "bun"), "");
    assert.ok("missing" in resolveBun({ PATH: dir }, noMise));
  });
});

describe("launch", () => {
  const noMise = () => null;
  test("bun by default, node when asked, an error (never node) when bun is missing", () => {
    const bun = stub("bun");
    assert.deepEqual(launch({ SOVA_BUN: bun }, noMise), { runtime: "bun", bun });
    assert.deepEqual(launch({ SOVA_RUNTIME: "node", SOVA_BUN: join(tmp, "nope") }, noMise), { runtime: "node" });
    const d = launch({ SOVA_BUN: join(tmp, "nope") }, noMise);
    assert.equal(d.runtime, "error");
    assert.ok(d.runtime === "error" && d.error.includes("SOVA_BUN") && d.error.includes("SOVA_RUNTIME=node"));
    assert.equal(launch({ PATH: "/nonexistent" }, noMise).runtime, "error");
  });
});

describe("runtimeInfo", () => {
  test("reports this process and the choice", () => {
    const here = process.versions.bun ? "bun" : "node";
    const version = process.versions.bun ?? process.versions.node;
    assert.deepEqual(runtimeInfo({ SOVA_RUNTIME: "node" }), { name: here, version, chosen: "node" });
    assert.deepEqual(runtimeInfo({}), { name: here, version, chosen: "bun" });
  });
});

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
