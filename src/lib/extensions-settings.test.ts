import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewTitle } from "./extensions-settings";

test("the review's title says what it does, in the extension's own title", () => {
  assert.equal(reviewTitle("install", "Stand-in"), "Add Stand-in?");
  assert.equal(reviewTitle("approve", "Stand-in"), "Approve Stand-in?");
  assert.equal(reviewTitle("folder", "Stand-in"), "Use this folder for Stand-in?");
});
