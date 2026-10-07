// Run: node scripts/run-tests.mjs server/share-ws-hop.test.ts. The gateway's `/ws/h` hop's handshake
// check (server/share/ws-hop.ts validHandshake), in process; the hop's lifecycle over real sockets is
// share-ws-hop.integration.test.ts. A throwaway PI_CODING_AGENT_DIR; ~/.pi untouched.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-ws-hop-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const { validHandshake } = await import("./share/ws-hop");

const GOOD_KEY = Buffer.alloc(16, 7).toString("base64");

test("B2: validHandshake refuses a Connection header without the upgrade token", () => {
  const req = { method: "GET", headers: { upgrade: "websocket", connection: "keep-alive", "sec-websocket-key": GOOD_KEY, "sec-websocket-version": "13" } };
  assert.equal(validHandshake(req as never), false);
  assert.equal(validHandshake({ ...req, headers: { ...req.headers, connection: "keep-alive, Upgrade" } } as never), true);
});
