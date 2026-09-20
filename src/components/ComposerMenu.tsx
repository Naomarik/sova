import { createMemo, createSignal, Index, onCleanup, Show, type Accessor } from "solid-js";
import { ensureModels, thinkingLevelsFor } from "../lib/models";
import { ModelPicker, type ModelControl } from "./ModelMenu";
import { Icon, type IconName } from "./ui";

/** What the chat view exposes so the flyout can show and change this session's thinking level. */
export interface ThinkingControl {
  /** Active level (one of the model's `thinkingLevels`), or null before hello reports one. */
  level: Accessor<string | null>;
  /** Level asked for, until the server's `{type:"thinking"}` echo — which may clamp it. */
  pending: Accessor<string | null>;
  /** Why changing is blocked right now (agent running, composer disabled), else null. */
  blocked: Accessor<string | null>;
  choose(level: string): void;
}

const idOf = (ref: string) => ref.slice(ref.indexOf("/") + 1);
const providerOf = (ref: string) => ref.slice(0, Math.max(0, ref.indexOf("/")));

/** One row of the root panel. Rendering order is this array's order, separators included. */
interface Row {
  id: string;
  role: "menuitem" | "menuitemradio";
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
  run(): void;
}

/**
 * The composer's flyout (DESIGN_NOTES §4b): one ghost `plus` button opening a native popover
 * anchored ABOVE it, in the model menu's visual family. Root panel: Attach images, Commands,
 * the Model row, this model's Thinking ladder, and Session info. The Model row swaps in the
 * §4c picker as a second panel, with a way back. Ctrl/⌘+P opens it straight on that panel.
 */
export function ComposerMenu(props: {
  /** The composer is disabled (TUI-live, connecting, reconnecting): nothing here acts. */
  disabled: boolean;
  /** This session has slash commands; without them the Commands row can't open anything. */
  commandsAvailable: boolean;
  /** Opens the composer's hidden file picker (the picker stays the composer's). */
  onAttach(): void;
  /** Opens the slash menu, exactly as the old Commands button did. */
  onCommands(): void;
  /** Chat sessions only: the model picker's controls (§4c). */
  model?: ModelControl | null;
  /** Chat sessions only: this session's thinking ladder. */
  thinking?: ThinkingControl | null;
  /** Opens the per-session info modal (§4h). */
  onShowInfo?: () => void;
  /** Puts focus back in the textarea after a choice. */
  onRefocus(): void;
}) {
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;
  let closedByChoice = false; // focus handling is the choice's, not the trigger's
  let tabbedAway = false;

  const [open, setOpen] = createSignal(false);
  const [panel, setPanel] = createSignal<"root" | "model">("root");
  const [active, setActive] = createSignal(0);

  const levels = createMemo(() => (props.thinking ? thinkingLevelsFor(props.model?.model()) : []));
  /** One level is no choice, and an unknown model has no ladder to show yet. */
  const showThinking = () => levels().length > 1;

  const rows = createMemo<Row[]>(() => {
    const out: Row[] = [];
    out.push({
      id: "attach",
      role: "menuitem",
      icon: "attach",
      label: "Attach images",
      disabled: props.disabled,
      describe: true,
      run: () => {
        close(true);
        props.onAttach();
      },
    });
    out.push({
      id: "commands",
      role: "menuitem",
      icon: "command",
      label: "Commands",
      disabled: props.disabled || !props.commandsAvailable,
      title: props.commandsAvailable ? undefined : "No commands available",
      describe: props.disabled,
      run: () => {
        close(true);
        props.onCommands();
      },
    });

    const model = props.model;
    if (model) {
      const pending = model.pending();
      const ref = pending ?? model.model();
      out.push({
        id: "model",
        role: "menuitem",
        icon: "worker",
        label: "Model",
        value: ref ? idOf(ref) : "Choose model",
        meta: ref ? providerOf(ref) : undefined,
        chevron: true,
        busy: !!pending,
        disabled: !!pending,
        title: pending ?? model.model() ?? "Choose model",
        run: () => openPanel("model"),
      });

      const thinking = props.thinking;
      if (thinking && showThinking()) {
        const why = thinking.blocked();
        const pendingLevel = thinking.pending();
        for (const level of levels())
          out.push({
            id: `thinking-${level}`,
            role: "menuitemradio",
            label: level,
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
    }

    if (props.onShowInfo)
      out.push({
        id: "info",
        role: "menuitem",
        icon: "info",
        label: "Session info",
        disabled: false,
        run: () => {
          close(true);
          props.onShowInfo?.();
        },
      });
    return out;
  });

  /** Rows of one section, each with its index in `rows()` — the keyboard's order. */
  const pick = (keep: (r: Row) => boolean) => rows().map((r, index) => ({ r, index })).filter((x) => keep(x.r));

  const focusItem = (i: number) => {
    setActive(i);
    queueMicrotask(() => menu.querySelectorAll<HTMLElement>(".composer-flyout-list [role^=menuitem]")[i]?.focus());
  };

  /** Anchors the popover ABOVE the trigger: the composer sits at the bottom of the pane. */
  const place = () => {
    const r = trigger.getBoundingClientRect();
    if (trigger.offsetParent === null || (r.width === 0 && r.height === 0)) return false;
    menu.style.setProperty("--menu-bottom", `${Math.round(innerHeight - r.top + 4)}px`);
    menu.style.setProperty("--menu-left", `${Math.round(r.left)}px`);
    return true;
  };

  const openMenu = (to: "root" | "model" = "root") => {
    place();
    closedByChoice = false;
    tabbedAway = false;
    // Show first: a panel that mounts into a hidden popover can't take focus.
    if (!menu.matches(":popover-open")) menu.showPopover();
    setPanel(to);
    void ensureModels().catch(() => {}); // the Thinking ladder needs the list; the picker reports its own failure
    if (to === "root") {
      const at = rows().findIndex((r) => !r.disabled);
      focusItem(Math.max(0, at));
    }
  };
  const close = (byChoice = false) => {
    closedByChoice = byChoice;
    if (menu.matches(":popover-open")) menu.hidePopover();
  };
  const openPanel = (to: "root" | "model") => {
    place();
    setPanel(to);
    if (to === "root") focusItem(rows().findIndex((r) => r.id === "model"));
  };

  // Ctrl/⌘+P opens the flyout on the model panel while a chat session is open, instead of printing.
  const onKey = (e: KeyboardEvent) => {
    if (!props.model) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      if (open() && panel() === "model") close();
      else openMenu("model");
    }
  };
  // A resize (a phone's keyboard opening included) only re-anchors it; it closes only when the
  // trigger itself is gone from the layout.
  const onResize = () => {
    if (open() && !place()) close();
  };
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", onResize);
  window.visualViewport?.addEventListener("resize", onResize);
  onCleanup(() => {
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onResize);
    window.visualViewport?.removeEventListener("resize", onResize);
  });

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

  const Item = (p: { r: Row; index: number }) => (
    <div
      class="mode-option composer-flyout-item"
      role={p.r.role}
      id={`composer-flyout-${p.r.id}`}
      tabindex={active() === p.index ? 0 : -1}
      aria-checked={p.r.role === "menuitemradio" ? (p.r.checked ? "true" : "false") : undefined}
      aria-haspopup={p.r.chevron ? "true" : undefined}
      aria-disabled={p.r.disabled ? "true" : undefined}
      aria-busy={p.r.busy ? "true" : undefined}
      aria-describedby={p.r.describe ? "composer-reason" : undefined}
      title={p.r.title}
      onClick={() => {
        setActive(p.index);
        if (!p.r.disabled) p.r.run();
      }}
      onFocus={() => setActive(p.index)}
    >
      <Show when={p.r.role === "menuitemradio"} fallback={<Icon name={p.r.icon ?? "more"} small class="composer-flyout-icon" />}>
        <Icon name="check" small class="mode-option-check" />
      </Show>
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
        <Icon name="chevron-right" small class="composer-flyout-chevron" />
      </Show>
    </div>
  );

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class="button button-icon button-ghost composer-menu-trigger"
        id="composer-menu-trigger"
        aria-label="More Actions"
        title="More Actions"
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        aria-controls="composer-flyout"
        onClick={() => (open() ? close() : openMenu())}
      >
        <Icon name="plus" />
      </button>

      <div
        ref={menu}
        class="model-menu composer-flyout"
        id="composer-flyout"
        popover="auto"
        onToggle={(e) => {
          const isOpen = (e as ToggleEvent).newState === "open";
          setOpen(isOpen);
          if (isOpen) return;
          setPanel("root"); // the panel, like the query, doesn't survive a close
          if (!closedByChoice && !tabbedAway) trigger.focus();
        }}
        onFocusOut={(e) => {
          const to = e.relatedTarget as Node | null;
          if (to && !menu.contains(to) && to !== trigger) {
            tabbedAway = true;
            close();
          }
        }}
      >
        <Show
          when={panel() === "root"}
          fallback={
            <Show when={props.model}>
              {(control) => (
                <ModelPicker
                  control={control()}
                  autoFocus
                  onChosen={() => {
                    close(true);
                    props.onRefocus();
                  }}
                  head={
                    <div class="composer-flyout-head">
                      <button type="button" class="button button-sm button-ghost composer-flyout-back" onClick={() => openPanel("root")}>
                        <Icon name="chevron-left" small />
                        Back to Menu
                      </button>
                    </div>
                  }
                />
              )}
            </Show>
          }
        >
          <div class="model-menu-list composer-flyout-list" role="menu" aria-label="More actions" onKeyDown={onListKeyDown}>
            <Index each={pick((r) => r.id === "attach" || r.id === "commands")}>{(x) => <Item r={x().r} index={x().index} />}</Index>
            <Show when={pick((r) => r.id === "model").length > 0}>
              <div class="composer-flyout-sep" role="separator" />
              <Index each={pick((r) => r.id === "model")}>{(x) => <Item r={x().r} index={x().index} />}</Index>
            </Show>
            <Show when={pick((r) => r.role === "menuitemradio").length > 0}>
              <div class="composer-flyout-sep" role="separator" />
              <div class="model-menu-group" role="group" aria-labelledby="composer-flyout-thinking">
                <div class="list-group-label" id="composer-flyout-thinking">
                  Thinking
                </div>
                <Index each={pick((r) => r.role === "menuitemradio")}>{(x) => <Item r={x().r} index={x().index} />}</Index>
              </div>
            </Show>
            <Show when={pick((r) => r.id === "info").length > 0}>
              <div class="composer-flyout-sep" role="separator" />
              <Index each={pick((r) => r.id === "info")}>{(x) => <Item r={x().r} index={x().index} />}</Index>
            </Show>
          </div>
        </Show>
      </div>
    </>
  );
}
