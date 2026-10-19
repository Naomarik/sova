// Run: pnpm test -- server/extension-offers-row.test.ts
// The row place in what an extension offers (§app.extensions/row-chips): `screens` may name "row";
// a name that is no place is dropped, never the entry or its other places.
import assert from "node:assert/strict";
import { test } from "node:test";
import { offersOf, offersPlace, screenPath } from "../shared/extension-offers";

test("row is a place: offered, asked at its own path", () => {
  assert.deepEqual(offersOf("t", { screens: ["row"] }).offers, { screens: ["row"] });
  assert.equal(offersPlace({ screens: ["row"] }, "row"), true);
  assert.equal(offersPlace({ screens: ["reply"] }, "row"), false);
  assert.equal(screenPath("row"), "/api/screens/row");
});

test("a name that is no place is dropped, the places beside it kept", () => {
  const got = offersOf("t", { screens: ["sidebar", "row", "rows", "Row", 7, null, "reply", "row"] });
  assert.deepEqual(got.offers, { screens: ["reply", "row"] });
  assert.equal(got.dropped.length, 1, "logged");
  assert.equal(offersOf("t", { screens: ["sidebar", "rows"] }).offers, null, "nothing valid: no offers at all");
});
