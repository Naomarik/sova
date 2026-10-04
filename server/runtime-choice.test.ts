import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { bootsFile, chosenRuntime, decideLaunch, fallbackFile, launch, MAX_FAILED_BUN_BOOTS, parseRuntimeSetting, readBunBoots, resolveBun, runtimeFile, runtimeInfo } from "./runtime-choice";

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

describe("parseRuntimeSetting", () => {
  test("only a well-formed node or bun is taken; everything else is node", () => {
    assert.equal(parseRuntimeSetting('{"runtime":"bun"}'), "bun");
    assert.equal(parseRuntimeSetting('{"runtime":"node"}'), "node");
    for (const bad of [null, undefined, "", "{", "[]", '"bun"', '{"runtime":"Bun"}', '{"runtime":"deno"}', '{"runtime":1}', "null", "{}"])
      assert.equal(parseRuntimeSetting(bad), "node", String(bad));
  });
});

describe("chosenRuntime", () => {
  test("SOVA_RUNTIME wins when it names a runtime; otherwise the file decides", () => {
    const root = freshRoot();
    assert.equal(chosenRuntime({}, root), "node");
    writeFileSync(runtimeFile(root), '{"runtime":"bun"}');
    assert.equal(chosenRuntime({}, root), "bun");
    assert.equal(chosenRuntime({ SOVA_RUNTIME: "node" }, root), "node");
    assert.equal(chosenRuntime({ SOVA_RUNTIME: "deno" }, root), "bun");
    writeFileSync(runtimeFile(root), '{"runtime":"node"}');
    assert.equal(chosenRuntime({ SOVA_RUNTIME: "bun" }, root), "bun");
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

describe("decideLaunch", () => {
  const bun = { path: "/x/bun" };
  test("node resets the counter and never falls back", () => {
    assert.deepEqual(decideLaunch("node", bun, 5), { runtime: "node", resetBoots: true });
  });
  test("bun counts its boots", () => {
    assert.deepEqual(decideLaunch("bun", bun, 0), { runtime: "bun", bun: "/x/bun", boots: 1 });
    assert.deepEqual(decideLaunch("bun", bun, MAX_FAILED_BUN_BOOTS - 1), { runtime: "bun", bun: "/x/bun", boots: MAX_FAILED_BUN_BOOTS });
  });
  test("bun missing, or the third failed boot reached, falls back to node with a reason", () => {
    const missing = decideLaunch("bun", { missing: "gone" }, 0);
    assert.equal(missing.runtime, "node");
    assert.ok(missing.runtime === "node" && missing.fallback?.includes("gone") && !missing.resetBoots);
    const failing = decideLaunch("bun", bun, MAX_FAILED_BUN_BOOTS);
    assert.ok(failing.runtime === "node" && failing.fallback?.includes(`${MAX_FAILED_BUN_BOOTS} times`) && !failing.resetBoots);
  });
});

describe("launch", () => {
  test("three bun boots that never listen, then node with a fallback record; choosing node resets", () => {
    const root = freshRoot();
    const env = { SOVA_RUNTIME: "bun", SOVA_BUN: stub("bun") };
    for (let i = 1; i <= MAX_FAILED_BUN_BOOTS; i++) {
      assert.equal(launch(env, root).runtime, "bun");
      assert.equal(readBunBoots(root), i);
    }
    assert.ok(!existsSync(fallbackFile(root)));
    const d = launch(env, root);
    assert.equal(d.runtime, "node");
    const rec = JSON.parse(readFileSync(fallbackFile(root), "utf8"));
    assert.equal(typeof rec.at, "string");
    assert.ok(rec.reason.includes("times in a row"));
    assert.equal(readBunBoots(root), MAX_FAILED_BUN_BOOTS, "the fallback keeps the count");
    launch({ SOVA_RUNTIME: "node" }, root);
    assert.ok(!existsSync(bootsFile(root)));
    assert.equal(launch(env, root).runtime, "bun");
  });
});

describe("runtimeInfo", () => {
  test("reports this process, the choice, and the fallback only when they differ", () => {
    const root = freshRoot();
    writeFileSync(fallbackFile(root), JSON.stringify({ at: "2026-01-01T00:00:00.000Z", reason: "why" }));
    const here = process.versions.bun ? "bun" : "node";
    const other = here === "bun" ? "node" : "bun";
    assert.deepEqual(runtimeInfo({ SOVA_RUNTIME: here }, root), { name: here, version: process.versions.bun ?? process.versions.node, chosen: here });
    assert.deepEqual(runtimeInfo({ SOVA_RUNTIME: other }, root).fallback, { at: "2026-01-01T00:00:00.000Z", reason: "why" });
  });
});

describe("scripts/start-server.sh", () => {
  // Stub node and bun binaries: the launcher's decision step still runs on the real node.
  const realNode = process.execPath.endsWith("bun") ? "node" : process.execPath;
  function run(env: Record<string, string>, root: string): string {
    const dir = join(tmp, `nodeshim${n++}`);
    mkdirSync(dir);
    const shim = join(dir, "node");
    // The decision call goes to the real node; the final exec prints instead of starting a server.
    writeFileSync(shim, `#!/bin/sh\nif [ "$1" = server/runtime-choice.ts ]; then exec "${realNode}" "$@"; fi\necho "node $*"\n`);
    chmodSync(shim, 0o755);
    return execFileSync(join(REPO, "scripts", "start-server.sh"), [], {
      env: { PATH: process.env.PATH ?? "", HOME: tmp, PI_CODING_AGENT_DIR: dirname(root), SOVA_NODE: shim, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }
  test("execs node by default, bun when chosen, node again when bun is missing", () => {
    const root = join(freshRoot(), "sova");
    assert.equal(run({}, root), "node --import tsx server/index.ts");
    const bun = stub("bun");
    assert.equal(run({ SOVA_RUNTIME: "bun", SOVA_BUN: bun }, root), "bun server/index.ts");
    assert.equal(run({ SOVA_RUNTIME: "bun", SOVA_BUN: join(tmp, "missing-bun") }, root), "node --import tsx server/index.ts");
    assert.ok(JSON.parse(readFileSync(fallbackFile(root), "utf8")).reason.includes("missing-bun"));
  });
});
