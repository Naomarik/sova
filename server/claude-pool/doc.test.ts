// Run: pnpm test -- server/claude-pool/doc.test.ts. The pool document's bounds on a peer's stamps
// (§app.claude-logins/pool): pure, no I/O.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { emptyDoc, mergeDocs, MAX_POOL_SKEW_MS, MAX_SEQ_STEP, newPoolLogin, plausible, reg, type PoolDoc } from "./doc";

const L1 = "l-000000a1";
const L2 = "l-000000a2";
const NOW = 1_000_000_000;
const HOUR = 3_600_000;

function ours(): PoolDoc {
  const doc = emptyDoc();
  doc.keeper = reg("k", NOW - 1000, "k");
  doc.order = reg([L1], NOW - 1000, "k");
  doc.logins[L1] = newPoolLogin({ addedAt: 1, identity: null, label: "work", enabled: true, device: "d", seq: 5, now: NOW - 1000 });
  return doc;
}

describe("a peer's implausible stamps", () => {
  test("constants: an hour of skew, 10,000 holder steps", () => {
    assert.equal(MAX_POOL_SKEW_MS, HOUR);
    assert.equal(MAX_SEQ_STEP, 10_000);
  });

  test("removed, keeper and order stamped at 9e15, or a holder seq of 2^52, change nothing", () => {
    const mine = ours();
    const theirs = structuredClone(mine);
    theirs.logins[L1]!.removed = reg(true, 9e15, "x");
    theirs.logins[L1]!.holder = { device: "evil", free: false, seq: 2 ** 52, at: NOW };
    theirs.keeper = reg("evil", 9e15, "x");
    theirs.order = reg([], 9e15, "x");
    for (const key of ["label", "enabled", "pin", "standing", "returnAsk", "usage"] as const) {
      (theirs.logins[L1]![key] as { at: number }).at = 9e15;
    }
    theirs.logins[L1]!.label = reg("evil", 9e15, "x");
    const { doc, ignored } = plausible(theirs, mine, NOW);
    assert.deepEqual(mergeDocs(mine, doc), mine, "nothing changes, nothing is deleted");
    assert.deepEqual(ignored.sort(), ["keeper", "order", ...["enabled", "holder", "label", "pin", "removed", "returnAsk", "standing", "usage"].map((f) => `${L1}.${f}`)].sort());
  });

  test("a holder stamped far ahead is ignored too", () => {
    const mine = ours();
    const theirs = structuredClone(mine);
    theirs.logins[L1]!.holder = { device: "d", free: false, seq: 5, at: 9e15 };
    assert.deepEqual(plausible(theirs, mine, NOW).ignored, [`${L1}.holder`]);
  });

  test("the same edits at plausible stamps still apply", () => {
    const mine = ours();
    const theirs = structuredClone(mine);
    theirs.logins[L1]!.removed = reg(true, NOW, "e");
    theirs.logins[L1]!.holder = { device: "e", free: false, seq: 5 + MAX_SEQ_STEP, at: NOW };
    theirs.keeper = reg("e", NOW, "e");
    const { doc, ignored } = plausible(theirs, mine, NOW);
    assert.deepEqual(ignored, []);
    const merged = mergeDocs(mine, doc);
    assert.equal(merged.logins[L1]!.removed.value, true);
    assert.equal(merged.logins[L1]!.holder.device, "e");
    assert.equal(merged.keeper.value, "e");
  });

  test("a holder more than 10,000 steps ahead of ours is ignored; a new login's above 2^32 is not taken", () => {
    const mine = ours();
    const theirs = structuredClone(mine);
    theirs.logins[L1]!.holder = { device: "e", free: false, seq: 5 + MAX_SEQ_STEP + 1, at: NOW };
    theirs.logins[L2] = newPoolLogin({ addedAt: 2, identity: null, enabled: true, device: "e", seq: 2 ** 32 + 1, now: NOW });
    const { doc, ignored } = plausible(theirs, mine, NOW);
    assert.deepEqual(ignored.sort(), [`${L1}.holder`, `${L2}.holder`]);
    const merged = mergeDocs(mine, doc);
    assert.equal(merged.logins[L1]!.holder.device, "d");
    assert.equal(merged.logins[L2], undefined, "a new login with no plausible holder is not learned yet");
    theirs.logins[L2]!.holder.seq = 2 ** 32;
    assert.equal(mergeDocs(mine, plausible(theirs, mine, NOW).doc).logins[L2]!.holder.device, "e", "2^32 itself is fine");
  });

  test("a new login's far-ahead fields read as unset until their time; the login itself is learned", () => {
    const mine = ours();
    const theirs = structuredClone(mine);
    theirs.logins[L2] = newPoolLogin({ addedAt: 2, identity: null, label: "home", enabled: true, device: "e", now: NOW });
    theirs.logins[L2]!.removed = reg(true, 9e15, "x");
    theirs.logins[L2]!.label = reg("evil", 9e15, "x");
    const { doc, ignored } = plausible(theirs, mine, NOW);
    assert.deepEqual(ignored.sort(), [`${L2}.label`, `${L2}.removed`]);
    const l2 = mergeDocs(mine, doc).logins[L2]!;
    assert.equal(l2.removed.value, false);
    assert.equal(l2.label.value, null);
    assert.equal(l2.holder.device, "e");
  });

  test("an edit 30 minutes ahead applies; one 2 hours ahead applies only once the clock passes it", () => {
    const mine = ours();
    const soon = structuredClone(mine);
    soon.logins[L1]!.label = reg("soon", NOW + 30 * 60_000, "e");
    assert.equal(mergeDocs(mine, plausible(soon, mine, NOW).doc).logins[L1]!.label.value, "soon");
    const later = structuredClone(mine);
    later.logins[L1]!.label = reg("later", NOW + 2 * HOUR, "e");
    assert.equal(mergeDocs(mine, plausible(later, mine, NOW).doc).logins[L1]!.label.value, "work");
    assert.equal(mergeDocs(mine, plausible(later, mine, NOW + HOUR + 1).doc).logins[L1]!.label.value, "later");
  });

  test("the bounded merge stays commutative and idempotent among plausible documents", () => {
    const a = ours();
    const b = structuredClone(a);
    a.logins[L1]!.pin = reg("d", NOW, "a");
    b.logins[L1]!.label = reg("x", NOW + 1, "b");
    const ab = mergeDocs(a, plausible(b, a, NOW).doc);
    const ba = mergeDocs(b, plausible(a, b, NOW).doc);
    assert.deepEqual(ab, ba);
    assert.deepEqual(mergeDocs(ab, plausible(ab, ab, NOW).doc), ab);
  });
});
