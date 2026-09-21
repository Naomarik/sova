import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import type { SessionGroup, SessionSummary, WorkerInfo } from "../../shared/protocol";
import { setSessionArchived } from "../lib/api";
import { shortModel } from "../lib/format";
import { groupHref } from "../lib/group-route";
import {
  defaultPaneWidth,
  movePane,
  neighbourOf,
  orderPanes,
  readActive,
  readMode,
  readOrder,
  readWidths,
  stepWidth,
  TABS_ONLY_WIDTH,
  writeActive,
  writeMode,
  writeOrder,
  writeWidths,
  type GroupLayoutMode,
} from "../lib/group-layout";
import type { RewindControl } from "../lib/inputs";
import { quoted, setSessionGroup } from "../lib/session-groups";
import { announce, toast } from "../lib/ui-state";
import { sessionWorking, type UsageTotalView } from "../lib/workers";
import type { PaneInsight, TabId } from "./SessionPane";
import { sessionHref } from "./Sidebar";
import { SessionView } from "./SessionView";
import { Icon } from "./ui";

/**
 * A pane's id, stable for as long as the tab lives: it suffixes every DOM id inside the pane, so
 * it must not change when panes are reordered, and a session that leaves and comes back should
 * find its own ids again. Paths are filesystem paths — far too long, and full of characters an id
 * shouldn't carry — hence the counter.
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

/** The composer of a pane, for the focus moves: the one control a workspace hands the keyboard to. */
const composerOf = (path: string) => document.getElementById(`composer-input-${paneIdFor(path)}`) as HTMLTextAreaElement | null;

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
 * A group as a workspace (`#/g/<id>`): every session in it on screen at once, each pane a full
 * session view with its own transcript and composer. Two layouts, per group and remembered:
 * `split` lays the panes out in one horizontally scrolled row, `tabs` shows one at a time — but
 * mounts them all, so every stream keeps running and a tab can show its session's live dot.
 * Under 768px there is no room for a split row, so the workspace is tabs whatever is stored.
 *
 * Membership is the session list's (`SessionSummary.groupId`) and is changed only through the
 * assign endpoint. What lives here is the view: the order of the panes, their widths, the layout
 * and which pane is focused — all per group, in localStorage, none of it membership.
 */
export function GroupView(props: {
  group: SessionGroup;
  /** The group's sessions, in the list's own order (newest first). */
  members: SessionSummary[];
  /** The pane the route names, or null when it names none. */
  focused: string | null;
  wiring: PaneWiring;
}) {
  const id = () => props.group.id;

  // ---- Layout preferences (per group, stored) -------------------------------
  const [stored, setStored] = createSignal<GroupLayoutMode>(readMode(props.group.id) ?? "split");
  const [narrow, setNarrow] = createSignal(window.innerWidth < TABS_ONLY_WIDTH);
  const [order, setOrder] = createSignal<string[]>(readOrder(props.group.id));
  const [widths, setWidths] = createSignal<Record<string, number>>(readWidths(props.group.id));
  const [rowWidth, setRowWidth] = createSignal(window.innerWidth);
  // A group's stored preferences follow the group: opening another workspace reloads them.
  createEffect(
    on(id, (gid) => {
      setStored(readMode(gid) ?? "split");
      setOrder(readOrder(gid));
      setWidths(readWidths(gid));
    }, { defer: true }),
  );

  const onResize = () => {
    setNarrow(window.innerWidth < TABS_ONLY_WIDTH);
    if (row) setRowWidth(row.clientWidth);
  };
  window.addEventListener("resize", onResize);
  onCleanup(() => window.removeEventListener("resize", onResize));

  /** Stored unless the viewport is too narrow for a row of panes. */
  const mode = (): GroupLayoutMode => (narrow() ? "tabs" : stored());
  const setMode = (next: GroupLayoutMode) => {
    setStored(next);
    writeMode(id(), next);
    announce(next === "split" ? "Split view." : "Tabs.");
  };

  /** The panes, in the user's order: stored first, then members they never moved. */
  const panes = createMemo(() => orderPanes(props.members.map((m) => m.path), order()));
  const summaryOf = (path: string) => props.members.find((m) => m.path === path);
  const titleOf = (path: string) => summaryOf(path)?.title ?? "Session";
  const labelOf = (path: string) => {
    const model = shortModel(summaryOf(path)?.model);
    return model ? `${titleOf(path)} · ${model}` : titleOf(path);
  };

  /**
   * The focused pane. The route names it, but moving between panes only replaces the URL (it is
   * not history), and replaceState fires no hashchange — so the choice lives here, seeded from the
   * route, then from what this group last had open, and finally from the first pane. Without that
   * the focus would follow the session list's order, which changes whenever a session replies.
   */
  const [wanted, setWanted] = createSignal<string | null>(props.focused ?? readActive(props.group.id));
  createEffect(on(() => props.focused, (p) => p && setWanted(p), { defer: true }));
  createEffect(on(id, (gid) => setWanted(readActive(gid)), { defer: true }));
  const active = createMemo(() => {
    const list = panes();
    const at = wanted();
    return at && list.includes(at) ? at : (list[0] ?? null);
  });

  // The route always names the focused pane, so a reload (and a copied link) comes back to it.
  // replaceState, not a new hash: moving between panes is not history.
  createEffect(() => {
    const at = active();
    if (!at) return;
    if (at !== props.focused) history.replaceState(history.state, "", groupHref(id(), at));
    writeActive(id(), at);
  });

  /**
   * Focus moves that the user asked for (a tab, the pane menu, Ctrl+Alt+←/→) put the keyboard in
   * that pane's composer. Arriving at the workspace does not: the page has just loaded, and
   * stealing focus into a text field would fight a reader on its way through the head.
   */
  const focusPane = (path: string, moveFocus: boolean) => {
    if (!path) return;
    setWanted(path);
    if (!moveFocus) return;
    queueMicrotask(() => {
      // A read-only session (TUI-owned, or another writer) has a disabled composer, which takes no
      // focus at all: the pane's own region does, so the keyboard still lands in the right pane.
      const composer = composerOf(path);
      const el = composer && !composer.disabled ? composer : document.getElementById(`pane-${paneIdFor(path)}`);
      el?.focus();
      announce(`${labelOf(path)} focused.`);
    });
  };

  /** Ctrl+Alt+←/→: the pane row's roving focus. */
  const onKeyDown = (e: KeyboardEvent) => {
    if (!e.ctrlKey || !e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    const list = panes();
    const at = list.indexOf(active() ?? "");
    const next = list[at + (e.key === "ArrowRight" ? 1 : -1)];
    if (!next) return;
    e.preventDefault();
    focusPane(next, true);
  };

  let row: HTMLDivElement | undefined;
  onMount(() => {
    if (row) setRowWidth(row.clientWidth);
  });

  const widthOf = (path: string) => widths()[path] ?? defaultPaneWidth(rowWidth(), Math.max(1, panes().length));
  const resize = (path: string, direction: 1 | -1) => {
    const next = stepWidth(widthOf(path), direction);
    const map = { ...widths(), [path]: next };
    setWidths(map);
    writeWidths(id(), map);
    announce(`${labelOf(path)} ${direction === 1 ? "wider" : "narrower"}, ${next} pixels.`);
  };

  const move = (path: string, direction: 1 | -1) => {
    const next = movePane(panes(), path, direction);
    setOrder(next);
    writeOrder(id(), next);
    announce(`${labelOf(path)} moved ${direction === 1 ? "right" : "left"}, position ${next.indexOf(path) + 1} of ${next.length}.`);
  };

  /** Takes the session out of the group, and says which of the two things happened. */
  const detach = async (path: string, archive: boolean): Promise<boolean> => {
    const next = neighbourOf(panes(), path);
    if (!(await setSessionGroup(path, null))) return false;
    let archived = false;
    if (archive) {
      try {
        await setSessionArchived(path, true);
        archived = true;
      } catch (err) {
        toast(`Removed from the group, but it couldn't be archived. ${(err as Error).message}`);
      }
    }
    const done = archived ? "Removed and archived." : "Removed from group.";
    toast(done);
    announce(done);
    props.wiring.onRefresh();
    if (next) focusPane(next, true);
    return true;
  };

  const promote = async (path: string) => {
    if (!(await setSessionGroup(path, null))) return;
    props.wiring.onRefresh();
    toast(`Removed from ${quoted(props.group.name)}.`);
    location.hash = sessionHref(path);
  };

  return (
    <div class="workspace" onKeyDown={onKeyDown}>
      <header class="workspace-head">
        <a class="button button-icon button-ghost app-back" href="#/" aria-label="Back to Sessions">
          <Icon name="chevron-left" />
        </a>
        <div class="workspace-head-main">
          <h1 class="workspace-title" title={props.group.name}>
            <bdi>{props.group.name}</bdi>
          </h1>
          <p class="workspace-meta">
            <span class="text-num">{panes().length}</span> {panes().length === 1 ? "session" : "sessions"}
          </p>
        </div>
        {/* Below the split band the choice is not the user's to make: the row has no room. */}
        <Show when={!narrow()}>
          <div class="workspace-modes cluster" role="group" aria-label="Layout">
            <button
              type="button"
              class="button button-sm"
              aria-pressed={mode() === "split"}
              onClick={() => setMode("split")}
            >
              Split
            </button>
            <button type="button" class="button button-sm" aria-pressed={mode() === "tabs"} onClick={() => setMode("tabs")}>
              Tabs
            </button>
          </div>
        </Show>
      </header>

      <Show when={mode() === "tabs" && panes().length > 0}>
        <div class="workspace-tabs" role="tablist" aria-label="Sessions in this group">
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
                title={labelOf(path)}
                onClick={() => focusPane(path, true)}
              >
                {/* The tab is the only sign of a pane that is mounted but not shown: a running
                    session says so here. */}
                <Show when={summaryOf(path)?.busy || sessionWorking(summaryOf(path) ?? ({} as SessionSummary)) > 0}>
                  <span class="live-dot" />
                </Show>
                <span class="workspace-tab-title">{titleOf(path)}</span>
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
              <p class="empty-title">Nothing in {quoted(props.group.name)} yet.</p>
              <p class="empty-body">Drag a session onto the group in the sidebar, or use “Open beside” from a session.</p>
              <a class="button empty-action" href="#/">
                Back to Sessions
              </a>
            </div>
          </div>
        }
      >
        <div class="workspace-row" data-mode={mode()} ref={row}>
          <For each={panes()}>
            {(path) => {
              const paneId = paneIdFor(path);
              // The row can lose this path for an instant while a list reload lands; the pane
              // keeps the last summary it had rather than unmounting under the user.
              let last = summaryOf(path)!;
              const summary = () => (last = summaryOf(path) ?? last);
              const hidden = () => mode() === "tabs" && active() !== path;
              return (
                <section
                  class="workspace-pane"
                  id={`pane-${paneId}`}
                  classList={{ "workspace-pane-focused": active() === path }}
                  role={mode() === "tabs" ? "tabpanel" : "region"}
                  aria-label={mode() === "tabs" ? undefined : labelOf(path)}
                  aria-labelledby={mode() === "tabs" ? `ws-tab-${paneId}` : undefined}
                  tabindex="-1"
                  hidden={hidden()}
                  style={mode() === "split" ? { flex: `0 0 ${widthOf(path)}px` } : undefined}
                  onFocusIn={() => active() !== path && focusPane(path, false)}
                >
                  <SessionView
                    path={path}
                    summary={summary}
                    paneId={paneId}
                    listVersion={props.wiring.listVersion}
                    now={props.wiring.now}
                    actions={
                      <PaneMenu
                        label={labelOf(path)}
                        title={titleOf(path)}
                        split={mode() === "split"}
                        canArchive={summary().origin === "web"}
                        first={panes()[0] === path}
                        last={panes()[panes().length - 1] === path}
                        onWider={() => resize(path, 1)}
                        onNarrower={() => resize(path, -1)}
                        onLeft={() => move(path, -1)}
                        onRight={() => move(path, 1)}
                        onFocus={() => focusPane(path, true)}
                        onRemove={() => void detach(path, false)}
                        onEliminate={() => void detach(path, true)}
                        onPromote={() => void promote(path)}
                        standaloneHref={sessionHref(path)}
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
    </div>
  );
}

/**
 * One pane's own menu, in its head: what can be done to this pane (width, place, focus) and to
 * its session's membership of the group. The three that change membership are deliberately three
 * separate words — Remove takes it out, Promote takes it out and opens it on its own, Eliminate
 * takes it out and archives it, which only pi-web's own sessions can be.
 */
function PaneMenu(props: {
  label: string;
  title: string;
  /** Width and order only mean something in the split row. */
  split: boolean;
  /** Archiving closes a runtime, so it is ours to offer only for sessions pi-web started. */
  canArchive: boolean;
  first: boolean;
  last: boolean;
  onWider(): void;
  onNarrower(): void;
  onLeft(): void;
  onRight(): void;
  onFocus(): void;
  onRemove(): void;
  onEliminate(): void;
  onPromote(): void;
  standaloneHref: string;
}) {
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;
  const [open, setOpen] = createSignal(false);

  const close = () => {
    if (menu.matches(":popover-open")) menu.hidePopover();
  };
  const openMenu = () => {
    const r = trigger.getBoundingClientRect();
    menu.style.setProperty("--menu-top", `${Math.round(r.bottom + 4)}px`);
    menu.style.setProperty("--menu-right", `${Math.max(0, Math.round(innerWidth - r.right))}px`);
    menu.showPopover();
    queueMicrotask(() => menu.querySelector<HTMLElement>("[role^=menuitem]")?.focus());
  };
  /** Every row closes the menu and hands focus back, except the ones that move focus themselves. */
  const run = (act: () => void, keepFocus = false) => {
    close();
    if (!keepFocus) trigger.focus();
    act();
  };

  const Item = (p: { label: string; icon: JSX.Element; disabled?: boolean; onRun(): void; keepFocus?: boolean }) => (
    <div
      class="mode-option group-option"
      role="menuitem"
      tabindex={0}
      aria-disabled={p.disabled ? "true" : undefined}
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
        aria-label={`Pane actions · ${props.label}`}
        title="Pane actions"
        onClick={() => (open() ? close() : openMenu())}
      >
        <Icon name="more" />
      </button>
      <div
        ref={menu}
        class="model-menu group-menu"
        popover="auto"
        onToggle={(e) => setOpen((e as ToggleEvent).newState === "open")}
      >
        <div class="model-menu-list" role="menu" aria-label={`Pane actions · ${props.label}`}>
          <Show when={props.split}>
            <div class="model-menu-group" role="group" aria-label="Size and place">
              <Item label="Wider" icon={<Icon name="chevron-right" small />} onRun={props.onWider} />
              <Item label="Narrower" icon={<Icon name="chevron-left" small />} onRun={props.onNarrower} />
              <Item label="Move left" icon={<Icon name="chevron-left" small />} disabled={props.first} onRun={props.onLeft} />
              <Item label="Move right" icon={<Icon name="chevron-right" small />} disabled={props.last} onRun={props.onRight} />
            </div>
          </Show>
          <div class="model-menu-group" role="group" aria-label="This session">
            <Item label="Focus" icon={<Icon name="chat" small />} keepFocus onRun={props.onFocus} />
            <Item label="Open standalone" icon={<Icon name="external" small />} keepFocus onRun={() => (location.hash = props.standaloneHref)} />
            <Item label="Promote out of group" icon={<Icon name="arrow-right" small />} keepFocus onRun={props.onPromote} />
            <Item label="Remove from group" icon={<Icon name="close" small />} keepFocus onRun={props.onRemove} />
            <Show when={props.canArchive}>
              <Item label="Remove and archive" icon={<Icon name="archive" small />} keepFocus onRun={props.onEliminate} />
            </Show>
          </div>
        </div>
      </div>
    </>
  );
}
