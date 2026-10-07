// Run: node scripts/run-tests.mjs server/share-front.integration.test.ts. The gateway front's Verify
// against loopback stub servers and the real share edge, with real fetch (its redirect handling
// included); https is rewritten to the stub's http by an injected fetch. The guides and Verify's
// judging in process are share-front.test.ts.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-share-front-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const { verifyPublicUrl } = await import("./share/front");
const { createShareServer } = await import("./share/edge");

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));
async function stub(handler: Parameters<typeof createServer>[1]): Promise<typeof fetch> {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  return (input, init) => fetch(String(input).replace("https://share.example.com", `http://127.0.0.1:${port}`), init);
}
const sovaNotFound = (_req: unknown, res: import("node:http").ServerResponse) => {
  res.writeHead(404, { "content-type": "application/json", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify({ error: "Unknown link.", code: "not-found" }));
};

test("verify: another server's 404, a 200 and a redirect fail", async () => {
  const other = await stub((_q, res) => res.writeHead(404).end("nope"));
  assert.equal((await verifyPublicUrl("https://share.example.com", { fetch: other })).ok, false);
  const ok200 = await stub((_q, res) => res.writeHead(200).end("hi"));
  assert.deepEqual(await verifyPublicUrl("https://share.example.com", { fetch: ok200 }), { ok: false, status: 200, error: "Got 200, not Sova's answer" });
  let followed = false;
  const redirect = await stub((req, res) => {
    if (req.url === "/elsewhere") followed = true;
    res.writeHead(302, { location: "/elsewhere" }).end();
  });
  const r = await verifyPublicUrl("https://share.example.com", { fetch: redirect });
  assert.equal(r.ok, false);
  assert.equal(r.status, 302);
  assert.equal(followed, false);
});

test("verify: the real share edge answers the signature", async () => {
  const s = createShareServer();
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  const f: typeof fetch = (input, init) => fetch(String(input).replace("https://share.example.com", `http://127.0.0.1:${port}`), init);
  assert.deepEqual(await verifyPublicUrl("https://share.example.com", { fetch: f }), { ok: true, status: 404 });
});
