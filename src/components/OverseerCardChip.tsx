import { createSignal, For, onCleanup } from "solid-js";
import type { OverseerCard } from "../../shared/overseer-card";
import { Icon } from "./ui";

/** The gap the panel keeps from every viewport edge, and the one it keeps from its trigger. */
const EDGE_GAP = 8;
const TRIGGER_GAP = 4;

/** "1 open card" / "3 open cards". */
export const cardChipText = (n: number): string => `${n} open ${n === 1 ? "card" : "cards"}`;

/**
 * The Overseer composer's card chip (§app.overseer/confirm), a clone of the alignment chip: "2 open
 * cards", a menu button in the run-status row. Its menu lists each open card on one line (id,
 * title), newest touched first; choosing one jumps to that card. The panel is the shared
 * `.model-menu.action-menu` popover, placed above or below the trigger, whichever fits.
 */
export function OverseerCardChip(props: { cards: OverseerCard[]; onJump(card: OverseerCard): void }) {
  let trigger!: HTMLButtonElement;
  let menu!: HTMLDivElement;
  const [open, setOpen] = createSignal(false);
  const rows = () => [...props.cards].reverse();

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

  const choose = (card: OverseerCard) => {
    menu.hidePopover();
    props.onJump(card);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        class="run-status-link run-status-align run-status-cards"
        aria-haspopup="menu"
        aria-expanded={open() ? "true" : "false"}
        aria-label={cardChipText(props.cards.length)}
        title="Open cards · jump to one"
        onClick={() => {
          if (open()) return menu.hidePopover();
          menu.showPopover();
          place();
          queueMicrotask(() => menu.querySelector<HTMLElement>("[role=menuitem]")?.focus());
        }}
      >
        <Icon name="eye" small />
        <span class="text-num">{cardChipText(props.cards.length)}</span>
        <Icon name="chevron-down" small />
      </button>
      <div
        ref={menu}
        class="model-menu action-menu align-menu"
        popover="auto"
        role="menu"
        aria-label="Open cards"
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
          {(card) => (
            <div
              class="popover-item"
              role="menuitem"
              tabindex="0"
              aria-label={`${card.id}: ${card.title}`}
              onClick={() => choose(card)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                choose(card);
              }}
            >
              <span class="text-mono align-menu-id">{card.id}</span>
              <span class="align-menu-title" title={card.title}>
                {card.title}
              </span>
            </div>
          )}
        </For>
      </div>
    </>
  );
}
