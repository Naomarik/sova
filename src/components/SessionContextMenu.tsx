/**
 * A sidebar session row's own menu: its items, and what each does. How it opens, sits and closes is
 * every right-click or hold menu's (ContextMenu.tsx); a row's door is `sessionMenu.door`, keyed by
 * the session's path. One panel for the whole list, beside the drop overlay: it keeps only the
 * row's path and reads the live row from the list on every change, so a refresh under it shows the
 * new title and a row that goes away closes it. Every row does what its existing door does: the
 * drop panel's archive, Undo and groups (lib/drag-overlay), the Agents board menu's titles
 * (lib/session-actions, lib/auto-title), the board's Copy Path. The rules are lib/session-context-menu.
 */
import { createMemo, For, Show } from "solid-js";
import type { SessionSummary } from "../../shared/protocol";
import { regeneratingTitle } from "../lib/auto-title";
import { archiveDragOf, archivedProjectOf, unarchivedProjectOf } from "../lib/drag-archive";
import { type DragInfo, dropTiles } from "../lib/drag-overlay";
import { hostLabel, hostOf } from "../lib/mesh";
import { groupRefusal } from "../lib/regions";
import { regenerateSessionTitleNow, renameSession } from "../lib/session-actions";
import { groupChoices, rowMenuOf } from "../lib/session-context-menu";
import { groupNameOf, loadSessionGroups, quoted, sessionGroups } from "../lib/session-groups";
import { copyText, localRunning } from "../lib/ui-state";
import { createContextMenu } from "./ContextMenu";
import { TitleField } from "./TitleField";
import { Icon } from "./ui";

/** The session rows' menu, keyed by the session's path. */
export const sessionMenu = createContextMenu<string>();

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
  return (
    <sessionMenu.Panel live={(path) => props.rows.some((r) => r.path === path)}>
      {(path, api) => {
        const row = createMemo(() => {
          const p = path();
          return p === null ? null : (props.rows.find((r) => r.path === p) ?? null);
        });
        const drag = createMemo(() => (row() ? dragOf(row()!) : null));
        const tiles = createMemo(() => (drag() ? dropTiles(drag()!, sessionGroups(), props.counts) : null));
        const model = createMemo(() => (row() && drag() ? rowMenuOf(row()!, drag()!.archive, tiles()!, regeneratingTitle(row()!.path)) : null));
        const { Item, run, screen, show } = api;
        const setTitle = (title: string | null) => {
          const r = row();
          if (!r) return;
          void renameSession(r, title).then((ok) => ok && props.onRefresh());
        };
        return (
          <Show when={row() && model() ? { r: row()!, m: model()!, d: drag()! } : null} keyed={false}>
            {(v) => {
              const r = () => v().r;
              const name = () => quoted(r().title);
              return (
                <Show
                  when={screen() === null}
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
                            onCancel={() => show(null)}
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
                                onRun={g.current ? undefined : () => props.onMove(v().d, g.id)}
                              />
                            )}
                          </For>
                        </div>
                        <div class="model-menu-group" role="group" aria-label="New group">
                          <Item
                            label="New Group…"
                            aria={`Move ${name()} into a new group`}
                            icon={<Icon name="plus" small />}
                            disabled={tiles()!.newDisabled ?? ""}
                            onRun={() => props.onNewGroup(v().d)}
                          />
                        </div>
                      </div>
                    </Show>
                  }
                >
                  <div class="model-menu-list" role="menu" aria-label={`Actions for ${name()}`}>
                    {/* One line, cut short when long: the full title is its tooltip. */}
                    <div class="popover-label" aria-hidden="true" title={r().title} style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                      {r().title}
                    </div>
                    {/* A chat Sova names itself keeps that name: no title rows at all. */}
                    <Show when={v().m.title}>
                      {(t) => (
                        <div class="model-menu-group" role="group" aria-label="Title">
                          <Item label="Rename…" aria={`Rename ${name()}`} icon={<Icon name="pencil" small />} stayOpen onRun={() => show("rename")} />
                          <Item
                            label="Regenerate Title"
                            aria={`Regenerate the title of ${name()}`}
                            icon={<Icon name="refresh" small />}
                            description={t().regenerateDesc}
                            disabled={t().regenerateDisabled}
                            onRun={() => void regenerateSessionTitleNow(r(), props.onRefresh)}
                          />
                          <Item
                            label="Reset to Original Title"
                            aria={`Reset ${name()} to its original title`}
                            icon={<Icon name="undo" small />}
                            description={t().original}
                            disabled={t().resetDisabled}
                            onRun={() => setTitle(null)}
                          />
                        </div>
                      )}
                    </Show>
                    <div class="model-menu-group" role="group" aria-label="Session">
                      <Item
                        label="Move to Group…"
                        aria={`Move ${name()} into a group`}
                        icon={<Icon name="folder" small />}
                        description={groupNameOf(sessionGroups(), r().groupId) ?? undefined}
                        disabled={v().m.moveDisabled}
                        stayOpen
                        onRun={() => {
                          void loadSessionGroups();
                          show("groups");
                        }}
                      />
                      <Item label="Copy Path" aria={`Copy the path of ${name()}`} icon={<Icon name="copy" small />} onRun={() => void copyText(r().path, "Copied path.")} />
                      <Item
                        label={v().m.archive.label}
                        aria={`${v().m.archive.label} ${name()}`}
                        icon={<Icon name="archive" small />}
                        disabled={v().m.archive.disabled}
                        onRun={(() => {
                          const act = v().m.archive.act;
                          const d = v().d;
                          if (act === "archive") return () => props.onArchive(d);
                          if (act === "unarchive") return () => props.onUnarchive(d.path, d.orgProject);
                          return undefined;
                        })()}
                      />
                    </div>
                  </div>
                </Show>
              );
            }}
          </Show>
        );
      }}
    </sessionMenu.Panel>
  );
}
