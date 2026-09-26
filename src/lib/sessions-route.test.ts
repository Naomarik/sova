import assert from "node:assert/strict";
import { test } from "node:test";
import { isSessionsHash, SESSIONS_HREF } from "./sessions-route";

test("isSessionsHash: the list route only", () => {
  assert.equal(isSessionsHash(SESSIONS_HREF), true);
  assert.equal(isSessionsHash("#/sessions/"), true);
  for (const h of ["", "#/", "#/home", "#/sessionsx", "#/sessions/x", "#/s/%2Fsessions"]) assert.equal(isSessionsHash(h), false, h);
});
