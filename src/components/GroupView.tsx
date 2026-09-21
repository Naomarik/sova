import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js";
import type { SessionGroup, SessionSummary, WorkerInfo } from "../../shared/protocol";
import { setSessionArchived } from "../lib/api";
import { shortModel } from "../lib/format";
import { groupHref } from "../lib/group-route";
import {
  defaultPaneWidth,
  movePane,
  neighbourOf,
  readMode,
  stepWidth,
  TABS_ONLY_WIDTH,
  writeMode,
  type GroupLayoutMode,
} from "../lib/group-layout";
import type { RewindControl } from "../lib/inputs";
import { memberLabel, orderedMembers, quoted, setGroupOrder, setSessionGroup } from "../lib/session-groups";
import { announce, toast } from "../lib/ui-state";
import { sessionWorking, type UsageTotalView } from "../lib/workers";
import type { PaneInsight, TabId } from "./SessionPane";
import { sessionHref } from "./Sidebar";
import { SessionView } from "./SessionView";
import { Icon } from "./ui";

/**
 * A pane's id, issued once per session path and kept for as long as the tab lives: it suffixes
 * every DOM id inside the pane, so Move Left must not renumber the view, and a member that leaves
 * and comes back finds its own ids again (spec/14-workspaces.md "A pane"). The path itself can't
 * be the id — it is long and full of characters an id shouldn't carry.
 */
const paneIds = new Map<string, string>();
let paneSeq = 0;
export function paneIdFor(path: string): string {
  let id = paneIds.get(path);
  if (!id) {
    id = `p${++paneSeq}`;
    paneIds.set(path, id);
  }
  return id;
}

/** The composer of a pane, for the focus moves. A disabled (read-only) one takes no focus. */
const composerOf = (path: string) => document.getElementById(`composer-input-${paneIdFor(path)}`) as HTMLTextAreaElement | null;

/** Whether a member is mid-turn: what the tab's live dot and Eliminate's refusal both read. */
const running = (s: SessionSummary | undefined) => !!s && (s.busy || sessionWorking(s) > 0);

/** What SessionView needs from App, forwarded through the workspace unchanged. */
export interface PaneWiring {
  listVersion: number;
  now: number;
  onRefresh(): void;
  onInsight(path: string, insight: PaneInsight | null): void;
  onWorkers(path: string, workers: WorkerInfo[] | null, usage: UsageTotalView | null): void;
  onRewindControl(path: string, control: RewindControl | null): void;
  onRewound(info: { path: string; entryId: string }): void;
  paneOn(path: string, tab: TabId): boolean;
  openPane(path: string, tab: TabId): void;
  toggleSubagents(path: string): void;
  showTimeline(path: string, inputsOnly?: boolean): void;
  inputsOnly(): string | null;
  subagentsPath(): string | null;
  onNewSession(path: string): Promise<string | null>;
}

/**
 * A group as a workspace (spec/14-workspaces.md): every member side by side, each pane a whole
 * session view with its own transcript, composer and socket. `split` is one horizontally scrolled
 * row; `tabs` shows one member at a time and keeps the rest mounted, so a turn that lands while
 * you read another member is not lost. Under 768px there is no room for a split row, so the
 * workspace is tabs whatever is remembered.
 *
 * Membership and member ORDER are the server's (`SessionGroup.members`, the assignments map) and
 * change only through the group routes. What lives in this component is posture: which layout,
 * how wide a pane is, and which pane has the keyboard.
 */
export function GroupView(props: {
  group: SessionGroup;
  /** The group's sessions, from the session list; this puts them in the group's own order. */
  members: SessionSummary[];
  /** The pane the route names, or null when it names none. */
  focused: string | null;
  wiring: PaneWiring;
}) {
  const id = () => props.group.id;

  // ---- Layout --------------------------------------------------------------
  const [stored, setStored] = createSignal<GroupLayoutMode>(readMode(props.group.id) ?? "split");
  const [narrow, setNarrow] = createSignal(window.innerWidth < TABS_ONLY_WIDTH);
  const [viewport, setViewport] = createSignal(window.innerWidth);
  /** Pane widths the user stepped, in memory only: a width is a posture for the task at hand. */
  const [widths, setWidths] = createSignal<Record<string, number>>({});
  // Another group, another posture: its own remembered layout, and nobody's widths.
  createEffect(
    on(id, (gid) => {
      setStored(readMode(gid) ?? "split");
      setWidths({});
    }, { defer: true }),
  );

  const onResize = () => {
    setNarrow(window.innerWidth < TABS_ONLY_WIDTH);
    setViewport(window.innerWidth);
  };
  window.addEventListener("resize", onResize);
  onCleanup(() => window.removeEventListener("resize", onResize));

  /** What is remembered, unless the viewport is too narrow for a row of panes. */
  const mode = (): GroupLayoutMode => (narrow() ? "tabs" : stored());
  const setMode = (next: GroupLayoutMode) => {
    setStored(next);
    writeMode(id(), next);
    announce(next === "split" ? "Split view." : "Tabs.");
  };

  // ---- Members -------------------------------------------------------------
  /** The group's sessions in the group's own display order. */
  const rows = createMemo(() => orderedMembers(props.members, props.group));
  const panes = createMemo(() => rows().map((s) => s.path));
  const summaryOf = (path: string) => rows().find((m) => m.path === path);
  const labelOf = (path: string) => {
    const s = summaryOf(path);
    return s ? memberLabel(props.group, s.id) : null;
  };
  /** The pane's name, the same string the pane head shows and AT reads: "{label|title} · {model}". */
  const nameOf = (path: string) => {
    const s = summaryOf(path);
    const name = labelOf(path) || s?.title || "Session";
    const model = shortModel(s?.model);
    return model ? `${name} · ${model}` : name;
  };

  /**
   * The focused pane. The route names it, but moving between panes only replaces the URL (it is
   * not history) and replaceState fires no hashchange — so the choice lives here, seeded from the
   * route and falling back to the first pane. Without that the focus would follow the session
   * list's order, which changes whenever a member replies.
   */
  const [wanted, setWanted] = createSignal<string | null>(props.focused);
  createEffect(on(() => props.focused, (p) => p && setWanted(p), { defer: true }));
  createEffect(on(id, () => setWanted(null), { defer: true }));
  const active = createMemo(() => {
    const list = panes();
    const at = wanted();
    return at && list.includes(at) ? at : (list[0] ?? null);
  });

  // The route always names the focused pane, so a reload (and a copied link) comes back to it.
  createEffect(() => {
    const at = active();
    if (at && at !== props.focused) history.replaceState(history.state, "", groupHref(id(), at));
  });

  /**
   * Focus moves the user asked for (a tab, the pane menu, Ctrl+Alt+←/→) put the keyboard in that
   * pane and scroll it into view. Arriving at the workspace does not: the page has just loaded,
   * and stealing focus would fight a reader on its way through the head.
   */
  const focusPane = (path: string, moveFocus: boolean) => {
    if (!path) return;
    setWanted(path);
    if (!moveFocus) return;
    queueMicrotask(() => {
      const section = document.getElementById(`pane-${paneIdFor(path)}`);
      // A read-only member (TUI-owned, archived) has a disabled composer, which takes no focus at
      // all: the pane's own region does, so the keyboard still lands in the right pane.
      const composer = composerOf(path);
      (composer && !composer.disabled ? composer : section)?.focus();
      section?.scrollIntoView({ inline: "nearest", block: "nearest" });
      announce(`${nameOf(path)} — focused.`);
    });
  };

  /**
   * Ctrl+Alt+←/→ walks the row. Alt+Arrow is browser history and Ctrl+Arrow is word navigation in
   * every one of the N textareas on screen, so this is the binding left. It is registered while a
   * workspace is mounted and torn down with it, so it exists nowhere else in the product — on the
   * window rather than the row, because the press is just as meaningful with the focus still in
   * the workspace head or on a tab.
   */
  const onKeyDown = (e: KeyboardEvent) => {
    if (!e.ctrlKey || !e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    const list = panes();
    const next = list[list.indexOf(active() ?? "") + (e.key === "ArrowRight" ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    focusPane(next, true);
  };
  window.addEventListener("keydown", onKeyDown);
  onCleanup(() => window.removeEventListener("keydown", onKeyDown));

  // ---- Pane actions --------------------------------------------------------
  const widthOf = (path: string) => widths()[path] ?? defaultPaneWidth(viewport());
  const resize = (path: string, direction: 1 | -1) => {
    const next = stepWidth(widthOf(path), direction);
    setWidths((m) => ({ ...m, [path]: next }));
    announce(`${nameOf(path)} — ${direction === 1 ? "wider" : "narrower"}, ${next} pixels.`);
  };

  /** Move Left / Move Right send the WHOLE order — that is what `PATCH {order}` means. */
  const move = async (path: string, direction: 1 | -1) => {
    const s = summaryOf(path);
    if (!s) return;
    const order = movePane(rows().map((m) => m.id), s.id, direction);
    const at = order.indexOf(s.id);
    if (!(await setGroupOrder(id(), order))) return;
    announce(`${nameOf(path)} — moved ${direction === 1 ? "right" : "left"}, position ${at + 1} of ${order.length}.`);
    // The thing you moved is the thing you are still looking at.
    queueMicrotask(() => document.getElementById(`pane-${paneIdFor(path)}`)?.scrollIntoView({ inline: "nearest", block: "nearest" }));
  };

  /** Takes the session out of the group — and, for Eliminate, archives it in the same gesture. */
  const detach = async (path: string, archive: boolean) => {
    const title = summaryOf(path)?.title ?? "this session";
    const next = neighbourOf(panes(), path);
    if (!(await setSessionGroup(path, null))) return;
    let archived = false;
    if (archive) {
      try {
        await setSessionArchived(path, true);
        archived = true;
      } catch {
        // The genuine race: a turn started between the check and the write. Say both halves.
        const partial = `Removed ${title} from ${quoted(props.group.name)}, but couldn't archive it.`;
        toast(partial);
        announce(partial);
        props.wiring.onRefresh();
        if (next) focusPane(next, true);
        return;
      }
    }
    const done = archived ? `Removed ${title} and archived it.` : `Removed ${title} from ${quoted(props.group.name)}.`;
    toast(done);
    announce(done);
    props.wiring.onRefresh();
    if (next) focusPane(next, true);
  };

  /** Promote: the member you picked is the answer, so it leaves the group and opens on its own. */
  const promote = async (path: string) => {
    const title = summaryOf(path)?.title ?? "this session";
    if (!(await setSessionGroup(path, null))) return;
    props.wiring.onRefresh();
    toast(`Removed ${title} from ${quoted(props.group.name)}.`);
    location.hash = sessionHref(path);
  };

  return (
    <>
      <header class="workspace-head">
        <a class="button button-icon button-ghost app-back" href="#/" aria-label="Back to Sessions">
          <Icon name="chevron-left" />
        </a>
        <div class="workspace-head-main">
          <h1 class="workspace-title" tabindex="-1" title={props.group.name}>
            <bdi>{props.group.name}</bdi>
          </h1>
          <p class="workspace-meta">
            <span class="workspace-count">
              {panes().length} {panes().length === 1 ? "member" : "members"}
            </span>
          </p>
        </div>
        {/* Below the split band there is nothing to toggle: 440px of pane doesn't fit beside
            anything, and a stored split preference is ignored rather than cleared. */}
        <Show when={!narrow()}>
          <div class="workspace-modes">
            <button
              type="button"
              class="button button-sm button-ghost"
              aria-pressed={mode() === "tabs"}
              title="Show one member at a time. The others keep running."
              onClick={() => setMode(mode() === "tabs" ? "split" : "tabs")}
            >
              Tabs
            </button>
          </div>
        </Show>
      </header>

      <Show when={mode() === "tabs" && panes().length > 0}>
        <div class="workspace-tabs" role="tablist" aria-label="Members">
          <For each={panes()}>
            {(path) => (
              <button
                type="button"
                class="workspace-tab"
                role="tab"
                id={`ws-tab-${paneIdFor(path)}`}
                aria-selected={active() === path}
                aria-controls={`pane-${paneIdFor(path)}`}
                tabindex={active() === path ? 0 : -1}
                title={nameOf(path)}
                onClick={() => focusPane(path, true)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                  const list = panes();
                  const next = list[list.indexOf(path) + (e.key === "ArrowRight" ? 1 : -1)];
                  if (!next) return;
                  e.preventDefault();
                  focusPane(next, false);
                  document.getElementById(`ws-tab-${paneIdFor(next)}`)?.focus();
                }}
              >
                <span class="workspace-tab-title">{labelOf(path) || summaryOf(path)?.title}</span>
                {/* The one sign of a pane that is mounted but not shown: a member mid-turn. */}
                <Show when={running(summaryOf(path))}>
                  <span class="live-dot" />
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show
        when={panes().length > 0}
        fallback={
          <div class="center-fill">
            <div class="empty">
              <Icon name="folder" class="empty-mark" />
              <p class="empty-title">{quoted(props.group.name)} has no sessions yet.</p>
              <p class="empty-body">Drag a row onto the group in the sidebar, or use “Open beside” from a session's details.</p>
              <a class="button empty-action" href="#/">
                Back to Sessions
              </a>
            </div>
          </div>
        }
      >
        <div class="workspace-row" data-mode={mode()} aria-label="Members">
          <For each={panes()}>
            {(path) => {
              const paneId = paneIdFor(path);
              // The list can stop carrying a row for an instant; the pane keeps the last summary
              // it had rather than tearing itself down under the user.
              let last = summaryOf(path)!;
              const summary = () => (last = summaryOf(path) ?? last);
              return (
                <section
                  class="workspace-pane"
                  id={`pane-${paneId}`}
                  classList={{ "workspace-pane-focused": active() === path }}
                  role={mode() === "tabs" ? "tabpanel" : "region"}
                  aria-labelledby={mode() === "tabs" ? `ws-tab-${paneId}` : `pane-${paneId}-name`}
                  tabindex="-1"
                  hidden={mode() === "tabs" && active() !== path}
                  style={mode() === "split" ? { "--workspace-pane-w": `${widthOf(path)}px` } : undefined}
                  onFocusIn={() => active() !== path && focusPane(path, false)}
                >
                  <SessionView
                    path={path}
                    summary={summary}
                    paneId={paneId}
                    label={() => labelOf(path)}
                    listVersion={props.wiring.listVersion}
                    now={props.wiring.now}
                    actions={
                      <PaneMenu
                        name={nameOf(path)}
                        split={mode() === "split"}
                        first={panes()[0] === path}
                        last={panes()[panes().length - 1] === path}
                        eliminate={
                          summary().origin !== "web"
                            ? null
                            : summary().live
                              ? "This session is open in a terminal."
                              : running(summary())
                                ? "It's mid-turn. Stop it or wait, then eliminate it."
                                : ""
                        }
                        standaloneHref={sessionHref(path)}
                        onWider={() => resize(path, 1)}
                        onNarrower={() => resize(path, -1)}
                        onLeft={() => void move(path, -1)}
                        onRight={() => void move(path, 1)}
                        onFocus={() => focusPane(path, true)}
                        onRemove={() => void detach(path, false)}
                        onEliminate={() => void detach(path, true)}
                        onPromote={() => void promote(path)}
                      />
                    }
                    onRefresh={props.wiring.onRefresh}
                    onInsight={props.wiring.onInsight}
                    onWorkers={props.wiring.onWorkers}
                    onRewindControl={props.wiring.onRewindControl}
                    onRewound={props.wiring.onRewound}
                    paneOn={props.wiring.paneOn}
                    openPane={props.wiring.openPane}
                    toggleSubagents={props.wiring.toggleSubagents}
                    showTimeline={props.wiring.showTimeline}
                    inputsOnly={props.wiring.inputsOnly}
                    subagentsPath={props.wiring.subagentsPath}
                    onNewSession={props.wiring.onNewSession}
                  />
                </section>
              );
            }}
          </For>
        </div>
      </Show>
    </>
  );
}

/**
 * One pane's tools (spec/14-workspaces.md "A pane"), as a menu: at 440px a row of seven buttons
 * is not a thing a pane head can hold. What can be done to the pane (width, place, focus, open on
 * its own) and to its membership — three separate words on purpose: Promote takes it out and
 * opens it, Eliminate takes it out and archives it, Remove From Group only takes it out.
 */
function PaneMenu(props: {
  /** The pane's name, so every label here says which member it acts on. */
  name: string;
  /** Width and order only mean something in the split row. */
  split: boolean;
  first: boolean;
  last: boolean;
  /**
   * Eliminate's state: `null` when this session was not started in pi-web (there is nothing to
   * archive, so the row is absent), `""` when it can be eliminated, and otherwise the reason it
   * can't — said before the press rather than discovered as a half-finished gesture.
   */
  eliminate: string | null;
  standaloneHref: string;
  onWider(): void;
  onNarrower(): void;
  onLeft(): void;
  onRight(): void;
  onFocus(): void;
  onRemove(): void;
  onEliminate(): void;
  onPromote(): void;
}) {
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;
  const [open, setOpen] = createSignal(false);

  const close = () => {
    if (menu.matches(":popover-open")) menu.hidePopover();
  };
  const openMenu = () => {
    const r = trigger.getBoundingClientRect();
    // Same anchoring as the group menu, and inline for the same reason: `.model-menu`'s
    // `inset: auto; top: var(--menu-top)` is declared after any class that would move it.
    const up = innerHeight - r.bottom < 320;
    menu.style.setProperty("--menu-top", `${Math.round(r.bottom + 4)}px`);
    menu.style.setProperty("--menu-right", `${Math.max(0, Math.round(innerWidth - r.right))}px`);
    menu.style.top = up ? "auto" : "";
    menu.style.bottom = up ? `${Math.round(innerHeight - r.top + 4)}px` : "";
    menu.showPopover();
    queueMicrotask(() => menu.querySelector<HTMLElement>("[role=menuitem]")?.focus());
  };
  /** Every row closes the menu; the ones that move focus themselves don't take it back. */
  const run = (act: () => void, keepFocus = false) => {
    close();
    if (!keepFocus) trigger.focus();
    act();
  };

  const Item = (p: { label: string; icon: JSX.Element; disabled?: string; onRun(): void; keepFocus?: boolean }) => (
    <div
      class="mode-option group-option"
      role="menuitem"
      tabindex={0}
      aria-disabled={p.disabled ? "true" : undefined}
      title={p.disabled || undefined}
      onClick={() => !p.disabled && run(p.onRun, p.keepFocus)}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        if (!p.disabled) run(p.onRun, p.keepFocus);
      }}
    >
      {p.icon}
      <span class="mode-option-text">
        <span class="mode-option-id">{p.label}</span>
        <Show when={p.disabled}>
          <span class="mode-option-note">{p.disabled}</span>
        </Show>
      </span>
    </div>
  );

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class="button button-icon button-ghost"
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        aria-label={`Pane actions · ${props.name}`}
        title="Pane actions"
        onClick={() => (open() ? close() : openMenu())}
      >
        <Icon name="more" />
      </button>
      <div ref={menu} class="model-menu group-menu" popover="auto" onToggle={(e) => setOpen((e as ToggleEvent).newState === "open")}>
        <div class="model-menu-list" role="menu" aria-label={`Pane actions · ${props.name}`}>
          <div class="model-menu-group" role="group" aria-label="This pane">
            <Item label="Open" icon={<Icon name="external" small />} keepFocus onRun={() => (location.hash = props.standaloneHref)} />
            <Item label="Focus" icon={<Icon name="chat" small />} keepFocus onRun={props.onFocus} />
            <Show when={props.split}>
              <Item label="Wider" icon={<Icon name="chevron-right" small />} onRun={props.onWider} />
              <Item label="Narrower" icon={<Icon name="chevron-left" small />} onRun={props.onNarrower} />
              <Item label="Move Left" icon={<Icon name="chevron-left" small />} disabled={props.first ? "It's already first." : ""} onRun={props.onLeft} />
              <Item label="Move Right" icon={<Icon name="chevron-right" small />} disabled={props.last ? "It's already last." : ""} onRun={props.onRight} />
            </Show>
          </div>
          <div class="model-menu-group" role="group" aria-label="This session's membership">
            <Item label="Promote" icon={<Icon name="arrow-right" small />} keepFocus onRun={props.onPromote} />
            <Item label="Remove From Group" icon={<Icon name="close" small />} keepFocus onRun={props.onRemove} />
            <Show when={props.eliminate !== null}>
              <Item label="Eliminate" icon={<Icon name="archive" small />} disabled={props.eliminate!} keepFocus onRun={props.onEliminate} />
            </Show>
          </div>
        </div>
      </div>
    </>
  );
}
