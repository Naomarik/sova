import { For, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";

/** The gap the panel keeps from every viewport edge. */
const EDGE_GAP = 8;

export interface RowMenuItem {
  label: string;
  /** The row's accessible name: it names the thing it acts on. */
  aria: string;
  onRun(): void;
}

/** The handle a row keeps: open the menu at a point (a right-click, a held press), or close it. */
export interface RowMenuHandle {
  openAt(x: number, y: number): void;
  close(): void;
}

/**
 * A row's context menu, opened where the pointer is rather than under a trigger: a right-click on
 * desktop, a held press on a phone (§app.session-list/needs-you). The same `.model-menu.action-menu`
 * popover as the "⋯" menus — top layer, light dismiss, Escape for free — and under 768px the
 * `.model-menu` sheet rules place it, as for every other menu. Focus goes to the first row and back
 * to `returnFocus` when a row runs.
 */
export function RowMenu(props: { label: string; items: RowMenuItem[]; returnFocus?: () => HTMLElement | undefined; ref(h: RowMenuHandle | undefined): void; ignore?: () => boolean }) {
  let menu!: HTMLDivElement;
  const close = () => {
    if (menu.matches(":popover-open")) menu.hidePopover();
  };
  const openAt = (x: number, y: number) => {
    if (!menu.matches(":popover-open")) menu.showPopover();
    const box = menu.getBoundingClientRect();
    const left = Math.min(Math.max(x, EDGE_GAP), Math.max(EDGE_GAP, innerWidth - EDGE_GAP - box.width));
    const top = Math.min(Math.max(y, EDGE_GAP), Math.max(EDGE_GAP, innerHeight - EDGE_GAP - box.height));
    menu.style.setProperty("--menu-left", `${Math.round(left)}px`);
    menu.style.setProperty("--menu-top", `${Math.round(top)}px`);
    queueMicrotask(() => menu.querySelector<HTMLElement>("[role=menuitem]")?.focus());
  };
  props.ref({ openAt, close });
  onCleanup(() => props.ref(undefined));
  // The panel stays where it was put; a scroll under it would leave it beside the wrong row.
  addEventListener("scroll", close, true);
  onCleanup(() => removeEventListener("scroll", close, true));
  const run = (item: RowMenuItem) => {
    // A held press opens the menu under the finger: the release's click is the gesture's echo, not a choice.
    if (props.ignore?.()) return;
    close();
    props.returnFocus?.()?.focus();
    item.onRun();
  };
  return (
    <Portal>
      <div ref={menu} class="model-menu action-menu" popover="auto" role="menu" aria-label={props.label}>
        <For each={props.items}>
          {(item) => (
            <div
              class="mode-option group-option"
              role="menuitem"
              tabindex={0}
              aria-label={item.aria}
              onClick={() => run(item)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                run(item);
              }}
            >
              <span class="mode-option-text">
                <span class="mode-option-id">{item.label}</span>
              </span>
            </div>
          )}
        </For>
      </div>
    </Portal>
  );
}
