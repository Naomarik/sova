/**
 * A workspace pane's tools, as a menu (§workspace.groups/a-pane): at 440px a row of seven buttons
 * is not a thing a pane head can hold. One body, `PaneMenuBody`, for every door: the pane head's ⋯
 * (`PaneMenu`), and a right-click or Shift+F10 on the pane head or on its tab (GroupView, through
 * the page's one right-click menu, ContextMenu.tsx). Its rows are lib/pane-menu's.
 */
import { createMemo, Show } from "solid-js";
import { GROUP_LABEL_MAX } from "../../shared/protocol";
import { type PaneMenuProps, paneMenuLabel, paneMenuRows } from "../lib/pane-menu";
import { ActionMenu, type ActionMenuApi } from "./ActionMenu";
import { MenuRows } from "./MenuRows";

/** The menu's rows, and its one non-menu screen: the member's name. */
export function PaneMenuBody(props: PaneMenuProps & { menu: ActionMenuApi }) {
  const menu = props.menu;
  /**
   * The rename screen: the menu's one non-menu screen, same shape as the narrow head's dissolve
   * question. The field starts from the current label, `maxlength` is the wire's own
   * GROUP_LABEL_MAX, and an empty field CLEARS the label — that is the gesture's other half, and
   * a disabled Save would hide it. Enter saves, Escape cancels, both keep the menu's focus rules.
   */
  let nameInput!: HTMLInputElement;
  const startNaming = () => {
    menu.show("rename");
    queueMicrotask(() => nameInput?.focus());
  };
  const saveName = () => {
    const raw = nameInput?.value.trim() ?? "";
    menu.show(null);
    menu.run(() => props.onRename(raw.length > 0 ? raw : null), true);
  };
  const rows = createMemo(() => paneMenuRows(props, startNaming));

  return (
    // The rename screen: the menu's one input, given the whole menu while it is up — the
    // same "one question at a time" shape the narrow head's dissolve ask uses. Empty CLEARS
    // the label (that half of the gesture is invisible if Save refuses it), Enter saves,
    // Escape cancels, and the field caps at the wire's GROUP_LABEL_MAX.
    <Show
      when={menu.screen() === "rename"}
      fallback={
        <div class="model-menu-list" role="menu" aria-label={paneMenuLabel(props.name)}>
          <div class="model-menu-group" role="group" aria-label="This member">
            <MenuRows menu={menu} rows={rows().member} />
          </div>
          <div class="model-menu-group" role="group" aria-label="This pane">
            <MenuRows menu={menu} rows={rows().pane} />
          </div>
          <div class="model-menu-group" role="group" aria-label="This session's membership">
            <MenuRows menu={menu} rows={rows().membership} />
          </div>
        </div>
      }
    >
      <div class="model-menu-list">
        <div class="group-menu-field">
          <input
            ref={nameInput}
            class="input"
            type="text"
            aria-label={`Name ${props.name}`}
            maxlength={GROUP_LABEL_MAX}
            placeholder={props.name}
            value={props.label ?? ""}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                saveName();
              } else if (e.key === "Escape") {
                e.preventDefault();
                menu.dismiss(); // Escape means "leave this screen AND the menu", as everywhere else
              }
            }}
          />
        </div>
        <div class="cluster">
          <button type="button" class="button button-sm" onClick={saveName}>
            Save
          </button>
          <button
            type="button"
            class="button button-sm button-ghost"
            onClick={() => {
              menu.show(null);
              menu.focusTrigger();
            }}
          >
            Cancel
          </button>
        </div>
        <p class="sidebar-region-note">Empty clears the label — the pane shows the title again.</p>
      </div>
    </Show>
  );
}

/** The pane head's ⋯. */
export function PaneMenu(props: PaneMenuProps) {
  return (
    <ActionMenu label={paneMenuLabel(props.name)} title="Pane actions">
      {(menu) => <PaneMenuBody {...props} menu={menu} />}
    </ActionMenu>
  );
}
