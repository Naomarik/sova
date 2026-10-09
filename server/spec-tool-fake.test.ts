// The stand-in's manifest record order is the real draft tool's: withNewRecords mirrored, held to the tool's own.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { withNewRecords } from "./spec-tool-fake";

type Rule = (claims: Record<string, number>, added: Record<string, number>) => Record<string, number>;
const TOOL = new URL("../pi-config/extensions/spec/core/sova-spec-draft.mjs", import.meta.url).href;
const real = ((await import(TOOL)) as { withNewRecords: Rule }).withNewRecords;

const IDS = ["§app/a", "§app.a/x", "§app.a/y", "§app.b/z", "§app/b", "§requirements/hosting", "§requirements.hosting/a", "§requirements.hosting/b", "§tools.spec/m", "§tools/spec", "§z"];

/** A deterministic shuffle (mulberry32), so a failure reproduces. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the stand-in's withNewRecords", () => {
  test("places new records exactly where the real tool does", () => {
    const r = rng(1);
    for (let n = 0; n < 2000; n++) {
      const ids = [...IDS].sort(() => r() - 0.5);
      const cut = Math.floor(r() * ids.length);
      const claims = Object.fromEntries(ids.slice(0, cut).map((id, i) => [id, i]));
      const added = Object.fromEntries(ids.slice(cut).filter(() => r() < 0.6).map((id, i) => [id, 100 + i]));
      const fake = withNewRecords(claims, added);
      assert.deepEqual(Object.entries(fake), Object.entries(real(claims, added)), JSON.stringify({ claims, added }));
    }
  });

  test("never reorders records already there, only places new ones", () => {
    const r = rng(2);
    for (let n = 0; n < 500; n++) {
      const ids = [...IDS].sort(() => r() - 0.5);
      const cut = Math.floor(r() * ids.length);
      const claims = Object.fromEntries(ids.slice(0, cut).map((id, i) => [id, i]));
      const added = Object.fromEntries(ids.slice(cut).map((id, i) => [id, 100 + i]));
      for (const out of [withNewRecords(claims, added), real(claims, added)]) {
        assert.deepEqual(Object.keys(out).filter((k) => k in claims), Object.keys(claims));
        assert.deepEqual(Object.keys(out).sort(), [...Object.keys(claims), ...Object.keys(added)].sort());
        for (const k of Object.keys(out)) assert.equal(out[k], k in added ? added[k] : claims[k]);
      }
    }
  });

  test("a new record lands inside its area, by id", () => {
    const claims = { "§app/thing": 0, "§requirements.hosting/runs-on-srv": 1, "§requirements/hosting": 2 };
    assert.deepEqual(Object.keys(withNewRecords(claims, { "§requirements.hosting/backups-nightly": 3, "§app/aaa": 4 })), [
      "§app/aaa",
      "§app/thing",
      "§requirements.hosting/backups-nightly",
      "§requirements.hosting/runs-on-srv",
      "§requirements/hosting",
    ]);
  });
});
