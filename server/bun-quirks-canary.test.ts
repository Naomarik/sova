// Canaries for docs/bun-quirks.md: each asserts that a Bun bug Sova works around STILL EXISTS. They
// run only under Bun (`pnpm run test:bun`) and skip on Node. When a Bun upgrade fixes a bug, its
// canary fails: delete the workaround the registry names, then the canary and the registry row.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import os from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { after, describe, test } from "node:test";
import { WebSocket, WebSocketServer } from "ws";

// A canary is about Bun by definition: the one place outside the launcher that names it.
const skip = typeof (process.versions as Record<string, string | undefined>).bun === "string" ? false : "a Bun canary (pnpm run test:bun)";
const tmp = mkdtempSync(join(os.tmpdir(), "sova-bun-canary-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("Bun quirk canaries (docs/bun-quirks.md)", { skip }, () => {
  test("resolver-case: ./parts beside parts.ts and Parts.tsx does not load parts.ts", () => {
    const dir = mkdtempSync(join(tmp, "resolver-"));
    writeFileSync(join(dir, "parts.ts"), 'export const which = "parts.ts";\n');
    writeFileSync(join(dir, "Parts.tsx"), 'export const which = "Parts.tsx";\n');
    writeFileSync(join(dir, "main.ts"), 'import { which } from "./parts";\nconsole.log(which);\n');
    const run = () => spawnSync(process.execPath, [join(dir, "main.ts")], { cwd: dir, encoding: "utf8" });
    assert.notEqual(run().stdout.trim(), "parts.ts", "fixed: ./parts loads parts.ts; remove the quirk (PartsView.tsx may stay)");
    // The control: without the case twin, the same import loads parts.ts.
    rmSync(join(dir, "Parts.tsx"));
    assert.equal(run().stdout.trim(), "parts.ts");
  });

  test("homedir: os.homedir() ignores an in-process HOME change", () => {
    const before = process.env.HOME;
    const other = join(tmp, "elsewhere");
    try {
      process.env.HOME = other;
      assert.notEqual(os.homedir(), other, "fixed: os.homedir() follows HOME; test:bun's env home and hermetic-env's check may go");
    } finally {
      process.env.HOME = before;
    }
  });

  test("ws-max-payload: a WebSocketServer's maxPayload is not enforced", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", maxPayload: 1024 });
    await new Promise<void>((r) => wss.on("listening", () => r()));
    const got = new Promise<number>((resolve) => wss.on("connection", (s) => s.on("message", (m: Buffer) => resolve(m.length))));
    const c = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`);
    c.on("error", () => {});
    await new Promise<void>((r) => c.on("open", () => r()));
    c.send(Buffer.alloc(4096));
    const len = await Promise.race([got, new Promise<number>((r) => setTimeout(() => r(-1), 1000))]);
    c.terminate();
    wss.close();
    assert.equal(len, 4096, "fixed: maxPayload is enforced; enforceMaxPayload in server/runtime-quirks.ts may go");
  });

  test("ws-socket: a ws WebSocket has no _socket", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((r) => wss.on("listening", () => r()));
    const c = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`);
    await new Promise<void>((r) => c.on("open", () => r()));
    const socket = (c as unknown as { _socket?: unknown })._socket;
    c.terminate();
    wss.close();
    assert.equal(socket, undefined, "fixed: _socket exists; server/compression.test.ts may read it again");
  });

  test("ws-deflate: a ws server never negotiates permessage-deflate", async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", perMessageDeflate: true });
    await new Promise<void>((r) => wss.on("listening", () => r()));
    const c = new WebSocket(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, { perMessageDeflate: true });
    await new Promise<void>((r) => c.on("open", () => r()));
    const ext = c.extensions;
    c.terminate();
    wss.close();
    assert.equal(ext, "", "fixed: permessage-deflate is negotiated; compression.test.ts's deflate tests run again, drop the probe's skip");
  });

  test("fetch-refused: a refused fetch carries code ConnectionRefused, not cause.code ECONNREFUSED", async () => {
    const s = createNetServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    const { port } = s.address() as AddressInfo;
    await new Promise((r) => s.close(r));
    const err = await fetch(`http://127.0.0.1:${port}/`).then(() => null, (e: unknown) => e as { code?: string; cause?: { code?: string } });
    assert.ok(err, "the fetch was refused");
    assert.equal(err.cause?.code, undefined, "fixed: the cause carries ECONNREFUSED as on Node; REFUSED_CODES in server/runtime-quirks.ts may drop ConnectionRefused");
    assert.equal(err.code, "ConnectionRefused");
  });

  test("assert-throws-empty: assert.throws(fn, \"\") rejects an empty message instead of passing", () => {
    let got: unknown = null;
    try {
      assert.throws(() => {
        throw new Error("boom");
      }, "");
    } catch (e) {
      got = e;
    }
    assert.equal((got as { code?: string } | null)?.code, "ERR_INVALID_ARG_VALUE", "fixed: assert.throws(fn, \"\") passes as on Node");
  });

  test("ws-handshake-timeout: a ws client's handshakeTimeout never fires", async () => {
    const wedged = createNetServer(() => {}); // accepts, never answers the upgrade
    await new Promise<void>((r) => wedged.listen(0, "127.0.0.1", () => r()));
    const c = new WebSocket(`ws://127.0.0.1:${(wedged.address() as AddressInfo).port}/`, { handshakeTimeout: 200 });
    const ended = await new Promise<boolean>((resolve) => {
      c.on("error", () => resolve(true));
      c.on("close", () => resolve(true));
      setTimeout(() => resolve(false), 800);
    });
    c.terminate();
    wedged.close();
    assert.equal(ended, false, "fixed: handshakeTimeout fires; the timer in cappedWebSocket (server/runtime-quirks.ts) may go");
  });

  test("fetch-read-size: a streamed fetch body arrives in reads bigger than Node's 64 KiB", async () => {
    const http = createHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(Buffer.alloc(2 * 1024 * 1024, 0x20));
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
    const res = await fetch(`http://127.0.0.1:${(http.address() as AddressInfo).port}/`);
    let biggest = 0;
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) biggest = Math.max(biggest, part.length);
    http.close();
    assert.ok(biggest > 64 * 1024, `fixed: reads are at most ${biggest} bytes; the slicing fetch (useSlicedProviderReads in server/runtime-quirks.ts) may go`);
  });

  test("event-loop-delay: monitorEventLoopDelay samples exclude the resolution interval", async () => {
    const h = monitorEventLoopDelay({ resolution: 10 });
    h.enable();
    await new Promise((r) => setTimeout(r, 80));
    h.disable();
    assert.ok(h.count > 0, "the histogram recorded nothing at all");
    assert.ok(h.percentile(50) < 5e6, `fixed: p50 ${h.percentile(50) / 1e6} ms includes the interval; the drift sampler in server/runtime-quirks.ts may go`);
  });
});
