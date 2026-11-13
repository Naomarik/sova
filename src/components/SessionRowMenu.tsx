/**
 * The session menu's doors (§app.extensions/session-menu), in a file of its own so a test can draw
 * them (src/lib/session-row-menu.test.ts): the Agents board row's ⋯ (`RowMenu`), and a right-click
 * on a board row or on a session row in the sidebar (`openSessionMenu`). Both draw the
 * one declaration, lib/session-menu `SESSION_MENU`: Sova's own rows, then what extensions add.
 */
import { createContext } from "solid-js";
import type { SessionSummary } from "../../shared/protocol";
import type { BoardRow } from "../lib/agents-board";
import { SESSION_MENU, type SessionArchiveRow, type SessionMenuCtx } from "../lib/session-menu";
import { openMenu, PlaceMenu } from "./MenuPlace";

/** What the board's ⋯ needs from the board: the session menu's own context. */
export type RowMenuCtx = SessionMenuCtx;

/** The sidebar's door, filled by App (lib/session-menu `sidebarSessionMenuCtx`); none: no menu. */
export const SidebarSessionMenu = createContext<SessionMenuCtx | null>(null);

/** The board row's ⋯: every action the row has but opening it (its title link does), the only door to them at folded width. */
export function RowMenu(props: { row: BoardRow; ctx: RowMenuCtx; archive: SessionArchiveRow }) {
  return <PlaceMenu decl={SESSION_MENU} subject={{ session: props.row.session, ctx: props.ctx, archive: props.archive }} title="Session actions" class="board-more" />;
}

/**
 * A session row's right-click (§app/context-menus): the same menu, at the pointer. `el` is the row,
 * `link` its own link (the row itself, and where focus goes back to); `holds` is the row's own
 * gesture owning the event.
 */
export const openSessionMenu = (e: MouseEvent, place: { el: Element; link: HTMLElement; holds?: boolean }, session: () => SessionSummary, ctx: SessionMenuCtx, archive: () => SessionArchiveRow) =>
  openMenu(e, SESSION_MENU, () => ({ session: session(), ctx, archive: archive() }), { el: place.el, origin: () => place.link, ownLink: place.link, holds: place.holds });
