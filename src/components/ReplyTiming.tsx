import { createMemo, createSignal, For, onCleanup, type JSX, Show } from "solid-js";
import type { ReplyTiming } from "../../shared/usage/perf";
import { placeHelpCard } from "../lib/help-popover";
import { replyCard, replyCardSummary } from "../lib/perf";
import "../reply-timing.css";

let nextId = 0;
/** Hover opens after a short rest, so moving the pointer across a thread opens nothing. */
const OPEN_DELAY_MS = 300;
const CLOSE_DELAY_MS = 120;

/**
 * A measured reply's head: the model name and the time, with the reply's own figures in a card.
 * With a mouse, resting on the head shows the card; the time is a button, so a tap (or Enter)
 * shows it too and keeps it until a press elsewhere, Escape, or a second tap. The card holds no
 * controls: it is the time button's description, and a top-layer popover so no pane clips it.
 */
export function ReplyTimingHead(props: { timing: ReplyTiming; author: JSX.Element; stamp: JSX.Element; extra?: JSX.Element }) {
  const id = `reply-timing-${++nextId}`;
  const c = createMemo(() => replyCard(props.timing));
  let head!: HTMLDivElement;
  let button!: HTMLButtonElement;
  let card!: HTMLDivElement;
  const [open, setOpen] = createSignal(false);
  const [pinned, setPinned] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => timer !== undefined && (clearTimeout(timer), (timer = undefined));

  const place = () => {
    if (!open()) return;
    const at = placeHelpCard(button.getBoundingClientRect(), card.getBoundingClientRect(), { width: innerWidth, height: innerHeight });
    card.style.setProperty("--reply-timing-top", `${at.top}px`);
    card.style.setProperty("--reply-timing-left", `${at.left}px`);
  };
  const show = () => {
    clear();
    if (open() || !card.isConnected) return;
    card.showPopover();
    setOpen(true);
    place();
  };
  const hide = () => {
    clear();
    setPinned(false);
    if (!open()) return;
    if (card.isConnected && card.matches(":popover-open")) card.hidePopover();
    setOpen(false);
  };
  const later = (fn: () => void, ms: number) => {
    clear();
    timer = setTimeout(fn, ms);
  };

  const mouse = (e: PointerEvent) => e.pointerType === "mouse";
  const onPointerDown = (e: PointerEvent) => {
    if (!pinned()) return;
    const t = e.target as Node | null;
    if (t && (button.contains(t) || card.contains(t))) return;
    hide();
  };
  addEventListener("pointerdown", onPointerDown, true);
  addEventListener("resize", place);
  addEventListener("scroll", place, true);
  onCleanup(() => {
    clear();
    removeEventListener("pointerdown", onPointerDown, true);
    removeEventListener("resize", place);
    removeEventListener("scroll", place, true);
    if (card?.isConnected && card.matches(":popover-open")) card.hidePopover();
  });

  return (
    <div
      ref={head}
      class="message-head reply-timing-head"
      onPointerEnter={(e) => mouse(e) && !pinned() && later(show, OPEN_DELAY_MS)}
      onPointerLeave={(e) => mouse(e) && !pinned() && later(hide, CLOSE_DELAY_MS)}
    >
      {props.author}
      {props.extra}
      <button
        ref={button}
        type="button"
        class="reply-timing-button"
        aria-expanded={open() ? "true" : "false"}
        aria-describedby={id}
        onClick={() => {
          if (pinned()) return hide();
          setPinned(true);
          show();
        }}
        onFocus={() => show()}
        onBlur={() => !pinned() && hide()}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || !open()) return;
          e.preventDefault();
          e.stopPropagation();
          hide();
        }}
      >
        {props.stamp}
      </button>
      <div
        ref={card}
        id={id}
        class="reply-timing-card"
        popover="manual"
        role="tooltip"
        onPointerEnter={(e) => mouse(e) && clear()}
        onPointerLeave={(e) => mouse(e) && !pinned() && later(hide, CLOSE_DELAY_MS)}
      >
        <span class="visually-hidden">{replyCardSummary(props.timing)}</span>
        <div class="reply-timing-body" aria-hidden="true">
          <Show when={c().effort}>{(e) => <p class="reply-timing-effort">Effort {e()}</p>}</Show>
          <div class="reply-timing-headline">
            <span class="reply-timing-label">{c().headline.label}</span>
            <span class="reply-timing-big">{c().headline.value}</span>
            <span class="reply-timing-note">{c().headline.note}</span>
          </div>
          <dl class="reply-timing-lines">
            <For each={c().parts}>
              {(l) => (
                <div class="reply-timing-line">
                  <dt>{l.label}</dt>
                  <dd>{l.value}</dd>
                </div>
              )}
            </For>
          </dl>
        </div>
      </div>
    </div>
  );
}
