// Run: node scripts/run-tests.mjs server/insights-agents-tokens.integration.test.ts
// GET /api/insights/agents carries per-session tokens only when asked (§app.insights/session-token-rate):
// the app polls it on every page for the sidebar's feed, and only the Agents board asks (`?tokens=1`).
// On a hermetic server (server/testing/hermetic-server.ts), the route as the service serves it.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startHermeticServer, type HermeticServer } from "./testing/hermetic-server";

let s: HermeticServer;
before(async () => {
  s = await startHermeticServer();
});
after(async () => {
  const changed = await s?.stop();
  assert.deepEqual(changed ?? [], [], "the sentinel home is untouched");
});

const get = async (path: string) => {
  const res = await fetch(`${s.base}${path}`, { headers: { "x-sova-token": s.token } });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  return JSON.parse(body) as Record<string, unknown>;
};

test("without ?tokens=1 the answer has no tokens field; with it, tokens is an object", async () => {
  const plain = await get("/api/insights/agents");
  assert.ok(Array.isArray(plain.sessions), "the ordinary answer");
  assert.equal("tokens" in plain, false, "no tokens unless asked");

  const other = await get("/api/insights/agents?tokens=0");
  assert.equal("tokens" in other, false, "only 1 asks");

  const asked = await get("/api/insights/agents?tokens=1");
  assert.ok(Array.isArray(asked.sessions), "the same answer otherwise");
  assert.equal(typeof asked.tokens, "object", "asked: tokens is sent, {} when none");
  assert.notEqual(asked.tokens, null);
  assert.deepEqual(Object.keys(asked).sort(), [...Object.keys(plain), "tokens"].sort(), "the one difference is the field");
});
