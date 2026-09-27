// Run: npx tsx --test server/compression.test.ts
// Transfer compression: permessage-deflate on /ws/chat and /ws/watch, gzip on /api/*. Uses a
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
async function watchSnapshot(perMessageDeflate: boolean) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/watch?path=${encodeURIComponent(sessionPath)}`, { perMessageDeflate });
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

describe("WebSocket permessage-deflate", () => {
  test("a client that offers it gets it, without context takeover either way, and the same snapshot", async () => {
    const plain = await watchSnapshot(false);
    const deflated = await watchSnapshot(true);
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
});

describe("REST gzip", () => {
  test("Accept-Encoding gzip gets a gzip transcript that decodes to the identity one", async () => {
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

  test("over a real socket too (the Node listener, not app.request)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}${transcriptUrl}`, { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(res.headers.get("content-encoding"), "gzip");
    const items = ((await res.json()) as { items: TranscriptItem[] }).items; // fetch decodes it
    assert.equal(items.length, 40);
  });

  test("an image is sent as is, whatever the client accepts", async () => {
    const res = await app.request(`/api/attachment?path=${encodeURIComponent(pngPath)}`, { headers: { "Accept-Encoding": "gzip" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("content-encoding"), null);
    assert.equal((await res.arrayBuffer()).byteLength, 8 + 4096);
  });
});
