// Canaries for docs/bun-quirks.md: each asserts that a Bun bug Sova works around STILL EXISTS. They
// run only under Bun (`pnpm test`) and skip on Node. When a Bun upgrade fixes a bug, its
// canary fails: delete the workaround the registry names, then the canary and the registry row.
// The canaries that start a Bun child, open sockets or measure the event loop's delay are bun-quirks-canary.integration.test.ts.
import assert from "node:assert/strict";
import { IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import { Duplex } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { WebSocketServer } from "ws";

// A canary is about Bun by definition: the one place outside the launcher that names it.
const skip = typeof (process.versions as Record<string, string | undefined>).bun === "string" ? false : "a Bun canary (pnpm test runs Bun)";
const tmp = mkdtempSync(join(os.tmpdir(), "sova-bun-canary-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("Bun quirk canaries (docs/bun-quirks.md)", { skip }, () => {
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

  test("ws-stream: the ws shim can't upgrade a request that arrived on a plain stream", () => {
    const sock = new Duplex({ read() {}, write(_c, _e, cb) { cb(); } });
    const req = new IncomingMessage(sock as never);
    req.method = "GET";
    req.url = "/";
    req.headers = { host: "x", upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": randomBytes(16).toString("base64"), "sec-websocket-version": "13" };
    const wss = new WebSocketServer({ noServer: true });
    let threw = false;
    try {
      wss.handleUpgrade(req, sock, Buffer.alloc(0), () => {});
    } catch {
      threw = true;
    }
    sock.destroy();
    assert.equal(threw, true, "fixed: the shim upgrades a plain stream; streamWebSocketServer/streamWebSocket in server/runtime-quirks.ts may use `ws` itself");
  });
});
