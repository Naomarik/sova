import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { download, DownloadError } from "./download";

const BODY = randomBytes(300_000);
const SHA = createHash("sha256").update(BODY).digest("hex");
let server: Server;
let base = "";
const seen: { range?: string }[] = [];
let ignoreRange = false;

before(async () => {
  server = createServer((req, res) => {
    seen.push({ range: req.headers.range });
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    if (m && !ignoreRange) {
      const from = Number(m[1]);
      if (from >= BODY.length) {
        res.writeHead(416).end();
        return;
      }
      res.writeHead(206, { "Content-Length": String(BODY.length - from), "Content-Range": `bytes ${from}-${BODY.length - 1}/${BODY.length}` });
      res.end(BODY.subarray(from));
      return;
    }
    res.writeHead(200, { "Content-Length": String(BODY.length) }).end(BODY);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/model.bin`;
});
after(() => server.close());

const dir = () => mkdtempSync(join(tmpdir(), "voice-dl-"));

describe("download", () => {
  it("fetches, checks size and sha256, and renames into place", async () => {
    const dest = join(dir(), "model.bin");
    const progress: number[] = [];
    const n = await download({ url: base, dest, bytes: BODY.length, sha256: SHA, onProgress: (d) => progress.push(d) });
    assert.equal(n, BODY.length);
    assert.ok(readFileSync(dest).equals(BODY));
    assert.equal(existsSync(`${dest}.part`), false);
    assert.equal(progress.at(-1), BODY.length);
  });

  it("resumes a .part with a Range request and still verifies the whole file", async () => {
    const dest = join(dir(), "model.bin");
    writeFileSync(`${dest}.part`, BODY.subarray(0, 123_456));
    seen.length = 0;
    await download({ url: base, dest, bytes: BODY.length, sha256: SHA });
    assert.equal(seen[0]?.range, "bytes=123456-");
    assert.ok(readFileSync(dest).equals(BODY));
  });

  it("a whole .part answers 416 and is just verified", async () => {
    const dest = join(dir(), "model.bin");
    writeFileSync(`${dest}.part`, BODY);
    await download({ url: base, dest, bytes: BODY.length, sha256: SHA });
    assert.ok(readFileSync(dest).equals(BODY));
  });

  it("a corrupt prefix fails the sha256 and deletes the part, so a retry starts clean", async () => {
    const dest = join(dir(), "model.bin");
    const bad = Buffer.from(BODY.subarray(0, 1000));
    bad[10] = bad[10]! ^ 0xff;
    writeFileSync(`${dest}.part`, bad);
    await assert.rejects(download({ url: base, dest, bytes: BODY.length, sha256: SHA }), (e: unknown) => e instanceof DownloadError && /sha256 mismatch/.test(e.message));
    assert.equal(existsSync(`${dest}.part`), false);
    assert.equal(existsSync(dest), false);
    await download({ url: base, dest, bytes: BODY.length, sha256: SHA });
    assert.ok(readFileSync(dest).equals(BODY));
  });

  it("a server that ignores Range gets a fresh download, not a doubled file", async () => {
    const dest = join(dir(), "model.bin");
    writeFileSync(`${dest}.part`, BODY.subarray(0, 5000));
    ignoreRange = true;
    try {
      await download({ url: base, dest, bytes: BODY.length, sha256: SHA });
    } finally {
      ignoreRange = false;
    }
    assert.ok(readFileSync(dest).equals(BODY));
  });

  it("an HTTP error names the host and status", async () => {
    const dest = join(dir(), "x.bin");
    const fetchImpl = (async () => new Response("nope", { status: 404, statusText: "Not Found" })) as typeof fetch;
    await assert.rejects(download({ url: "https://example.invalid/x.bin", dest, fetchImpl }), /example\.invalid answered 404 Not Found/);
  });

  it("aborting stops it and keeps the part for a resume", async () => {
    const dest = join(dir(), "model.bin");
    const ac = new AbortController();
    let slowServer: Server | null = null;
    slowServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Length": String(BODY.length) });
      res.write(BODY.subarray(0, 50_000));
      setTimeout(() => ac.abort(), 50);
    });
    await new Promise<void>((r) => slowServer!.listen(0, "127.0.0.1", () => r()));
    const addr = slowServer.address();
    const url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/`;
    await assert.rejects(download({ url, dest, bytes: BODY.length, sha256: SHA, signal: ac.signal }));
    slowServer.closeAllConnections();
    slowServer.close();
    assert.equal(existsSync(dest), false);
    assert.ok(existsSync(`${dest}.part`));
  });
});
