// bun assert-throws-empty-message.mjs  vs  node assert-throws-empty-message.mjs
// Node 25: assert.throws(fn, "") takes "" as the (empty) failure message and passes when fn throws.
// Bun 1.4.2: it throws ERR_INVALID_ARG_VALUE ("The argument 'error' may not be an empty object").
import assert from "node:assert";
try {
  assert.throws(() => { throw new Error("boom"); }, "");
  console.log("passed: an empty-string message is accepted (Node)");
} catch (e) {
  console.log("threw:", e.code ?? "", e.message);
}
