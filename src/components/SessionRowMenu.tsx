/**
 * The Agents board row's ⋯ menu (§app.insights/team-cards), in a file of its own so a test can draw
 * it (src/lib/session-row-menu.test.ts): everything it needs from the board comes in through its
 * props and the page's extension list. It is the "session" menu place (src/lib/menu-place.ts):
 * Sova's own items first, Copy Path among them as the place's built-in, then what extensions add.
 */
import { createMemo, For, Show, useContext } from "solid-js";
import type { SessionSummary } from "../../shared/protocol";
import { type BoardRow, gistTitle } from "../lib/agents-board";
import { type MenuBuiltIn, type MenuEntry, menuGroups, runMenuEntry, sameGroups } from "../lib/menu-place";
import { ExtensionsContext } from "../lib/reply-place";
import { archivedProjectOf, unarchivedProjectOf } from "../lib/drag-archive";
import { hostOf } from "../lib/mesh";
import { archiveSession, renameSession } from "../lib/session-actions";
import { groupNameOf, loadSessionGroups, quoted, sessionGroups, setSessionGroup } from "../lib/session-groups";
import { summaryLineOf } from "../lib/summary-row";
import { announce, copyText, toast } from "../lib/ui-state";
import { ActionMenu } from "./ActionMenu";
import { MenuAdded, MenuBuiltIns } from "./MenuPlace";
import { Icon } from "./ui";

/** What the menu needs from the board: the gestures that reach past it. */
export interface RowMenuCtx {
  setRenaming(path: string | null): void;
  onRefresh(): void;
  onArchiveChanged(path: string, archived: boolean): void;
  onOpenSubagents(path: string): void;
  /** The session whose Session details pane is open beside the board, if any. */
  detailsPath: string | null;
  onOpenDetails(path: string): void;
}

/** Sova's own contributions to the session menu place, drawn last in the Organize group. */
export const SESSION_MENU_BUILT_INS: readonly MenuBuiltIn<SessionSummary>[] = [
  {
    id: "sova.copy-path",
    rows: (s) => [{ label: "Copy Path", aria: `Copy the path of ${quoted(s.title)}`, icon: "copy", run: () => void copyText(s.path, "Copied path.") }],
  },
];

/** Run an extension's entry for this session, and say how it went. */
const runEntry = async (entry: MenuEntry, session: string) => {
  const said = await runMenuEntry(entry, session);
  toast(said);
  announce(said);
};

/** The ⋯ menu: every action the row has, the only door to them at folded width. */
export function RowMenu(props: { row: BoardRow; ctx: RowMenuCtx; href: string; archive: { label: string; blocked: string | null } | null }) {
  const s = () => props.row.session;
  const gist = () => gistTitle(s());
  /** What extensions add, for a session on this host only: an extension is this host's. */
  const extensions = useContext(ExtensionsContext);
  const added = createMemo(() => (hostOf(s().path) === null ? menuGroups(extensions(), "session") : []), [], { equals: sameGroups });
  const setTitle = async (title: string | null) => {
    if (await renameSession(s(), title)) props.ctx.onRefresh();
  };
  const move = async (id: string | null) => {
    const before = groupNameOf(sessionGroups(), s().groupId);
    if (id === (s().groupId ?? null)) return;
    if (!(await setSessionGroup(s().path, id))) return;
    const after = groupNameOf(sessionGroups(), id ?? undefined);
    const done = id === null ? `Removed from ${before ? quoted(before) : "the group"}.` : `${before ? "Moved" : "Added"} to ${quoted(after ?? "the group")}.`;
    toast(done);
    announce(done);
    props.ctx.onRefresh();
  };
  return (
    <ActionMenu label={`Actions for ${quoted(s().title)}`} title="Session actions" class="board-more">
      {(menu) => (
        <Show
          when={menu.screen() === "groups"}
          fallback={
            <div class="model-menu-list" role="menu" aria-label={`Actions for ${quoted(s().title)}`}>
              <div class="model-menu-group" role="group" aria-label="Open">
                <menu.Item label="Open Session" aria={`Open ${quoted(s().title)}`} icon={<Icon name="arrow-right" small />} href={props.href} />
                <menu.Item
                  label={props.ctx.detailsPath === s().path ? "Close Session Details" : "Session Details"}
                  aria={`${props.ctx.detailsPath === s().path ? "Close the session details" : "Session details"} of ${quoted(s().title)}`}
                  icon={<Icon name="info" small />}
                  onRun={() => props.ctx.onOpenDetails(s().path)}
                />
                <menu.Item
                  label="Open Subagents"
                  aria={`Open the subagents pane of ${quoted(s().title)}`}
                  icon={<Icon name="worker" small />}
                  keepFocus
                  onRun={() => props.ctx.onOpenSubagents(s().path)}
                />
              </div>
              <div class="model-menu-group" role="group" aria-label="Title">
                <menu.Item label="Rename…" aria={`Rename ${quoted(s().title)}`} icon={<Icon name="pencil" small />} keepFocus onRun={() => props.ctx.setRenaming(s().path)} />
                <menu.Item
                  label="Use Gist as Title"
                  aria={`Use the gist as the title of ${quoted(s().title)}`}
                  icon={<Icon name="pencil" small />}
                  description={gist() ?? undefined}
                  disabled={gist() ? "" : summaryLineOf(s()) ? "The gist is already the title." : "No gist yet."}
                  onRun={() => void setTitle(gist())}
                />
                <menu.Item
                  label="Reset to Original Title"
                  aria={`Reset ${quoted(s().title)} to its original title`}
                  icon={<Icon name="undo" small />}
                  description={s().originalTitle}
                  disabled={s().originalTitle === undefined ? "Not renamed." : ""}
                  onRun={() => void setTitle(null)}
                />
              </div>
              <div class="model-menu-group" role="group" aria-label="Organize">
                <menu.Item
                  label="Move to Group…"
                  aria={`Move ${quoted(s().title)} into a group`}
                  icon={<Icon name="folder" small />}
                  description={groupNameOf(sessionGroups(), s().groupId) ?? undefined}
                  stayOpen
                  onRun={() => {
                    void loadSessionGroups();
                    menu.show("groups");
                  }}
                />
                <Show when={props.archive}>
                  {(a) => (
                    <menu.Item
                      label={a().label}
                      aria={`${a().label} ${quoted(s().title)}`}
                      icon={<Icon name="archive" small />}
                      disabled={a().blocked ?? ""}
                      onRun={() => {
                        const path = s().path;
                        const next = !s().archived;
                        void archiveSession(path, next, next ? archivedProjectOf(s()) : unarchivedProjectOf(s(), hostOf(path) === null)).then((ok) => ok && props.ctx.onArchiveChanged(path, next));
                      }}
                    />
                  )}
                </Show>
                <MenuBuiltIns menu={menu} builtIns={SESSION_MENU_BUILT_INS} subject={s()} />
              </div>
              <MenuAdded menu={menu} groups={added()} subject={quoted(s().title)} run={(e) => void runEntry(e, s().id)} />
            </div>
          }
        >
          <div class="model-menu-list" role="menu" aria-label="Move to group">
            <div class="model-menu-group" role="group" aria-label="Groups">
              <div class="list-group-label">Groups</div>
              <For each={[{ id: null as string | null, name: "No group" }, ...sessionGroups().map((g) => ({ id: g.id as string | null, name: g.name }))]}>
                {(g) => (
                  <menu.Item
                    label={g.name}
                    aria={g.id ? `Move ${quoted(s().title)} to ${quoted(g.name)}` : `Take ${quoted(s().title)} out of its group`}
                    icon={<Icon name={g.id === (s().groupId ?? null) ? "check" : "folder"} small />}
                    onRun={() => void move(g.id)}
                  />
                )}
              </For>
            </div>
          </div>
        </Show>
      )}
    </ActionMenu>
  );
}
