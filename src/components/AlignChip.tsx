import { createSignal, For, onCleanup } from "solid-js";
import { alignChipCounts, alignChipLabel, alignChipText, alignMenuNote, isOpenDoc, type AlignEntry } from "../lib/align";
import { Icon } from "./ui";

/** The gap the panel keeps from every viewport edge, and the one it keeps from its trigger. */
const EDGE_GAP = 8;
const TRIGGER_GAP = 4;

/**
 * The composer's alignment chip (§chat.alignment/chip): "2 aligns · 5/15", a menu button in the
 * run-status row, right before the Inputs trigger. Its menu lists each open alignment (title,
 * summary, open count); choosing one jumps to that alignment's newest card. The panel is the
 * shared `.model-menu.action-menu` popover (top layer, light dismiss, Escape for free), placed
 * above or below the trigger, whichever fits.
 */
export function AlignChip(props: { entries: AlignEntry[]; onJump(entry: AlignEntry): void }) {
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;
  const [open, setOpen] = createSignal(false);
  const counts = () => alignChipCounts(props.entries);
  /** Newest first: the one the user touched last is the likeliest answer. */
  const rows = () => props.entries.filter((e) => isOpenDoc(e.doc)).reverse();

  const place = () => {
    if (!menu.isConnected || !menu.matches(":popover-open")) return;
    const r = trigger.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    const above = r.top - TRIGGER_GAP - box.height;
    const top = above >= EDGE_GAP ? above : Math.min(r.bottom + TRIGGER_GAP, innerHeight - EDGE_GAP - box.height);
    const left = Math.min(Math.max(r.right - box.width, EDGE_GAP), Math.max(EDGE_GAP, innerWidth - EDGE_GAP - box.width));
    menu.style.setProperty("--menu-top", `${Math.round(Math.max(top, EDGE_GAP))}px`);
    menu.style.setProperty("--menu-left", `${Math.round(left)}px`);
  };
  addEventListener("resize", place);
  onCleanup(() => removeEventListener("resize", place));

  const choose = (entry: AlignEntry) => {
    menu.hidePopover();
    props.onJump(entry);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class="run-status-link run-status-align"
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        aria-label={alignChipLabel(counts())}
        title="Open alignments · questions open of all"
        onClick={() => {
          if (open()) return menu.hidePopover();
          menu.showPopover();
          place();
          queueMicrotask(() => menu.querySelector<HTMLElement>("[role=menuitem]")?.focus());
        }}
      >
        <Icon name="chat" small />
        <span class="text-num">{alignChipText(counts())}</span>
        <Icon name="chevron-down" small />
      </button>
      <div
        ref={menu}
        class="model-menu action-menu align-menu"
        popover="auto"
        role="menu"
        aria-label="Open alignments"
        onToggle={(e) => setOpen((e as ToggleEvent).newState === "open")}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          const items = [...menu.querySelectorAll<HTMLElement>("[role=menuitem]")];
          const i = items.indexOf(document.activeElement as HTMLElement);
          items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
        }}
      >
        <For each={rows()}>
          {(entry) => (
            <div
              class="mode-option group-option align-menu-item"
              role="menuitem"
              tabindex="0"
              aria-label={`${entry.doc.id} ${entry.doc.title}: ${alignMenuNote(entry.doc)} — jump to its card`}
              onClick={() => choose(entry)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                choose(entry);
              }}
            >
              <span class="mode-option-text">
                <span class="mode-option-id">
                  <span class="text-mono align-menu-id">{entry.doc.id}</span> {entry.doc.title}
                </span>
                <span class="mode-option-note">{alignMenuNote(entry.doc)}</span>
              </span>
            </div>
          )}
        </For>
      </div>
    </>
  );
}
