import assert from "node:assert/strict";
import { test } from "node:test";
import type { OwnerPageInfo } from "../../shared/orgs";
import { ownerChangeLine, ownerLinkLine, rotateLine, turnOffLine, updateMeta } from "./owner-card";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const DAY = 86_400_000;
const at = (d: number) => new Date(NOW + d * DAY).toISOString();
const kim = { id: "p_kim00001", name: "Kim Lee" };

test("the link line says each state once, and warns when it is running out or gone", () => {
  assert.equal(ownerLinkLine(undefined, NOW), null);
  assert.equal(ownerLinkLine({ person: null, link: null, opened: 0 }, NOW), null);
  assert.deepEqual(ownerLinkLine({ person: kim, link: null, opened: 0 }, NOW), { text: "No owner link yet.", warn: false });
  const live = (created: number, expires: number, opened = 4): OwnerPageInfo => ({ person: kim, link: { state: "live", createdAt: at(created), expiresAt: at(expires) }, opened });
  assert.deepEqual(ownerLinkLine(live(-3, 87), NOW), { text: "Owner link made 3d ago · expires in 87d · opened 4 times", warn: false });
  assert.equal(ownerLinkLine(live(-3, 87, 1), NOW)!.text.endsWith("opened 1 time"), true);
  assert.deepEqual(ownerLinkLine(live(-80, 10), NOW), { text: "Owner link expires in 10d.", warn: true });
  // A live record past its expiry (the page read between expiry and the next sweep) reads expired.
  assert.deepEqual(ownerLinkLine(live(-91, -1), NOW), { text: "The owner link expired yesterday.", warn: true });
  assert.deepEqual(ownerLinkLine({ person: kim, link: { state: "expired", createdAt: at(-92), expiresAt: at(-2) }, opened: 9 }, NOW), { text: "The owner link expired 2d ago.", warn: true });
  assert.deepEqual(ownerLinkLine({ person: kim, link: { state: "off", createdAt: at(-5), expiresAt: at(85) }, opened: 9 }, NOW), { text: "The owner link is turned off.", warn: false });
});

test("the latest change is said only when the operator made it", () => {
  assert.equal(ownerChangeLine(undefined, NOW), "");
  assert.equal(ownerChangeLine([{ at: at(-2), from: null, to: "p_kim00001", why: "operator" }], NOW), "Set by you 2d ago.");
  assert.equal(ownerChangeLine([{ at: at(-2), from: null, to: "p_kim00001", why: "operator" }, { at: at(-1), from: "p_kim00001", to: null, why: "left" }], NOW), "");
});

test("confirms use the first name and say what stays", () => {
  assert.equal(rotateLine("Kim Lee"), "Kim's current link stops working at once. The new one works from now.");
  assert.equal(turnOffLine("Kim Lee"), "Kim's owner page stops opening at once. The conversations and updates stay.");
});

test("an update's log line says who posted it", () => {
  assert.equal(updateMeta({ by: "overseer", at: at(-1) }, NOW), "Posted by the overseer yesterday");
  assert.equal(updateMeta({ by: "operator", at: new Date(NOW - 3 * 3_600_000).toISOString() }, NOW), "Posted when you asked 3h ago");
});

test("an owner set through the Overseer: \"Set by you, via the Overseer\"", () => {
  assert.equal(ownerChangeLine([{ at: at(-2), from: null, to: "p_kim00001", why: "operator", via: "overseer" }], NOW), "Set by you, via the Overseer 2d ago.");
});
