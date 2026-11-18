import { createEffect, createMemo, createSignal, createUniqueId, For, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { actionRows, enterTarget, filterRows, GROUP_LABEL, moveActive, NO_ROW, type ChatActionId, type PaletteComposer, type PaletteRow } from "../lib/palette";
import { hideThinking, hideTools, setHideThinking, setHideTools } from "../lib/ui-state";
import type { ComposerHandle } from "../commands/composers";
import { isPhone } from "../commands/palette-open";
import { trapFocus } from "./ui";
import "../command-palette.css";

const sameRow = (a: PaletteRow, b: PaletteRow) => a.label === b.label && a.disabled === b.disabled;

/**
 * The Commands dialog (§app/command-palette): the This chat rows for the chat whose composer's "+"
 * opened it. Loaded on its first opening (App's `lazy`), so nothing here runs before.
 */
export default function CommandPalette(props: {
  /** What `Esc` and the scrim give focus back to (the "+" it was opened from). */
  returnTo: HTMLElement | null;
  /** The chat's composer, as the rows read it now; null: none on screen. */
  state(): PaletteComposer | null;
  /** The chat the rows act on. */
  chatPath(): string;
  /** The composer the rows act on. */
  composer(): ComposerHandle | null;
  onClose(): void;
}) {
  const uid = createUniqueId();
  const listId = `palette-list-${uid}`;
  const optionId = (key: string) => `palette-${uid}-${key.replace(/[^A-Za-z0-9_-]/g, "_")}`;

  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(NO_ROW);
  let input!: HTMLInputElement;
  let dialog!: HTMLDivElement;

  // A row that reads the same as before stays the same object, so the list redraws only what changed.
  let previous = new Map<string, PaletteRow>();
  const rows = createMemo(() => {
    const state = props.state();
    const next = new Map<string, PaletteRow>();
    const out = (state ? actionRows(state) : []).map((row) => {
      const old = previous.get(row.key);
      const keep = old && sameRow(old, row) ? old : row;
      next.set(row.key, keep);
      return keep;
    });
    previous = next;
    return out;
  });
  const shown = createMemo(() => filterRows(rows(), query()));
  const indexOf = createMemo(() => new Map(shown().map((row, i) => [row, i])));

  // The active row's marks, set on its element alone: one effect for the list, not two per row.
  let marked: HTMLElement | null = null;
  createEffect(() => {
    const row = shown()[active()];
    const el = row ? document.getElementById(optionId(row.key)) : null;
    if (marked && marked !== el) {
      marked.removeAttribute("data-active");
      marked.setAttribute("aria-selected", "false");
    }
    if (el) {
      el.setAttribute("data-active", "");
      el.setAttribute("aria-selected", "true");
    }
    marked = el;
  });

  /** One row, drawn once: a row's fields never change (a changed row is a new row). */
  const Option = (p: { row: PaletteRow; id: string }) => {
    const { row, id } = p;
    return (
      <div
        class="palette-option"
        id={id}
        role="option"
        aria-selected="false"
        aria-disabled={row.disabled ? "true" : undefined}
        onPointerMove={() => {
          const i = indexOf().get(row) ?? NO_ROW;
          if (active() !== i) setActive(i);
        }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => act(row)}
      >
        <span class="palette-option-text">
          <span class="palette-option-label">{row.label}</span>
          {row.disabled ? <span class="palette-option-desc">{row.disabled}</span> : null}
        </span>
      </div>
    );
  };

  const setActiveShown = (i: number) => {
    setActive(i);
    const row = shown()[i];
    if (row) document.getElementById(optionId(row.key))?.scrollIntoView({ block: "nearest" });
  };

  /** `Esc` or the scrim: closed with nothing picked, focus back to the "+" it was opened from. */
  const dismiss = () => {
    const to = props.returnTo;
    props.onClose();
    if (to) queueMicrotask(() => to.isConnected && to.focus());
  };

  /** A row picked (§app.command-palette/picking). Synchronous to the end: Attach images must open
      the picker inside the click or key press that picked it. */
  const runAction = (id: ChatActionId) => {
    const composer = props.composer();
    const path = props.chatPath();
    if (!composer) return;
    if (id === "attach") {
      composer.attach(); // first, before anything else runs: the picker needs this gesture
      props.onClose();
    } else if (id === "hide-tools") {
      setHideTools(path, !hideTools(path)); // says so itself, through the status region
      props.onClose();
    } else if (id === "hide-thinking") {
      setHideThinking(path, !hideThinking(path));
      props.onClose();
    } else {
      props.onClose();
      composer.playbooks();
    }
  };

  const act = (row: PaletteRow) => {
    if (!row.disabled) runAction(row.id);
  };

  const onListKey = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActiveShown(moveActive(active(), shown().length, e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = enterTarget(shown(), active());
      if (row) act(row);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    dismiss();
  };

  // On a phone the dialog takes focus instead of the field, so no keyboard comes up; tapping the
  // field still types. trapFocus leaves focus where it is once it's inside.
  onMount(() => (isPhone() ? dialog.focus() : input.focus()));

  const activeRow = () => shown()[active()];

  return (
    <Portal>
      <div class="scrim" onClick={dismiss} />
      <div
        class="modal palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`palette-title-${uid}`}
        ref={(el) => {
          dialog = el;
          trapFocus(el);
        }}
        onKeyDown={onKeyDown}
      >
        <div class="sheet-grip" aria-hidden="true" />
        <div class="modal-head">
          <h2 class="modal-title" id={`palette-title-${uid}`}>
            Commands
          </h2>
        </div>
        <div class="palette-search">
          <input
            ref={input}
            class="input"
            type="text"
            role="combobox"
            aria-label="Type a command"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeRow() ? optionId(activeRow()!.key) : undefined}
            placeholder="Type a command"
            autocomplete="off"
            spellcheck={false}
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setActive(NO_ROW); // a new query never leaves a row chosen
            }}
            onKeyDown={onListKey}
          />
        </div>
        <div class="palette-list" id={listId} role="listbox" aria-label="Commands">
          <Show when={shown().length}>
            <div role="group" aria-labelledby={`palette-${uid}-g-this`}>
              <p class="popover-label" id={`palette-${uid}-g-this`} role="presentation">
                {GROUP_LABEL}
              </p>
              <For each={shown()}>{(row) => <Option row={row} id={optionId(row.key)} />}</For>
            </div>
          </Show>
          <Show when={query().trim() && shown().length === 0}>
            <p class="palette-note" role="status">
              {rows().length} commands. None match “{query().trim()}”.
            </p>
          </Show>
        </div>
        <p class="palette-foot">Choose with ↑ ↓, then Enter. Esc closes.</p>
      </div>
    </Portal>
  );
}
