/**
 * A place's own rows (lib/menu-row), drawn as menu Items: the one drawer a place's ⋯ and its
 * right-click menu (§app/context-menus) both use. Rows keep their nodes while their data changes
 * (`Index`), so a focused row stays focused when the list it reads refreshes under an open menu.
 */
import { Index } from "solid-js";
import type { MenuRow } from "../lib/menu-row";
import type { ActionMenuApi } from "./ActionMenu";
import { Icon } from "./ui";

/** One row. */
export function MenuRowItem(props: { menu: ActionMenuApi; row: MenuRow }) {
  const r = () => props.row;
  return (
    <props.menu.Item
      label={r().label}
      aria={r().aria}
      title={r().title}
      icon={r().icon ? <Icon name={r().icon!} small /> : undefined}
      description={r().description}
      disabled={r().disabled}
      href={r().href}
      keepFocus={r().keepFocus}
      stayOpen={r().stayOpen}
      onRun={r().run ? () => r().run?.() : undefined}
    />
  );
}

/** Rows in their order, nothing around them. */
export function MenuRows(props: { menu: ActionMenuApi; rows: readonly MenuRow[] }) {
  return <Index each={props.rows}>{(r) => <MenuRowItem menu={props.menu} row={r()} />}</Index>;
}
