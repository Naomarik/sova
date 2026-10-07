import { createContext, createMemo, createSignal, Index, Match, onCleanup, onMount, Show, Switch, useContext, type Accessor } from "solid-js";
import { modelLabel, modelProvider } from "../lib/format";
import { ensureModels, thinkingLevelsFor } from "../lib/models";
import { useHostScope } from "../lib/host-scope";
import { confirmActivate, confirmReset } from "../lib/confirm-step";
import { hideThinking, hideTools, setHideThinking, setHideTools } from "../lib/ui-state";
import { SANDBOX_ROWS, sandboxStateOf, type SandboxState } from "../lib/sandbox";
import { loginMenu, resendNote } from "../lib/claude-login";
import type { ContextState } from "../lib/context";
import type { ChatClaudeLogin, ClaudeAccountsInfo, SandboxInfo } from "../../shared/protocol";
import { ModelPicker, type ModelControl } from "./ModelMenu";
import { usePaneId } from "../lib/pane-scope";
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

/** What the chat view exposes so the flyout can rewind to just before the last user message. */
export interface UndoControl {
  /** Why it can't run now ("Stop first…", nothing to undo, composer disabled), else null; "" when
      it can't run yet with nothing to say (the chat's transcript hasn't said where its last input is). */
  blocked: Accessor<string | null>;
  run(): void;
}

/** What the chat view exposes so the flyout (and the shield) can set this chat's sandbox state
    (§chat.sandbox/states). */
export interface SandboxControl {
  /** The runtime's last "sandbox" message; null = no sandbox extension, so there is no group. */
  state: Accessor<SandboxInfo | null>;
  /** The state asked for, until the server's answer. */
  pending: Accessor<SandboxState | null>;
  set(state: SandboxState): void;
}

/** What the chat view exposes so the flyout can move this chat to another Claude login
    (§app.claude-logins/switch-login). */
export interface LoginControl {
  /** The chat's login and its waiting pick (WS "claude_login"). */
  login: Accessor<ChatClaudeLogin | null>;
  /** This device's logins (GET /api/claude/accounts), read at each opening; null until it lands. */
  info: Accessor<ClaudeAccountsInfo | null>;
  /** Why that read failed, else null. */
  error: Accessor<string | null>;
  /** Reads them again: the panel does at each opening. */
  refresh(): void;
  /** A reply is running: a pick waits for it to end. */
  running: Accessor<boolean>;
  /** The chat's context fill, for the resend note (§app.claude-logins/switch-cost). */
  context: Accessor<ContextState | undefined>;
  choose(id: string): void;
  /** Drops the waiting pick. */
  cancel(): void;
}

/** The flyout's panels: the "+" button's root menu, the indicator's model panel, the model menu's
    picker the model panel opens, the login label's login panel, and the sandbox shield's panel. */
export type FlyoutPanel = "menu" | "model" | "picker" | "login" | "sandbox";

/** What the composer gets on mount so a second trigger — the model indicator — can open
    this one popover, anchored above itself. */
export interface ComposerMenuApi {
  /** Shows the flyout on `panel`, anchored above `anchor` (the "+" trigger when it's omitted). */
  show(panel?: FlyoutPanel, anchor?: HTMLElement): void;
  close(): void;
  /** The popover is open right now — a caller's `aria-expanded`. */
  open: Accessor<boolean>;
  /** The element it's anchored to while open, so a second trigger knows the flyout is its own. */
  anchor: Accessor<HTMLElement | null>;
}

/** The session whose composer holds the flyout, provided by the view around it (chat or watch), so
    the per-session "Hide tool calls" and "Hide thinking" rows need no prop threaded through the composer. */
export const FlyoutSession = createContext<Accessor<string | undefined>>(() => undefined);

/** One row of the root panel. Rendering order is this array's order, separators included. */
interface Row {
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
  run(): void;
}

/**
 * The composer's flyout: one native popover anchored ABOVE whatever opened
 * it, in the model menu's visual family, with three panels. The ghost `plus` button opens the
 * **menu** panel (Attach images, Commands, in chats Playbooks, Hide tool calls, Hide thinking, and in
 * chats Undo last turn); the
 * composer's model indicator opens the **model** panel (the Model row and this model's
 * Thinking ladder); the Model row opens the model menu's **picker**, which comes back to the model panel.
 * The Claude login label, where shown, opens the **login** panel. Ctrl/⌘+P opens the picker.
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
  /** Chat sessions only: the model picker's controls. */
  model?: ModelControl | null;
  /** Chat sessions only: this session's thinking ladder. */
  thinking?: ThinkingControl | null;
  /** Chat sessions only: opens the Playbooks dialog, which sends a playbook as a turn. Absent
      where nothing can be sent — a watch view holds no runtime. */
  onPlaybooks?: () => void;
  /** Chat sessions only: "Undo last turn", a two-step row (the first click arms it). */
  undo?: UndoControl | null;
  /** Chat sessions whose runtime has the sandbox extension: the Sandbox group (and the shield's panel). */
  sandbox?: SandboxControl | null;
  /** Chat sessions on a Claude Code model with several logins: the login panel. */
  login?: LoginControl | null;
  /** Puts focus back in the textarea after a choice. */
  onRefocus(): void;
  /** Called once on mount with the handle the composer's model indicator opens this menu by. */
  onApi?: (api: ComposerMenuApi) => void;
}) {
  const paneId = usePaneId();
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;
  let closedByChoice = false; // focus handling is the choice's, not the trigger's
  let tabbedAway = false;

  const [open, setOpen] = createSignal(false);
  /** The element the popover is measured from: the "+" trigger, or whatever opened it. */
  const [anchor, setAnchor] = createSignal<HTMLElement | null>(null);
  const [panel, setPanel] = createSignal<FlyoutPanel>("menu");
  const [active, setActive] = createSignal(0);
  /** "Undo last turn" was activated once; the next activation runs it. It never outlives one
      opening of the flyout (disarmed on both open and close), and one arming runs at most once. */
  const [undoArmed, setUndoArmed] = createSignal(false);
  const session = useContext(FlyoutSession);

  const host = useHostScope();
  const levels = createMemo(() => (props.thinking ? thinkingLevelsFor(props.model?.model(), host()) : []));
  /** One level is no choice, and an unknown model has no ladder to show yet. */
  const showThinking = () => levels().length > 1;

  /** The Sandbox group (§chat.composer/composer-flyout): three radios, checked on the state the
      session reports, never on the click. The "+" panel holds it, and the shield's panel alone. */
  const sandboxRows = createMemo<Row[]>(() => {
    // Only when the runtime has the sandbox extension; without it the group doesn't exist.
    const sandbox = props.sandbox;
    const sbx = sandbox?.state();
    if (!sandbox || !sbx) return [];
    const now = sandboxStateOf(sbx);
    const pending = sandbox.pending();
    return SANDBOX_ROWS.map(({ state, label, title }) => ({
      id: `sandbox-${state}`,
      role: "menuitemradio" as const,
      label,
      checked: state === now,
      busy: state === pending,
      disabled: props.disabled || pending !== null,
      describe: props.disabled,
      title: props.disabled ? undefined : title, // disabled: the composer's reason line says why
      run: () => {
        if (pending !== null || state === now) return;
        sandbox.set(state); // stays open: the check (and the shield) follow the server's answer
      },
    }));
  });

  /** The "+" panel: what you do to the session that isn't choosing a model. */
  const menuRows = createMemo<Row[]>(() => {
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
    if (props.onPlaybooks)
      out.push({
        id: "playbooks",
        role: "menuitem",
        icon: "file",
        label: "Playbooks",
        disabled: props.disabled,
        describe: props.disabled,
        run: () => {
          close(true);
          props.onPlaybooks?.();
        },
      });
    const path = session();
    // View preferences, not writes to the session: they work in read-only sessions too.
    if (path) {
      out.push({
        id: "hide-tools",
        role: "menuitemcheckbox",
        label: "Hide tool calls",
        checked: hideTools(path),
        disabled: false,
        run: () => setHideTools(path, !hideTools(path)), // stays open: the check is the feedback
      });
      out.push({
        id: "hide-thinking",
        role: "menuitemcheckbox",
        label: "Hide thinking",
        checked: hideThinking(path),
        disabled: false,
        run: () => setHideThinking(path, !hideThinking(path)),
      });
    }
    out.push(...sandboxRows());
    // Last, after its own separator: the only row here that changes the session.
    const undo = props.undo;
    if (undo) {
      const why = undo.blocked();
      out.push({
        id: "undo",
        role: "menuitem",
        icon: "refresh",
        label: undoArmed() && why === null ? "Confirm: undo last turn" : "Undo last turn",
        disabled: why !== null,
        title: why || "Rewind to before your last message; its text comes back to the composer",
        run: () => {
          // Two steps, inline (no modal): the first activation arms the row and keeps the flyout
          // open. Disarming BEFORE running means a double click (or Enter then a click) re-arms
          // instead of rewinding twice.
          const step = confirmActivate(undoArmed(), why !== null);
          setUndoArmed(step.armed);
          if (!step.run) return;
          close(true);
          undo.run();
        },
      });
    }
    return out;
  });

  /** The indicator's panel: what the composer's model indicator says, and how to change it. */
  const modelRows = createMemo<Row[]>(() => {
    const out: Row[] = [];
    const model = props.model;
    if (!model) return out;
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
      run: () => openPanel("picker"),
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
    return out;
  });

  /** The login label's panel: every login by account, the waiting pick and its Cancel. */
  const loginGroups = createMemo(() => {
    const control = props.login;
    const info = control?.info();
    return control && info ? loginMenu(info, control.login(), control.running()) : [];
  });
  const loginRows = createMemo<Row[]>(() => {
    const control = props.login;
    const out: Row[] = [];
    if (!control) return out;
    if (control.login()?.pending && control.running())
      out.push({
        id: "login-cancel",
        role: "menuitem",
        icon: "close",
        label: "Cancel switch",
        disabled: props.disabled,
        describe: props.disabled,
        run: () => {
          control.cancel(); // stays open: the pending row and the label go back as the server says
        },
      });
    for (const group of loginGroups())
      for (const r of group.rows)
        out.push({
          id: `login-${r.id}`,
          role: "menuitemradio",
          label: r.name,
          meta: r.meta ?? undefined,
          checked: r.checked,
          busy: r.pending,
          disabled: props.disabled || (r.reason !== null && !r.checked),
          describe: props.disabled,
          title: props.disabled ? undefined : (r.reason ?? (r.borrow ? "Borrows this login from the keeper, then moves the chat to it." : undefined)),
          group: group.key,
          run: () => {
            if (r.checked) {
              if (control.login()?.pending) control.cancel();
              close(true);
              props.onRefocus();
              return;
            }
            if (r.pending) return;
            control.choose(r.id);
            close(true);
            props.onRefocus();
          },
        });
    return out;
  });

  /** The panel in front, which is the only list rendered — and so the keyboard's whole order. */
  const rows = createMemo<Row[]>(() =>
    panel() === "model" ? modelRows() : panel() === "login" ? loginRows() : panel() === "sandbox" ? sandboxRows() : menuRows(),
  );

  /** Rows of one section, each with its index in `rows()` — the keyboard's order. */
  const pick = (keep: (r: Row) => boolean) => rows().map((r, index) => ({ r, index })).filter((x) => keep(x.r));

  const focusItem = (i: number) => {
    setActive(i);
    queueMicrotask(() => menu.querySelectorAll<HTMLElement>(".composer-flyout-list [role^=menuitem]")[i]?.focus());
  };

  /** Anchors the popover ABOVE its trigger: the composer sits at the bottom of the pane. */
  const place = () => {
    const from = anchor() ?? trigger;
    const r = from.getBoundingClientRect();
    if (from.offsetParent === null || (r.width === 0 && r.height === 0)) return false;
    menu.style.setProperty("--menu-bottom", `${Math.round(innerHeight - r.top + 4)}px`);
    // Kept on screen: a trigger at the right end (the sandbox shield) would push it past the edge.
    // Hidden, it has no width yet; openMenu places it again once shown.
    const w = menu.offsetWidth;
    menu.style.setProperty("--menu-left", `${Math.round(w ? Math.max(4, Math.min(r.left, innerWidth - w - 4)) : r.left)}px`);
    return true;
  };

  /** Opening focuses the first row that can act; the picker takes its own focus. */
  const focusFirst = () => focusItem(Math.max(0, rows().findIndex((r) => !r.disabled)));

  const openMenu = (to: FlyoutPanel = "menu", from?: HTMLElement) => {
    setAnchor(from ?? trigger);
    place();
    closedByChoice = false;
    tabbedAway = false;
    // Show first: a panel that mounts into a hidden popover can't take focus.
    if (!menu.matches(":popover-open")) menu.showPopover();
    setPanel(to);
    place(); // now that the panel has a width
    if (to === "login") props.login?.refresh(); // standings change: read them at each opening
    void ensureModels(host()).catch(() => {}); // the Thinking ladder needs the list; the picker reports its own failure
    if (to !== "picker") focusFirst();
  };
  const close = (byChoice = false) => {
    closedByChoice = byChoice;
    if (menu.matches(":popover-open")) menu.hidePopover();
  };
  const openPanel = (to: FlyoutPanel) => {
    place();
    setPanel(to);
    if (to !== "picker") focusFirst();
  };

  onMount(() =>
    props.onApi?.({
      show: (to = "menu", from) => openMenu(to, from),
      close: () => close(),
      open,
      anchor,
    }),
  );

  // Ctrl/⌘+P opens the flyout straight on the picker while a chat session is open, not print.
  const onKey = (e: KeyboardEvent) => {
    if (!props.model) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "p") {
      e.preventDefault();
      if (open() && panel() === "picker") close();
      else openMenu("picker");
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
      class="popover-item composer-flyout-item"
      role={p.r.role}
      id={paneId(`composer-flyout-${p.r.id}`)}
      tabindex={active() === p.index ? 0 : -1}
      aria-checked={p.r.role !== "menuitem" ? (p.r.checked ? "true" : "false") : undefined}
      aria-haspopup={p.r.chevron ? "true" : undefined}
      aria-disabled={p.r.disabled ? "true" : undefined}
      aria-busy={p.r.busy ? "true" : undefined}
      aria-describedby={p.r.describe ? paneId("composer-reason") : undefined}
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

  /** The labelled Sandbox group, in whichever panel is in front. */
  const SandboxGroup = () => (
    <div class="model-menu-group composer-flyout-sandbox" role="group" aria-labelledby={paneId("composer-flyout-sandbox")}>
      <div class="list-group-label" id={paneId("composer-flyout-sandbox")}>
        Sandbox
      </div>
      <Index each={pick((r) => r.id.startsWith("sandbox-"))}>{(x) => <Item r={x().r} index={x().index} />}</Index>
    </div>
  );

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class="button button-icon button-ghost composer-menu-trigger"
        id={paneId("composer-menu-trigger")}
        aria-label="More Actions"
        title="More Actions"
        aria-haspopup="menu"
        aria-expanded={open() && anchor() === trigger ? "true" : "false"}
        aria-controls={paneId("composer-flyout")}
        onClick={() => (open() ? close() : openMenu("menu"))}
      >
        <Icon name="plus" />
      </button>

      <div
        ref={menu}
        class="model-menu composer-flyout"
        id={paneId("composer-flyout")}
        popover="auto"
        onToggle={(e) => {
          const isOpen = (e as ToggleEvent).newState === "open";
          setOpen(isOpen);
          setUndoArmed(confirmReset().armed); // open or close: never an arming from last time
          if (isOpen) return;
          setPanel("menu"); // the panel, like the query, doesn't survive a close
          const from = anchor() ?? trigger;
          setAnchor(null);
          if (!closedByChoice && !tabbedAway) from.focus();
        }}
        onFocusOut={(e) => {
          const to = e.relatedTarget as Node | null;
          if (to && !menu.contains(to) && to !== trigger && to !== anchor()) {
            tabbedAway = true;
            close();
          }
        }}
      >
        <Switch>
          <Match when={panel() === "picker"}>
            <Show when={props.model}>
              {(control) => (
                <ModelPicker
                  control={control()}
                  autoFocus
                  onChosen={() => {
                    close(true);
                    props.onRefocus();
                  }}
                  onBack={() => openPanel("model")}
                />
              )}
            </Show>
          </Match>
          {/* The indicator's panel: this session's model, and the ladder that model allows. */}
          <Match when={panel() === "model"}>
            <div class="model-menu-list composer-flyout-list" role="menu" aria-label="Model and thinking" onKeyDown={onListKeyDown}>
              <Index each={pick((r) => r.id === "model")}>{(x) => <Item r={x().r} index={x().index} />}</Index>
              <Show when={pick((r) => r.role === "menuitemradio").length > 0}>
                <div class="popover-sep" role="separator" />
                <div class="model-menu-group" role="group" aria-labelledby={paneId("composer-flyout-thinking")}>
                  <div class="list-group-label" id={paneId("composer-flyout-thinking")}>
                    Thinking
                  </div>
                  <Index each={pick((r) => r.role === "menuitemradio")}>{(x) => <Item r={x().r} index={x().index} />}</Index>
                </div>
              </Show>
            </div>
          </Match>
          {/* The login label's panel (§app.claude-logins/switch-login): logins by account, the
              device's own last; the waiting pick first, and what a switch resends last. */}
          <Match when={panel() === "login" && props.login}>
            {(control) => (
              <div class="model-menu-list composer-flyout-list composer-flyout-logins" role="menu" aria-label="Claude login" onKeyDown={onListKeyDown}>
                <Show when={control().running() && control().login()?.pending}>
                  {(waiting) => (
                    <>
                      <p class="composer-flyout-status">
                        <span class="live-dot" />
                        Switching to {waiting().name} after this reply
                      </p>
                      <Index each={pick((r) => r.id === "login-cancel")}>{(x) => <Item r={x().r} index={x().index} />}</Index>
                      <div class="popover-sep" role="separator" />
                    </>
                  )}
                </Show>
                <Show when={control().info()} fallback={<p class="composer-flyout-note">{control().error() ?? "Loading logins…"}</p>}>
                  <Index each={loginGroups()}>
                    {(group) => (
                      <div class="model-menu-group" role="group" aria-labelledby={paneId(`composer-flyout-login-${group().key}`)}>
                        <div class="list-group-label" id={paneId(`composer-flyout-login-${group().key}`)}>
                          {group().label}
                        </div>
                        <Index each={pick((r) => r.group === group().key)}>{(x) => <Item r={x().r} index={x().index} />}</Index>
                      </div>
                    )}
                  </Index>
                </Show>
                <Show when={resendNote(control().context())}>
                  {(note) => (
                    <>
                      <div class="popover-sep" role="separator" />
                      <p class="composer-flyout-note" title={note().title}>
                        {note().text}
                      </p>
                    </>
                  )}
                </Show>
              </div>
            )}
          </Match>
          {/* The shield's panel (§chat.composer/sandbox-shield): the Sandbox group alone. */}
          <Match when={panel() === "sandbox"}>
            <div class="model-menu-list composer-flyout-list" role="menu" aria-label="Sandbox" onKeyDown={onListKeyDown}>
              <SandboxGroup />
            </div>
          </Match>
          <Match when={panel() === "menu"}>
            <div class="model-menu-list composer-flyout-list" role="menu" aria-label="More actions" onKeyDown={onListKeyDown}>
              <Index each={pick((r) => r.id === "attach" || r.id === "commands" || r.id === "playbooks")}>{(x) => <Item r={x().r} index={x().index} />}</Index>
              {/* The rows are picked by id, so a row that matches no section is built and never
                  rendered. */}
              <Show when={pick((r) => r.id.startsWith("hide-")).length > 0}>
                <div class="popover-sep" role="separator" />
                <Index each={pick((r) => r.id.startsWith("hide-"))}>{(x) => <Item r={x().r} index={x().index} />}</Index>
              </Show>
              <Show when={pick((r) => r.id.startsWith("sandbox-")).length > 0}>
                <div class="popover-sep" role="separator" />
                <SandboxGroup />
              </Show>
              <Show when={pick((r) => r.id === "undo").length > 0}>
                <div class="popover-sep" role="separator" />
                <Index each={pick((r) => r.id === "undo")}>{(x) => <Item r={x().r} index={x().index} />}</Index>
              </Show>
            </div>
          </Match>
        </Switch>
      </div>
    </>
  );
}
