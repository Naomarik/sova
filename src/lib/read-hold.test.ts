import assert from "node:assert/strict";
import { test } from "node:test";
import { readHoldTop } from "./read-hold";

test("a transcript that fits with the rows gained stays following", () => {
  // The row read 300px above the view's bottom; everything fits (scrollHeight == clientHeight).
  assert.equal(readHoldTop({ scrollTop: 0, scrollHeight: 900, clientHeight: 900 }, -300, 80), null);
});

test("rows overflowing a short transcript by less than 80px stay following", () => {
  assert.equal(readHoldTop({ scrollTop: 0, scrollHeight: 940, clientHeight: 900 }, -200, 80), null);
  assert.equal(readHoldTop({ scrollTop: 0, scrollHeight: 979, clientHeight: 900 }, -200, 80), null);
});

test("rows overflowing by 80px or more hold at the row read, never above the top", () => {
  assert.equal(readHoldTop({ scrollTop: 0, scrollHeight: 980, clientHeight: 900 }, -200, 80), 0);
  assert.equal(readHoldTop({ scrollTop: 0, scrollHeight: 1400, clientHeight: 900 }, 100, 80), 100);
});

test("a long transcript holds the row read's bottom at the view's bottom", () => {
  assert.equal(readHoldTop({ scrollTop: 5000, scrollHeight: 8000, clientHeight: 900 }, 400, 80), 5400);
});

test("rows gained short enough to leave the row within 80px of the end stay following", () => {
  assert.equal(readHoldTop({ scrollTop: 5000, scrollHeight: 8000, clientHeight: 900 }, 2050, 80), null);
});

test("never past the end", () => {
  assert.equal(readHoldTop({ scrollTop: 5000, scrollHeight: 8000, clientHeight: 900 }, 9000, 80), null);
});
