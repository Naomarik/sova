// Run: pnpm test -- scripts/sova-not-sent.test.ts
// An in-chat action that never reached its chat (§app.chat-actions/never-replay): the route's
// 503 `not-sent` answer is a failure the command line exits 1 with, never exit 5.
import assert from "node:assert/strict";
import { test } from "node:test";
import { EXIT, exitForAnswer } from "./sova.mjs";
import { NOT_SENT } from "../server/chat-actions";

test("503 not-sent exits 1 (failed), not 5: nothing was sent, so running it again is safe", () => {
  assert.equal(exitForAnswer(503, { error: NOT_SENT, outcome: "not-sent", requestId: "act-1" }), EXIT.failed);
});
