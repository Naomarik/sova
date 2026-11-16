import { test } from "node:test";
import assert from "node:assert/strict";
import { DESIGN_CARD_TYPICAL, designCardEstimate, rememberDesignCardHeight, resetDesignCardHeights } from "./design-card-size";

const memory = () => {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), map };
};

test("a card is estimated at the height this browser last drew it at, else a typical card's", () => {
  resetDesignCardHeights();
  const store = memory();
  assert.equal(designCardEstimate("r1"), DESIGN_CARD_TYPICAL);
  assert.equal(designCardEstimate(undefined), DESIGN_CARD_TYPICAL);
  rememberDesignCardHeight("r1", 1234.4, store);
  assert.equal(designCardEstimate("r1"), 1234);
  rememberDesignCardHeight("r1", 1238, store);
  assert.equal(designCardEstimate("r1"), 1234, "a change of a few px isn't worth writing");
  rememberDesignCardHeight("r1", 1300, store);
  assert.equal(designCardEstimate("r1"), 1300);
  resetDesignCardHeights();
  assert.deepEqual(JSON.parse(store.map.get("sova.lookbook.heights")!), [["r1", 1300]], "it outlives the page");
});

test("only the newest runs are remembered", () => {
  resetDesignCardHeights();
  const store = memory();
  for (let i = 0; i < 70; i++) rememberDesignCardHeight(`r${i}`, 500 + i, store);
  assert.equal(designCardEstimate("r0"), DESIGN_CARD_TYPICAL);
  assert.equal(designCardEstimate("r69"), 569);
  assert.equal((JSON.parse(store.map.get("sova.lookbook.heights")!) as unknown[]).length, 64);
});
