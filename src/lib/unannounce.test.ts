import assert from "node:assert/strict";
import { test } from "node:test";
import { announcement, announce, unannounce } from "./ui-state";
import { NOT_CONNECTED_YET } from "./shell-mode";

const settle = () => new Promise<void>((r) => queueMicrotask(r));

test("a reason said aloud leaves the live region when it clears on screen; a later sentence stays", async () => {
  announce(NOT_CONNECTED_YET);
  await settle();
  assert.equal(announcement(), NOT_CONNECTED_YET);
  unannounce(NOT_CONNECTED_YET);
  await settle();
  assert.equal(announcement(), "", "the region no longer says a reason the box doesn't show");

  // Something said since is another sentence: taking the reason back leaves it.
  announce(NOT_CONNECTED_YET);
  await settle();
  announce("Shell mode off.");
  await settle();
  unannounce(NOT_CONNECTED_YET);
  await settle();
  assert.equal(announcement(), "Shell mode off.");
});

test("a reason taken back in the same tick it was said never lands", async () => {
  announce("A command is already running in this chat.");
  unannounce("A command is already running in this chat.");
  await settle();
  await settle();
  assert.equal(announcement(), "");
});
