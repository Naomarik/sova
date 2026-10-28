// Run: pnpm test -- src/lib/tour-nav.test.ts. The tour player's one place {step, view} and every move
// on it (§app.tours/viewer), over a tour shaped 3, 2 and 1 views.
import assert from "node:assert/strict";
import { test } from "node:test";
import { tourCoverageQuestion, tourFooter, tourMove, tourPlace, tourPosition, tourQuestion, type TourMove, type TourPlace } from "./tour-state";
import { tourNavFixture } from "./tour-nav-fixture";

const m = tourNavFixture();
const places: TourPlace[] = m.steps.flatMap((s, step) => s.views.map((_, view) => ({ step, view })));
const moves: TourMove[] = ["next", "back", ...[-1, 0, 1, 2, 3, 9].map(step => ({ step })), ...[-1, 0, 1, 2, 3, 9].map(view => ({ view }))];
const valid = (p: TourPlace) => p.step >= 0 && p.step < m.steps.length && p.view >= 0 && p.view < m.steps[p.step]!.views.length && Number.isInteger(p.step) && Number.isInteger(p.view);
const name = (p: TourPlace, mv: TourMove) => `${JSON.stringify(mv)} from step ${p.step + 1} view ${p.view + 1}`;

test("the fixture is the shape that froze the player", () => {
  assert.deepEqual(m.steps.map(s => s.views.length), [3, 2, 1]);
  assert.ok(m.steps[0]!.views.some(v => v.kind === "reference"));
  assert.ok(m.steps.flatMap(s => s.views).some(v => v.kind === "page" && !v.captures.phone));
  assert.ok(m.steps.flatMap(s => s.views).some(v => v.kind === "page" && !v.captures.desktop));
});

test("every move from every place lands on a real place, and the questions name it", () => {
  for (const from of places) for (const mv of moves) {
    const to = tourMove(m, from, mv);
    assert.ok(valid(to), name(from, mv));
    const s = m.steps[to.step]!, v = s.views[to.view]!;
    for (const q of [tourQuestion(m, to.step, to.view), tourCoverageQuestion(m, to.step, to.view)]) assert.ok(q.includes(`step: ${s.id}; view: ${v.id}.`), name(from, mv));
  }
});

test("Next and Back move whole steps from any view and land on the first view; at an end they stay", () => {
  for (const from of places) {
    const last = from.step === m.steps.length - 1, first = from.step === 0;
    assert.deepEqual(tourMove(m, from, "next"), last ? from : { step: from.step + 1, view: 0 }, name(from, "next"));
    assert.deepEqual(tourMove(m, from, "back"), first ? from : { step: from.step - 1, view: 0 }, name(from, "back"));
  }
  // The crash path: step 2, its second view, Next.
  assert.deepEqual(tourMove(m, { step: 1, view: 1 }, "next"), { step: 2, view: 0 });
  // Walking Next from the start reaches every step, Back walks home again.
  let p: TourPlace = { step: 0, view: 2 }; const seen = [p.step];
  for (let i = 0; i < 5; i++) { p = tourMove(m, p, "next"); seen.push(p.step); }
  assert.deepEqual(seen, [0, 1, 2, 2, 2, 2]);
  for (let i = 0; i < 5; i++) p = tourMove(m, p, "back");
  assert.deepEqual(p, { step: 0, view: 0 });
});

test("the Steps list opens a step at its first view; the step already shown keeps its view", () => {
  for (const from of places) for (let step = 0; step < m.steps.length; step++)
    assert.deepEqual(tourMove(m, from, { step }), step === from.step ? from : { step, view: 0 }, name(from, { step }));
});

test("a view chip changes only the view, within the step", () => {
  for (const from of places) m.steps[from.step]!.views.forEach((_, view) => assert.deepEqual(tourMove(m, from, { view }), { step: from.step, view }));
});

test("a place that points past its step is pulled back to a real one", () => {
  assert.deepEqual(tourPlace(m, { step: 2, view: 1 }), { step: 2, view: 0 });
  assert.deepEqual(tourPlace(m, { step: 7, view: 7 }), { step: 2, view: 0 });
  assert.deepEqual(tourPlace(m, { step: -3, view: Number.NaN }), { step: 0, view: 0 });
  assert.deepEqual(tourMove(m, { step: 2, view: 1 }, "back"), { step: 1, view: 0 });
});

test("reopening at a saved place opens exactly there, by stable ids", () => {
  for (const p of places) for (const size of ["desktop", "phone"] as const) {
    const s = m.steps[p.step]!;
    assert.deepEqual(tourPosition(m, { stepId: s.id, viewId: s.views[p.view]!.id, size }), p);
  }
});

test("the footer names the next step, and offers Finish Tour only on the last step", () => {
  for (const p of places) {
    const f = tourFooter(m, p), last = p.step === m.steps.length - 1;
    assert.equal(f.finish, last, JSON.stringify(p));
    assert.equal(f.canBack, p.step > 0);
    assert.equal(f.nextLabel, last ? "You're at the last step" : m.steps[p.step + 1]!.title);
  }
});
