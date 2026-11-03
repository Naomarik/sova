// Run: pnpm test -- src/lib/tour-player.browser.test.ts (Solid's reactive build).
// The tour player's state as the viewer draws it (§app.tours/viewer): render effects read the step,
// the view's picture at the chosen size and the footer, as TourViewer's do. The player froze when a
// move gave a render effect a new step with the old view index (a throw that left the screen stale);
// here every control is pressed from every place at both sizes, and after each press the drawn
// screen must be the player's place, the saved place must match it, and Next/Back must still move.
import assert from "node:assert/strict";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { createTourPlayer } = await import("./tour-player");
const { tourNavFixture } = await import("./tour-nav-fixture");
type TourMove = import("./tour-state").TourMove;
type TourSize = import("../../shared/tour").TourSize;

const m = tourNavFixture();
const places = m.steps.flatMap((s, step) => s.views.map((_, view) => ({ step, view })));
const controls: { label: string; move: TourMove }[] = [
  { label: "Next", move: "next" }, { label: "Back", move: "back" },
  ...m.steps.map((s, step) => ({ label: `Steps list: ${s.title}`, move: { step } as TourMove })),
  ...[0, 1, 2].map(view => ({ label: `view chip ${view + 1}`, move: { view } as TourMove })),
];

/** Mounts the player with effects that draw what the viewer draws; returns the player and the screen. */
function mount(start: { step: number; view: number }, size: TourSize) {
  const s = m.steps[start.step]!;
  return solid.createRoot(dispose => {
    const player = createTourPlayer(m, { stepId: s.id, viewId: s.views[start.view]!.id, size });
    player.setSize(size);
    const screen = { head: "", picture: "", footer: "", errors: [] as unknown[] };
    const draw = (fn: () => void) => solid.createRenderEffect(() => { try { fn(); } catch (e) { screen.errors.push(e); throw e; } });
    draw(() => { screen.head = `Step ${player.step().n} of ${m.steps.length} · ${player.place().view + 1}/${player.step().views.length} views`; });
    draw(() => {
      const v = player.view(), cap = v.captures[player.size()];
      screen.picture = cap ? `${v.id}:${cap.image}` : v.kind === "reference" ? `${v.id}:in words` : `${v.id}:${player.size()} unavailable`;
    });
    draw(() => { const f = player.footer(); screen.footer = `${f.canBack ? "Back" : "-"}|${f.nextLabel}|${f.finish ? "Finish Tour" : "Next"}`; });
    return { player, screen, dispose };
  });
}
const expected = (p: { step: number; view: number }, size: TourSize) => {
  const s = m.steps[p.step]!, v = s.views[p.view]!, cap = v.captures[size];
  return {
    head: `Step ${s.n} of ${m.steps.length} · ${p.view + 1}/${s.views.length} views`,
    picture: cap ? `${v.id}:${cap.image}` : v.kind === "reference" ? `${v.id}:in words` : `${v.id}:${size} unavailable`,
  };
};

test("every control from every place, at desktop and phone: the screen follows the place, and the saved place matches", () => {
  for (const size of ["desktop", "phone"] as const) for (const start of places) for (const c of controls) {
    const { player, screen, dispose } = mount(start, size);
    const where = `${c.label} from step ${start.step + 1} view ${start.view + 1} (${size})`;
    assert.deepEqual(player.place(), start, `opens at the saved place: ${where}`);
    assert.doesNotThrow(() => player.move(c.move), where);
    assert.deepEqual(screen.errors, [], where);
    const p = player.place();
    assert.ok(p.view < m.steps[p.step]!.views.length, where);
    const want = expected(p, size);
    assert.equal(screen.head, want.head, where);
    assert.equal(screen.picture, want.picture, where);
    assert.deepEqual(player.position(), { stepId: m.steps[p.step]!.id, viewId: m.steps[p.step]!.views[p.view]!.id, size }, where);
    assert.doesNotThrow(() => { player.question(); player.coverageQuestion(); }, where);
    // Next and Back still move, unless legitimately at an end.
    const before = p.step;
    player.move("next");
    assert.equal(player.place().step, Math.min(before + 1, m.steps.length - 1), `Next after ${where}`);
    assert.equal(screen.head, expected(player.place(), size).head);
    player.move("back");
    assert.equal(player.place().step, Math.max(Math.min(before + 1, m.steps.length - 1) - 1, 0), `Back after ${where}`);
    assert.equal(screen.head, expected(player.place(), size).head);
    assert.deepEqual(screen.errors, [], where);
    dispose();
  }
});

test("the crash path: step 2, its second view, Next lands on step 3 and the footer turns to Finish Tour", () => {
  for (const size of ["desktop", "phone"] as const) {
    const { player, screen, dispose } = mount({ step: 1, view: 0 }, size);
    player.move({ view: 1 });
    assert.equal(screen.picture, expected({ step: 1, view: 1 }, size).picture);
    assert.deepEqual(player.move("next"), { moved: true, stepChanged: true });
    assert.deepEqual(screen.errors, []);
    assert.equal(screen.head, "Step 3 of 3 · 1/1 views");
    assert.equal(screen.footer, "Back|You're at the last step|Finish Tour");
    assert.deepEqual(player.position(), { stepId: "s3", viewId: "s3-a", size });
    dispose();
  }
});

test("Desktop/Phone keeps the step and view; a view missing one size says so", () => {
  for (const start of places) {
    const { player, screen, dispose } = mount(start, "desktop");
    for (const size of ["phone", "desktop", "phone"] as const) {
      player.setSize(size);
      assert.deepEqual(player.place(), start);
      assert.equal(screen.picture, expected(start, size).picture);
    }
    dispose();
  }
  const { player, screen, dispose } = mount({ step: 0, view: 2 }, "phone");
  assert.equal(screen.picture, "s1-c:phone unavailable");
  player.setSize("desktop");
  assert.equal(screen.picture, "s1-c:desktop.png");
  dispose();
});
