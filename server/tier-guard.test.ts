// Run: pnpm test -- server/tier-guard.test.ts (and with --runtime node). The unit tier's guard
// (scripts/test-tier-guard.mjs, the runner's second preload) refuses every way a unit test could start
// a program other than git, bind or connect a socket, fetch over the network, or import the whole
// server (§app.server-runtime/test-tiers). Each is tried inside the guard's trial, which enforces the
// rule whatever SOVA_TEST_GUARD says and records nothing, so the refused call never happens and this
// file stays a clean unit file.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { describe, test } from "node:test";

interface Guard { file: string; tier: string; mode: string; trial(fn: () => unknown): Promise<Error | null> }
const guard = (globalThis as Record<symbol, unknown>)[Symbol.for("sova:test-tier-guard")] as Guard | undefined;
const bun = (globalThis as { Bun?: Record<string, (...a: unknown[]) => unknown> }).Bun;
const RENAME = /tier guard: server\/tier-guard\.test\.ts is a unit test file and .*rename it \(or split those cases into\) server\/tier-guard\.integration\.test\.ts/;

/** `fn` run under the trial: refused, with the rename message. */
async function refused(fn: () => unknown, what: RegExp) {
  assert.ok(guard, "the tier guard isn't loaded: run this file through scripts/run-tests.mjs");
  const err = await guard.trial(fn);
  assert.ok(err, "not refused");
  assert.match(err.message, RENAME);
  assert.match(err.message, what);
}

describe("the unit tier's guard", () => {
  test("is loaded, and knows this file and its tier", () => {
    assert.ok(guard, "the tier guard isn't loaded: run this file through scripts/run-tests.mjs");
    assert.equal(guard.file, "server/tier-guard.test.ts");
    assert.equal(guard.tier, "unit");
  });

  test("refuses a program started through an ESM named import: spawn and execFileSync of sleep", async () => {
    await refused(() => spawn("sleep", ["30"]), /started sleep 30/);
    await refused(() => execFileSync("sleep", ["30"]), /started sleep 30/);
    // Bun's spawnSync hands a failure back as its result's error rather than throwing it.
    await refused(() => { const r = spawnSync("sleep", ["30"]); if (r.error) throw r.error; }, /started sleep 30/);
    await refused(() => execFileSync("/bin/sh", ["-c", "sleep 30"]), /started sleep 30/);
  });

  test("lets git run: Sova's own org store is a git repository", async () => {
    assert.ok(guard);
    let out = "";
    assert.equal(await guard.trial(() => { out = execFileSync("git", ["--version"], { encoding: "utf8" }); }), null);
    assert.match(out, /^git version /);
  });

  test("refuses a socket: net.connect, and http.createServer().listen", async () => {
    await refused(() => net.connect({ port: 9, host: "127.0.0.1" }), /connected to 127\.0\.0\.1:9/);
    await refused(() => net.connect(9, "127.0.0.1"), /connected to 127\.0\.0\.1:9/);
    const server = http.createServer();
    await refused(() => server.listen(0, "127.0.0.1"), /listened on 127\.0\.0\.1:0/);
    assert.equal(server.listening, false);
  });

  test("refuses a fetch to localhost", async () => {
    await refused(() => fetch("http://127.0.0.1:9/x"), /fetched http:\/\/127\.0\.0\.1:9\/x/);
    await refused(() => http.get("http://127.0.0.1:9/x"), /connected to 127\.0\.0\.1:9/);
  });

  test("refuses Bun's own calls: Bun.connect, Bun.listen, Bun.serve, Bun.spawn", { skip: !bun && "not on Bun" }, async () => {
    await refused(() => bun!.connect({ hostname: "127.0.0.1", port: 9, socket: { data() {} } }), /connected to 127\.0\.0\.1:9/);
    await refused(() => bun!.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }), /listened on 127\.0\.0\.1:0/);
    await refused(() => bun!.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") }), /listened on 127\.0\.0\.1:0/);
    await refused(() => bun!.spawn(["sleep", "30"]), /started sleep 30/);
    await refused(() => bun!.spawnSync(["sleep", "30"]), /started sleep 30/);
  });

  test("refuses a dynamic import of server/index.ts", async () => {
    // Were it let through, the server would start: on an ephemeral port, at least.
    process.env.PORT = "0";
    await refused(() => import("./index.ts"), /imported server\/index\.ts/);
  });
});
