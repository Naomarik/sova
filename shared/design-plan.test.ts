import { test } from "node:test";
import assert from "node:assert/strict";
import { designPlan, type DesignSetup } from "./design";

const model = (ref: string, design = true) => ({ ref, name: ref, design, coordinator: false, vision: true, route: "tool" as const });
const ticks = (names: string[], on: string[]) => names.map((name) => ({ name, on: on.includes(name) }));
const plan = (models: number, styles: string[], layouts: string[], over: Partial<DesignSetup> = {}) =>
  designPlan({
    models: [model("x/off", false), ...Array.from({ length: models }, (_, i) => model(`x/m${i + 1}`))],
    directions: ticks([...styles, "Heritage"], styles),
    layouts: ticks([...layouts, "Dashboard"], layouts),
    ...over,
  });
const S = (n: number) => ["Minimalist", "Bold & Vibrant", "Balanced", "Playful", "Elegant", "Technical"].slice(0, n);
const L = (n: number) => ["Compact", "Bento", "Split Screen", "Magazine", "Card Grid", "Spacious"].slice(0, n);
const pairs = (p: ReturnType<typeof designPlan>, ref: string) => p.items.filter((i) => i.model === ref).map((i) => `${i.style} + ${i.layout}`);

test("the count of every way of combining, over the edges of both lists", () => {
  for (let m = 1; m <= 3; m++)
    for (let s = 1; s <= 4; s++)
      for (let l = 0; l <= 4; l++) {
        const paired = plan(m, S(s), L(l)).items.length;
        const every = plan(m, S(s), L(l), { combine: "every" }).items.length;
        assert.equal(paired, l ? m * Math.max(s, l) : m * s, `pair up, ${m}×${s}×${l}`);
        assert.equal(every, l ? m * s * l : m * s, `every mix, ${m}×${s}×${l}`);
      }
  assert.equal(plan(0, S(3), L(3)).items.length, 0, "no model, no designs");
  assert.equal(plan(2, [], L(3)).items.length, 0, "no style, no designs: a layout alone makes nothing");
});

test("with no layout ticked a run is exactly what it was: every model makes every style, style by style", () => {
  const p = plan(2, S(2), []);
  assert.deepEqual(
    p.items,
    [
      { model: "x/m1", style: "Minimalist" },
      { model: "x/m2", style: "Minimalist" },
      { model: "x/m1", style: "Bold & Vibrant" },
      { model: "x/m2", style: "Bold & Vibrant" },
    ],
  );
  const stored = designPlan({ models: [model("x/m1"), model("x/m2")], directions: ticks(S(2), S(2)) });
  assert.deepEqual(stored.items, p.items, "a run stored before layouts plans the same");
});

test("Pair Up shifts the pairs per model, and every model gets every style", () => {
  const p = plan(2, S(3), L(3));
  assert.deepEqual(pairs(p, "x/m1"), ["Minimalist + Compact", "Bold & Vibrant + Bento", "Balanced + Split Screen"]);
  assert.deepEqual(pairs(p, "x/m2"), ["Minimalist + Bento", "Bold & Vibrant + Split Screen", "Balanced + Compact"]);
  assert.equal(new Set(p.items.map((i) => `${i.style} + ${i.layout}`)).size, 6, "6 designs try 6 combinations");
  for (let m = 1; m <= 3; m++)
    for (let s = 1; s <= 4; s++)
      for (let l = 1; l <= 4; l++) {
        const q = plan(m, S(s), L(l));
        for (let k = 1; k <= m; k++) {
          const mine = q.items.filter((i) => i.model === `x/m${k}`);
          assert.deepEqual(new Set(mine.map((i) => i.style)), new Set(S(s)), `model ${k} gets every style, ${s}×${l}`);
          assert.deepEqual(new Set(mine.map((i) => i.layout)), new Set(L(l)), `model ${k} gets every layout, ${s}×${l}`);
        }
      }
});

test("Every Mix makes each style in each layout on each model, once", () => {
  const p = plan(2, S(3), L(3), { combine: "every" });
  const seen = new Set(p.items.map((i) => `${i.model}|${i.style}|${i.layout}`));
  assert.equal(seen.size, 18);
  assert.equal(p.items.length, 18);
});

test("a shuffle is stable: the same seed deals the same pairs, and seed 0 is the ticked order", () => {
  const a = plan(2, S(3), L(3), { pairSeed: 12345 });
  const b = plan(2, S(3), L(3), { pairSeed: 12345 });
  assert.deepEqual(a.items, b.items);
  assert.deepEqual(plan(2, S(3), L(3), { pairSeed: 0 }).items, plan(2, S(3), L(3)).items);
  const dealings = new Set(Array.from({ length: 40 }, (_, i) => JSON.stringify(plan(2, S(3), L(3), { pairSeed: i + 1 }).items)));
  assert.ok(dealings.size > 1, "seeds deal differently");
  for (const d of dealings) assert.equal(JSON.parse(d).length, 6, "and every dealing keeps the count");
});
