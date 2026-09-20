// Run: npx tsx --test src/lib/socket.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { isPermanentClose } from "./socket";

test("isPermanentClose: only codes no reconnect can fix", () => {
  assert.equal(isPermanentClose(4422), true, "config: the session's cwd is gone");
  assert.equal(isPermanentClose(4500), false, "internal: transient, safe to retry");
  assert.equal(isPermanentClose(4409), false, "busy: the view closes it itself, with its own copy");
  assert.equal(isPermanentClose(1006), false, "abnormal close: a dropped link, keep retrying");
  assert.equal(isPermanentClose(1000), false, "normal close");
});
