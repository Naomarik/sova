// scripts/start-server.sh run as a program is runtime-choice.integration.test.ts.
import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { chosenRuntime, launch, resolveBun, runtimeInfo } from "./runtime-choice";

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
