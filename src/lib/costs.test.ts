import assert from "node:assert/strict";
import { test } from "node:test";
import { usd } from "./costs";

test("dollars: symbol first, comma thousands, 2 decimals; a spend under a cent is <$0.01, never $0.00", () => {
  assert.equal(usd(1240), "$1,240.00");
  assert.equal(usd(12.475), "$12.48");
  assert.equal(usd(0.08), "$0.08");
  assert.equal(usd(0.004), "<$0.01");
  assert.equal(usd(0.005), "$0.01");
  assert.equal(usd(0), "$0.00");
  assert.equal(usd(1_234_567.891), "$1,234,567.89");
});
