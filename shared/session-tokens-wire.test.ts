// Run: pnpm test -- shared/session-tokens-wire.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeSessionTokens, encodeSessionTokens } from "./session-tokens-wire";

test("a row's tokens survive the trip as one string", () => {
  for (const t of [
    { end: 58_000_000, own: [100, 0, 50], own30: 150 },
    { end: 1, workers: [12], workers30: 40 },
    { end: 2, own: [1], own30: 9, workers: [3, 4], workers30: 7, partial: true as const },
  ]) assert.deepEqual(decodeSessionTokens(encodeSessionTokens(t)), t);
  assert.equal(encodeSessionTokens({ end: 7, own: [1, 2], own30: 3 }), "7 3 0 1,2 -");
  assert.equal(encodeSessionTokens({ end: 7, workers: [5], workers30: 5, partial: true }), "7 0 5 - 5 p");
});

test("anything else is no row, never a guessed number", () => {
  for (const bad of [undefined, 3, "", "7 3 0 1,2", "7 3 0 1,x -", "7 3 0 1,2 - q", "-1 0 0 - -", "7 3 0 1,,2 -", "7 3 0 1,2 - p extra"]) assert.equal(decodeSessionTokens(bad), null, String(bad));
});
