// The rename bridge: read-old/write-both, with falsy-but-real values preserved. These tests exist
// because a migration that drops "0" or "" is how a closed folder reopens itself after a rebrand.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { dualGet, dualRemove, dualSet } from "./storage-keys";

/** Minimal in-memory Storage; a `blocked` one throws like a hardened browser's. */
function memStorage(blocked = false): Storage & { dump(): Map<string, string> } {
  const map = new Map<string, string>();
  const guard = () => {
    if (blocked) throw new Error("denied");
  };
  return {
    get length() {
      guard();
      return map.size;
    },
    clear: () => {
      guard();
      map.clear();
    },
    getItem: (k: string) => {
      guard();
      return map.has(k) ? map.get(k)! : null;
    },
    key: (i: number) => {
      guard();
      return [...map.keys()][i] ?? null;
    },
    removeItem: (k: string) => {
      guard();
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      guard();
      map.set(k, v);
    },
    dump: () => map,
  };
}

describe("dualGet", () => {
  test("reads the new key when present", () => {
    const s = memStorage();
    s.setItem("sova:k", "new");
    assert.equal(dualGet(s, "sova:k", "pi-web:k"), "new");
  });
  test("falls back to the legacy key", () => {
    const s = memStorage();
    s.setItem("pi-web:k", "old");
    assert.equal(dualGet(s, "sova:k", "pi-web:k"), "old");
  });
  test("new wins when both exist", () => {
    const s = memStorage();
    s.setItem("sova:k", "new");
    s.setItem("pi-web:k", "old");
    assert.equal(dualGet(s, "sova:k", "pi-web:k"), "new");
  });
  test("falsy-but-real values are preserved, not treated as absent", () => {
    for (const v of ["0", "", "false"]) {
      const legacy = memStorage();
      legacy.setItem("pi-web:k", v);
      assert.equal(dualGet(legacy, "sova:k", "pi-web:k"), v, `legacy ${JSON.stringify(v)}`);
      const fresh = memStorage();
      fresh.setItem("sova:k", v);
      fresh.setItem("pi-web:k", "other");
      assert.equal(dualGet(fresh, "sova:k", "pi-web:k"), v, `new ${JSON.stringify(v)}`);
    }
  });
  test("a blocked store reads as null, never throws", () => {
    assert.equal(dualGet(memStorage(true), "sova:k", "pi-web:k"), null);
  });
});

describe("dualSet", () => {
  test("writes BOTH keys, so a pre-rebrand build after a rollback sees the same value", () => {
    const s = memStorage();
    dualSet(s, "sova:k", "pi-web:k", "v");
    assert.equal(s.getItem("sova:k"), "v");
    assert.equal(s.getItem("pi-web:k"), "v");
  });
  test("overwrites a stale legacy mirror too", () => {
    const s = memStorage();
    s.setItem("pi-web:k", "stale");
    dualSet(s, "sova:k", "pi-web:k", "v");
    assert.equal(s.dump().get("pi-web:k"), "v");
  });
  test("blocked store never throws", () => {
    dualSet(memStorage(true), "sova:k", "pi-web:k", "v"); // no assertion beyond not throwing
  });
});

describe("dualRemove", () => {
  test("removes both spellings, so a cleared choice cannot resurrect from the legacy key", () => {
    const s = memStorage();
    s.setItem("sova:k", "v");
    s.setItem("pi-web:k", "v");
    dualRemove(s, "sova:k", "pi-web:k");
    assert.equal(s.getItem("sova:k"), null);
    assert.equal(s.getItem("pi-web:k"), null);
  });
  test("blocked store never throws", () => {
    dualRemove(memStorage(true), "sova:k", "pi-web:k");
  });
});
