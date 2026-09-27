import assert from "node:assert/strict";
import { test } from "node:test";
import { LIST_REFRESH_EVENT, onListRefresh } from "./list-refresh";

test("a view's refresh request re-reads the list and the Needs you digest, until unsubscribed", () => {
  const target = new EventTarget();
  const reads: string[] = [];
  const off = onListRefresh(target, { list: () => reads.push("list"), attention: () => reads.push("attention") });
  target.dispatchEvent(new Event(LIST_REFRESH_EVENT));
  assert.deepEqual(reads, ["list", "attention"]);
  off();
  target.dispatchEvent(new Event(LIST_REFRESH_EVENT));
  assert.deepEqual(reads, ["list", "attention"]);
});
