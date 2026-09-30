// The drop overlay a dragged session row opens (§app.session-list/drop-overlay), and
// the New group dialog a drop on `+ New group` opens after it. The drag itself lives here, in module
// state, and not in the row that started it: a list poll can rebuild that row mid-drag, and the
// drag must outlive it — which is also why the card that follows the pointer is a copy of the row,
// taken once when the drag starts. The rules are in lib/drag-overlay; what a drop does is the Sidebar's.

import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { GROUP_NAME_MAX, type SessionGroup } from "../../shared/protocol";
import {
  ARCHIVE_TILE,
  autoScrollStep,
  CANCEL_TILE,
  type DragInfo,
  dropHint,
  DROP_LIST_FIT,
  dropListLayout,
  dropTiles,
  ghostPlacement,
  ghostTarget,
  groupCountLabel,
  hitTile,
  NEW_TILE,
  NO_GROUPS_LINE,
  openAnnouncement,
  type Point,
  type Rect,
  REMOVE_TILE,
  type TileId,
} from "../lib/drag-overlay";
import { HOLD_SUPPRESS_MS } from "../lib/hold-select";
import { quoted } from "../lib/session-groups";
import { announce } from "../lib/ui-state";
import { Icon, trapFocus } from "./ui";

const [drag, setDrag] = createSignal<DragInfo | null>(null);
const [over, setOver] = createSignal<TileId | null>(null);
/** The row a drop on `+ New group` is naming a group for; the dialog is open while this is set. */
const [naming, setNaming] = createSignal<DragInfo | null>(null);
/** The floating card: a copy of the row as it looked when the drag started. */
const [card, setCard] = createSignal<HTMLElement | null>(null);

/** The row being dragged, if any: the source row reads it to dim itself. */
export const draggingPath = () => drag()?.path ?? null;

let pointerId: number | null = null;
let last: Point = { x: 0, y: 0 };
let endedAt = -Infinity;
/** The row the last drag carried: only its own click is the drag's echo. */
let endedPath: string | null = null;
let root: HTMLDivElement | undefined;
let grid: HTMLDivElement | undefined;
let ghost: HTMLDivElement | undefined;
/** A finger (or pen) carries the card above it; a mouse trails it. */
let touch = false;
let frame = 0;
/** The mounted overlay's drop handler. None mounted, no drag: a row can't start one. */
let onDropHandler: ((info: DragInfo, tile: TileId | null) => void) | null = null;

/** Whether a click arriving now is a drag's echo: during the drag, and for a while after it ends. */
export const dragSuppressesClick = (path: string) => draggingPath() === path || (endedPath === path && Date.now() - endedAt <= HOLD_SUPPRESS_MS);

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
};

/** The tile under the pointer, read from the tiles on screen now (the grid may have scrolled). */
function hitNow(): TileId | null {
  if (!root) return null;
  const clip = grid ? rectOf(grid) : undefined;
  const tiles = [...root.querySelectorAll<HTMLElement>("[data-drop-tile]")].map((el) => ({
    id: el.dataset.dropTile!,
    rect: rectOf(el),
    clip: grid?.contains(el) ? clip : undefined,
  }));
  return hitTile(tiles, last);
}
const track = () => setOver(hitNow());

/** The card follows the pointer. Geometry only: hit-testing reads the tiles' rects, never the card. */
function placeGhost() {
  if (!ghost) return;
  const size = { width: ghost.offsetWidth, height: ghost.offsetHeight };
  const at = ghostPlacement(last, size, { width: innerWidth, height: innerHeight }, touch);
  ghost.style.transform = `translate3d(${Math.round(at.x)}px, ${Math.round(at.y)}px, 0)`;
}

/** The dragged row, copied for the card: no ids (they'd repeat), no menus, no state classes. */
function cardOf(source: Element): HTMLElement {
  const copy = source.cloneNode(true) as HTMLElement;
  copy.classList.remove("session-row-lifted", "session-row-dragging", "session-row-shell-current", "session-row-shell-selecting", "session-row-shell-selected");
  for (const el of [copy, ...copy.querySelectorAll("[id]")]) el.removeAttribute("id");
  for (const el of copy.querySelectorAll("[popover], .session-later")) el.remove();
  return copy;
}

/** Scrolls the grid while the pointer rests near its top or bottom edge. */
function tick() {
  frame = 0;
  if (!drag()) return;
  if (grid) {
    const step = autoScrollStep(last.y, rectOf(grid));
    if (step) {
      const before = grid.scrollTop;
      grid.scrollTop += step;
      if (grid.scrollTop !== before) track();
    }
  }
  frame = requestAnimationFrame(tick);
}

const onMove = (e: PointerEvent) => {
  if (e.pointerId !== pointerId) return;
  last = { x: e.clientX, y: e.clientY };
  track();
  placeGhost();
};
const onUp = (e: PointerEvent) => {
  if (e.pointerId !== pointerId) return;
  last = { x: e.clientX, y: e.clientY };
  finish(hitNow());
};
const onCancel = (e: Event) => {
  if (e instanceof PointerEvent && e.pointerId !== pointerId) return;
  finish(null);
};
const onKey = (e: KeyboardEvent) => {
  if (e.key !== "Escape") return;
  e.preventDefault();
  e.stopPropagation();
  finish(null);
};
const onHidden = () => document.visibilityState === "hidden" && finish(null);
/** While a row is in flight the list must not scroll under it, nor the page pan. */
const noScroll = (e: Event) => e.cancelable && e.preventDefault();

function listen(on: boolean) {
  const f = on ? addEventListener : removeEventListener;
  f("pointermove", onMove as EventListener, true);
  f("pointerup", onUp as EventListener, true);
  f("pointercancel", onCancel, true);
  f("keydown", onKey as EventListener, true);
  f("blur", onCancel);
  f("touchmove", noScroll, { capture: true, passive: false } as AddEventListenerOptions);
  f("contextmenu", noScroll, true);
  if (on) document.addEventListener("visibilitychange", onHidden);
  else document.removeEventListener("visibilitychange", onHidden);
  // An iframe is its own document and would swallow the pointer: see through it (base.css).
  document.documentElement.toggleAttribute("data-row-drag", on);
}

/**
 * The row's press became a drag: open the overlay. `source` keeps the pointer (capture), so the
 * moves keep coming wherever it goes; the listeners are on the window, so they outlive the row.
 */
export function startRowDrag(info: DragInfo, at: Point, id: number, source: Element, pointerType: string): void {
  if (!onDropHandler || drag()) return;
  pointerId = id;
  last = at;
  touch = pointerType !== "mouse";
  setCard(cardOf(source));
  try {
    source.setPointerCapture(id);
  } catch {
    // A pointer the browser has already let go of: the window listeners still see its release.
  }
  setOver(null);
  setDrag(info);
  listen(true);
  announce(openAnnouncement(info.title));
  frame = requestAnimationFrame(() => {
    track();
    placeGhost();
    tick();
  });
}

/** Every way a drag ends, in one place: the tile under the pointer, or null for no action. */
function finish(tile: TileId | null) {
  const info = drag();
  if (!info) return;
  listen(false);
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  pointerId = null;
  endedAt = Date.now();
  endedPath = info.path;
  setDrag(null);
  setOver(null);
  setCard(null);
  onDropHandler?.(info, tile);
}

/** Opens the New group dialog for the row just dropped on `+ New group`. */
export const openNewGroupFor = (info: DragInfo) => setNaming(info);

export function DropOverlay(props: {
  groups: SessionGroup[];
  /** Each group's session count, as the Groups region counts them. */
  counts: ReadonlyMap<string, number>;
  onDrop(info: DragInfo, tile: TileId | null): void;
  /** `Create and Move`: the name is trimmed and non-empty. */
  onCreate(info: DragInfo, name: string): void;
}) {
  onMount(() => (onDropHandler = (info, tile) => props.onDrop(info, tile)));
  onCleanup(() => {
    onDropHandler = null;
    finish(null);
  });
  const tiles = createMemo(() => {
    const d = drag();
    return d ? dropTiles(d, props.groups, props.counts) : null;
  });

  return (
    <>
      <Show when={drag()}>
        {(d) => {
          const t = () => tiles()!;
          /** The second line: what a drop does while the tile is under the pointer, else its resting words. */
          const line = (id: TileId, resting: string | null, disabled: string | null) =>
            over() === id ? (disabled ?? dropHint(id, d())) : resting;
          // The list is its own size, centred: session-row targets in one column, then 2 and 3,
          // then shorter rows, then a scroll (dropListLayout). The room it may take is the window
          // less the overlay's margins and the panel's own head, bar and padding.
          const count = () => 1 + (t().remove ? 1 : 0) + t().groups.length;
          const [box, setBox] = createSignal({ width: 0, height: 0 });
          const [folded, setFolded] = createSignal(innerWidth < 768);
          let panel: HTMLDivElement | undefined;
          const measure = () => {
            if (!root || !panel || !grid) return;
            const px = (v: string) => parseFloat(v) || 0;
            const outer = getComputedStyle(root);
            const inner = getComputedStyle(panel);
            setFolded(root.clientWidth < 768);
            setBox({
              width: root.clientWidth - px(outer.paddingLeft) - px(outer.paddingRight) - px(inner.paddingLeft) - px(inner.paddingRight),
              height: root.clientHeight - px(outer.paddingTop) - px(outer.paddingBottom) - (panel.offsetHeight - grid.offsetHeight),
            });
          };
          // Folded, the one column is the sheet's width; wider, it is the sessions pane's.
          const layout = createMemo(() => dropListLayout(count(), box(), folded() ? { ...DROP_LIST_FIT, columnWidth: box().width } : DROP_LIST_FIT));
          const observer = new ResizeObserver(measure);
          onMount(() => {
            for (const el of [root, panel?.querySelector(".drop-overlay-head"), panel?.querySelector(".drop-overlay-bar")]) if (el) observer.observe(el);
            measure();
          });
          onCleanup(() => observer.disconnect());
          const aim = () => ghostTarget(over(), t(), d());
          /** A target's two lines: the name (and a badge), then what it holds or, under the pointer, what a drop does. */
          const Words = (p: { name: JSX.Element; line: string | null; badge?: JSX.Element }) => (
            <span class="drop-tile-words">
              <span class="drop-tile-name">
                <span class="drop-tile-text">{p.name}</span>
                {p.badge}
              </span>
              <Show when={p.line}>{(l) => <span class="drop-tile-line">{l()}</span>}</Show>
            </span>
          );
          return (
            <Portal>
              <div ref={root} class="drop-overlay" role="dialog" aria-modal="true" aria-labelledby="drop-overlay-title">
                <div ref={panel} class="drop-overlay-panel" style={{ "--drop-list-w": `${layout().width}px` }}>
                  <div class="drop-overlay-head">
                    <h2 class="drop-overlay-title" id="drop-overlay-title" title={d().title}>
                      Move “<bdi>{d().title}</bdi>”
                    </h2>
                    <p class="drop-overlay-hint">Drop it on a group or on Archive. Let go anywhere else to cancel.</p>
                    <Show when={t().groupNote}>{(note) => <p class="drop-overlay-note">{note()}</p>}</Show>
                  </div>
                  <div
                    ref={grid}
                    class="drop-overlay-grid"
                    style={{
                      "grid-template-columns": `repeat(${layout().columns}, minmax(0, 1fr))`,
                      "grid-template-rows": `repeat(${layout().rows}, ${layout().rowHeight}px)`,
                      height: `${Math.min(layout().height, Math.max(box().height, layout().rowHeight))}px`,
                    }}
                  >
                    <div
                      class="drop-tile drop-tile-new"
                      classList={{ "drop-tile-over": over() === NEW_TILE && !t().newDisabled }}
                      data-drop-tile={NEW_TILE}
                      aria-disabled={t().newDisabled ? "true" : undefined}
                      title={t().newDisabled ?? undefined}
                    >
                      <Icon name="plus" class="drop-tile-icon" />
                      <Words name="New group" line={line(NEW_TILE, t().groups.length === 0 && !t().newDisabled ? NO_GROUPS_LINE : null, t().newDisabled)} />
                    </div>
                    <Show when={t().remove}>
                      {(r) => (
                        <div
                          class="drop-tile drop-tile-remove"
                          classList={{ "drop-tile-over": over() === REMOVE_TILE }}
                          data-drop-tile={REMOVE_TILE}
                          title={`Remove from ${quoted(r().name)}`}
                        >
                          <Icon name="close" class="drop-tile-icon" />
                          <Words name={<>Remove from {quoted(r().name)}</>} line={line(REMOVE_TILE, null, null)} />
                        </div>
                      )}
                    </Show>
                    <For each={t().groups}>
                      {(g) => (
                        <div
                          class="drop-tile"
                          classList={{ "drop-tile-over": over() === g.id && !g.current && !g.disabled, "drop-tile-current": g.current }}
                          data-drop-tile={g.id}
                          aria-disabled={g.current || g.disabled ? "true" : undefined}
                          title={g.disabled ?? g.name}
                        >
                          <Icon name="folder" class="drop-tile-icon" />
                          <Words
                            name={<bdi>{g.name}</bdi>}
                            badge={g.current ? <span class="chip drop-tile-chip">Current</span> : undefined}
                            line={g.current ? groupCountLabel(g.count) : line(g.id, groupCountLabel(g.count), g.disabled)}
                          />
                        </div>
                      )}
                    </For>
                  </div>
                  {/* Cancel first and wider: the way out. Archive is the deliberate reach to the far end, 12px apart. */}
                  <div class="drop-overlay-bar">
                    <button
                      type="button"
                      class="drop-tile drop-tile-cancel"
                      classList={{ "drop-tile-over": over() === CANCEL_TILE }}
                      data-drop-tile={CANCEL_TILE}
                      onClick={() => finish(null)}
                    >
                      <Icon name="close" class="drop-tile-icon" />
                      <Words name="Cancel" line={over() === CANCEL_TILE ? dropHint(CANCEL_TILE, d()) : null} />
                    </button>
                    <div
                      class="drop-tile drop-tile-archive"
                      classList={{ "drop-tile-over": over() === ARCHIVE_TILE && !t().archiveDisabled }}
                      data-drop-tile={ARCHIVE_TILE}
                      aria-disabled={t().archiveDisabled ? "true" : undefined}
                    >
                      <Icon name="archive" class="drop-tile-icon" />
                      <Words name="Archive" line={t().archiveDisabled ?? (over() === ARCHIVE_TILE ? dropHint(ARCHIVE_TILE, d()) : null)} />
                    </div>
                  </div>
                </div>
                {/* The row itself, in the air: what is being dropped, and under it where it would go.
                    pointer-events none, and hit-testing reads the tiles' own rects, so it never
                    stands between the pointer and a tile. */}
                <div ref={ghost} class="drop-ghost" classList={{ "drop-ghost-touch": touch }} aria-hidden="true">
                  <ul class="drop-ghost-card">{card()}</ul>
                  <p class="drop-ghost-target" classList={{ "drop-ghost-target-refused": aim().refused, "drop-ghost-target-none": over() === null }}>
                    <Icon name={aim().refused || over() === null || over() === CANCEL_TILE ? "close" : "arrow-right"} small />
                    <span class="drop-ghost-target-text">{aim().text}</span>
                  </p>
                </div>
              </div>
            </Portal>
          );
        }}
      </Show>
      <Show when={naming()}>
        {(info) => (
          <NewGroupDialog
            title={info().title}
            onCancel={() => setNaming(null)}
            onCreate={(name) => {
              // Read the row before closing: the accessor is stale once the dialog's <Show> is gone.
              const row = info();
              setNaming(null);
              props.onCreate(row, name);
            }}
          />
        )}
      </Show>
    </>
  );
}

/** "New group", after a drop on its tile: one field, `Create and Move`, `Cancel`. Nothing happens until Create. */
function NewGroupDialog(props: { title: string; onCancel(): void; onCreate(name: string): void }) {
  const [value, setValue] = createSignal("");
  const name = () => value().trim();
  let input!: HTMLInputElement;
  onMount(() => input.focus());
  return (
    <Portal>
      <div class="scrim" onClick={() => props.onCancel()} />
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-group-title"
        aria-describedby="new-group-body"
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          props.onCancel();
        }}
      >
        <div class="sheet-grip" aria-hidden="true" />
        <div class="modal-head">
          <h2 class="modal-title" id="new-group-title">
            New group
          </h2>
        </div>
        <form
          class="modal-body"
          id="new-group-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (name()) props.onCreate(name());
          }}
        >
          <p class="message-text" id="new-group-body">
            “<bdi>{props.title}</bdi>” moves into it.
          </p>
          <input
            ref={input}
            class="input"
            type="text"
            maxlength={GROUP_NAME_MAX}
            placeholder="Group name"
            aria-label="New group name"
            value={value()}
            onInput={(e) => setValue(e.currentTarget.value)}
          />
        </form>
        <div class="modal-foot">
          <span class="modal-spacer" />
          <button type="button" class="button button-ghost" onClick={() => props.onCancel()}>
            Cancel
          </button>
          <button
            type="submit"
            form="new-group-form"
            class="button button-primary"
            disabled={!name()}
            title={name() ? undefined : "Type a name first."}
          >
            Create and Move
          </button>
        </div>
      </div>
    </Portal>
  );
}
