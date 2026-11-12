// Run: pnpm test server/share/tunnel/download.test.ts. The one-click cloudflared download with fetch and tar
// injected (no network, no process): what is kept, what is deleted, and who may press it. The real tar unpacking
// a .tgz is download.integration.test.ts.
import { dropScratchAgentDir, scratchAgentDir } from "../../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, describe, test } from "node:test";
import { Hono } from "hono";
import { CALLER_HEADER, TOKEN_HEADER } from "../../auth";
import { pageHeaders } from "../../testing/page";
import { forgetCloudflared, onCloudflaredChanged } from "./binary";
import { downloadCloudflared, type DownloadDeps, mountCloudflaredDownload } from "./download";
import type { CloudflaredAsset } from "./release";

const dir = join(scratchAgentDir, "sova", "bin");
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const BINARY = new TextEncoder().encode("#!/bin/sh\necho 'cloudflared version 2026.10.7'\n");
const BARE: CloudflaredAsset = { name: "cloudflared-linux-amd64", size: BINARY.byteLength, sha256: sha(BINARY) };
// Keep the PATH probe from finding a real cloudflared after a download: only the downloaded copy may answer.
process.env.PATH = "/nonexistent";
delete process.env.SOVA_CLOUDFLARED;

after(dropScratchAgentDir);
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  forgetCloudflared();
});

/** A fetch that serves `body` in chunks, and records what it was asked. */
function serving(body: Uint8Array, opts: { status?: number; length?: number | null; fail?: boolean } = {}) {
  const asked: string[] = [];
  const f = (async (url: string | URL | Request) => {
    asked.push(String(url));
    if (opts.fail) throw new TypeError("fetch failed");
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < body.byteLength; i += 7) c.enqueue(body.slice(i, i + 7));
        c.close();
      },
    });
    const headers: Record<string, string> = {};
    if (opts.length !== null) headers["content-length"] = String(opts.length ?? body.byteLength);
    return new Response(stream, { status: opts.status ?? 200, headers });
  }) as typeof fetch;
  return { fetch: f, asked };
}

const deps = (over: Partial<DownloadDeps>): DownloadDeps => ({
  fetch: serving(BINARY).fetch,
  asset: BARE,
  version: "2026.10.7",
  platform: "linux",
  dir,
  untar: async () => assert.fail("a bare binary is never unpacked"),
  now: () => 1234,
  timeoutMs: 5000,
  ...over,
});

const left = () => (existsSync(dir) ? readdirSync(dir).sort() : []);

describe("the download", () => {
  test("a match is kept: 0755, its record, nothing else left, and the next look finds it", async () => {
    const s = serving(BINARY);
    let told = 0;
    const off = onCloudflaredChanged(() => told++);
    const r = await downloadCloudflared(deps({ fetch: s.fetch }));
    off();
    assert.deepEqual(s.asked, ["https://github.com/cloudflare/cloudflared/releases/download/2026.10.7/cloudflared-linux-amd64"]);
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(r.ok && r.found, { ok: true, path: join(dir, "cloudflared"), version: "2026.10.7", source: "download" });
    assert.equal(statSync(join(dir, "cloudflared")).mode & 0o777, 0o755);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "cloudflared.json"), "utf8")), { version: "2026.10.7", sha256: BARE.sha256, at: 1234 });
    assert.deepEqual(left(), ["cloudflared", "cloudflared.json"]);
    assert.equal(told, 1, "a waiting tunnel is told");
  });

  test("a wrong byte is deleted and said so; nothing is installed", async () => {
    const bad = BINARY.slice();
    bad[3] = (bad[3] ?? 0) ^ 1;
    const r = await downloadCloudflared(deps({ fetch: serving(bad).fetch }));
    assert.equal(r.ok, false);
    assert.deepEqual(!r.ok && [r.code, r.error], ["checksum", "The download didn't match its checksum, so it was deleted."]);
    assert.equal(!r.ok && r.status, 502);
    assert.deepEqual(left(), []);
  });

  test("more bytes than the asset is cut off, with or without a length", async () => {
    const long = new Uint8Array([...BINARY, 1, 2, 3]);
    for (const length of [undefined, null]) {
      const r = await downloadCloudflared(deps({ fetch: serving(long, { length }).fetch }));
      assert.equal(r.ok, false, String(length));
      assert.deepEqual(left(), []);
    }
  });

  test("an error answer or no network: nothing written", async () => {
    const e = await downloadCloudflared(deps({ fetch: serving(BINARY, { status: 404 }).fetch }));
    assert.match(!e.ok ? e.error : "", /^GitHub answered 404\./);
    const n = await downloadCloudflared(deps({ fetch: serving(BINARY, { fail: true }).fetch }));
    assert.match(!n.ok ? n.error : "", /^GitHub couldn't be reached/);
    assert.deepEqual(left(), []);
  });

  test("no build for this computer: the install line, and no fetch", async () => {
    const s = serving(BINARY);
    const r = await downloadCloudflared(deps({ fetch: s.fetch, asset: null, platform: "darwin" }));
    assert.deepEqual(r, { ok: false, status: 400, code: "unsupported", error: "Install cloudflared yourself, then reload this page. brew install cloudflared" });
    assert.deepEqual(s.asked, []);
  });

  test("a second click while one runs joins it: one fetch", async () => {
    const s = serving(BINARY);
    const [a, b] = await Promise.all([downloadCloudflared(deps({ fetch: s.fetch })), downloadCloudflared(deps({ fetch: s.fetch }))]);
    assert.ok(a.ok && b.ok);
    assert.equal(s.asked.length, 1);
  });
});

describe("a macOS archive", () => {
  const ARCHIVE = new TextEncoder().encode("pretend tgz");
  const TGZ: CloudflaredAsset = { name: "cloudflared-darwin-arm64.tgz", size: ARCHIVE.byteLength, sha256: sha(ARCHIVE), member: { name: "cloudflared", sha256: sha(BINARY) } };

  test("its one member, by name, checked against its own sum", async () => {
    const untarred: string[] = [];
    const r = await downloadCloudflared(
      deps({
        asset: TGZ,
        fetch: serving(ARCHIVE).fetch,
        untar: async (archive, member, into) => {
          untarred.push(member);
          assert.equal(readFileSync(archive, "utf8"), "pretend tgz");
          writeFileSync(join(into, member), BINARY);
        },
      }),
    );
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(untarred, ["cloudflared"]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "cloudflared.json"), "utf8")).sha256, sha(BINARY), "the record holds the binary's sum");
    assert.deepEqual(left(), ["cloudflared", "cloudflared.json"]);
  });

  test("a member that isn't the pinned binary, or is a link, is refused and cleaned up", async () => {
    for (const plant of [(p: string) => writeFileSync(p, "other"), (p: string) => symlinkSync("/bin/sh", p)]) {
      const r = await downloadCloudflared(deps({ asset: TGZ, fetch: serving(ARCHIVE).fetch, untar: async (_a, m, into) => plant(join(into, m)) }));
      assert.equal(r.ok, false);
      assert.deepEqual(left(), []);
    }
  });

  test("an archive tar can't unpack", async () => {
    const r = await downloadCloudflared(deps({ asset: TGZ, fetch: serving(ARCHIVE).fetch, untar: async () => Promise.reject(new Error("bad")) }));
    assert.deepEqual(r.ok ? null : [r.status, r.code], [500, "unpack"]);
    assert.deepEqual(left(), []);
  });
});

describe("POST /api/public-links/cloudflared/download: only your click", () => {
  const app = new Hono();
  let s = serving(BINARY);
  mountCloudflaredDownload(app, () => deps({ fetch: s.fetch }));
  const post = (headers: Record<string, string>, env?: object) => app.request("/api/public-links/cloudflared/download", { method: "POST", headers }, env);

  test("a chat, a script, the Overseer, an extension and a cookieless call get the 403 and nothing is fetched", async () => {
    s = serving(BINARY);
    const { OVERSEER_SENDER_HEADER, senderSecret } = await import("../../overseer-sender");
    for (const h of <Record<string, string>[]>[{ [CALLER_HEADER]: "sess-1" }, { [TOKEN_HEADER]: "tok" }, { [OVERSEER_SENDER_HEADER]: senderSecret() }, {}]) {
      const res = await post(h);
      assert.equal(res.status, 403, JSON.stringify(h));
      const body = (await res.json()) as { error: string; yourClick: boolean };
      assert.equal(body.yourClick, true);
    }
    const chat = (await (await post({ [CALLER_HEADER]: "sess-1" })).json()) as { error: string };
    assert.equal(chat.error, "Only the user downloads programs. Ask them to press Download in Settings → Public links. Nothing was downloaded.");
    assert.deepEqual(s.asked, []);
    assert.deepEqual(left(), []);
  });

  test("a peer's relay gets the plain 404", async () => {
    assert.equal((await post(pageHeaders(), { meshPeer: true })).status, 404);
  });

  test("the page's click downloads it", async () => {
    s = serving(BINARY);
    mkdirSync(dir, { recursive: true });
    const res = await post(pageHeaders(), { incoming: {} });
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(((await res.json()) as { cloudflared: { source: string } }).cloudflared.source, "download");
    assert.equal(s.asked.length, 1);
  });
});
