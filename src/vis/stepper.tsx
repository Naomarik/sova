import { createSignal, type Accessor } from "solid-js";

/**
 * Step-through for kinds that unfold in order (sequence first; gitgraph could use it). Starts showing
 * everything — a still picture is the default and nothing plays by itself; Step starts from the
 * first item, then Prev/Next walk it, All ends the walk. `shown(i)`: whether item i (0-based) is
 * visible. Buttons are real buttons with names, so it works from the keyboard and a screen reader.
 */
export function createStepper(count: Accessor<number>) {
  const [at, setAt] = createSignal<number | null>(null); // null = all shown
  const shown = (i: number) => at() === null || i <= at()!;
  const Controls = () => (
    <div class="vis-stepper" role="group" aria-label="Step through">
      {at() === null ? (
        <button class="button button-sm button-secondary" type="button" onClick={() => setAt(0)}>
          Step Through
        </button>
      ) : (
        <>
          <button class="button button-sm button-ghost" type="button" disabled={at() === 0} onClick={() => setAt(Math.max(0, at()! - 1))}>
            Previous
          </button>
          {/* One announced string; the visible count is "Step 3 of 8", or "3/8" at phone width. */}
          <span class="visually-hidden" aria-live="polite">
            Step {at()! + 1} of {count()}
          </span>
          <span class="vis-stepper-count" aria-hidden="true">
            <span class="vis-stepper-long">Step {at()! + 1} of {count()}</span>
            <span class="vis-stepper-short">{at()! + 1}/{count()}</span>
          </span>
          <button class="button button-sm button-ghost" type="button" disabled={at()! >= count() - 1} onClick={() => setAt(Math.min(count() - 1, at()! + 1))}>
            Next
          </button>
          <button class="button button-sm button-ghost" type="button" onClick={() => setAt(null)}>
            Show All
          </button>
        </>
      )}
    </div>
  );
  return { at, shown, Controls };
}
