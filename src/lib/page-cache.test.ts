import assert from "node:assert/strict";
import { test } from "node:test";
import { forgetAll, PAGE_CACHE_MAX, recall, remember } from "./page-cache";

test("a read's last answer is recalled by its key; the oldest go past the cap", () => {
  forgetAll();
  assert.equal(recall("po:prj_a:info"), undefined);
  remember("po:prj_a:info", { n: 1 });
  remember("po:prj_a:info", { n: 2 });
  assert.deepEqual(recall("po:prj_a:info"), { n: 2 });
  for (let i = 0; i < PAGE_CACHE_MAX; i++) remember(`k${i}`, i);
  assert.equal(recall("po:prj_a:info"), undefined, "the oldest was dropped");
  assert.equal(recall(`k${PAGE_CACHE_MAX - 1}`), PAGE_CACHE_MAX - 1);
  // Remembering again makes a key the newest.
  remember("k0", "again");
  remember("extra", 1);
  assert.equal(recall("k0"), "again");
  assert.equal(recall("k1"), undefined);
  forgetAll();
});
