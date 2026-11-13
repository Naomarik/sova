/**
 * The session menu's pointer doors (§app.extensions/session-menu), in a file of its own so tests can
 * draw the declaration: a right-click or touch/pen hold on an Agents board row or a session row in
 * the sidebar. Both draw lib/session-menu `SESSION_MENU`: Sova's own rows, then what extensions add.
 */
import { createContext } from "solid-js";
import type { SessionSummary } from "../../shared/protocol";
import { SESSION_MENU, type SessionArchiveRow, type SessionMenuCtx } from "../lib/session-menu";
import { holdMenu, openMenu } from "./MenuPlace";

/** The sidebar's menu context, filled by App (lib/session-menu `sidebarSessionMenuCtx`); null: no menu. */
export const SidebarSessionMenu = createContext<SessionMenuCtx | null>(null);

type SessionPlace = { el: Element; link: HTMLElement; holds?: boolean; drag?(at: { x: number; y: number }): void; lift?(on: boolean): void };

/** A session row's right-click. `link` is its own link and where focus goes back to. */
export const openSessionMenu = (e: MouseEvent, place: SessionPlace, session: () => SessionSummary, ctx: SessionMenuCtx, archive: () => SessionArchiveRow) =>
  openMenu(e, SESSION_MENU, () => ({ session: session(), ctx, archive: archive() }), { el: place.el, origin: () => place.link, ownLink: place.link, holds: place.holds });

/** A session row's touch/pen hold: lift at 500ms, then drag on movement or open on release. */
export const holdSessionMenu = (e: PointerEvent, place: SessionPlace, session: () => SessionSummary, ctx: SessionMenuCtx, archive: () => SessionArchiveRow) =>
  holdMenu(e, SESSION_MENU, () => ({ session: session(), ctx, archive: archive() }), { el: place.el, origin: () => place.link, ownLink: place.link, drag: place.drag, lift: place.lift });
