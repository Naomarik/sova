import assert from "node:assert/strict";
import { test } from "node:test";
import { createLiveSlots, type LiveSlotHolder } from "./design-live-slots";

function holder(log: string[], name: string, priority = false): LiveSlotHolder {
  return { priority, grant: () => log.push(`+${name}`), revoke: () => log.push(`-${name}`) };
}

test("frames past the cap wait, and connect in order as slots come back", () => {
  const log: string[] = [];
  const slots = createLiveSlots(2);
  const a = slots.ask(holder(log, "a"));
  slots.ask(holder(log, "b"));
  slots.ask(holder(log, "c"));
  slots.ask(holder(log, "d"));
  assert.deepEqual(log, ["+a", "+b"]);
  a();
  assert.deepEqual(log, ["+a", "+b", "+c"]);
});

test("leaving the line never grants the one who left", () => {
  const log: string[] = [];
  const slots = createLiveSlots(1);
  const a = slots.ask(holder(log, "a"));
  const b = slots.ask(holder(log, "b"));
  b();
  a();
  assert.deepEqual(log, ["+a"]);
});

test("an open design takes the longest-held tile's place, and that tile returns next", () => {
  const log: string[] = [];
  const slots = createLiveSlots(2);
  slots.ask(holder(log, "a"));
  slots.ask(holder(log, "b"));
  slots.ask(holder(log, "c"));
  const open = slots.ask(holder(log, "open", true));
  assert.deepEqual(log, ["+a", "+b", "-a", "+open"]);
  open();
  assert.deepEqual(log, ["+a", "+b", "-a", "+open", "+a"]);
});

test("open designs never take each other's place", () => {
  const log: string[] = [];
  const slots = createLiveSlots(1);
  slots.ask(holder(log, "x", true));
  slots.ask(holder(log, "y", true));
  assert.deepEqual(log, ["+x"]);
});
