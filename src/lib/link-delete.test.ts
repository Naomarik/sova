// Run: pnpm exec tsx --test src/lib/link-delete.test.ts. Every public link's Delete words.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  allDeleted,
  COPY_LINK_GONE,
  copyLinkDeleted,
  DELETE_ASK,
  DELETE_LINK,
  DELETE_OWNER_LINK,
  DELETE_OWNER_LINK_ASK,
  DELETE_THIS_LINK,
  deleteAllConfirm,
  deleteAllLabel,
  deleteAllLine,
  deleteLinkConfirm,
  DELETING,
  LINK_DELETED,
  LINK_GONE,
  linkGone,
  NEW_LINK_TIP,
  newLinkFor,
  OWNER_LINK_DELETED,
} from "./link-delete";

test("a link's Delete asks, and its line says the link stops working for good", () => {
  assert.equal(DELETE_LINK, "Delete Link");
  assert.equal(DELETE_ASK, "Delete?");
  assert.equal(deleteLinkConfirm("Ana"), "Delete Ana's Link?");
  assert.equal(DELETE_THIS_LINK, "Delete This Link?");
  assert.equal(LINK_GONE, "The link stops working for good.");
  assert.equal(linkGone("Ana"), "Ana's link stops working for good.");
  assert.equal(DELETING, "Deleting…");
  assert.equal(LINK_DELETED, "Link deleted.");
});

test("a copy's link: the copy keeps running", () => {
  assert.equal(COPY_LINK_GONE, "The link stops working for good. The copy keeps running.");
  assert.equal(copyLinkDeleted("web.http", "slot 2"), "The web.http link of slot 2 is deleted.");
});

test("a person's links all at once, and the owner link", () => {
  assert.equal(deleteAllLabel(3), "Delete All 3 Links");
  assert.equal(deleteAllConfirm(3), "Delete All 3 Links?");
  assert.equal(deleteAllLine("Ana", 3), "Ana's 3 links stop working for good. Their sessions, messages and visits stay.");
  assert.equal(allDeleted(3), "Deleted 3 links.");
  assert.equal(DELETE_OWNER_LINK, "Delete Owner Link");
  assert.equal(DELETE_OWNER_LINK_ASK, "Delete Owner Link?");
  assert.equal(OWNER_LINK_DELETED, "Owner link deleted.");
});

test("a new link's tooltip says the older one is deleted", () => {
  assert.equal(NEW_LINK_TIP, "Makes a new link and deletes the one you sent before");
  assert.equal(newLinkFor("Ana"), "Makes a new link for Ana and deletes their older one");
});
