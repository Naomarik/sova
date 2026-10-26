import { createMemo, createSignal } from "solid-js";
import type { TourPresentation, TourSize } from "../../shared/tour";
import { tourCoverageQuestion, tourFooter, tourMove, tourPlace, tourPosition, tourQuestion, type TourMove, type TourPlace, type TourPosition } from "./tour-state";

/** The tour player's state, with no DOM: one place {step, view} that every control changes in a single
    write, so the step and the view shown can never disagree, plus the picture size, kept apart because
    changing it never moves the place. */
export function createTourPlayer(manifest: TourPresentation, initial?: TourPosition) {
  const [place, setPlace] = createSignal<TourPlace>(tourPlace(manifest, tourPosition(manifest, initial)), { equals: (a, b) => a.step === b.step && a.view === b.view });
  const [size, setSizeSignal] = createSignal<TourSize>("desktop");
  /** Derived in one memo from the one place, so a reader never sees a new step with an old view. */
  const here = createMemo(() => {
    const p = tourPlace(manifest, place());
    const step = manifest.steps[p.step]!;
    return { place: p, step, view: step.views[p.view]! };
  });
  /** The place a reader would save: what is on screen, by stable identity. */
  const position = (): TourPosition => ({ stepId: here().step.id, viewId: here().view.id, size: size() });
  /** Applies one move; returns whether the place changed, and whether the step did. */
  const move = (m: TourMove): { moved: boolean; stepChanged: boolean } => {
    const from = here().place;
    const to = tourMove(manifest, from, m);
    if (to.step === from.step && to.view === from.view) return { moved: false, stepChanged: false };
    setPlace(to);
    return { moved: true, stepChanged: to.step !== from.step };
  };
  return {
    place: () => here().place,
    step: () => here().step,
    view: () => here().view,
    size,
    setSize: (s: TourSize) => setSizeSignal(s),
    move,
    position,
    footer: () => tourFooter(manifest, here().place),
    question: () => tourQuestion(manifest, here().place.step, here().place.view),
    coverageQuestion: () => tourCoverageQuestion(manifest, here().place.step, here().place.view),
  };
}
export type TourPlayer = ReturnType<typeof createTourPlayer>;
