import { createSignal, onCleanup, type JSX } from "solid-js";
import { placeHelpCard, refocusAfterClose, type HelpCloseReason } from "../lib/help-popover";
import { Icon } from "./ui";
import "./help-popover.css";

/**
 * A `?` button and the help it opens (§chat.memory/help): a small card anchored under the button,
 * a bottom sheet at folded width (help-popover.css). With a mouse, hovering the button (or focusing
 * it from the keyboard) shows `label` as a one-line hint; a press opens the card, so a phone never
 * depends on hover. The card is a `popover="manual"` dialog in the top layer, so no scrolling pane
 * clips it; it stays in the DOM where it is written, inside any focus trap around it. It closes on
 * Escape (which stops there, so an enclosing dialog stays open), its ×, a press outside it, or focus
 * leaving it, and hands focus back to the button (help-popover.ts says when).
 */
export function HelpPopover(props: {
  /** The button's accessible name and hover hint, and the dialog's name: "How memory works". */
  label: string;
  /** Unique per page: the card's id, and its heading's. */
  id: string;
  /** Called as the card opens, before it is placed: the caller can pick what it shows. */
  onOpen?(): void;
  children: JSX.Element;
}) {
  let button!: HTMLButtonElement;
  let card!: HTMLDivElement;
  const [open, setOpen] = createSignal(false);

  const place = () => {
    if (!open()) return;
    const r = button.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    const at = placeHelpCard(r, box, { width: innerWidth, height: innerHeight });
    card.style.setProperty("--help-top", `${at.top}px`);
    card.style.setProperty("--help-left", `${at.left}px`);
  };

  const show = () => {
    props.onOpen?.();
    card.showPopover();
    setOpen(true);
    place();
    // The selected tab, or the card itself: focus moves in, so Tab walks the card's own controls.
    queueMicrotask(() => (card.querySelector<HTMLElement>("[role=tab][aria-selected=true]") ?? card).focus());
  };

  const close = (reason: HelpCloseReason) => {
    if (!open()) return;
    const active = document.activeElement;
    const focus = !active || active === document.body ? "body" : card.contains(active) ? "inside" : "elsewhere";
    card.hidePopover();
    setOpen(false);
    if (refocusAfterClose(reason, focus)) button.focus();
  };

  // A press anywhere but the card and its button closes it; capture, so a handler that stops the
  // event (a menu row, the dialog's own) can't keep the card open behind it. As a sheet, over its
  // dimmed backdrop, the press only closes the sheet: its click is swallowed, or a tap above the
  // sheet would also land on the Settings scrim and close Settings.
  const sheet = () => matchMedia("(max-width: 767px)").matches;
  const swallowClick = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    removeEventListener("click", swallowClick, true);
  };
  const onPointerDown = (e: PointerEvent) => {
    removeEventListener("click", swallowClick, true);
    if (!open()) return;
    const t = e.target as Node | null;
    if (t && (card.contains(t) || button.contains(t))) return;
    if (sheet()) addEventListener("click", swallowClick, true);
    close("outside");
  };
  addEventListener("pointerdown", onPointerDown, true);
  addEventListener("resize", place);
  addEventListener("scroll", place, true);
  onCleanup(() => {
    removeEventListener("pointerdown", onPointerDown, true);
    removeEventListener("click", swallowClick, true);
    removeEventListener("resize", place);
    removeEventListener("scroll", place, true);
    if (card.isConnected && card.matches(":popover-open")) card.hidePopover();
  });

  return (
    <span class="help-anchor">
      <button
        ref={button}
        type="button"
        class="button button-ghost help-button"
        aria-label={props.label}
        aria-haspopup="dialog"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={props.id}
        onClick={() => (open() ? close("close-button") : show())}
      >
        <span class="help-button-mark" aria-hidden="true">
          ?
        </span>
      </button>
      <span class="help-hint" aria-hidden="true">
        {props.label}
      </span>
      <div
        ref={card}
        id={props.id}
        class="help-card"
        popover="manual"
        role="dialog"
        aria-labelledby={`${props.id}-title`}
        tabindex="-1"
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          // Ours alone: the Settings dialog around the card closes on Escape too.
          e.preventDefault();
          e.stopPropagation();
          close("escape");
        }}
        onFocusOut={(e) => {
          const next = e.relatedTarget as Node | null;
          if (next && !card.contains(next) && !button.contains(next)) close("focus-left");
        }}
      >
        <div class="sheet-grip" aria-hidden="true" />
        <div class="help-card-head">
          <h4 class="help-card-title" id={`${props.id}-title`}>
            {props.label}
          </h4>
          <button type="button" class="button button-icon button-ghost" aria-label="Close" onClick={() => close("close-button")}>
            <Icon name="close" small />
          </button>
        </div>
        <div class="help-card-body">{props.children}</div>
      </div>
    </span>
  );
}
