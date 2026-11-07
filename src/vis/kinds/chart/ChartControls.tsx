import { For, Show, createMemo, createSignal, type Accessor } from "solid-js";
import type { ChartSpec, ChartType } from "./parse";
import { chartViews, drawAs, isModel, modelChoice, pickView, settle, shownToggles, toggle, type ChartChoice, type ChartView } from "./switch";
import { recallChoice, rememberChoice } from "./memory";

/**
 * The reader's view of one chart (§chat.markdown/vis-chart-views): the choice kept for the tab
 * under `key` (memory.ts), settled against what this chart offers, and the spec to draw for it
 * (switch.ts). Read once at creation, so the figure's reserved height already uses it.
 */
export interface ChartState {
  spec: ChartSpec;
  views: ChartView[];
  choice: Accessor<ChartChoice>;
  drawn: Accessor<ChartSpec>;
  set: (c: ChartChoice) => void;
}

export function createChartState(spec: ChartSpec, key: string): ChartState {
  const offer = chartViews(spec);
  const stored = recallChoice(key);
  const [choice, setChoice] = createSignal<ChartChoice>(settle(spec, stored ? { ...stored, view: stored.view as ChartType } : modelChoice(spec)));
  const drawn = createMemo(() => drawAs(spec, choice()));
  const set = (c: ChartChoice) => {
    setChoice(c);
    rememberChoice(key, isModel(spec, c) ? undefined : c);
  };
  return { spec, views: offer.views, choice, drawn, set };
}

const VIEW_LABEL: Record<ChartView, string> = { bar: "Bar", stacked: "Stacked", line: "Line", parts: "Parts" };

/**
 * The figure head's chart controls: a segmented view switch (a radio group: one Tab stop, the
 * arrow keys move and pick; a dot marks the model's view, no Reset) when more than one view fits,
 * then the Log, Sort and % toggles this view shows. The caller leaves them out while Source shows.
 */
export function ChartControls(props: { state: ChartState }) {
  const st = props.state;
  const model = st.spec.type;
  const shown = createMemo(() => shownToggles(st.spec, st.choice()));
  const refs: HTMLButtonElement[] = [];
  const onKey = (e: KeyboardEvent, i: number) => {
    const n = st.views.length;
    const to = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % n : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    st.set(pickView(st.spec, st.choice(), st.views[to]!));
    refs[to]?.focus();
  };
  const flip = (t: "log" | "sort" | "pct") => st.set(toggle(st.spec, st.choice(), t));
  return (
    <div class="vis-chart-controls">
      <Show when={st.views.length > 1}>
        <div class="vis-chart-views" role="radiogroup" aria-label="View">
          <For each={st.views}>
            {(v, i) => {
              const on = () => st.choice().view === v;
              return (
                <button
                  ref={(el) => (refs[i()] = el)}
                  class="vis-chart-view"
                  type="button"
                  role="radio"
                  aria-checked={on()}
                  tabindex={on() ? 0 : -1}
                  onClick={() => st.set(pickView(st.spec, st.choice(), v))}
                  onKeyDown={(e) => onKey(e, i())}
                >
                  {VIEW_LABEL[v]}
                  <Show when={v === model}>
                    <span class="vis-chart-model-dot" aria-hidden="true" />
                    <span class="visually-hidden"> (as drawn)</span>
                  </Show>
                </button>
              );
            }}
          </For>
        </div>
      </Show>
      <Show when={shown().log}>
        <button class="button button-sm button-ghost vis-chart-toggle" type="button" aria-pressed={st.choice().log} title="Log scale" onClick={() => flip("log")}>
          Log
        </button>
      </Show>
      <Show when={shown().sort}>
        <button class="button button-sm button-ghost vis-chart-toggle" type="button" aria-pressed={st.choice().sort} title="Sort largest first" onClick={() => flip("sort")}>
          Sort
        </button>
      </Show>
      <Show when={shown().pct}>
        <button class="button button-sm button-ghost vis-chart-toggle" type="button" aria-pressed={st.choice().pct} title="Show each value as a share of the total" onClick={() => flip("pct")}>
          %
        </button>
      </Show>
    </div>
  );
}
