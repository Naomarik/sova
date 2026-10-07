// Run: pnpm test -- server/voice/download.test.ts
// The model download's decisions (size, sha256, resume, a server ignoring Range, errors, abort)
// against an in-process fetch that answers as a file server does. A real streamed download and a
// real Range resume over HTTP: download.integration.test.ts.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { download, DownloadError } from "./download";

const BODY = randomBytes(300_000);
const SHA = createHash("sha256").update(BODY).digest("hex");
const URL_ = "http://models.example/model.bin";
const seen: { range?: string }[] = [];
let ignoreRange = false;

/** A file server for BODY: honours `bytes=N-` (206, or 416 past the end) unless told to ignore it. */
const serve = (async (_url: string | URL | Request, init?: RequestInit) => {
  const range = new Headers(init?.headers).get("range") ?? undefined;
  seen.push({ range });
  const m = /^bytes=(\d+)-$/.exec(range ?? "");
  if (m && !ignoreRange) {
    const from = Number(m[1]);
    if (from >= BODY.length) return new Response(null, { status: 416 });
    return new Response(BODY.subarray(from), { status: 206, headers: { "Content-Length": String(BODY.length - from), "Content-Range": `bytes ${from}-${BODY.length - 1}/${BODY.length}` } });
  }
  return new Response(BODY, { status: 200, headers: { "Content-Length": String(BODY.length) } });
}) as typeof fetch;

const dir = () => mkdtempSync(join(tmpdir(), "voice-dl-"));

describe("download", () => {
  it("fetches, checks size and sha256, and renames into place", async () => {
    const dest = join(dir(), "model.bin");
    const progress: number[] = [];
    const n = await download({ url: URL_, dest, bytes: BODY.length, sha256: SHA, onProgress: (d) => progress.push(d), fetchImpl: serve });
    assert.equal(n, BODY.length);
    assert.ok(readFileSync(dest).equals(BODY));
    assert.equal(existsSync(`${dest}.part`), false);
    assert.equal(progress.at(-1), BODY.length);
  });

  it("resumes a .part with a Range request and still verifies the whole file", async () => {
    const dest = join(dir(), "model.bin");
    writeFileSync(`${dest}.part`, BODY.subarray(0, 123_456));
    seen.length = 0;
    await download({ url: URL_, dest, bytes: BODY.length, sha256: SHA, fetchImpl: serve });
    assert.equal(seen[0]?.range, "bytes=123456-");
    assert.ok(readFileSync(dest).equals(BODY));
  });

  it("a whole .part answers 416 and is just verified", async () => {
    const dest = join(dir(), "model.bin");
    writeFileSync(`${dest}.part`, BODY);
    await download({ url: URL_, dest, bytes: BODY.length, sha256: SHA, fetchImpl: serve });
    assert.ok(readFileSync(dest).equals(BODY));
  });

  it("a corrupt prefix fails the sha256 and deletes the part, so a retry starts clean", async () => {
    const dest = join(dir(), "model.bin");
    const bad = Buffer.from(BODY.subarray(0, 1000));
    bad[10] = bad[10]! ^ 0xff;
    writeFileSync(`${dest}.part`, bad);
    await assert.rejects(download({ url: URL_, dest, bytes: BODY.length, sha256: SHA, fetchImpl: serve }), (e: unknown) => e instanceof DownloadError && /sha256 mismatch/.test(e.message));
    assert.equal(existsSync(`${dest}.part`), false);
    assert.equal(existsSync(dest), false);
    await download({ url: URL_, dest, bytes: BODY.length, sha256: SHA, fetchImpl: serve });
    assert.ok(readFileSync(dest).equals(BODY));
  });

  it("a server that ignores Range gets a fresh download, not a doubled file", async () => {
    const dest = join(dir(), "model.bin");
    writeFileSync(`${dest}.part`, BODY.subarray(0, 5000));
    ignoreRange = true;
    try {
      await download({ url: URL_, dest, bytes: BODY.length, sha256: SHA, fetchImpl: serve });
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
    // A body that sends its first 50 KB and then nothing more, as a stalled server does; the abort
    // comes once that much has been taken in.
    const stalled = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(BODY.subarray(0, 50_000)));
          init?.signal?.addEventListener("abort", () => c.error(init.signal!.reason));
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Length": String(BODY.length) } });
    }) as typeof fetch;
    const onProgress = (done: number) => {
      if (done >= 50_000) ac.abort();
    };
    await assert.rejects(download({ url: URL_, dest, bytes: BODY.length, sha256: SHA, signal: ac.signal, onProgress, fetchImpl: stalled }));
    assert.equal(existsSync(dest), false);
    assert.ok(existsSync(`${dest}.part`));
  });
});
