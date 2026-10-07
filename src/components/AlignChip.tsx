import { createSignal, For, onCleanup, Show } from "solid-js";
import { ALIGN_STATUS_CHIP, alignChipCounts, alignChipLabel, alignChipText, alignMenuLabel, alignMenuRows, alignStatusOf, liveCount, openCount, type AlignEntry } from "../lib/align";
import { Chip, Icon } from "./ui";

/** The gap the panel keeps from every viewport edge, and the one it keeps from its trigger. */
const EDGE_GAP = 8;
const TRIGGER_GAP = 4;

/**
 * The composer's alignment chip (§chat.alignment/chip): "2 aligns · 10/15 decided", a menu button in the
 * run-status row, right before the Inputs trigger. Its menu lists each open alignment on one line
 * (id, title, a progress bar and "{decided}/{live}", or its status word when it has no questions);
 * choosing one jumps to that alignment's newest card. The panel is the
 * shared `.model-menu.action-menu` popover (top layer, light dismiss, Escape for free), placed
 * above or below the trigger, whichever fits.
 */
export function AlignChip(props: { entries: AlignEntry[]; onJump(entry: AlignEntry): void }) {
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;
  const [open, setOpen] = createSignal(false);
  const counts = () => alignChipCounts(props.entries);
  /** Those still asking first, then newest first: the one the user touched last is the likeliest answer. */
  const rows = () => alignMenuRows(props.entries);

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
        title="Open alignments · questions decided of all"
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
          const items = [...menu.querySelectorAll<HTMLElement>("[role=menuitem]")];
          const i = items.indexOf(document.activeElement as HTMLElement);
          const to =
            e.key === "ArrowDown" ? (i + 1) % items.length
            : e.key === "ArrowUp" ? (i + items.length - 1) % items.length
            : e.key === "Home" ? 0
            : e.key === "End" ? items.length - 1
            : -1;
          if (to < 0) return;
          e.preventDefault();
          items[to]?.focus();
        }}
      >
        <For each={rows()}>
          {(entry) => {
            const live = () => liveCount(entry.doc);
            const decided = () => live() - openCount(entry.doc);
            const tone = () => (decided() < live() ? "warn" : "success");
            return (
              <div
                class="popover-item"
                role="menuitem"
                tabindex="0"
                aria-label={alignMenuLabel(entry.doc)}
                onClick={() => choose(entry)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  choose(entry);
                }}
              >
                <span class="text-mono align-menu-id">{entry.doc.id}</span>
                <span class="align-menu-title" title={entry.doc.title}>
                  {entry.doc.title}
                </span>
                <Show
                  when={live() > 0}
                  fallback={<Chip tone={ALIGN_STATUS_CHIP[alignStatusOf(entry.doc)].tone}>{ALIGN_STATUS_CHIP[alignStatusOf(entry.doc)].label}</Chip>}
                >
                  <span class="align-menu-bar" aria-hidden="true">
                    <span class={`align-menu-fill align-menu-fill-${tone()}`} style={{ width: `${(decided() / live()) * 100}%` }} />
                  </span>
                  <Chip tone={tone()} count>
                    {decided()}/{live()}
                  </Chip>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </>
  );
}
