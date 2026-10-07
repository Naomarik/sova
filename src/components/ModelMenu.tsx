import { createEffect, createMemo, createSignal, For, on, onMount, Show, type Accessor } from "solid-js";
import type { ModelInfo } from "../../shared/protocol";
import { loadModelPolicy, usableModels } from "../lib/model-policy";
import { loadModels, modelList, toggleFavorite } from "../lib/models";
import { initialActive, modelCount, modelKey, onlyProvider, pickerGroups, providerKey, type PickerItem, type PickerStep } from "../lib/model-picker";
import { useHostScope } from "../lib/host-scope";
import { usePaneId } from "../lib/pane-scope";
import { announce } from "../lib/ui-state";
import { claudeModelName } from "../lib/format";
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

const domSafe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "-");
const baseOptionId = (item: PickerItem) => (item.kind === "model" ? `mo-${domSafe(item.model.ref)}` : `mp-${domSafe(item.provider)}`);
const PAGE = 8;

/**
 * The model picker: a combobox input over a listbox, shown as the composer
 * flyout's picker panel, in two steps — Providers (favorites, then one row per provider), then one
 * provider's models; typing on Providers searches every model. Both steps share the input and the
 * listbox, so a step change never drops focus out of the flyout. Mounting or changing step focuses
 * the listbox, never the input, so a phone doesn't raise its keyboard; typing there moves into the
 * input. The keyboard position is aria-activedescendant. The list comes from the shared cache
 * (`src/lib/models.ts`) and refreshes on every mount, so a stale list is still shown while the new
 * one lands.
 */
export function ModelPicker(props: {
  control: ModelControl;
  /** Back from the first step: the flyout's way back to its model panel. */
  onBack(): void;
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
  /** The host whose models these are: a peer session's own (lib/host-scope.ts). */
  const host = useHostScope();
  const models = () => modelList(host());
  const optionId = (item: PickerItem) => paneId(baseOptionId(item));

  const [query, setQuery] = createSignal("");
  const [step, setStep] = createSignal<PickerStep>({ kind: "providers" });
  /** The active row's key (lib/model-picker.ts: "m:<ref>" or "p:<provider>"). */
  const [active, setActive] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [showSkeleton, setShowSkeleton] = createSignal(false);
  const [loadError, setLoadError] = createSignal(false);
  /** The last star/unstar that failed (already rolled back), until Dismiss or the next toggle. */
  const [starError, setStarError] = createSignal<{ id: string; favorite: boolean; message: string } | null>(null);

  const load = async () => {
    setLoading(true);
    setLoadError(false);
    const skeleton = setTimeout(() => setShowSkeleton(true), 300);
    try {
      // The policy rides along with the list: a model turned off in Settings → Models is refused
      // by the server, so offering it here would be a dead option. A policy that fails to load
      // hides nothing (src/lib/model-policy.ts) — the list is still the models you have.
      await Promise.all([loadModels(undefined, host()), loadModelPolicy(host()).catch(() => undefined)]);
    } catch {
      if (!models()) setLoadError(true);
    } finally {
      clearTimeout(skeleton);
      setShowSkeleton(false);
      setLoading(false);
    }
  };

  const usable = createMemo(() => usableModels(models() ?? [], host()));
  /** With exactly one provider to choose from, there is no Providers step. */
  const only = createMemo(() => onlyProvider(usable()));
  /** The step on screen: Providers, unless there's only one provider to open. */
  const view = createMemo<PickerStep>(() => {
    const s = step();
    const one = only();
    return s.kind === "providers" && one ? { kind: "provider", provider: one } : s;
  });
  const viewProvider = () => {
    const v = view();
    return v.kind === "provider" ? v.provider : null;
  };
  const groups = createMemo(() => pickerGroups(usable(), view(), query(), props.control.model()));
  /** Keyboard order: the rows as rendered. */
  const flat = createMemo(() => groups().flatMap((g) => g.items));
  const activeItem = () => flat().find((i) => i.key === active());
  const blocked = () => props.control.blocked();

  const scrollActive = () =>
    queueMicrotask(() => {
      const item = activeItem();
      if (item) document.getElementById(optionId(item))?.scrollIntoView({ block: "nearest" });
    });
  createEffect(on(active, scrollActive));

  const startActive = () => initialActive(groups(), view(), props.control.model());

  onMount(() => {
    setActive(startActive());
    if (props.autoFocus) listbox.focus({ preventScroll: true }); // not the input: that would raise a phone's keyboard
    void load().then(() => {
      // The list (or the one-provider skip) may have changed under the first position.
      if (!activeItem()) setActive(startActive());
      scrollActive();
    });
  });

  /** The active option resets to the first match whenever the query changes. */
  const changeQuery = (q: string) => {
    setQuery(q);
    listbox.scrollTop = 0; // a new list starts at its top, its first group label included
    setActive(flat()[0]?.key ?? null);
    scrollActive();
  };

  /** Changes step: the query clears, the listbox takes focus, and `to` (else the step's start) is active. */
  const goTo = (next: PickerStep, to?: string) => {
    setQuery("");
    setStep(next);
    listbox.scrollTop = 0;
    setActive(to ?? startActive());
    scrollActive();
    listbox.focus({ preventScroll: true });
  };
  const openProvider = (provider: string) => goTo({ kind: "provider", provider });
  /** One provider's step returns to Providers on the provider it came from; otherwise back is the flyout's. */
  const back = () => {
    const s = step();
    if (s.kind === "provider" && !only()) goTo({ kind: "providers" }, providerKey(s.provider));
    else props.onBack();
  };

  const choose = (ref: string) => {
    if (blocked()) return;
    if (ref !== props.control.model()) props.control.choose(ref);
    props.onChosen(); // choosing the current model just closes, per the model menu spec
  };
  /** Enter or a click: a model is chosen, a provider is opened. */
  const activate = (item: PickerItem) => (item.kind === "model" ? choose(item.model.ref) : openProvider(item.provider));

  /**
   * Star or unstar a row without choosing it. The row moves between groups at once (the shared
   * cache flips before the server answers) and stays the active option, so it's scrolled to where
   * it landed — and again if the save fails and it moves back.
   */
  const star = (m: ModelInfo) => {
    const favorite = !m.favorite;
    setStarError(null);
    holdHover = true;
    setActive(modelKey(m.ref));
    scrollActive();
    toggleFavorite(m.ref, favorite, undefined, host()).then(
      () => announce(favorite ? `Added ${m.id} to favorites.` : `Removed ${m.id} from favorites.`),
      (error: unknown) => {
        setStarError({ id: m.id, favorite, message: error instanceof Error ? error.message : String(error) });
        if (active() === modelKey(m.ref)) scrollActive();
      },
    );
  };

  /**
   * When a star moves its row, another row slides under a pointer that hasn't moved, and the
   * browser fires mouseenter on it — which would take the active option away from the row just
   * starred. So hovering is ignored after a star until the pointer really moves (the browser's
   * own after-layout mousemove repeats the last position, so it doesn't count).
   */
  let holdHover = false;
  let lastPointer: { x: number; y: number } | null = null;
  const hover = (key: string) => {
    if (!holdHover) setActive(key);
  };
  const onPointerMove = (e: MouseEvent) => {
    const still = lastPointer?.x === e.clientX && lastPointer.y === e.clientY;
    lastPointer = { x: e.clientX, y: e.clientY };
    if (!holdHover || still) return;
    holdHover = false;
    const key = (e.target as Element).closest<HTMLElement>(".model-row")?.dataset.key;
    if (key) setActive(key);
  };

  const move = (delta: number) => {
    const list = flat();
    if (list.length === 0) return;
    const i = list.findIndex((x) => x.key === active());
    const next = i < 0 ? (delta > 0 ? 0 : list.length - 1) : Math.abs(delta) === 1 ? (i + delta + list.length) % list.length : Math.min(list.length - 1, Math.max(0, i + delta));
    setActive(list[next]!.key);
  };

  /** ↑ ↓ PageUp PageDown, Enter and Ctrl+F from the input or the listbox; ← → there too, but in the input only with no query. */
  const navKey = (e: KeyboardEvent, inInput: boolean): boolean => {
    // Ctrl+F stars the active row, as in the TUI palette. Ctrl only: ⌘F stays the browser's find.
    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      const item = activeItem();
      if (item?.kind === "model") star(item.model);
      return true;
    }
    const arrows = !inInput || !query();
    const keys: Record<string, () => void> = {
      ArrowDown: () => move(1),
      ArrowUp: () => move(-1),
      PageDown: () => move(PAGE),
      PageUp: () => move(-PAGE),
      Enter: () => {
        const item = activeItem();
        if (item) activate(item);
      },
    };
    if (arrows) {
      keys.ArrowLeft = back;
      const item = activeItem();
      if (item?.kind === "provider") keys.ArrowRight = () => openProvider(item.provider);
    }
    const act = keys[e.key];
    if (!act || e.altKey || e.metaKey) return false;
    e.preventDefault();
    act();
    return true;
  };
  /** On the listbox: Home/End too, and typing goes to the input (the user chose to type). */
  const onListKey = (e: KeyboardEvent) => {
    if (navKey(e, false)) return;
    const list = flat();
    if ((e.key === "Home" || e.key === "End") && list.length) {
      e.preventDefault();
      setActive(list[e.key === "Home" ? 0 : list.length - 1]!.key);
      return;
    }
    const typed = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (!typed && !(e.key === "Backspace" && query())) return;
    e.preventDefault();
    changeQuery(typed ? query() + e.key : query().slice(0, -1));
    search.focus();
    const end = search.value.length;
    search.setSelectionRange(end, end);
  };

  // The star is the option's sibling, not its child: an option's content is presentational, so a
  // button inside it would be unreachable. It's out of the tab order (focus stays in the input or
  // listbox, and Tab closes the menu); Ctrl+F is its keyboard path.
  const ModelRow = (p: { item: Extract<PickerItem, { kind: "model" }> }) => (
    <div class="model-row" role="none" data-key={p.item.key}>
      <div
        class="model-option"
        role="option"
        id={optionId(p.item)}
        aria-selected={p.item.model.ref === props.control.model() ? "true" : "false"}
        aria-disabled={blocked() ? "true" : undefined}
        data-active={active() === p.item.key ? "" : undefined}
        onMouseEnter={() => hover(p.item.key)}
        onMouseDown={(e) => e.preventDefault() /* keep focus where it is (input or listbox) */}
        onClick={() => choose(p.item.model.ref)}
      >
        <Icon name="check" small class="model-option-check" />
        {/* A Claude model: its catalog name, then its id (§app.claude-code-provider/model-names). */}
        <span class="model-option-id">
          <Show when={claudeModelName(p.item.model.ref)} fallback={p.item.model.id}>
            {(name) => (
              <>
                <span class="model-option-name">{name()}</span> <span class="model-option-subid">{p.item.model.id}</span>
              </>
            )}
          </Show>
        </span>
        {/* Metadata, not status: only for models that take images, and never when input is unknown. */}
        <Show when={p.item.model.input?.includes("image")}>
          <span class="model-option-vision" title="Accepts images">
            vision
          </span>
        </Show>
        <Show when={p.item.caption}>
          <span class="model-option-provider">{p.item.model.provider}</span>
        </Show>
      </div>
      <button
        type="button"
        class="button button-icon button-ghost model-option-star"
        tabindex="-1"
        aria-pressed={p.item.model.favorite ? "true" : "false"}
        aria-label={`Favorite ${p.item.model.ref}`}
        title={`${p.item.model.favorite ? "Remove from" : "Add to"} favorites (Ctrl+F)`}
        onMouseEnter={() => hover(p.item.key)}
        onMouseDown={(e) => e.preventDefault() /* same: never take focus from the menu */}
        onClick={(e) => {
          lastPointer = { x: e.clientX, y: e.clientY };
          star(p.item.model);
        }}
      >
        <Icon name="star" small />
      </button>
    </div>
  );

  // A provider row opens its step rather than choosing: the chevron says so. It stays enabled
  // while changing is blocked, so the list is still browsable.
  const ProviderRow = (p: { item: Extract<PickerItem, { kind: "provider" }> }) => (
    <div class="model-row" role="none" data-key={p.item.key}>
      <div
        class="model-option model-option-nav"
        role="option"
        id={optionId(p.item)}
        aria-selected={p.item.current ? "true" : "false"}
        data-active={active() === p.item.key ? "" : undefined}
        onMouseEnter={() => hover(p.item.key)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => openProvider(p.item.provider)}
      >
        <Icon name="check" small class="model-option-check" />
        <span class="model-option-id">{p.item.provider}</span>
        <span class="model-option-count">{modelCount(p.item.count)}</span>
        <Icon name="chevron-right" small class="model-option-chevron" />
      </div>
    </div>
  );

  const Row = (p: { item: PickerItem }) => {
    const item = p.item;
    return item.kind === "model" ? <ModelRow item={item} /> : <ProviderRow item={item} />;
  };

  return (
    <>
      <div class="composer-flyout-head">
        <button type="button" class="button button-sm button-ghost composer-flyout-back" onClick={back}>
          <Icon name="chevron-left" small />
          Back
        </button>
        <Show when={viewProvider()}>{(p) => <span class="model-menu-head-title">{p()}</span>}</Show>
      </div>
      <div class="model-menu-search">
        <div class="search">
          <Icon name="search" />
          <input
            ref={search}
            class="input"
            type="text"
            role="combobox"
            aria-label={viewProvider() ? `Search ${viewProvider()}` : "Search models"}
            placeholder={viewProvider() ? `Search ${viewProvider()}` : "Search models"}
            autocomplete="off"
            spellcheck={false}
            aria-expanded="true"
            aria-controls={paneId("model-listbox")}
            aria-autocomplete="list"
            aria-activedescendant={activeItem() ? optionId(activeItem()!) : undefined}
            value={query()}
            onInput={(e) => changeQuery(e.currentTarget.value)}
            onKeyDown={(e) => navKey(e, true)}
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

      <Show when={starError()}>
        {(err) => (
          <Banner
            tone="error"
            title={
              <>
                Couldn't {err().favorite ? "add" : "remove"} <code>{err().id}</code> {err().favorite ? "to" : "from"} favorites.
              </>
            }
            body={`${err().message.replace(/\.?$/, ".")} Your favorites are unchanged.`}
            action={
              <button type="button" class="button button-sm button-ghost" onMouseDown={(e) => e.preventDefault()} onClick={() => setStarError(null)}>
                Dismiss
              </button>
            }
          />
        )}
      </Show>

      <div
        class="model-menu-list"
        id={paneId("model-listbox")}
        role="listbox"
        aria-label={viewProvider() ? `${viewProvider()} models` : "Models"}
        tabindex="-1"
        aria-activedescendant={activeItem() ? optionId(activeItem()!) : undefined}
        aria-busy={loading() && !models() ? "true" : undefined}
        ref={listbox}
        onKeyDown={onListKey}
        onMouseMove={onPointerMove}
      >
        <Show when={!models() && showSkeleton()}>
          <For each={[1, 2, 3, 4]}>{() => <div class="skeleton skeleton-row" />}</For>
        </Show>
        <Show when={models()}>
          <Show
            when={flat().length > 0}
            fallback={
              <p class="model-menu-empty">
                <Show
                  when={query().trim()}
                  fallback={
                    <Show
                      when={(models() ?? []).length > 0}
                      fallback={
                        <>
                          0 models have credentials. Log in with <code>pi</code> in a terminal to add one.
                        </>
                      }
                    >
                      Every model is turned off in Settings → Models. Turn one back on to switch to it.
                    </Show>
                  }
                >
                  0 models match “{query().trim()}”.
                </Show>
              </p>
            }
          >
            <For each={groups()}>
              {(g) => (
                <Show when={g.label} fallback={<For each={g.items}>{(item) => <Row item={item} />}</For>}>
                  {(label) => (
                    <div class="model-menu-group" role="group" aria-labelledby={paneId(`mg-${domSafe(g.key)}`)}>
                      <div class="list-group-label" id={paneId(`mg-${domSafe(g.key)}`)}>
                        {label()}
                      </div>
                      <For each={g.items}>{(item) => <Row item={item} />}</For>
                    </div>
                  )}
                </Show>
              )}
            </For>
          </Show>
        </Show>
      </div>

      <p class="model-menu-foot">
        <kbd>↑</kbd>
        <kbd>↓</kbd> to move · <kbd>Enter</kbd> to choose · <kbd>Esc</kbd> to close
        {/* Its own line: at 360px the four hints can't share one without rewording the first three. */}
        <span class="model-menu-foot-line">
          <kbd>Ctrl</kbd>+<kbd>F</kbd> to add or remove a favorite
        </span>
      </p>
    </>
  );
}
