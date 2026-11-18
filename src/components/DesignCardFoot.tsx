import { onCleanup, onMount, type JSX } from "solid-js";
import { watchPinnedBar } from "../lib/pinned-bar";

/**
 * A Lookbook card's bottom bar. It sticks to the bottom of the transcript while the card is in view
 * (the card grows to fit, so it can be taller than the screen) and sits at the card's end otherwise.
 * `data-pinned` says which, for its shadow; nothing about its size changes.
 */
export function DesignCardFoot(props: { class?: string; label?: string; children: JSX.Element }) {
  let foot!: HTMLDivElement;
  onMount(() => {
    const card = foot.closest<HTMLElement>(".design-card");
    // `data-pinned` while it is stuck, and the chat's floating controls lifted above it (lib/pinned-bar).
    if (card) onCleanup(watchPinnedBar(foot, card));
  });
  return (
    <div ref={foot} class={`card-foot design-card-foot${props.class ? ` ${props.class}` : ""}`} role={props.label ? "group" : undefined} aria-label={props.label}>
      {props.children}
    </div>
  );
}
