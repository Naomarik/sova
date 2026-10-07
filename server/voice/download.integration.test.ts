// Run: node scripts/run-tests.mjs server/voice/download.integration.test.ts
// The model download over real HTTP on loopback: a streamed body, and a Range resume. Its decisions
// against an in-process fetch: download.test.ts.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { download } from "./download";

const BODY = randomBytes(300_000);
const SHA = createHash("sha256").update(BODY).digest("hex");
let server: Server;
let base = "";
const seen: { range?: string }[] = [];

before(async () => {
  server = createServer((req, res) => {
    seen.push({ range: req.headers.range });
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    if (m) {
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
});
