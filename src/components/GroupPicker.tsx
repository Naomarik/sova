// The group picker the Groups head's `Open Groups` opens: the drop overlay's shell and group tiles
// with nothing in flight. A press on a group opens its workspace; nothing here makes, moves,
// archives or removes a group. The tiles are lib/group-picker's. The panel takes the list's own
// size, never the window's — the drop overlay's own dropListLayout: one column of session-row
// tiles, a second and a third when the window's height won't hold one, then shorter rows, then a
// scroll. The scrim still fills the window; folded, the panel is a bottom sheet as tall as its list.

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { SessionGroup } from "../../shared/protocol";
import { DROP_LIST_FIT, dropListLayout } from "../lib/drag-overlay";
import { firstFocusTile, NO_GROUPS_NOTE, pickerTiles } from "../lib/group-picker";
import { announce } from "../lib/ui-state";
import { Icon, trapFocus } from "./ui";

export function GroupPicker(props: {
  groups: SessionGroup[];
  /** Each group's session count, as the drop overlay counts them. */
  counts: ReadonlyMap<string, number>;
  onClose(): void;
}) {
  const tiles = createMemo(() => pickerTiles(props.groups, props.counts));
  // The room the list may take: the window less the shell's margins and the panel's head and
  // padding — the drop overlay's own measure, so the two can never size the same list differently.
  const [box, setBox] = createSignal({ width: 0, height: 0 });
  const [folded, setFolded] = createSignal(innerWidth < 768);
  // Folded, the one column is the sheet's width; wider, it is the sessions pane's.
  const layout = createMemo(() => dropListLayout(tiles().length, box(), folded() ? { ...DROP_LIST_FIT, columnWidth: box().width } : DROP_LIST_FIT));
  let root: HTMLDivElement | undefined;
  let panel: HTMLDivElement | undefined;
  let grid: HTMLDivElement | undefined;
  const measure = () => {
    if (!root || !panel || !grid) return;
    const px = (v: string) => parseFloat(v) || 0;
    const outer = getComputedStyle(root);
    const inner = getComputedStyle(panel);
    // Chrome measured directly, head + padding + borders + the panel's gap: the grid's height is
    // content-sized, so the drop overlay's panel-minus-grid read goes negative before the cap
    // lands and never converges for a long list.
    const head = panel.querySelector<HTMLElement>(".drop-overlay-head");
    setFolded(root.clientWidth < 768);
    setBox({
      width: root.clientWidth - px(outer.paddingLeft) - px(outer.paddingRight) - px(inner.paddingLeft) - px(inner.paddingRight),
      height:
        root.clientHeight -
        px(outer.paddingTop) -
        px(outer.paddingBottom) -
        px(inner.paddingTop) -
        px(inner.paddingBottom) -
        px(inner.borderTopWidth) -
        px(inner.borderBottomWidth) -
        px(inner.rowGap) -
        (head?.offsetHeight ?? 0),
    });
  };
  const observer = new ResizeObserver(measure);
  onMount(() => {
    if (root) observer.observe(root);
    const head = panel?.querySelector(".drop-overlay-head");
    if (head) observer.observe(head);
    measure();
    const at = firstFocusTile(tiles());
    if (at >= 0) grid?.querySelectorAll<HTMLElement>(".group-picker-tile")[at]?.focus();
  });
  onCleanup(() => observer.disconnect());

  return (
    <Portal>
      <div
        ref={(el) => {
          root = el;
          trapFocus(el);
        }}
        class="drop-overlay group-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-picker-title"
        aria-describedby="group-picker-hint"
        onClick={(e) => e.target === e.currentTarget && props.onClose()}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          e.stopPropagation();
          props.onClose();
        }}
      >
        <div
          ref={panel}
          class="drop-overlay-panel"
          style={{
            "--drop-list-w": `${layout().width}px`,
            "--pick-row-h": `${layout().rowHeight}px`,
          }}
        >
          <div class="drop-overlay-head group-picker-head">
            <div class="group-picker-head-text">
              <h2 class="drop-overlay-title" id="group-picker-title">
                Groups
              </h2>
              <p class="drop-overlay-hint" id="group-picker-hint">
                Open one as a workspace.
              </p>
              <Show when={tiles().length === 0}>
                <p class="drop-overlay-note">{NO_GROUPS_NOTE}</p>
              </Show>
            </div>
            <button type="button" class="button button-icon button-ghost" aria-label="Close" title="Close" onClick={() => props.onClose()}>
              <Icon name="close" />
            </button>
          </div>
          <div
            ref={grid}
            class="drop-overlay-grid group-picker-grid"
            style={{
              "grid-template-columns": `repeat(${layout().columns}, minmax(0, 1fr))`,
              // The scroll cap. Not flex-shrink: a shrink-to-fit grid freezes its auto rows at
              // their minimum, and a wrapped reason is clipped by the next row (measured, Chrome).
              "max-height": box().height > 0 ? `${Math.max(box().height, layout().rowHeight)}px` : undefined,
            }}
          >
            <For each={tiles()}>
              {(t) => (
                // A group that opens is a plain link: the route does the rest. An empty one stays in
                // the Tab order, disabled, with its reason written out in full under its name.
                <a
                  class="drop-tile group-picker-tile"
                  href={t.href ?? undefined}
                  role={t.href ? undefined : "link"}
                  tabindex={t.href ? undefined : 0}
                  aria-disabled={t.disabled ? "true" : undefined}
                  title={t.disabled ?? t.name}
                  onClick={(e) => {
                    if (t.disabled) {
                      e.preventDefault();
                      announce(t.disabled);
                      return;
                    }
                    // A new tab or window is the browser's: the picker stays.
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                    props.onClose();
                  }}
                  onKeyDown={(e) => {
                    if (t.disabled && (e.key === "Enter" || e.key === " ")) {
                      e.preventDefault();
                      announce(t.disabled);
                    }
                  }}
                >
                  <Icon name="folder" class="drop-tile-icon" />
                  <span class="drop-tile-words">
                    <span class="drop-tile-name">
                      <span class="drop-tile-text">
                        <bdi>{t.name}</bdi>
                      </span>
                      <Show when={t.disabled}>
                        <span class="chip drop-tile-chip">Empty</span>
                      </Show>
                    </span>
                    <span class="drop-tile-line">{t.line}</span>
                  </span>
                </a>
              )}
            </For>
          </div>
        </div>
      </div>
    </Portal>
  );
}
