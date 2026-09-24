import { createMemo, createSignal, For, Show, type Accessor } from "solid-js";
import type { ChatServerMessage, ModeInfo } from "../../shared/protocol";
import { getMode, postMode, saveModeDefault } from "../lib/api";
import { FOOT_NOTE, isDefaultMode, modeSummary, saveLabel, saveTitle, type ShownMode } from "../lib/mode-menu";
import { usePaneId } from "../lib/pane-scope";
import { openSettings } from "../lib/settings-nav";
import { announce } from "../lib/ui-state";
import { Banner, Icon } from "./ui";

/** This chat's last WS "mode" message: the mode of THIS chat and how a switch applies here. */
export type ModeState = Omit<Extract<ChatServerMessage, { type: "mode" }>, "type">;

/** What the chat view hands its composer so the foot can show and switch this chat's mode. */
export interface ModeControl {
  state: Accessor<ModeState | null>;
  /** This chat's session file: POST /api/mode?path= switches this chat and no other. */
  path: string;
}

/** radio: the major mode; check: a minor mode; action: opens a settings screen, switches nothing. */
type Item = { kind: "radio" | "check" | "action"; id: string; description: string; label?: string };

/** The actions: a gear on Delegate's row and on spec's, since both settings live in Settings → Modes. */
const CONFIGURE_DELEGATE: Item = {
  kind: "action",
  id: "configure-delegate",
  label: "Configure Delegate",
  description: "Which worker each kind of work goes to",
};
const CONFIGURE_SPEC: Item = {
  kind: "action",
  id: "configure-spec",
  label: "Configure Spec",
  description: "Which worker writes the spec",
};

const itemId = (it: Item) => `mode-${it.kind}-${it.id}`;

// Lists of what exists (and the default for new sessions); fetched on first open, refreshed on
// every open. Only `modes`/`minors` are read from it: what is checked comes from this chat.
const [info, setInfo] = createSignal<ModeInfo | null>(null);
/**
 * What new sessions start from, as mode.json says: written ONLY by GET /api/mode (each open) and by
 * the save's answer (the file as written). Never by a switch — a switch's reply is THIS chat's mode,
 * and reading it here made the footer say "Already the default" after any minor toggle. null when
 * the last read failed: unknown is never "already the default".
 */
const [defaultMode, setDefaultMode] = createSignal<ShownMode | null>(null);
const shownOf = (m: Pick<ModeInfo, "mode" | "minorModes" | "strict">): ShownMode => ({ mode: m.mode, minorModes: [...m.minorModes], strict: m.strict });

/**
 * The composer foot's mode switch: a trigger plus a native popover menu. One
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
  /** The save's own request. `busy` is the rows' (a switch): the button says "Saving…" only for this. */
  const [saving, setSaving] = createSignal(false);

  // This chat's own state only. Before its WS "mode" message arrives there is nothing to show:
  // the default in `info()` is not this chat's mode, so the label stays "Mode" and nothing is checked.
  const current = () => props.control.state();
  const items = createMemo<Item[]>(() => {
    const i = info();
    if (!i) return [];
    // Each gear follows its row in the roving order, as it follows it on the row.
    return [
      ...i.modes.flatMap((m) => (m.id === "delegate" ? [{ kind: "radio" as const, ...m }, CONFIGURE_DELEGATE] : [{ kind: "radio" as const, ...m }])),
      ...i.minors.flatMap((m) => (m.id === "spec" ? [{ kind: "check" as const, ...m }, CONFIGURE_SPEC] : [{ kind: "check" as const, ...m }])),
    ];
  });
  const checked = (it: Item) => {
    const c = current();
    if (!c || it.kind === "action") return false;
    return it.kind === "radio" ? c.mode === it.id : c.minorModes.includes(it.id);
  };
  const label = () => {
    const c = current();
    return c ? [c.mode, ...c.minorModes].join(" · ") : "Mode";
  };
  const name = () => `Mode: ${label()}${current()?.applies === "after-turn" ? ", applies after this turn" : ""}`;

  /** This chat's mode as the footer reads it, or null before its "mode" message arrives. */
  const shown = (): ShownMode | null => {
    const c = current();
    return c ? shownOf(c) : null;
  };
  /**
   * Is what this chat is on already what new sessions start from? Read off the file's own
   * `mode`/`strict`/`minorModes` (`defaultMode`: GET /api/mode on every open, or the save's answer),
   * so the answer is the file's, not a guess from the last press or from a switch's reply.
   */
  const alreadyDefault = () => isDefaultMode(defaultMode(), shown());
  const saveState = (): "idle" | "saving" | "done" => (saving() ? "saving" : alreadyDefault() ? "done" : "idle");

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
      const read = await getMode();
      setInfo(read);
      setDefaultMode(shownOf(read));
    } catch {
      setDefaultMode(null);
      if (!info()) setError({ title: "Couldn't load the modes.", body: "Your mode is unchanged. Close this and try again." });
    }
    const at = items().findIndex((it) => it.kind === "radio" && checked(it));
    focusItem(Math.max(0, at));
  };
  const closeMenu = () => {
    if (menu.matches(":popover-open")) menu.hidePopover();
  };

  const activate = async (it: Item) => {
    if (it.kind === "action") {
      // Opens Settings at Modes (→ Delegate, or → Spec). This chat's mode is left exactly as it is.
      closedByChoice = true;
      closeMenu();
      openSettings("modes", it.id === CONFIGURE_SPEC.id ? "spec" : null);
      return;
    }
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

  /**
   * `Save as default`: make THIS chat's mode the one new sessions start from. Nothing else
   * moves — the chat keeps its mode, and no other chat hears about it. The mode extension re-reads
   * mode.json at each session_start, so the next session starts on it, TUI included.
   *
   * The press is what the file gets: the request carries no mode of its own (the server takes this
   * chat's), so a switch that lands between the click and the request cannot make the default
   * something the user never saw. On success the answer — the file as written — becomes
   * `defaultMode`, so `alreadyDefault` says so from the server's own copy.
   *
   * Pressable in a chat that can't switch (`applies: "new-chats"`) too: it saves the very state the
   * menu is showing, which is still a mode someone can want new sessions to start from.
   */
  const saveAsDefault = async () => {
    if (busy() || saving() || alreadyDefault()) return;
    setSaving(true);
    setError(null);
    try {
      const written = await saveModeDefault(props.control.path); // the file as written, not this chat's copy
      setDefaultMode(shownOf(written));
      setInfo((i) => i ?? written); // the lists, in case the open-time read failed
      const mode = shown();
      announce(mode ? `Default mode saved: ${modeSummary(mode)}. New sessions start here.` : "Default mode saved. New sessions start here.");
    } catch (err) {
      const why = (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
      setError({ title: "Couldn't save the default.", body: `${why}. Your mode is unchanged.` });
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // Only the menu's own items take keys here: the footer's button is a button, and Enter or Space
    // on it must press IT, not whichever row was last focused.
    if (!(e.target as HTMLElement | null)?.closest?.("[role^=menuitem]")) return;
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
        <span class="mode-option-id">{p.it.label ?? p.it.id}</span>
        <span class="mode-option-desc">{p.it.description}</span>
      </span>
    </div>
  );
  // A sibling of its row, not inside it: a button nested in a menuitemradio (or menuitemcheckbox) loses its role.
  const Gear = (p: { it: Item; index: number }) => (
    <button
      type="button"
      class="button button-ghost button-icon mode-option-gear"
      role="menuitem"
      id={itemId(p.it)}
      tabindex={active() === p.index ? 0 : -1}
      aria-label={p.it.label}
      title={p.it.label}
      onClick={() => {
        setActive(p.index);
        void activate(p.it);
      }}
      onFocus={() => setActive(p.index)}
    >
      <Icon name="settings" small />
    </button>
  );
  /** A row, with its gear beside it when an action follows it in the roving order. */
  const WithGear = (p: { it: Item; index: number }) => {
    const gear = () => (items()[p.index + 1]?.kind === "action" ? items()[p.index + 1]! : null);
    return (
      <Show when={gear()} fallback={<Row it={p.it} index={p.index} />}>
        {(g) => (
          <div class="mode-option-row" role="none">
            <Row it={p.it} index={p.index} />
            <Gear it={g()} index={p.index + 1} />
          </div>
        )}
      </Show>
    );
  };
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
        <Icon name="sliders" small />
        {/* Two parts, so a narrow foot ellipsizes the minor modes before the major one. */}
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
            <For each={group("radio")}>{(x) => <WithGear it={x.it} index={x.index} />}</For>
          </div>
          <Show when={group("check").length > 0}>
            <div class="model-menu-group" role="group" aria-labelledby={paneId("mode-group-minor")}>
              <div class="list-group-label" id={paneId("mode-group-minor")}>
                Minor modes
              </div>
              <For each={group("check")}>{(x) => <WithGear it={x.it} index={x.index} />}</For>
            </div>
          </Show>
        </div>

        <div class="mode-menu-foot">
          <p class="mode-menu-foot-line">
            <span class="text-mono">strict: {current()?.strict ? "on" : "off"}</span> · {FOOT_NOTE}
          </p>
          <button
            type="button"
            class="button button-ghost button-sm mode-menu-save"
            aria-disabled={busy() || saving() || alreadyDefault() ? "true" : undefined}
            title={saveTitle(shown(), alreadyDefault())}
            onClick={() => void saveAsDefault()}
          >
            <Show when={alreadyDefault() && !saving()}>
              <Icon name="check" small />
            </Show>
            {saveLabel(saveState())}
          </button>
        </div>
      </div>
    </>
  );
}
