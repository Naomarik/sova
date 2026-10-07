// Run: node scripts/run-tests.mjs server/compression.integration.test.ts
// Transfer compression over real sockets: permessage-deflate on /ws/watch through a counting relay,
// and gzip on /api/* for every client but a browser on this machine connecting directly
// (server/compression.ts). The in-process decisions are compression.test.ts. Uses a throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written, and the server is
// imported with PORT=0 so it binds an ephemeral port instead of the dev port.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
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

const { app, server } = await import("./index");
const { AUTH_COOKIE, sovaToken } = await import("./auth");
// Whether a ws server here can negotiate permessage-deflate at all (not on Bun 1.4.2: docs/bun-quirks.md,
// ws-deflate). Where it can't, the same requests must still deliver the snapshot whole, uncompressed.
// Awaited before any test or hook is registered: a top-level await between registrations lets the
// runner finish the tests so far and run `after` early.
const deflate = await (await import("./runtime-quirks")).wsNegotiatesDeflate();
// The real-socket requests below pass the main listener's gate as a browser would: with the cookie.
const AUTH = { Cookie: `${AUTH_COOKIE}=${sovaToken()}` };
if (!server.listening) await new Promise((r) => server.once("listening", r));
const port = (server.address() as AddressInfo).port;

after(() => {
  server.close();
  rmSync(agentDir, { recursive: true, force: true });
});

const transcriptUrl = `/api/transcript?path=${encodeURIComponent(sessionPath)}`;

/** A TCP relay to the server that counts the bytes the server sent through it. The count is read
    off the wire, not off the client's socket (ws's `_socket` does not exist on every runtime: see
    docs/bun-quirks.md). */
async function countingRelay(): Promise<{ port: number; bytes: () => number; close: () => void }> {
  let bytes = 0;
  const relay = createServer((client) => {
    const upstream = connect(port, "127.0.0.1");
    upstream.on("data", (d: Buffer) => void (bytes += d.length));
    client.pipe(upstream).pipe(client);
    const end = () => { client.destroy(); upstream.destroy(); };
    client.on("error", end).on("close", end);
    upstream.on("error", end).on("close", end);
  });
  await new Promise<void>((r) => relay.listen(0, "127.0.0.1", () => r()));
  return { port: (relay.address() as AddressInfo).port, bytes: () => bytes, close: () => relay.close() };
}

/** Open /ws/watch on the session and read its snapshot, with the handshake's extensions and the
    bytes that crossed the socket for it. */
async function watchSnapshot(perMessageDeflate: boolean, headers: Record<string, string> = {}) {
  const relay = await countingRelay();
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/ws/watch?path=${encodeURIComponent(sessionPath)}`, { perMessageDeflate, headers: { ...AUTH, ...headers } });
  let extensions = "";
  ws.once("upgrade", (res) => void (extensions = String(res.headers["sec-websocket-extensions"] ?? "")));
  const [raw] = await new Promise<[string]>((resolve, reject) => {
    ws.once("message", (d: Buffer) => resolve([d.toString()]));
    ws.once("error", reject);
  });
  const bytesRead = relay.bytes();
  const result = { extensions, msg: JSON.parse(raw) as WatchServerMessage, length: raw.length, bytesRead };
  ws.close();
  await new Promise((r) => ws.once("close", r));
  relay.close();
  return result;
}

// What tailscale serve adds when it forwards the phone to 127.0.0.1 (ipn/ipnlocal/serve.go).
const TAILSCALE = { "X-Forwarded-Host": "host.example.ts.net:8443", "X-Forwarded-Proto": "https", "X-Forwarded-For": "100.64.0.7" };

describe("WebSocket permessage-deflate", () => {
  test("through a proxy it is negotiated, without context takeover either way, and carries the same snapshot", async () => {
    const plain = await watchSnapshot(false, TAILSCALE);
    const deflated = await watchSnapshot(true, TAILSCALE);
    assert.equal(plain.extensions, "");
    if (!deflate) {
      // No deflate here: the offer is declined and the snapshot arrives whole, uncompressed.
      assert.equal(deflated.extensions, "");
      assert.deepEqual(deflated.msg, plain.msg);
      assert.equal((deflated.msg as { items: TranscriptItem[] }).items.length, 40);
      assert.ok(deflated.bytesRead > deflated.length, `uncompressed: read ${deflated.bytesRead} ≥ its ${deflated.length}-byte frame`);
      return;
    }
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
    // Where a ws server can't deflate (above), a proxied client gets no extension either.
    const proxied = deflate ? /^permessage-deflate/ : /^$/;
    assert.match((await watchSnapshot(true, { "X-Forwarded-For": "100.64.0.7" })).extensions, proxied);
    assert.match((await watchSnapshot(true, { "Tailscale-User-Login": "someone@example.com" })).extensions, proxied);
  });
});

describe("REST gzip", () => {
  test("over a real socket: gzip through a proxy, identity for a direct client on this machine", async () => {
    const proxied = await fetch(`http://127.0.0.1:${port}${transcriptUrl}`, { headers: { "Accept-Encoding": "gzip", ...TAILSCALE, ...AUTH } });
    assert.equal(proxied.headers.get("content-encoding"), "gzip");
    assert.equal(((await proxied.json()) as { items: TranscriptItem[] }).items.length, 40); // fetch decodes it
    const direct = await fetch(`http://127.0.0.1:${port}${transcriptUrl}`, { headers: { "Accept-Encoding": "gzip", ...AUTH } });
    assert.equal(direct.headers.get("content-encoding"), null);
    assert.equal(((await direct.json()) as { items: TranscriptItem[] }).items.length, 40);
  });
});
