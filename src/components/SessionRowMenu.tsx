/**
 * The session menu (§app.extensions/session-menu), in a file of its own so a test can draw it
 * (src/lib/session-row-menu.test.ts). One body, `SessionMenuBody`, for every door: the Agents
 * board row's ⋯ (`RowMenu`), and a right-click or Shift+F10 on a board row or on a session row in
 * the sidebar (`openSessionMenu`, through the page's one right-click menu, ContextMenu.tsx).
 * Everything it needs comes in through its props and the page's extension list. It is the
 * "session" menu place (src/lib/menu-place.ts): Sova's own items first (lib/session-menu), Copy
 * Path among them as the place's built-in, then what extensions add.
 */
import { createContext, createMemo, createUniqueId, For, Index, Match, Show, Switch, useContext } from "solid-js";
import type { SessionSummary } from "../../shared/protocol";
import type { BoardRow } from "../lib/agents-board";
import { type MenuBuiltIn, type MenuEntry, menuGroups, runMenuEntry, sameGroups } from "../lib/menu-place";
import { ExtensionsContext } from "../lib/reply-place";
import { hostOf } from "../lib/mesh";
import { renameValue, SESSION_MENU_ACTS, type SessionArchiveRow, type SessionMenuCtx, type SessionMenuRow, sessionMenuRows } from "../lib/session-menu";
import { groupNameOf, quoted, sessionGroups, setSessionGroup } from "../lib/session-groups";
import { announce, copyText, toast } from "../lib/ui-state";
import { type ActionMenuApi, ActionMenu } from "./ActionMenu";
import { openContextMenu } from "./ContextMenu";
import { MenuAdded, MenuBuiltIns } from "./MenuPlace";
import { TitleField } from "./TitleField";
import { Icon } from "./ui";

/** What the board's ⋯ needs from the board: the session menu's own context. */
export type RowMenuCtx = SessionMenuCtx;

/** The sidebar's door, filled by App (lib/session-menu `sidebarSessionMenuCtx`); none: no menu. */
export const SidebarSessionMenu = createContext<SessionMenuCtx | null>(null);

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

/** The menu's name, the ⋯ trigger's: every door names it the same. */
export const sessionMenuLabel = (s: SessionSummary) => `Actions for ${quoted(s.title)}`;

/** One of Sova's rows, drawn from its data (lib/session-menu). */
function RowItem(props: { menu: ActionMenuApi; row: SessionMenuRow }) {
  const r = () => props.row;
  return (
    <props.menu.Item
      label={r().label}
      aria={r().aria}
      icon={<Icon name={r().icon} small />}
      description={r().description}
      disabled={r().disabled}
      keepFocus={r().keepFocus}
      stayOpen={r().stayOpen}
      onRun={() => r().run()}
    />
  );
}

/**
 * The session menu's body, for every door: Sova's rows, the place's built-ins, what extensions add,
 * and its two screens (the name field and the groups). Rows keep their nodes while the list polls
 * (`Index`), so a focused row stays focused.
 */
export function SessionMenuBody(props: { menu: ActionMenuApi; session: SessionSummary; ctx: SessionMenuCtx; archive: SessionArchiveRow }) {
  const s = () => props.session;
  const menu = props.menu;
  /** What extensions add, for a session on this host only: an extension is this host's. */
  const extensions = useContext(ExtensionsContext);
  const added = createMemo(() => (hostOf(s().path) === null ? menuGroups(extensions(), "session") : []), [], { equals: sameGroups });
  const rows = createMemo(() => sessionMenuRows(s(), props.ctx, props.archive, (name) => menu.show(name)));
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
  const hint = createUniqueId();
  return (
    <Switch
      fallback={
        <div class="model-menu-list" role="menu" aria-label={sessionMenuLabel(s())}>
          <div class="model-menu-group" role="group" aria-label="Open">
            <Index each={rows().open}>{(r) => <RowItem menu={menu} row={r()} />}</Index>
          </div>
          {/* A chat Sova names itself keeps that name: no Title group at all. */}
          <Show when={rows().title.length > 0}>
            <div class="model-menu-group" role="group" aria-label="Title">
              <Index each={rows().title}>{(r) => <RowItem menu={menu} row={r()} />}</Index>
            </div>
          </Show>
          <div class="model-menu-group" role="group" aria-label="Organize">
            <Index each={rows().organize}>{(r) => <RowItem menu={menu} row={r()} />}</Index>
            <MenuBuiltIns menu={menu} builtIns={SESSION_MENU_BUILT_INS} subject={s()} />
          </div>
          <MenuAdded menu={menu} groups={added()} subject={quoted(s().title)} run={(e) => void runEntry(e, s().id)} />
        </div>
      }
    >
      <Match when={menu.screen() === "rename"}>
        {/* The name, asked inside the menu (§app.insights/team-cards "Rename"): the rows give way
            to the field, and nothing on the row below moves while it is answered. */}
        {(() => {
          const opened = s().title;
          return (
            <div class="group-menu-screen">
              <TitleField
                initial={opened}
                label={`Rename ${quoted(opened)}`}
                describedBy={hint}
                onDone={(typed) => {
                  menu.dismiss();
                  const title = renameValue(opened, typed);
                  if (title !== undefined) void SESSION_MENU_ACTS.setTitle(s(), title).then((ok) => ok && props.ctx.onRefresh());
                }}
                onCancel={() => menu.dismiss()}
              />
              <p class="text-caption text-muted" id={hint}>
                Kept in Sova only. Empty restores {quoted(s().originalTitle ?? opened)}.
              </p>
            </div>
          );
        })()}
      </Match>
      <Match when={menu.screen() === "groups"}>
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
      </Match>
    </Switch>
  );
}

/** The board row's ⋯: every action the row has but opening it (its title link does), the only door to them at folded width. */
export function RowMenu(props: { row: BoardRow; ctx: RowMenuCtx; archive: SessionArchiveRow }) {
  const s = () => props.row.session;
  return (
    <ActionMenu label={sessionMenuLabel(s())} title="Session actions" class="board-more">
      {(menu) => <SessionMenuBody menu={menu} session={s()} ctx={props.ctx} archive={props.archive} />}
    </ActionMenu>
  );
}

/**
 * A session row's right-click and Shift+F10 (§app/context-menus): the same body, at the pointer or
 * under the row, through the page's one right-click menu. `el` is the row, `link` its own link
 * (the row itself, and where focus goes back to); `holds` is the row's own gesture owning the event.
 */
export function openSessionMenu(
  e: MouseEvent,
  place: { el: Element; link: HTMLElement; holds?: boolean },
  session: () => SessionSummary,
  ctx: SessionMenuCtx,
  archive: () => SessionArchiveRow,
) {
  return openContextMenu(e, {
    el: place.el,
    ownLink: place.link,
    holds: place.holds,
    menu: () => ({
      label: sessionMenuLabel(session()),
      origin: place.link,
      body: (menu) => <SessionMenuBody menu={menu} session={session()} ctx={ctx} archive={archive()} />,
    }),
  });
}
