import { createMemo, createSignal, For, Show, type Accessor } from "solid-js";
import type { ChatServerMessage, ModeInfo } from "../../shared/protocol";
import { getMode, postMode } from "../lib/api";
import { usePaneId } from "../lib/pane-scope";
import { Banner, Icon } from "./ui";

/** This chat's last WS "mode" message: the mode of THIS chat and how a switch applies here. */
export type ModeState = Omit<Extract<ChatServerMessage, { type: "mode" }>, "type">;

/** What the chat view hands its composer so the foot can show and switch this chat's mode. */
export interface ModeControl {
  state: Accessor<ModeState | null>;
  /** This chat's session file: POST /api/mode?path= switches this chat and no other. */
  path: string;
}

type Item = { kind: "radio" | "check"; id: string; description: string };

const itemId = (it: Item) => `mode-${it.kind}-${it.id}`;

// Lists of what exists (and the default for new sessions); fetched on first open, refreshed on
// every open. Only `modes`/`minors` are read from it: what is checked comes from this chat.
const [info, setInfo] = createSignal<ModeInfo | null>(null);

/**
 * The composer foot's mode switch (spec/04g-mode-menu.md §4g): a trigger plus a native popover menu. One
 * major mode (menuitemradio, picking closes) and any minor modes (menuitemcheckbox, toggling
 * stays open). The mode is per chat: only this chat follows, from its next message.
 */
export function ModeMenu(props: { control: ModeControl }) {
  const paneId = usePaneId();
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;
  let closedByChoice = false;
  let tabbedAway = false;

  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<{ title: string; body: string } | null>(null);
  const [active, setActive] = createSignal(0);

  // This chat's own state only. Before its WS "mode" message arrives there is nothing to show:
  // the default in `info()` is not this chat's mode, so the label stays "Mode" and nothing is checked.
  const current = () => props.control.state();
  const items = createMemo<Item[]>(() => {
    const i = info();
    if (!i) return [];
    return [...i.modes.map((m) => ({ kind: "radio" as const, ...m })), ...i.minors.map((m) => ({ kind: "check" as const, ...m }))];
  });
  const checked = (it: Item) => {
    const c = current();
    return !!c && (it.kind === "radio" ? c.mode === it.id : c.minorModes.includes(it.id));
  };
  const label = () => {
    const c = current();
    return c ? [c.mode, ...c.minorModes].join(" · ") : "Mode";
  };
  const name = () => `Mode: ${label()}${current()?.applies === "after-turn" ? ", applies after this turn" : ""}`;

  const focusItem = (i: number) => {
    setActive(i);
    queueMicrotask(() => menu.querySelectorAll<HTMLElement>("[role^=menuitem]")[i]?.focus());
  };

  const openMenu = async (keepError = false) => {
    if (open()) return;
    const r = trigger.getBoundingClientRect();
    // The foot is pinned to the pane's bottom edge, so the menu grows upward from the trigger.
    menu.style.setProperty("--menu-bottom", `${Math.round(innerHeight - r.top + 4)}px`);
    menu.style.setProperty("--menu-right", `${Math.round(innerWidth - r.right)}px`);
    closedByChoice = false;
    tabbedAway = false;
    if (!keepError) setError(null);
    menu.showPopover();
    try {
      setInfo(await getMode());
    } catch {
      if (!info()) setError({ title: "Couldn't load the modes.", body: "Your mode is unchanged. Close this and try again." });
    }
    const at = items().findIndex((it) => it.kind === "radio" && checked(it));
    focusItem(Math.max(0, at));
  };
  const closeMenu = () => {
    if (menu.matches(":popover-open")) menu.hidePopover();
  };

  const activate = async (it: Item) => {
    const c = current();
    if (!c || busy()) return;
    let patch: { mode?: string; minorModes?: string[] };
    if (it.kind === "radio") {
      closedByChoice = true;
      closeMenu();
      trigger.focus();
      if (it.id === c.mode) return;
      patch = { mode: it.id };
    } else {
      patch = { minorModes: checked(it) ? c.minorModes.filter((m) => m !== it.id) : [...c.minorModes, it.id] };
    }
    setBusy(true);
    setError(null);
    try {
      setInfo(await postMode(patch, props.control.path)); // this chat's "mode" message follows over the socket
    } catch (err) {
      const why = (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
      setError({ title: "Couldn't switch the mode.", body: `${why}. Your mode is unchanged.` });
      if (it.kind === "radio") await openMenu(true); // show why, in place
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const n = items().length;
    if (n === 0) return;
    const keys: Record<string, () => void> = {
      ArrowDown: () => focusItem((active() + 1) % n),
      ArrowUp: () => focusItem((active() - 1 + n) % n),
      Home: () => focusItem(0),
      End: () => focusItem(n - 1),
      Enter: () => void activate(items()[active()]!),
      " ": () => void activate(items()[active()]!),
    };
    const act = keys[e.key];
    if (!act) return;
    e.preventDefault();
    act();
  };

  const Row = (p: { it: Item; index: number }) => (
    <div
      class="mode-option"
      role={p.it.kind === "radio" ? "menuitemradio" : "menuitemcheckbox"}
      id={itemId(p.it)}
      tabindex={active() === p.index ? 0 : -1}
      aria-checked={checked(p.it) ? "true" : "false"}
      aria-disabled={busy() ? "true" : undefined}
      onClick={() => {
        setActive(p.index);
        void activate(p.it);
      }}
      onFocus={() => setActive(p.index)}
    >
      <Icon name="check" small class="mode-option-check" />
      <span class="mode-option-text">
        <span class="mode-option-id">{p.it.id}</span>
        <span class="mode-option-desc">{p.it.description}</span>
      </span>
    </div>
  );
  const group = (kind: Item["kind"]) => items().map((it, index) => ({ it, index })).filter((x) => x.it.kind === kind);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class="button button-ghost mode-trigger"
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={paneId("mode-popover")}
        aria-label={name()}
        title={name()}
        data-applies={current()?.applies}
        onClick={() => (open() ? closeMenu() : void openMenu())}
      >
        <Icon name="worker" small />
        {/* Two parts, so a narrow foot ellipsizes the minor modes before the major one (§4g). */}
        <span class="mode-trigger-label">{current()?.mode ?? "Mode"}</span>
        <Show when={current()?.minorModes.length}>
          <span class="mode-trigger-label mode-trigger-minor">· {current()!.minorModes.join(" · ")}</span>
        </Show>
        <Icon name="chevron-down" small />
      </button>

      <div
        ref={menu}
        class="model-menu mode-menu"
        id={paneId("mode-popover")}
        popover="auto"
        onKeyDown={onKeyDown}
        onToggle={(e) => {
          const isOpen = (e as ToggleEvent).newState === "open";
          setOpen(isOpen);
          if (!isOpen && !closedByChoice && !tabbedAway) trigger.focus();
        }}
        onFocusOut={(e) => {
          const to = e.relatedTarget as Node | null;
          if (to && !menu.contains(to) && to !== trigger) {
            tabbedAway = true;
            closeMenu();
          }
        }}
      >
        <Show when={current()?.applies === "after-turn"}>
          <Banner
            tone="info"
            title="Applies after this turn."
            body="This turn keeps the old mode, and so do messages queued during it. Your next message follows the new one."
          />
        </Show>
        <Show when={current()?.applies === "new-chats"}>
          <Banner
            tone="warn"
            title="This chat can't switch."
            body="This chat can't switch: the mode extension isn't loaded here, or another program wrote this session."
          />
        </Show>
        <Show when={error()}>{(e) => <Banner tone="error" title={e().title} body={e().body} />}</Show>

        <div class="model-menu-list" role="menu" id={paneId("mode-menu")} aria-label="Mode">
          <div class="model-menu-group" role="group" aria-labelledby={paneId("mode-group-major")}>
            <div class="list-group-label" id={paneId("mode-group-major")}>
              Major mode
            </div>
            <For each={group("radio")}>{(x) => <Row it={x.it} index={x.index} />}</For>
          </div>
          <Show when={group("check").length > 0}>
            <div class="model-menu-group" role="group" aria-labelledby={paneId("mode-group-minor")}>
              <div class="list-group-label" id={paneId("mode-group-minor")}>
                Minor modes
              </div>
              <For each={group("check")}>{(x) => <Row it={x.it} index={x.index} />}</For>
            </div>
          </Show>
        </div>

        <p class="mode-menu-foot">
          <span class="text-mono">strict: {current()?.strict ? "on" : "off"}</span> · This chat only. New sessions start from
          the default; <code>/mode default</code> saves this chat's as it.
        </p>
      </div>
    </>
  );
}
