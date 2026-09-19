import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type Accessor } from "solid-js";
import type { ModelInfo } from "../../shared/protocol";
import { listModels } from "../lib/api";
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

const idOf = (ref: string) => ref.slice(ref.indexOf("/") + 1);
const optionId = (ref: string) => `mo-${ref.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
const PAGE = 8;

// Fetched on every open; later opens show this cache while it refreshes.
const [cache, setCache] = createSignal<ModelInfo[] | null>(null);

/**
 * The chat header's model picker (DESIGN_NOTES §4c): a trigger plus a native popover holding a
 * combobox input and a listbox. Focus stays in the input; the keyboard position is
 * aria-activedescendant. Ctrl/⌘+P toggles it while this chat session is open.
 */
export function ModelMenu(props: { control: ModelControl }) {
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;
  let search!: HTMLInputElement;
  let listbox!: HTMLDivElement;
  let chose = false; // closed by choosing: focus handling is the choice's
  let tabbedAway = false; // closed by Tab: focus moves on, not back to the trigger

  const [open, setOpen] = createSignal(false);
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
      setCache(await listModels());
    } catch {
      if (!cache()) setLoadError(true);
    } finally {
      clearTimeout(skeleton);
      setShowSkeleton(false);
      setLoading(false);
    }
  };

  /** Every query token must appear in provider/id, case-insensitively. */
  const matches = createMemo(() => {
    const tokens = query().toLowerCase().split(/\s+/).filter(Boolean);
    return (cache() ?? []).filter((m) => tokens.every((t) => m.ref.toLowerCase().includes(t)));
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

  const openMenu = () => {
    if (open()) return;
    const r = trigger.getBoundingClientRect();
    menu.style.setProperty("--menu-top", `${Math.round(r.bottom + 4)}px`);
    menu.style.setProperty("--menu-right", `${Math.round(innerWidth - r.right)}px`);
    setQuery("");
    setActive(props.control.model() ?? flat()[0]?.ref ?? null);
    chose = false;
    tabbedAway = false;
    menu.showPopover();
    search.focus();
    void load().then(() => {
      if (!active()) setActive(props.control.model() ?? flat()[0]?.ref ?? null);
      scrollActive();
    });
  };
  const closeMenu = () => {
    if (menu.matches(":popover-open")) menu.hidePopover();
  };
  const toggle = () => (open() ? closeMenu() : openMenu());

  const choose = (ref: string) => {
    if (blocked()) return;
    chose = true;
    closeMenu();
    trigger.focus();
    if (ref !== props.control.model()) props.control.choose(ref);
  };

  const move = (delta: number) => {
    const list = flat();
    if (list.length === 0) return;
    const i = list.findIndex((m) => m.ref === active());
    const next = i < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.abs(delta) === 1 ? (i + delta + list.length) % list.length : Math.min(list.length - 1, Math.max(0, i + delta));
    setActive(list[next]!.ref);
  };

  // Ctrl/⌘+P toggles the menu while this chat session is open, instead of printing.
  const onKey = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      toggle();
    }
  };
  const onResize = () => closeMenu();
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", onResize);
  onCleanup(() => {
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onResize);
  });

  const Option = (p: { m: ModelInfo }) => (
    <div
      class="model-option"
      role="option"
      id={optionId(p.m.ref)}
      aria-selected={p.m.ref === props.control.model() ? "true" : "false"}
      aria-disabled={blocked() ? "true" : undefined}
      data-active={active() === p.m.ref ? "" : undefined}
      onMouseEnter={() => setActive(p.m.ref)}
      onMouseDown={(e) => e.preventDefault() /* keep focus in the input */}
      onClick={() => choose(p.m.ref)}
    >
      <Icon name="check" small class="model-option-check" />
      <span class="model-option-id">{p.m.id}</span>
      <span class="model-option-provider">{p.m.provider}</span>
    </div>
  );

  const label = () => {
    const target = props.control.pending();
    const current = props.control.model();
    return target ? idOf(target) : current ? idOf(current) : "Choose model";
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class="button button-ghost model-trigger"
        id="model-trigger"
        aria-haspopup="dialog"
        aria-expanded={open() ? "true" : "false"}
        aria-controls="model-menu"
        aria-busy={props.control.pending() ? "true" : undefined}
        aria-disabled={props.control.pending() ? "true" : undefined}
        title={props.control.pending() ?? props.control.model() ?? "Choose model"}
        onClick={() => !props.control.pending() && toggle()}
      >
        <span class="visually-hidden">Model: </span>
        <Show when={props.control.pending()}>
          <span class="live-dot" />
        </Show>
        <span class="model-trigger-label">{label()}</span>
        <Icon name="chevron-down" small />
      </button>

      <div
        ref={menu}
        class="model-menu"
        id="model-menu"
        popover="auto"
        role="dialog"
        aria-label="Choose model"
        onToggle={(e) => {
          const isOpen = (e as ToggleEvent).newState === "open";
          setOpen(isOpen);
          if (isOpen) return;
          setQuery(""); // the query doesn't survive a close
          if (!chose && !tabbedAway) trigger.focus();
        }}
        onFocusOut={(e) => {
          const to = e.relatedTarget as Node | null;
          if (to && !menu.contains(to) && to !== trigger) {
            tabbedAway = true;
            closeMenu();
          }
        }}
      >
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
              aria-controls="model-listbox"
              aria-autocomplete="list"
              aria-activedescendant={active() ? optionId(active()!) : undefined}
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
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
                if (!act) return;
                e.preventDefault();
                act();
              }}
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

        <div class="model-menu-list" id="model-listbox" role="listbox" aria-label="Models" aria-busy={loading() && !cache() ? "true" : undefined} ref={listbox}>
          <Show when={!cache() && showSkeleton()}>
            <For each={[1, 2, 3, 4]}>{() => <div class="skeleton skeleton-row" />}</For>
          </Show>
          <Show when={cache()}>
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
                <div class="model-menu-group" role="group" aria-labelledby="mg-fav">
                  <div class="list-group-label" id="mg-fav">
                    Favorites
                  </div>
                  <For each={favorites()}>{(m) => <Option m={m} />}</For>
                </div>
              </Show>
              <Show when={others().length > 0}>
                <div class="model-menu-group" role="group" aria-labelledby="mg-all">
                  <div class="list-group-label" id="mg-all">
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
      </div>
    </>
  );
}
