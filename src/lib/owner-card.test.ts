import assert from "node:assert/strict";
import { test } from "node:test";
import type { OwnerPageInfo } from "../../shared/orgs";
import { deleteOwnerLine, ownerChangeLine, ownerLinkActions, ownerLinkLine, rotateLine, updateMeta } from "./owner-card";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const DAY = 86_400_000;
const at = (d: number) => new Date(NOW + d * DAY).toISOString();
const kim = { id: "p_kim00001", name: "Kim Lee" };

test("the link line says each state once, and warns when it turned off unused or the owner asked", () => {
  assert.equal(ownerLinkLine(undefined, NOW), null);
  assert.equal(ownerLinkLine({ person: null, link: null, opened: 0 }, NOW), null);
  assert.deepEqual(ownerLinkLine({ person: kim, link: null, opened: 0 }, NOW), { text: "No owner link yet.", warn: false });
  const live = (created: number, expires: number, opened = 4): OwnerPageInfo => ({ person: kim, link: { state: "live", createdAt: at(created), expiresAt: at(expires) }, opened });
  assert.deepEqual(ownerLinkLine(live(-3, 6), NOW), { text: "Owner link made 3d ago · last used yesterday · turns off in 6d if unused · opened 4 times", warn: false });
  assert.deepEqual(ownerLinkLine(live(0, 7, 0), NOW), { text: "Owner link made just now · not used yet · turns off in 7d if unused · opened 0 times", warn: false });
  assert.equal(ownerLinkLine(live(-3, 6, 1), NOW)!.text.endsWith("opened 1 time"), true);
  // A live record past its deadline (read before anything swept it) reads as turned off.
  assert.deepEqual(ownerLinkLine(live(-9, -1), NOW), { text: "The owner link turned off yesterday: nobody used it for a week.", warn: true });
  assert.deepEqual(ownerLinkLine({ person: kim, link: { state: "expired", createdAt: at(-12), expiresAt: at(-2) }, opened: 9 }, NOW), { text: "The owner link turned off 2d ago: nobody used it for a week.", warn: true });
  assert.deepEqual(ownerLinkLine({ person: kim, link: { state: "expired", createdAt: at(-12), expiresAt: at(-2), askedAt: at(-1) }, opened: 9 }, NOW), { text: "Kim asked for a new link yesterday.", warn: true });
  assert.deepEqual(ownerLinkLine({ person: kim, link: { state: "off", createdAt: at(-5), expiresAt: at(2) }, opened: 9 }, NOW), { text: "The owner link is turned off.", warn: false });
});

test("the latest change is said only when the operator made it", () => {
  assert.equal(ownerChangeLine(undefined, NOW), "");
  assert.equal(ownerChangeLine([{ at: at(-2), from: null, to: "p_kim00001", why: "operator" }], NOW), "Set by you 2d ago.");
  assert.equal(ownerChangeLine([{ at: at(-2), from: null, to: "p_kim00001", why: "operator" }, { at: at(-1), from: "p_kim00001", to: null, why: "left" }], NOW), "");
});

test("confirms use the first name and say what stays", () => {
  assert.equal(rotateLine("Kim Lee"), "Kim's current link stops working at once. The new one works from now.");
  assert.equal(deleteOwnerLine("Kim Lee"), "Kim's owner link stops working for good. The conversations and updates stay.");
});

test("an update's log line says who posted it", () => {
  assert.equal(updateMeta({ by: "overseer", at: at(-1) }, NOW), "Posted by the overseer yesterday");
  assert.equal(updateMeta({ by: "operator", at: new Date(NOW - 3 * 3_600_000).toISOString() }, NOW), "Posted when you asked 3h ago");
});

test("an owner set through the Overseer: \"Set by you, via the Overseer\"", () => {
  assert.equal(ownerChangeLine([{ at: at(-2), from: null, to: "p_kim00001", why: "operator", via: "overseer" }], NOW), "Set by you, via the Overseer 2d ago.");
});

test("the owner card's link buttons: Copy Owner Link while the live link is kept, else Get Owner Link (asking first over a live one); Get New Owner Link and Delete while live (§app.owner-page/controls)", () => {
  const link = (state: "live" | "expired" | "off", url?: string) => ({ state, createdAt: at(-1), expiresAt: at(80), ...(url ? { url } : {}) });
  const URL = "https://share.example.invalid/i/abc";
  assert.deepEqual(ownerLinkActions({ person: kim, link: link("live", URL) }), { copy: URL, get: null, rotate: true, remove: true });
  assert.deepEqual(ownerLinkActions({ person: kim, link: link("live") }), { get: "ask", rotate: true, remove: true }, "live, made before tokens were kept");
  assert.deepEqual(ownerLinkActions({ person: kim, link: link("expired") }), { get: "now", rotate: false, remove: false });
  assert.deepEqual(ownerLinkActions({ person: kim, link: link("off") }), { get: "now", rotate: false, remove: false });
  assert.deepEqual(ownerLinkActions({ person: kim, link: null }), { get: "now", rotate: false, remove: false });
  assert.deepEqual(ownerLinkActions(undefined), { get: "now", rotate: false, remove: false });
});
