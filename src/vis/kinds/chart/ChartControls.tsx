import { For, Show, createMemo, createSignal, createUniqueId, onCleanup, onMount, type Accessor } from "solid-js";
import type { ChartSpec, ChartType } from "./parse";
import { chartViews, drawAs, isModel, modelChoice, pickView, settle, toggle, toggleStates, type ChartChoice, type ChartView, type Toggle, type ToggleState } from "./switch";
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
const TOGGLE: Record<Toggle, { label: string; row: string; title: string }> = {
  log: { label: "Log", row: "Log scale", title: "Log scale" },
  sort: { label: "Sort", row: "Sort largest first", title: "Sort largest first" },
  pct: { label: "%", row: "Show as % of total", title: "Show each value as a share of the total" },
};

/**
 * The figure head's chart controls: a segmented view switch (a radio group: one Tab stop, the
 * arrow keys move and pick; a neutral dot marks the model's view, titled "As drawn by the reply",
 * no Reset) when more than one view fits, then every Log, Sort and % toggle the chart can use in any
 * of its views, always, in that order: one this view can't use stays in its place, greyed (still
 * pressed when set), so no control ever moves. A greyed toggle is `aria-disabled`, not `disabled`:
 * it keeps its Tab stop, a press does nothing, and its hint is its title and its description (a
 * hidden span beside the button, so it isn't read as part of its name too).
 *
 * On a card too narrow for the one-row head (the figure's container query in vis.css) the toggles
 * give way to one Options menu holding the same three, with a count of those set and a chevron on
 * its trigger; both are always in the page and CSS shows one. The caller leaves them out while Source shows.
 */
export function ChartControls(props: { state: ChartState }) {
  const st = props.state;
  const model = st.spec.type;
  const toggles = createMemo(() => toggleStates(st.spec, st.choice()));
  const refs: HTMLButtonElement[] = [];
  const onKey = (e: KeyboardEvent, i: number) => {
    const n = st.views.length;
    const to = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % n : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    st.set(pickView(st.spec, st.choice(), st.views[to]!));
    refs[to]?.focus();
  };
  const flip = (t: Toggle) => st.set(toggle(st.spec, st.choice(), t));
  const uid = createUniqueId();
  const stateOf = (t: Toggle) => () => toggles().find((x) => x.toggle === t)!;
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
                  title={v === model ? "As drawn by the reply" : undefined}
                  onClick={() => st.set(pickView(st.spec, st.choice(), v))}
                  onKeyDown={(e) => onKey(e, i())}
                >
                  {VIEW_LABEL[v]}
                  {/* The title alone says it: on hover, and once as the description (a hidden "(as drawn)" in the name would read it twice). */}
                  <Show when={v === model}>
                    <span class="vis-chart-model-dot" aria-hidden="true" />
                  </Show>
                </button>
              );
            }}
          </For>
        </div>
      </Show>
      <Show when={toggles().length}>
        <div class="vis-chart-toggles">
          <For each={toggles().map((t) => t.toggle)}>
            {(t) => {
              const s = stateOf(t);
              const hintId = `vis-chart-hint-${uid}-${t}`;
              return (
                <>
                  <button
                    class="button button-sm button-ghost vis-chart-toggle"
                    type="button"
                    data-toggle={t}
                    aria-pressed={s().on}
                    aria-disabled={s().enabled ? undefined : "true"}
                    aria-describedby={s().hint ? hintId : undefined}
                    title={s().hint ?? TOGGLE[t].title}
                    onClick={() => s().enabled && flip(t)}
                  >
                    {TOGGLE[t].label}
                  </button>
                  {/* Beside the button, not in it: inside, it would be read as its name and again as its description. */}
                  <Show when={s().hint}>
                    {(h) => (
                      <span id={hintId} class="visually-hidden">
                        {h()}
                      </span>
                    )}
                  </Show>
                </>
              );
            }}
          </For>
        </div>
        <OptionsMenu toggles={toggles()} uid={uid} flip={flip} />
      </Show>
    </div>
  );
}

/** The menu's gap from the viewport's edges, and from its trigger. */
const EDGE = 8;
const GAP = 4;

/**
 * The narrow head's one menu of Log, Sort and %: `.popover` rows that are checkboxes (a tick when
 * set; one this view can't use greyed with its hint, keeping its tick when set). A toggle keeps it
 * open. It is a `popover="auto"`, so it sits in the top layer (the figure's `overflow: hidden`
 * can't clip it) and an outside tap or Escape closes it; focus then returns to the trigger. The
 * trigger counts the toggles set, in a slot of fixed width, so it never changes size.
 */
function OptionsMenu(props: { toggles: ToggleState[]; uid: string; flip: (t: Toggle) => void }) {
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;
  const rows: HTMLDivElement[] = [];
  const [open, setOpen] = createSignal(false);
  const count = () => props.toggles.filter((t) => t.on).length;
  const menuId = `vis-chart-menu-${props.uid}`;
  const isOpen = () => menu.matches(":popover-open");

  const place = () => {
    if (!isOpen()) return;
    // The trigger hidden (the figure grew to the one-row head): the menu goes with it.
    if (!trigger.getClientRects().length) return menu.hidePopover();
    const r = trigger.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    const below = r.bottom + GAP;
    const top = below + box.height <= innerHeight - EDGE ? below : Math.max(EDGE, r.top - GAP - box.height);
    const left = Math.min(Math.max(EDGE, r.right - box.width), Math.max(EDGE, innerWidth - EDGE - box.width));
    menu.style.setProperty("--vis-menu-top", `${Math.round(top)}px`);
    menu.style.setProperty("--vis-menu-left", `${Math.round(left)}px`);
  };
  // Open with the first row focused, or the last (ArrowUp on the trigger).
  let first = 0;
  onMount(() => {
    // The trigger is the menu's invoker, so a tap on it while open closes it (rather than the
    // light dismiss closing it and the click opening it again).
    trigger.popoverTargetElement = menu;
    let hadFocus = false;
    menu.addEventListener("beforetoggle", (e) => {
      if ((e as ToggleEvent).newState === "closed") hadFocus = menu.contains(document.activeElement);
    });
    menu.addEventListener("toggle", (e) => {
      const opened = (e as ToggleEvent).newState === "open";
      setOpen(opened);
      if (opened) {
        place();
        focusRow(first);
        first = 0;
      }
      // Escape, a tap on nothing focusable, or Tab: focus goes back to the trigger. A tap that
      // focused something else keeps it there.
      if (!opened && (hadFocus || document.activeElement === document.body)) trigger.focus();
    });
    addEventListener("resize", place);
    addEventListener("scroll", place, true);
    onCleanup(() => {
      removeEventListener("resize", place);
      removeEventListener("scroll", place, true);
    });
  });

  const focusRow = (i: number) => rows[(i + props.toggles.length) % props.toggles.length]?.focus();
  const onRowKey = (e: KeyboardEvent, i: number, t: ToggleState) => {
    const n = props.toggles.length;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (t.enabled) props.flip(t.toggle);
    } else if (e.key === "ArrowDown") focusRow(i + 1);
    else if (e.key === "ArrowUp") focusRow(i - 1);
    else if (e.key === "Home") focusRow(0);
    else if (e.key === "End") focusRow(n - 1);
    // Tab leaves the menu: it closes, and the toggle handler puts focus back on the trigger.
    else if (e.key === "Tab") menu.hidePopover();
    else return;
    e.preventDefault();
  };

  return (
    <div class="vis-chart-more">
      <button
        ref={trigger}
        class="button button-sm button-ghost vis-chart-options"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={menuId}
        aria-label={count() ? `Options, ${count()} on` : "Options"}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          if (isOpen()) return focusRow(e.key === "ArrowUp" ? -1 : 0);
          first = e.key === "ArrowUp" ? -1 : 0;
          menu.showPopover();
        }}
      >
        Options
        <span class="vis-chart-options-count" aria-hidden="true">
          {count() || ""}
        </span>
        <span class="vis-chart-chevron" aria-hidden="true" />
      </button>
      <div ref={menu} id={menuId} class="popover vis-chart-menu" popover="auto" role="menu" aria-label="Chart options">
        <For each={props.toggles.map((t) => t.toggle)}>
          {(t, i) => {
            const s = () => props.toggles.find((x) => x.toggle === t)!;
            const labelId = `${menuId}-${t}`;
            const hintId = `${menuId}-${t}-hint`;
            return (
              <div
                ref={(el) => (rows[i()] = el)}
                class={s().hint ? "popover-item popover-item-detail" : "popover-item"}
                role="menuitemcheckbox"
                aria-checked={s().on ? "true" : "false"}
                aria-disabled={s().enabled ? undefined : "true"}
                aria-labelledby={labelId}
                aria-describedby={s().hint ? hintId : undefined}
                tabindex="-1"
                data-toggle={t}
                onClick={() => s().enabled && props.flip(t)}
                onKeyDown={(e) => onRowKey(e, i(), s())}
              >
                <span class="popover-item-check vis-chart-tick" aria-hidden="true" />
                <span class="popover-item-text">
                  <span id={labelId} class="popover-item-label">
                    {TOGGLE[t].row}
                  </span>
                  <Show when={s().hint}>
                    {(h) => (
                      <span id={hintId} class="popover-item-desc">
                        {h()}
                      </span>
                    )}
                  </Show>
                </span>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}
