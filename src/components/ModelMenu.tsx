import { createEffect, createMemo, createSignal, For, on, onMount, Show, type Accessor, type JSX } from "solid-js";
import type { ModelInfo } from "../../shared/protocol";
import { loadModels, modelList } from "../lib/models";
import { usePaneId } from "../lib/pane-scope";
import { Banner, Icon } from "./ui";

/** What the chat view exposes so the header can show and change its model. */
export interface ModelControl {
  /** Active "provider/id", or null before the server reports one. */
  model: Accessor<string | null>;
  /** Target ref while a switch awaits the server's echo. */
  pending: Accessor<string | null>;
  /** Why changing is blocked right now (agent running, composer disabled), else null. */
  blocked: Accessor<{ title: string; body?: string } | null>;
  choose(ref: string): void;
}

const baseOptionId = (ref: string) => `mo-${ref.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
const PAGE = 8;

/**
 * The model picker (spec/04c-model-menu.md §4c): a combobox input over a listbox, shown as the composer
 * flyout's second panel (§4b). Mounting focuses the listbox, never the input, so a phone doesn't
 * raise its keyboard; typing there moves into the input. The keyboard position is
 * aria-activedescendant. The list comes from the shared cache (`src/lib/models.ts`) and refreshes
 * on every mount, so a stale list is still shown while the new one lands.
 */
export function ModelPicker(props: {
  control: ModelControl;
  /** Rendered above the search field: the flyout's way back to its root panel. */
  head?: JSX.Element;
  /** After a choice — including re-choosing the current model — so the shell can close. */
  onChosen(): void;
  /** Take focus on mount (the listbox). False when the picker isn't the panel in front. */
  autoFocus?: boolean;
}) {
  let search!: HTMLInputElement;
  let listbox!: HTMLDivElement;
  // Every id here is the pane's inside a workspace: aria-activedescendant and the scroll-into-view
  // below both resolve against the document, and N composers can have a picker open at once.
  const paneId = usePaneId();
  const optionId = (ref: string) => paneId(baseOptionId(ref));

  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [showSkeleton, setShowSkeleton] = createSignal(false);
  const [loadError, setLoadError] = createSignal(false);

  const load = async () => {
    setLoading(true);
    setLoadError(false);
    const skeleton = setTimeout(() => setShowSkeleton(true), 300);
    try {
      await loadModels();
    } catch {
      if (!modelList()) setLoadError(true);
    } finally {
      clearTimeout(skeleton);
      setShowSkeleton(false);
      setLoading(false);
    }
  };

  /** Every query token must appear in provider/id, case-insensitively. */
  const matches = createMemo(() => {
    const tokens = query().toLowerCase().split(/\s+/).filter(Boolean);
    return (modelList() ?? []).filter((m) => tokens.every((t) => m.ref.toLowerCase().includes(t)));
  });
  const favorites = createMemo(() => matches().filter((m) => m.favorite).sort((a, b) => a.ref.localeCompare(b.ref)));
  const others = createMemo(() =>
    matches()
      .filter((m) => !m.favorite)
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id)),
  );
  /** Keyboard order: favorites, then the rest. */
  const flat = createMemo(() => [...favorites(), ...others()]);
  const blocked = () => props.control.blocked();

  const scrollActive = () =>
    queueMicrotask(() => {
      const ref = active();
      if (ref) document.getElementById(optionId(ref))?.scrollIntoView({ block: "nearest" });
    });
  // The active option resets to the first match whenever the query changes.
  createEffect(on(query, () => setActive(flat()[0]?.ref ?? null), { defer: true }));
  createEffect(on(active, scrollActive));

  onMount(() => {
    setActive(props.control.model() ?? flat()[0]?.ref ?? null);
    if (props.autoFocus) listbox.focus({ preventScroll: true }); // not the input: that would raise a phone's keyboard
    void load().then(() => {
      if (!active()) setActive(props.control.model() ?? flat()[0]?.ref ?? null);
      scrollActive();
    });
  });

  const choose = (ref: string) => {
    if (blocked()) return;
    if (ref !== props.control.model()) props.control.choose(ref);
    props.onChosen(); // choosing the current model just closes, per §4c
  };

  const move = (delta: number) => {
    const list = flat();
    if (list.length === 0) return;
    const i = list.findIndex((m) => m.ref === active());
    const next = i < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.abs(delta) === 1 ? (i + delta + list.length) % list.length : Math.min(list.length - 1, Math.max(0, i + delta));
    setActive(list[next]!.ref);
  };

  /** ↑ ↓ PageUp PageDown and Enter, from the input or the listbox. */
  const navKey = (e: KeyboardEvent): boolean => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => move(1),
      ArrowUp: () => move(-1),
      PageDown: () => move(PAGE),
      PageUp: () => move(-PAGE),
      Enter: () => {
        const ref = active();
        if (ref) choose(ref);
      },
    };
    const act = keys[e.key];
    if (!act) return false;
    e.preventDefault();
    act();
    return true;
  };
  /** On the listbox: Home/End too, and typing goes to the input (the user chose to type). */
  const onListKey = (e: KeyboardEvent) => {
    if (navKey(e)) return;
    const list = flat();
    if ((e.key === "Home" || e.key === "End") && list.length) {
      e.preventDefault();
      setActive(list[e.key === "Home" ? 0 : list.length - 1]!.ref);
      return;
    }
    const typed = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (!typed && !(e.key === "Backspace" && query())) return;
    e.preventDefault();
    setQuery((q) => (typed ? q + e.key : q.slice(0, -1)));
    search.focus();
    const end = search.value.length;
    search.setSelectionRange(end, end);
  };

  const Option = (p: { m: ModelInfo }) => (
    <div
      class="model-option"
      role="option"
      id={optionId(p.m.ref)}
      aria-selected={p.m.ref === props.control.model() ? "true" : "false"}
      aria-disabled={blocked() ? "true" : undefined}
      data-active={active() === p.m.ref ? "" : undefined}
      onMouseEnter={() => setActive(p.m.ref)}
      onMouseDown={(e) => e.preventDefault() /* keep focus where it is (input or listbox) */}
      onClick={() => choose(p.m.ref)}
    >
      <Icon name="check" small class="model-option-check" />
      <span class="model-option-id">{p.m.id}</span>
      {/* Metadata, not status: only for models that take images, and never when input is unknown. */}
      <Show when={p.m.input?.includes("image")}>
        <span class="model-option-vision" title="Accepts images">
          vision
        </span>
      </Show>
      <span class="model-option-provider">{p.m.provider}</span>
    </div>
  );

  return (
    <>
      {props.head}
      <div class="model-menu-search">
        <div class="search">
          <Icon name="search" />
          <input
            ref={search}
            class="input"
            type="text"
            role="combobox"
            aria-label="Search models"
            placeholder="Search models"
            autocomplete="off"
            spellcheck={false}
            aria-expanded="true"
            aria-controls={paneId("model-listbox")}
            aria-autocomplete="list"
            aria-activedescendant={active() ? optionId(active()!) : undefined}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={navKey}
          />
        </div>
      </div>

      <Show when={blocked()}>{(b) => <Banner tone="info" title={b().title} body={b().body} />}</Show>
      <Show when={loadError()}>
        <Banner
          tone="error"
          title="Couldn't load models."
          body="Your current model is unchanged."
          action={
            <button type="button" class="button button-sm" onClick={() => void load()}>
              Retry
            </button>
          }
        />
      </Show>

      <div
        class="model-menu-list"
        id={paneId("model-listbox")}
        role="listbox"
        aria-label="Models"
        tabindex="-1"
        aria-activedescendant={active() ? optionId(active()!) : undefined}
        aria-busy={loading() && !modelList() ? "true" : undefined}
        ref={listbox}
        onKeyDown={onListKey}
      >
        <Show when={!modelList() && showSkeleton()}>
          <For each={[1, 2, 3, 4]}>{() => <div class="skeleton skeleton-row" />}</For>
        </Show>
        <Show when={modelList()}>
          <Show
            when={flat().length > 0}
            fallback={
              <p class="model-menu-empty">
                <Show
                  when={query().trim()}
                  fallback={
                    <>
                      0 models have credentials. Log in with <code>pi</code> in a terminal to add one.
                    </>
                  }
                >
                  0 models match “{query().trim()}”.
                </Show>
              </p>
            }
          >
            <Show when={favorites().length > 0}>
              <div class="model-menu-group" role="group" aria-labelledby={paneId("mg-fav")}>
                <div class="list-group-label" id={paneId("mg-fav")}>
                  Favorites
                </div>
                <For each={favorites()}>{(m) => <Option m={m} />}</For>
              </div>
            </Show>
            <Show when={others().length > 0}>
              <div class="model-menu-group" role="group" aria-labelledby={paneId("mg-all")}>
                <div class="list-group-label" id={paneId("mg-all")}>
                  All models
                </div>
                <For each={others()}>{(m) => <Option m={m} />}</For>
              </div>
            </Show>
          </Show>
        </Show>
      </div>

      <p class="model-menu-foot">
        <kbd>↑</kbd>
        <kbd>↓</kbd> to move · <kbd>Enter</kbd> to choose · <kbd>Esc</kbd> to close
      </p>
    </>
  );
}
