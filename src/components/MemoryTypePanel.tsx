import { For, Show } from "solid-js";
import type { ChatMemoryChoice, MemoryType, MemoryTypeInfo } from "../../shared/protocol";
import { sizeChoices, sizeLabel, typesOf } from "../lib/memory-ui";
import { Icon } from "./ui";

/**
 * The Memory type panel's rows (§chat.mode-menu/memory-panel): one radio per type — its name,
 * author and one-line description, UniiChat's write-up link under it — then Summary size, one
 * radio per suggested size. Rows only: the caller's popover holds the header, the foot and the
 * keys (`panelKeys`). The mode menu and the Overseer's memory switch draw the same rows.
 */
export function MemoryTypePanel(props: {
  /** Element ids stay unique per pane. */
  idPrefix: string;
  types: readonly MemoryTypeInfo[] | undefined;
  sizes: readonly number[] | undefined;
  /** The chat's choice; null until known (nothing checked). */
  choice: ChatMemoryChoice | null;
  busy: boolean;
  onPick(patch: { type?: MemoryType; size?: number }): void;
}) {
  const types = () => typesOf(props.types);
  const shownType = () => props.choice?.type ?? "uniichat";
  const sizes = () => sizeChoices(props.sizes, props.choice?.size);
  const defaultSize = () => types().find((t) => t.id === shownType())?.defaultSize;
  const pick = (patch: { type?: MemoryType; size?: number }) => {
    if (!props.busy) props.onPick(patch);
  };
  return (
    <div class="model-menu-list memory-panel" role="menu" aria-label="Memory type">
      <div class="model-menu-group" role="group" aria-labelledby={`${props.idPrefix}-types`}>
        <div class="list-group-label" id={`${props.idPrefix}-types`}>
          Type
        </div>
        <For each={types()}>
          {(t) => (
            <>
              <div
                class="popover-item popover-item-detail"
                role="menuitemradio"
                id={`${props.idPrefix}-type-${t.id}`}
                tabindex="-1"
                aria-checked={props.choice?.type === t.id ? "true" : "false"}
                aria-disabled={props.busy ? "true" : undefined}
                onClick={() => pick({ type: t.id })}
              >
                <Icon name="check" small class="popover-item-check" />
                <span class="popover-item-text">
                  <span class="popover-item-label">
                    {t.label} <span class="memory-type-by">· {t.by}</span>
                  </span>
                  <span class="popover-item-desc">{t.description}</span>
                </span>
              </div>
              <Show when={t.link}>
                {(href) => (
                  <a class="popover-item memory-type-link" role="menuitem" tabindex="-1" href={href()} target="_blank" rel="noopener noreferrer">
                    <span class="popover-item-text">
                      <span class="popover-item-label">Read the design ↗</span>
                    </span>
                  </a>
                )}
              </Show>
            </>
          )}
        </For>
      </div>
      <div class="model-menu-group" role="group" aria-labelledby={`${props.idPrefix}-sizes`}>
        <div class="list-group-label" id={`${props.idPrefix}-sizes`}>
          Summary size
        </div>
        <For each={sizes()}>
          {(s) => (
            <div
              class="popover-item"
              role="menuitemradio"
              id={`${props.idPrefix}-size-${s}`}
              tabindex="-1"
              aria-checked={props.choice?.size === s ? "true" : "false"}
              aria-disabled={props.busy ? "true" : undefined}
              onClick={() => pick({ size: s })}
            >
              <Icon name="check" small class="popover-item-check" />
              <span class="popover-item-label text-num">{sizeLabel(shownType(), s)}</span>
              <Show when={s === defaultSize()}>
                <span class="popover-item-end memory-size-default">default</span>
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

/**
 * Roving keys inside a panel: ↑/↓ move and wrap, Home/End jump, Enter/Space press the row. Only
 * rows take keys; a button in the header or foot keeps its own. Returns whether it took the key.
 */
export function panelKeys(e: KeyboardEvent, container: HTMLElement): boolean {
  const row = (e.target as HTMLElement | null)?.closest?.("[role^=menuitem]") as HTMLElement | null;
  if (!row || !container.contains(row)) return false;
  const rows = [...container.querySelectorAll<HTMLElement>("[role^=menuitem]")];
  const i = rows.indexOf(row);
  const focus = (k: number) => {
    const next = rows[(k + rows.length) % rows.length];
    if (!next) return;
    for (const r of rows) r.tabIndex = r === next ? 0 : -1;
    next.focus();
  };
  const keys: Record<string, () => void> = {
    ArrowDown: () => focus(i + 1),
    ArrowUp: () => focus(i - 1),
    Home: () => focus(0),
    End: () => focus(rows.length - 1),
    Enter: () => row.click(),
    " ": () => row.click(),
  };
  const act = keys[e.key];
  if (!act) return false;
  e.preventDefault();
  act();
  return true;
}

/** Focus the panel's checked type row (else its first row), as a picker opens on its current pick. */
export function focusPanel(container: HTMLElement | undefined): void {
  if (!container) return;
  const rows = [...container.querySelectorAll<HTMLElement>("[role^=menuitem]")];
  const at = rows.find((r) => r.getAttribute("role") === "menuitemradio" && r.getAttribute("aria-checked") === "true") ?? rows[0];
  for (const r of rows) r.tabIndex = r === at ? 0 : -1;
  at?.focus();
}
