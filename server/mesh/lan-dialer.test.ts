// Run: pnpm test -- server/mesh/lan-dialer.test.ts
// The dial-out host's redial schedule (§mesh.lan/dialer). Dialing a relay over real TLS:
// lan-dialer.integration.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Backoff } from "./lan-dialer";

test("Backoff: 1 s doubling to 60 s, jittered by a quarter either way, reset to 1 s", () => {
  const mid = new Backoff(() => 0.5);
  assert.deepEqual(Array.from({ length: 9 }, () => mid.next()), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  mid.reset();
  assert.equal(mid.next(), 1000);
  assert.equal(new Backoff(() => 0).next(), 750);
  assert.equal(new Backoff(() => 0.999999).next(), 1250);
  const low = new Backoff(() => 0);
  for (let i = 0; i < 40; i++) low.next();
  assert.equal(low.next(), 45000, "never past 60 s, even jittered");
});
