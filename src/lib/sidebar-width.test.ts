// Run: npx tsx --test src/lib/sidebar-width.test.ts (or npm test)
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  maxSidebarWidth,
  MIN_SIDEBAR_WIDTH,
} from "./sidebar-width";

// A window roomy enough that the token cap, not the viewport, decides.
const WIDE = 1920;

test("the default width sits inside the range", () => {
  assert.ok(DEFAULT_SIDEBAR_WIDTH >= MIN_SIDEBAR_WIDTH && DEFAULT_SIDEBAR_WIDTH <= MAX_SIDEBAR_WIDTH);
  assert.equal(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, WIDE), DEFAULT_SIDEBAR_WIDTH);
});

test("a width below the minimum clamps up", () => {
  assert.equal(clampSidebarWidth(120, WIDE), MIN_SIDEBAR_WIDTH);
  assert.equal(clampSidebarWidth(-500, WIDE), MIN_SIDEBAR_WIDTH);
});

test("a width above the maximum clamps down", () => {
  assert.equal(clampSidebarWidth(900, WIDE), MAX_SIDEBAR_WIDTH);
});

test("on a narrow window the viewport cap wins over the token cap", () => {
  // 900 - 440 (--main-min) = 460 of room, below the 560 token cap.
  assert.equal(maxSidebarWidth(900), 460);
  assert.equal(clampSidebarWidth(900, 900), 460);
});

test("a reserved subagents width lowers the cap further", () => {
  assert.equal(maxSidebarWidth(WIDE), MAX_SIDEBAR_WIDTH);
  // 1920 - 440 - 1000 = 480.
  assert.equal(maxSidebarWidth(WIDE, 1000), 480);
  assert.equal(clampSidebarWidth(560, WIDE, 1000), 480);
});

test("an absurdly narrow viewport still allows the minimum", () => {
  assert.equal(maxSidebarWidth(320), MIN_SIDEBAR_WIDTH);
  assert.equal(clampSidebarWidth(300, 320), MIN_SIDEBAR_WIDTH);
  assert.equal(maxSidebarWidth(WIDE, 5000), MIN_SIDEBAR_WIDTH);
  assert.equal(clampSidebarWidth(400, 0), MIN_SIDEBAR_WIDTH);
});

test("clampSidebarWidth rounds to whole pixels", () => {
  assert.equal(clampSidebarWidth(321.4, WIDE), 321);
  assert.equal(clampSidebarWidth(321.5, WIDE), 322);
});
