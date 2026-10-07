// Run: node scripts/run-tests.mjs server/compression.test.ts
// Transfer compression, in process: which clients are direct-local (server/compression.ts), gzip on
// /api/* through the app built without a listener (server/app.ts), and an image sent as is. Over
// real sockets (permessage-deflate, gzip by client) is compression.integration.test.ts. Uses a
// throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { gunzipSync } from "node:zlib";
import type { TranscriptItem } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-compression-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-compression-test--");
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
mkdirSync(sessionsDir, { recursive: true });

// A session whose transcript is well over the 1 KB thresholds and compresses well, like a real one.
const sessionPath = join(sessionsDir, "2026-09-28T00-00-00-000Z_01a0aaaa-0000-7000-8000-000000000000.jsonl");
{
  const lines = [{ type: "session", version: 3, id: "01a0aaaa-0000-7000-8000-000000000000", timestamp: "2026-09-28T00:00:00.000Z", cwd: "/tmp" }];
  let parentId: string | null = null;
  for (let i = 0; i < 40; i++) {
    const id = `e${i}`;
    const message =
      i % 2 === 0
        ? { role: "user", content: [{ type: "text", text: `Question ${i}: ${"please explain the session pipeline. ".repeat(20)}` }], timestamp: 0 }
        : { role: "assistant", content: [{ type: "text", text: `Answer ${i}: ${"the server normalizes entries into items. ".repeat(20)}` }], timestamp: 0 };
    lines.push({ type: "message", id, parentId, timestamp: "2026-09-28T00:00:00.000Z", message } as never);
    parentId = id;
  }
  writeFileSync(sessionPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
// An image directly in /tmp, the one place /api/attachment serves outside a session's folder (written by its case).
const pngPath = `/tmp/sova-compression-test-${randomUUID()}.png`;

const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const { isDirectLocal } = await import("./compression");

after(() => {
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(pngPath, { force: true });
});

const transcriptUrl = `/api/transcript?path=${encodeURIComponent(sessionPath)}`;

// What tailscale serve adds when it forwards the phone to 127.0.0.1 (ipn/ipnlocal/serve.go).
const TAILSCALE = { "X-Forwarded-Host": "host.example.ts.net:8443", "X-Forwarded-Proto": "https", "X-Forwarded-For": "100.64.0.7" };

describe("isDirectLocal", () => {
  const req = (remoteAddress: string | undefined, headers: Record<string, string> = {}) => ({ socket: remoteAddress === undefined ? null : { remoteAddress }, headers });
  test("a loopback peer with no proxy headers is direct-local, in every address form", () => {
    for (const a of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1", "::FFFF:127.0.0.1"]) assert.equal(isDirectLocal(req(a, { host: "localhost", "accept-encoding": "gzip" })), true, a);
  });
  test("any proxy marker on a loopback peer makes it remote", () => {
    for (const h of ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip", "via", "tailscale-user-login", "tailscale-funnel-request"])
      assert.equal(isDirectLocal(req("127.0.0.1", { [h]: "x" })), false, h);
    assert.equal(isDirectLocal(req("::1", { "tailscale-user-login": "someone@example.com" })), false);
  });
  test("a non-loopback peer, or no socket at all, is never direct-local", () => {
    for (const a of ["100.64.0.7", "192.168.1.5", "::ffff:10.0.0.1", "fd7a::1", "128.0.0.1", "", undefined]) assert.equal(isDirectLocal(req(a)), false, String(a));
  });
});

describe("REST gzip", () => {
  test("Accept-Encoding gzip gets a gzip transcript that decodes to the identity one (in-process: no socket, not direct-local)", async () => {
    const identity = await app.request(transcriptUrl);
    assert.equal(identity.status, 200);
    assert.equal(identity.headers.get("content-encoding"), null);
    const text = await identity.text();

    const gz = await app.request(transcriptUrl, { headers: { "Accept-Encoding": "gzip, deflate, br" } });
    assert.equal(gz.status, 200);
    assert.equal(gz.headers.get("content-encoding"), "gzip");
    assert.match(gz.headers.get("vary") ?? "", /accept-encoding/i);
    assert.equal(gz.headers.get("content-type"), "application/json");
    const body = Buffer.from(await gz.arrayBuffer());
    assert.ok(body.length < text.length / 3, `gzip ${body.length} vs identity ${text.length}`);
    assert.deepEqual(JSON.parse(gunzipSync(body).toString()), JSON.parse(text));
  });


  test("an image is sent as is, whatever the client accepts", async () => {
    writeFileSync(pngPath, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4096, 7)]));
    const res = await app.request(`/api/attachment?path=${encodeURIComponent(pngPath)}`, { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("content-encoding"), null);
    assert.equal((await res.arrayBuffer()).byteLength, 8 + 4096);
  });
});

