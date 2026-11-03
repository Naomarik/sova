import { createMemo, createSignal, Index, Match, onCleanup, Show, Switch } from "solid-js";
import type { ModelPick } from "../../shared/powers";
export { pickLabel } from "../lib/model-pick";
import type { ThinkingLevel } from "../../shared/profiles";
import { modelLabel, modelProvider } from "../lib/format";
import { ensureModels, thinkingLevelsFor } from "../lib/models";
import { useHostScope } from "../lib/host-scope";
import { pickWithModel } from "../lib/model-pick";
import { usePaneId } from "../lib/pane-scope";
import type { ThinkingControl } from "./ComposerMenu";
import { ModelPicker, type ModelControl } from "./ModelMenu";
import { Icon, type IconName } from "./ui";
import { EffortRing } from "./EffortRing";
import "./ModelPickButton.css";

/** One row of a flyout panel (the composer's, and this picker's model panel). */
export interface FlyoutRow {
  id: string;
  role: "menuitem" | "menuitemradio" | "menuitemcheckbox";
  icon?: IconName;
  label: string;
  /** The model row's current id, in mono, after the label. */
  value?: string;
  /** The model row's provider, muted, after the value. */
  meta?: string;
  /** A submenu row (the model panel). */
  chevron?: boolean;
  checked?: boolean;
  busy?: boolean;
  disabled: boolean;
  title?: string;
  /** Shares the composer's reason line, so a disabled row reads out why. */
  describe?: boolean;
  /** The login panel's account group the row sits in. */
  group?: string;
  /** A Thinking ladder row's level: its effort ring beside the name. */
  ring?: string;
  run(): void;
}

/**
 * The model panel's rows (§chat.composer/composer-flyout): the Model row, which opens the picker, then
 * one radio per level of the model's thinking ladder when it has more than one. The composer's flyout
 * and the Project Assistant's model control (below) build them here, so both panels are the same.
 */
export function modelPanelRows(o: { model: ModelControl; thinking: ThinkingControl | null | undefined; levels: string[]; openPicker(): void }): FlyoutRow[] {
  const out: FlyoutRow[] = [];
  const model = o.model;
  const pending = model.pending();
  const ref = pending ?? model.model();
  out.push({
    id: "model",
    role: "menuitem",
    icon: "worker",
    label: "Model",
    value: modelLabel(ref) ?? "Choose model",
    meta: ref ? modelProvider(ref) || undefined : undefined,
    chevron: true,
    busy: !!pending,
    disabled: !!pending,
    title: pending ?? model.model() ?? "Choose model",
    run: () => o.openPicker(),
  });
  const thinking = o.thinking;
  if (thinking && o.levels.length > 1) {
    const why = thinking.blocked();
    const pendingLevel = thinking.pending();
    for (const level of o.levels)
      out.push({
        id: `thinking-${level}`,
        role: "menuitemradio",
        label: level,
        ring: level,
        checked: level === (thinking.level() ?? ""),
        busy: level === pendingLevel,
        disabled: !!why || !!pendingLevel,
        title: why ?? undefined,
        run: () => {
          if (why || pendingLevel || level === thinking.level()) return;
          thinking.choose(level); // the radio follows the server's echo, which may clamp it
        },
      });
  }
  return out;
}

/**
 * The Project Assistant's model control (§app.project-assistant/models, §chat.model-menu/menu): a
 * button that opens the composer's model panel (the Model row and the picked model's thinking ladder)
 * and, from its Model row, the composer's picker (providers first, favorites, search, the vision tag,
 * models Settings → Models turned off left out), in a popover of its own. Picking calls `onPick` with
 * the model AND its thinking (a level the new model lacks is cleared); the panel stays open on the
 * new model's ladder. Nothing here saves: Settings puts the pick in its draft, the Owner card saves it.
 */
export function ModelPickButton(props: {
  /** The value it shows and changes. */
  value: ModelPick | null;
  onPick(pick: ModelPick): void;
  /** The button's words (`Change`, `Choose Model`). */
  label: string;
  /** Its accessible name when the words alone don't say what changes ("Change Its replies"). */
  ariaLabel?: string;
  /** A save is in flight: nothing can be picked. */
  busy?: boolean;
  disabled?: boolean;
  /** For the DOM ids, unique on the page. */
  id: string;
}) {
  const paneId = usePaneId();
  const host = useHostScope();
  const id = (s: string) => paneId(`${props.id}-${s}`);
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;
  let list: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [panel, setPanel] = createSignal<"model" | "picker">("model");
  const [active, setActive] = createSignal(0);
  let closedByChoice = false;

  const blockedWhy = () => (props.busy ? "Saving…" : null);
  const control: ModelControl = {
    model: () => props.value?.model ?? null,
    pending: () => null,
    blocked: () => (props.busy ? { title: "Saving…" } : null),
    choose: (ref) => props.onPick(pickWithModel(props.value, ref, thinkingLevelsFor(ref, host()))),
  };
  const thinking: ThinkingControl = {
    level: () => props.value?.thinking ?? null,
    pending: () => null,
    blocked: blockedWhy,
    choose: (level) => {
      if (props.value) props.onPick({ model: props.value.model, thinking: level as ThinkingLevel });
    },
  };
  const levels = createMemo(() => thinkingLevelsFor(props.value?.model, host()));
  const rows = createMemo(() => modelPanelRows({ model: control, thinking, levels: levels(), openPicker: () => showPanel("picker") }));

  const focusItem = (i: number) => {
    setActive(i);
    queueMicrotask(() => list?.querySelectorAll<HTMLElement>("[role^=menuitem]")[i]?.focus());
  };
  const focusFirst = () => focusItem(Math.max(0, rows().findIndex((r) => !r.disabled)));

  /** Above the button like the composer's flyout, or below it when there's no room above. */
  const place = () => {
    const r = trigger.getBoundingClientRect();
    if (trigger.offsetParent === null) return false;
    const w = menu.offsetWidth;
    const below = r.top < Math.min(440, innerHeight * 0.7) + 8;
    menu.toggleAttribute("data-below", below);
    menu.style.setProperty("--menu-bottom", `${Math.round(innerHeight - r.top + 4)}px`);
    menu.style.setProperty("--menu-top", `${Math.round(r.bottom + 4)}px`);
    menu.style.setProperty("--menu-left", `${Math.round(w ? Math.max(4, Math.min(r.left, innerWidth - w - 4)) : r.left)}px`);
    return true;
  };
  const show = () => {
    closedByChoice = false;
    place();
    if (!menu.matches(":popover-open")) menu.showPopover();
    setPanel("model");
    place();
    void ensureModels(host()).catch(() => {}); // the ladder needs the list; the picker reports its own failure
    focusFirst();
  };
  const close = (byChoice = false) => {
    closedByChoice = byChoice;
    if (menu.matches(":popover-open")) menu.hidePopover();
  };
  const showPanel = (to: "model" | "picker") => {
    setPanel(to);
    place();
    if (to === "model") focusFirst();
  };
  const onResize = () => {
    if (open() && !place()) close();
  };
  window.addEventListener("resize", onResize);
  onCleanup(() => window.removeEventListener("resize", onResize));

  const onListKeyDown = (e: KeyboardEvent) => {
    const n = rows().length;
    if (n === 0) return;
    const keys: Record<string, () => void> = {
      ArrowDown: () => focusItem((active() + 1) % n),
      ArrowUp: () => focusItem((active() - 1 + n) % n),
      Home: () => focusItem(0),
      End: () => focusItem(n - 1),
      Enter: () => rows()[active()]?.run(),
      " ": () => rows()[active()]?.run(),
    };
    const act = keys[e.key];
    if (!act) return;
    e.preventDefault();
    act();
  };

  const Item = (p: { r: FlyoutRow; index: number }) => (
    <div
      class="popover-item composer-flyout-item"
      role={p.r.role}
      id={id(`item-${p.r.id}`)}
      tabindex={active() === p.index ? 0 : -1}
      aria-checked={p.r.role !== "menuitem" ? (p.r.checked ? "true" : "false") : undefined}
      aria-haspopup={p.r.chevron ? "true" : undefined}
      aria-disabled={p.r.disabled ? "true" : undefined}
      aria-busy={p.r.busy ? "true" : undefined}
      title={p.r.title}
      onClick={() => {
        setActive(p.index);
        if (!p.r.disabled) p.r.run();
      }}
      onFocus={() => setActive(p.index)}
    >
      <Show when={p.r.role !== "menuitem"} fallback={<Icon name={p.r.icon ?? "more"} small />}>
        <Icon name="check" small class="popover-item-check" />
      </Show>
      <Show when={p.r.ring}>{(level) => <EffortRing level={level()} />}</Show>
      <span class="composer-flyout-label">{p.r.label}</span>
      <Show when={p.r.busy}>
        <span class="live-dot" />
      </Show>
      <Show when={p.r.value}>
        <span class="composer-flyout-value">{p.r.value}</span>
      </Show>
      <Show when={p.r.meta}>
        <span class="composer-flyout-meta">{p.r.meta}</span>
      </Show>
      <Show when={p.r.chevron}>
        <Icon name="chevron-right" small />
      </Show>
    </div>
  );
  const indexed = () => rows().map((r, index) => ({ r, index }));

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class="button button-sm"
        id={id("trigger")}
        aria-label={props.ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={id("flyout")}
        disabled={props.disabled}
        aria-busy={props.busy ? "true" : undefined}
        onClick={() => (open() ? close() : show())}
      >
        {props.label}
      </button>
      <div
        ref={menu}
        class="model-menu composer-flyout model-pick-flyout"
        id={id("flyout")}
        popover="auto"
        onToggle={(e) => {
          const isOpen = (e as ToggleEvent).newState === "open";
          setOpen(isOpen);
          if (isOpen) return;
          setPanel("model");
          if (!closedByChoice) trigger.focus();
        }}
        onKeyDown={(e) => {
          // Esc closes this popover only, never the dialog or page around it.
          if (e.key === "Escape") {
            e.stopPropagation();
            e.preventDefault();
            close();
          }
        }}
      >
        <Switch>
            <Match when={panel() === "picker"}>
              <ModelPicker control={control} autoFocus onChosen={() => showPanel("model")} onBack={() => showPanel("model")} />
            </Match>
            <Match when={panel() === "model"}>
              <div ref={list} class="model-menu-list composer-flyout-list" role="menu" aria-label="Model and thinking" onKeyDown={onListKeyDown}>
                <Index each={indexed().filter((x) => x.r.id === "model")}>{(x) => <Item r={x().r} index={x().index} />}</Index>
                <Show when={indexed().some((x) => x.r.role === "menuitemradio")}>
                  <div class="popover-sep" role="separator" />
                  <div class="model-menu-group" role="group" aria-labelledby={id("thinking")}>
                    <div class="list-group-label" id={id("thinking")}>
                      Thinking
                    </div>
                    <Index each={indexed().filter((x) => x.r.role === "menuitemradio")}>{(x) => <Item r={x().r} index={x().index} />}</Index>
                  </div>
                </Show>
              </div>
            </Match>
        </Switch>
      </div>
    </>
  );
}
