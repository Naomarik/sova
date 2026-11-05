import assert from "node:assert/strict";
import { test } from "node:test";
import { containRect, ICON_SIDE } from "./project-icon-upload";

test("containRect fits the whole picture, centred, with see-through margins: never cropped", () => {
  assert.deepEqual(containRect(512, 512, ICON_SIDE), { x: 0, y: 0, w: 256, h: 256 });
  assert.deepEqual(containRect(600, 200, ICON_SIDE), { x: 0, y: 86, w: 256, h: 85 });
  assert.deepEqual(containRect(100, 400, ICON_SIDE), { x: 96, y: 0, w: 64, h: 256 });
  assert.deepEqual(containRect(32, 32, ICON_SIDE), { x: 0, y: 0, w: 256, h: 256 }, "a small one is scaled up");
  const thin = containRect(10_000, 1, ICON_SIDE);
  assert.ok(thin.h >= 1 && thin.w === 256);
});
