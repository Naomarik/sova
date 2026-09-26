import assert from "node:assert/strict";
import { test } from "node:test";
import { MESSAGES_CAP } from "../../shared/baton";
import { parseLimit } from "./baton-settings-draft";

test("a typed message limit: whole numbers within the shared bounds only", () => {
  assert.equal(parseLimit("60"), 60);
  assert.equal(parseLimit(" 1 "), 1);
  assert.equal(parseLimit(String(MESSAGES_CAP)), MESSAGES_CAP);
  for (const bad of ["", "0", "-5", "2.5", "1e2", "abc", String(MESSAGES_CAP + 1)]) assert.equal(parseLimit(bad), null, bad);
});
