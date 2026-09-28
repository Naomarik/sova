// Run: npx tsx --test server/compression.test.ts
// Transfer compression: permessage-deflate on /ws/chat and /ws/watch, gzip on /api/*, for every
// client but a browser on this machine connecting directly (server/compression.ts). Uses a
// throwaway PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written, and the server
// is imported with PORT=0 so it binds an ephemeral port instead of the dev port.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { WebSocket } from "ws";
import type { TranscriptItem, WatchServerMessage } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-compression-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
process.env.PORT = "0";
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
// An image directly in /tmp, the one place /api/attachment serves outside a session's folder.
const pngPath = `/tmp/sova-compression-test-${randomUUID()}.png`;
writeFileSync(pngPath, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4096, 7)]));

const { app, server } = await import("./index");
const { isDirectLocal } = await import("./compression");
if (!server.listening) await new Promise((r) => server.once("listening", r));
const port = (server.address() as AddressInfo).port;

after(() => {
  server.close();
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(pngPath, { force: true });
});

const transcriptUrl = `/api/transcript?path=${encodeURIComponent(sessionPath)}`;

/** Open /ws/watch on the session and read its snapshot, with the handshake's extensions and the
    bytes that crossed the socket for it. */
async function watchSnapshot(perMessageDeflate: boolean, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/watch?path=${encodeURIComponent(sessionPath)}`, { perMessageDeflate, headers });
  let extensions = "";
  ws.once("upgrade", (res) => void (extensions = String(res.headers["sec-websocket-extensions"] ?? "")));
  const [raw] = await new Promise<[string]>((resolve, reject) => {
    ws.once("message", (d: Buffer) => resolve([d.toString()]));
    ws.once("error", reject);
  });
  const bytesRead = (ws as unknown as { _socket: { bytesRead: number } })._socket.bytesRead;
  const result = { extensions, msg: JSON.parse(raw) as WatchServerMessage, length: raw.length, bytesRead };
  ws.close();
  await new Promise((r) => ws.once("close", r));
  return result;
}

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

describe("WebSocket permessage-deflate", () => {
  test("through a proxy it is negotiated, without context takeover either way, and carries the same snapshot", async () => {
    const plain = await watchSnapshot(false, TAILSCALE);
    const deflated = await watchSnapshot(true, TAILSCALE);
    assert.equal(plain.extensions, "");
    assert.match(deflated.extensions, /^permessage-deflate/);
    assert.match(deflated.extensions, /server_no_context_takeover/);
    assert.match(deflated.extensions, /client_no_context_takeover/);
    assert.equal(deflated.msg.type, "snapshot");
    assert.deepEqual(deflated.msg, plain.msg);
    assert.equal((deflated.msg as { items: TranscriptItem[] }).items.length, 40);
    // The snapshot crossed the socket compressed: fewer bytes read than the uncompressed read
    // (both include the same-sized handshake answer, bar the extension header).
    assert.ok(plain.bytesRead > plain.length, `plain read ${plain.bytesRead} ≥ its ${plain.length}-byte frame`);
    assert.ok(deflated.bytesRead < plain.bytesRead / 3, `deflated read ${deflated.bytesRead} vs plain ${plain.bytesRead}`);
  });

  test("a direct client on this machine offering it is declined; one proxy header is enough to get it", async () => {
    const direct = await watchSnapshot(true);
    assert.equal(direct.extensions, "");
    assert.ok(direct.bytesRead > direct.length, "sent uncompressed");
    assert.match((await watchSnapshot(true, { "X-Forwarded-For": "100.64.0.7" })).extensions, /^permessage-deflate/);
    assert.match((await watchSnapshot(true, { "Tailscale-User-Login": "someone@example.com" })).extensions, /^permessage-deflate/);
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

  test("over a real socket: gzip through a proxy, identity for a direct client on this machine", async () => {
    const proxied = await fetch(`http://127.0.0.1:${port}${transcriptUrl}`, { headers: { "Accept-Encoding": "gzip", ...TAILSCALE } });
    assert.equal(proxied.headers.get("content-encoding"), "gzip");
    assert.equal(((await proxied.json()) as { items: TranscriptItem[] }).items.length, 40); // fetch decodes it
    const direct = await fetch(`http://127.0.0.1:${port}${transcriptUrl}`, { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(direct.headers.get("content-encoding"), null);
    assert.equal(((await direct.json()) as { items: TranscriptItem[] }).items.length, 40);
  });

  test("an image is sent as is, whatever the client accepts", async () => {
    const res = await app.request(`/api/attachment?path=${encodeURIComponent(pngPath)}`, { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("content-encoding"), null);
    assert.equal((await res.arrayBuffer()).byteLength, 8 + 4096);
  });
});
