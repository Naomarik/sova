// Run: pnpm exec tsx --test server/baton-images.integration.test.ts. A person's photos in a
// gathering chat (§app.baton/images) on a real share listener: the per-route body caps, the
// upload's own timer and the photo reads' own per-address bucket, over raw HTTP on 127.0.0.1. The
// rest (routes, stripper, staging, upload and message routes, view, prompt) is baton-images.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { MB } from "../shared/baton";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-baton-images-int-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
delete process.env.SOVA_SHARE_PUBLIC_URL;
mkdirSync(join(root, "agent", "sessions", "live"), { recursive: true });

const { createShareServer } = await import("./share/listener");
const { UPLOAD_BODY_MAX } = await import("./share/edge");

const T = "A".repeat(43);

describe("the edge", () => {
  describe("on a listener", async () => {
    const answered: string[] = [];
    const server = createShareServer({
      headersMs: 300,
      requestMs: 300,
      checkMs: 50,
      dispatch: (req, res) => {
        let n = 0;
        req.on("data", (d: Buffer) => (n += d.length));
        req.on("end", () => {
          answered.push(`${req.method} ${n}`);
          res.writeHead(200, { "Content-Type": "text/plain" }).end(String(n));
        });
      },
      upgrade: (_req, socket) => void socket.destroy(),
      client: () => "one-address",
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    after(() => {
      server.close();
      server.closeAllConnections();
    });
    /** Raw HTTP: `head` then, after `wait` ms, `body`. Resolves the reply's status line. */
    const raw = (head: string, body: Buffer = Buffer.alloc(0), wait = 0) =>
      new Promise<string>((resolve) => {
        const sock = connect(port, "127.0.0.1", () => {
          sock.write(head);
          setTimeout(() => sock.writable && sock.write(body), wait);
        });
        let data = "";
        sock.on("data", (d) => {
          data += d;
          if (data.includes("\r\n")) (sock.destroy(), resolve(data.split("\r\n")[0]!));
        });
        sock.on("error", () => resolve(data));
        sock.on("close", () => resolve(data.split("\r\n")[0] ?? ""));
      });
    const post = (path: string, len: number) => `POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: image/jpeg\r\nContent-Length: ${len}\r\n\r\n`;

    test("5 MB passes on /image; 16 KB + 1 on /message and past the upload cap on /image are 413", async () => {
      assert.match(await raw(post(`/api/h/${T}/image`, 5 * MB), Buffer.alloc(5 * MB, 1)), /^HTTP\/1\.1 200/);
      assert.match(await raw(post(`/api/h/${T}/message`, 16 * 1024 + 1)), /^HTTP\/1\.1 413/);
      assert.match(await raw(post(`/api/h/${T}/image`, UPLOAD_BODY_MAX + 1)), /^HTTP\/1\.1 413/);
      assert.match(await raw(`POST /api/h/${T}/image HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n`), /^HTTP\/1\.1 413/, "a length is still required");
    });

    test("the upload has its own time: a slow photo body is not cut at the page's timer, a slow message body is", async () => {
      assert.match(await raw(post(`/api/h/${T}/image`, 10), Buffer.alloc(10, 1), 700), /^HTTP\/1\.1 200/);
      assert.match(await raw(post(`/api/h/${T}/message`, 10), Buffer.alloc(10, 1), 700), /^HTTP\/1\.1 408/);
    });

    test("photo reads count in their own per-address bucket, never the page's 60", async () => {
      const get = (path: string) => raw(`GET ${path} HTTP/1.1\r\nHost: x\r\n\r\n`);
      for (let i = 0; i < 70; i++) assert.match(await get(`/api/h/${T}/img/${i}`), /^HTTP\/1\.1 200/, `read ${i}`);
      assert.match(await get(`/api/h/${T}`), /^HTTP\/1\.1 200/, "the page's own budget is untouched");
    });
  });
});
