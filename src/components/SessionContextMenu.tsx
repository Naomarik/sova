/**
 * A sidebar session row's own menu: a right-click on the row (a mouse's, once its button is up), or
 * a finger's or pen's hold let go without moving. One panel for the whole list, beside the drop
 * overlay: a row asks for it with `openSessionMenu` (the shape of DropOverlay's `startRowDrag`), and
 * the panel keeps only the row's path, reading the live row from the list on every change, so a
 * refresh under it shows the new title and a row that goes away closes it. Every row does what its
 * existing door does: the drop panel's archive, Undo and groups (lib/drag-overlay), the Agents
 * board menu's titles (lib/agents-board), the board's Copy Path. The rules are lib/session-context-menu.
 *
 * The panel is ActionMenu's shell (`popover="auto"`, `.model-menu.action-menu`, so a bottom sheet
 * below 768px), placed at a point instead of under a trigger: ActionMenu reads its trigger's box.
 */
import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { SessionSummary } from "../../shared/protocol";
import { gistTitle } from "../lib/agents-board";
import { archiveDragOf, archivedProjectOf, unarchivedProjectOf } from "../lib/drag-archive";
import { type DragInfo, dropTiles } from "../lib/drag-overlay";
import { hostLabel, hostOf } from "../lib/mesh";
import { groupRefusal } from "../lib/regions";
import { renameSession } from "../lib/session-actions";
import { createOpenOnRelease, groupChoices, type PointerKind, pointMenuRoom, pointMenuSpot, rowMenuOf } from "../lib/session-context-menu";
import { groupNameOf, loadSessionGroups, quoted, sessionGroups } from "../lib/session-groups";
import { copyText, localRunning } from "../lib/ui-state";
import { TitleField } from "./TitleField";
import { Icon, type IconName } from "./ui";

/** A row's ask: its path, the pointer it came at, what made it, and where focus goes back on close. */
export interface SessionMenuAsk {
  path: string;
  at: { x: number; y: number };
  kind: PointerKind;
  returnTo: HTMLElement | null;
}

let showHandler: ((ask: SessionMenuAsk) => void) | null = null;
let opener: ReturnType<typeof createOpenOnRelease> | null = null;

/** A row asks for its menu: now, or once the mouse button that made the ask is back up (`held`). */
export function openSessionMenu(ask: SessionMenuAsk, held: boolean): void {
  opener ??= createOpenOnRelease({
    win: window,
    doc: document,
    later: (fn) => {
      const t = setTimeout(fn, 0);
      return () => clearTimeout(t);
    },
  });
  opener.request(held, () => showHandler?.(ask));
}

/** The row as the drop panel sees it: the same refusals and the same toasts. */
function dragOf(row: SessionSummary): DragInfo {
  const host = hostOf(row.path);
  return {
    path: row.path,
    title: row.title,
    groupId: row.groupId ?? null,
    groupRefusal: groupRefusal(row),
    orgProject: unarchivedProjectOf(row, host === null),
    archivedProject: archivedProjectOf(row),
    peer: host ? hostLabel(host) : null,
    // Busy as the row shows it: this tab's own run is newer than the last fetched list.
    archive: archiveDragOf({ ...row, busy: localRunning()[row.path] ?? row.busy }),
    archived: !!row.archived,
  };
}

export function SessionContextMenu(props: {
  /** Every row the list draws (Sidebar's `all()`), by which the panel reads its live row. */
  rows: readonly SessionSummary[];
  /** Each group's session count, as the drop panel has it. */
  counts: ReadonlyMap<string, number>;
  onRefresh(): void;
  /** The drop panel's Archive, with its keyed Undo toast. */
  onArchive(d: DragInfo): void;
  /** The Undo toast's unarchive. */
  onUnarchive(path: string, project: string | null): void;
  /** A drop on a group tile (`null`: Remove from its group). */
  onMove(d: DragInfo, groupId: string | null): void;
  /** The drop panel's New group dialog, for this row. */
  onNewGroup(d: DragInfo): void;
}) {
  let menu!: HTMLDivElement;
  const [ask, setAsk] = createSignal<SessionMenuAsk | null>(null);
  const [screen, setScreen] = createSignal<"rows" | "rename" | "groups">("rows");
  const row = createMemo(() => {
    const a = ask();
    return a ? (props.rows.find((r) => r.path === a.path) ?? null) : null;
  });
  const drag = createMemo(() => (row() ? dragOf(row()!) : null));
  const tiles = createMemo(() => (drag() ? dropTiles(drag()!, sessionGroups(), props.counts) : null));
  const model = createMemo(() => (row() && drag() ? rowMenuOf(row()!, drag()!.archive, tiles()!) : null));
  const isOpen = () => menu?.matches(":popover-open") ?? false;

  const close = () => isOpen() && menu.hidePopover();
  /** The corner at the pointer, measured and kept inside the window (lib/session-context-menu). Below
      768px the sheet rules own the position and these properties are not read. */
  const place = () => {
    const a = ask();
    if (!a || !isOpen()) return;
    const view = { width: innerWidth, height: innerHeight };
    menu.style.setProperty("--menu-max", `${pointMenuRoom(a.at, view)}px`);
    const spot = pointMenuSpot(a.at, menu.getBoundingClientRect(), view);
    menu.style.setProperty("--menu-top", `${spot.top}px`);
    menu.style.setProperty("--menu-left", `${spot.left}px`);
  };
  const focusFirst = () => menu.querySelector<HTMLElement>("[role^=menuitem], input")?.focus();
  const show = (a: SessionMenuAsk) => {
    if (!props.rows.some((r) => r.path === a.path)) return;
    setScreen("rows");
    setAsk(a);
    if (!isOpen()) menu.showPopover();
    place();
    queueMicrotask(focusFirst);
  };
  onMount(() => (showHandler = show));
  onCleanup(() => {
    if (showHandler === show) showHandler = null;
  });
  // A row that leaves the list takes its menu with it.
  createEffect(() => ask() && !row() && close());
  // A screen is a different height from the rows: placed again once it has rendered, focus on its first control.
  createEffect(
    on(screen, () => {
      if (!isOpen()) return;
      queueMicrotask(() => {
        place();
        focusFirst();
      });
    }),
  );
  addEventListener("resize", place);
  onCleanup(() => removeEventListener("resize", place));

  /** Close, then act: focus goes back to the row unless the act moves it itself. */
  const run = (act: () => void) => {
    close();
    act();
  };
  const setTitle = (title: string | null) => {
    const r = row();
    if (!r) return;
    void renameSession(r, title).then((ok) => ok && props.onRefresh());
  };

  return (
    <Portal>
      <div
        ref={menu}
        class="model-menu action-menu"
        popover="auto"
        onToggle={() => {
          // Coalesced: a close followed at once by a reopen (another row's right-click) arrives as one open.
          if (isOpen()) return;
          const back = ask()?.returnTo;
          setAsk(null);
          setScreen("rows");
          // Escape, or a click on nothing focusable: focus would be lost with the panel, so it goes back to the row.
          const at = document.activeElement;
          if (back?.isConnected && (!at || at === document.body || menu.contains(at))) back.focus({ preventScroll: true });
        }}
      >
        <Show when={row() && model() ? { r: row()!, m: model()!, d: drag()! } : null} keyed={false}>
          {(v) => {
            const r = () => v().r;
            const name = () => quoted(r().title);
            return (
              <Show
                when={screen() === "rows"}
                fallback={
                  <Show
                    when={screen() === "groups"}
                    fallback={
                      <div class="group-menu-screen">
                        <TitleField
                          initial={r().title}
                          label={`Rename ${name()}`}
                          describedBy="session-menu-rename-hint"
                          onDone={(t) => run(() => setTitle(t))}
                          onCancel={() => setScreen("rows")}
                        />
                        <p class="text-caption text-muted" id="session-menu-rename-hint">
                          Kept in Sova only. Empty restores {quoted(r().originalTitle ?? r().title)}.
                        </p>
                      </div>
                    }
                  >
                    <div class="model-menu-list" role="menu" aria-label={`Move ${name()} to a group`}>
                      <div class="popover-label" aria-hidden="true">
                        Move to Group
                      </div>
                      <div class="model-menu-group" role="group" aria-label="Groups">
                        <For each={groupChoices(tiles()!)}>
                          {(g) => (
                            <Item
                              label={g.name}
                              aria={g.id ? `Move ${name()} to ${quoted(g.name)}` : `Take ${name()} out of its group`}
                              checked={g.current}
                              disabled={g.disabled}
                              onRun={() => !g.current && run(() => props.onMove(v().d, g.id))}
                            />
                          )}
                        </For>
                      </div>
                      <div class="model-menu-group" role="group" aria-label="New group">
                        <Item
                          label="New Group…"
                          aria={`Move ${name()} into a new group`}
                          icon="plus"
                          disabled={tiles()!.newDisabled ?? ""}
                          onRun={() => run(() => props.onNewGroup(v().d))}
                        />
                      </div>
                    </div>
                  </Show>
                }
              >
                <div class="model-menu-list" role="menu" aria-label={`Actions for ${name()}`}>
                  <div class="popover-label" aria-hidden="true" title={r().title}>
                    {r().title}
                  </div>
                  {/* A chat Sova names itself keeps that name: no title rows at all. */}
                  <Show when={v().m.title}>
                    {(t) => (
                      <div class="model-menu-group" role="group" aria-label="Title">
                        <Item label="Rename…" aria={`Rename ${name()}`} icon="pencil" onRun={() => setScreen("rename")} />
                        <Item
                          label="Use Gist as Title"
                          aria={`Use the gist as the title of ${name()}`}
                          icon="pencil"
                          description={t().gist ?? undefined}
                          disabled={t().gistDisabled}
                          onRun={() => run(() => setTitle(gistTitle(r())))}
                        />
                        <Item
                          label="Reset to Original Title"
                          aria={`Reset ${name()} to its original title`}
                          icon="undo"
                          description={t().original}
                          disabled={t().resetDisabled}
                          onRun={() => run(() => setTitle(null))}
                        />
                      </div>
                    )}
                  </Show>
                  <div class="model-menu-group" role="group" aria-label="Organize">
                    <Item
                      label="Move to Group…"
                      aria={`Move ${name()} into a group`}
                      icon="folder"
                      description={groupNameOf(sessionGroups(), r().groupId) ?? undefined}
                      disabled={v().m.moveDisabled}
                      onRun={() => {
                        void loadSessionGroups();
                        setScreen("groups");
                      }}
                    />
                    <Item label="Copy Path" aria={`Copy the path of ${name()}`} icon="copy" onRun={() => run(() => void copyText(r().path, "Copied path."))} />
                  </div>
                  <div class="model-menu-group" role="group" aria-label="Archive">
                    <Item
                      label={v().m.archive.label}
                      aria={`${v().m.archive.label} ${name()}`}
                      icon="archive"
                      disabled={v().m.archive.disabled}
                      onRun={() => {
                        const act = v().m.archive.act;
                        const d = v().d;
                        if (act === "archive") run(() => props.onArchive(d));
                        else if (act === "unarchive") run(() => props.onUnarchive(d.path, d.orgProject));
                      }}
                    />
                  </div>
                </div>
              </Show>
            );
          }}
        </Show>
      </div>
    </Portal>
  );
}

/**
 * One menu row, as ActionMenu draws its rows: Enter and Space wired by hand (a `menuitem` is not a
 * button), and a disabled row says why under its label rather than going silently grey.
 */
function Item(p: { label: string; aria: string; icon?: IconName; disabled?: string; description?: string; checked?: boolean; onRun(): void }) {
  const act = () => !p.disabled && p.onRun();
  const detail = () => !!(p.disabled || p.description);
  return (
    <div
      class={detail() ? "popover-item popover-item-detail" : "popover-item"}
      role={p.checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={p.checked === undefined ? undefined : p.checked ? "true" : "false"}
      tabindex={0}
      aria-label={p.aria}
      aria-disabled={p.disabled ? "true" : undefined}
      title={p.disabled || undefined}
      onClick={act}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        act();
      }}
    >
      <Show when={p.checked !== undefined}>
        <Icon name="check" small class="popover-item-check" />
      </Show>
      <Show when={p.icon}>{(i) => <Icon name={i()} small />}</Show>
      <span class="popover-item-text">
        <span class="popover-item-label">{p.label}</span>
        <Show when={p.disabled || p.description}>
          <span class="popover-item-desc">{p.disabled || p.description}</span>
        </Show>
      </span>
    </div>
  ) as JSX.Element;
}
