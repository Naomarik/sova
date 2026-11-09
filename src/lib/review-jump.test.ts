// A jump to a review card in another chat: taken once by its own card, never by another, never once stale.
import assert from "node:assert/strict";
import { test } from "node:test";
import { leaveReviewJump, REVIEW_JUMP_MS, takeReviewJump } from "./review-jump";

test("the card it names takes the jump once; another card never does", () => {
  leaveReviewJump("me_1:mr_2", 1000);
  assert.equal(takeReviewJump("me_1:mr_1", 1001), false);
  assert.equal(takeReviewJump("me_1:mr_2", 1002), true);
  assert.equal(takeReviewJump("me_1:mr_2", 1003), false);
});

test("a jump its card doesn't take in time is dropped, so a card drawn later never steals focus", () => {
  leaveReviewJump("me_1:mr_2", 1000);
  assert.equal(takeReviewJump("me_1:mr_2", 1000 + REVIEW_JUMP_MS + 1), false);
  assert.equal(takeReviewJump("me_1:mr_2", 1000 + REVIEW_JUMP_MS + 2), false);
});
