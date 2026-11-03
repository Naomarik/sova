// Run: npx tsx --test src/lib/merge-queue-requests-client.test.ts
// A refusal of 'How it lands' comes back as a refusal, never as a success (MergeQueueLandHow shows it as its error):
// the route's envelope with a 409, as it answers while a release is open.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { clearLandHowOverride, saveLandHow } from "./merge-queue-requests-client";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const answer = (status: number, body: unknown) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;
};
const REFUSED = { error: { code: "busy", message: "Release v0.4.0 is open: how a branch lands stays as it is until it's published or abandoned." } };

test("Clear Override refused while a release is open answers the route's words, not success", async () => {
  answer(409, REFUSED);
  assert.deepEqual(await clearLandHowOverride("prj_1"), { ok: false, message: REFUSED.error.message, code: "busy" });
});

test("setting how it lands refused answers the same way, on either side", async () => {
  answer(409, REFUSED);
  assert.deepEqual(await saveLandHow("prj_1", "github-pr", "computer"), { ok: false, message: REFUSED.error.message, code: "busy" });
  assert.deepEqual(await saveLandHow("prj_1", "github-pr", "project"), { ok: false, message: REFUSED.error.message, code: "busy" });
});

test("an accepted clear is a success", async () => {
  answer(200, { ok: true });
  assert.deepEqual(await clearLandHowOverride("prj_1"), { ok: true, body: { ok: true } });
});
