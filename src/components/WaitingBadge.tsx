import { createMemo, createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { OverseerCard } from "../../shared/overseer-card";
import type { OfferCard } from "../../shared/session-offers";
import type { AlignEntry } from "../lib/align";
import { cardNumeral, countSize, dash, dotXs, progressLength, RING_ARC, RING_R, waitingCounts, waitingLabel, waitingLook, type WaitingCounts, type WaitingLook } from "../lib/waiting";
import type { OfferControls } from "./OfferCard";
import { WaitingDialog } from "./WaitingDialog";
import "../waiting.css";

/** What in a chat waits for the user, and how to reach each (§chat.composer/waiting-badge). */
export interface WaitingSource {
  /** The branch's alignments (the badge counts the open ones). */
  aligns: AlignEntry[];
  /** An ordinary chat's offer cards. */
  offers?: OfferControls;
  /** The Overseer's open cards. */
  overseerCards: OverseerCard[];
  jumpAlign(entry: AlignEntry): void;
  jumpOverseerCard(card: OverseerCard): void;
  jumpOffer(card: OfferCard): void;
}

/** The badge's counts and look, for the composer (the box's text makes room only while it shows). */
export function createWaiting(source: () => WaitingSource | undefined) {
  const counts = createMemo<WaitingCounts>(() => {
    const s = source();
    if (!s) return waitingCounts([], 0);
    return waitingCounts(s.aligns, (s.offers?.open().length ?? 0) + s.overseerCards.length);
  });
  const look = createMemo<WaitingLook>(() => waitingLook(counts()));
  return { counts, look };
}

/** The glyph, drawn around (0,0) in the agreed reference's units ("Orb on top"). */
export function WaitingGlyph(props: { counts: WaitingCounts; look: WaitingLook }) {
  const c = () => props.counts;
  const numeral = () => cardNumeral(c().cards);
  const withAlignments = () => props.look !== "cards";
  return (
    <svg class="waiting-badge-glyph" viewBox="-20 -22 40 42" aria-hidden="true">
      <circle r={RING_R} class="waiting-badge-track" stroke-dasharray={dash(RING_ARC)} transform="rotate(135)" />
      <Show when={withAlignments() && progressLength(c()) > 0}>
        <circle r={RING_R} class="waiting-badge-progress" stroke-dasharray={dash(progressLength(c()))} transform="rotate(135)" />
      </Show>
      <Show when={withAlignments()}>
        <text class="waiting-badge-count" y="6" style={{ "font-size": `${countSize(c().open)}px` }}>
          {c().open}
        </text>
        <For each={dotXs(c().alignments)}>{(x) => <circle class="waiting-badge-dot" cx={x} cy="17" r="2" />}</For>
      </Show>
      <Show when={numeral()}>
        <text class="waiting-badge-cards" y="-9">
          {numeral()}
        </text>
      </Show>
    </svg>
  );
}

/**
 * The composer's waiting badge (§chat.composer/waiting-badge): inside the message box at its left
 * edge, on the last text line. A press opens the Waiting on you dialog
 * (§chat.composer/waiting-dialog); the dialog stays open, saying nothing is left, when the last
 * item goes and the badge with it.
 */
export function WaitingBadge(props: { source: WaitingSource; counts: WaitingCounts; look: WaitingLook }) {
  const [open, setOpen] = createSignal(false);
  return (
    <>
      <Show when={props.look !== "hidden"}>
        <button
          type="button"
          class="waiting-badge"
          data-look={props.look}
          aria-haspopup="dialog"
          aria-expanded={open() ? "true" : "false"}
          aria-label={waitingLabel(props.counts)}
          title={waitingLabel(props.counts).replace(" — show what's waiting", "")}
          onClick={() => setOpen(true)}
        >
          <WaitingGlyph counts={props.counts} look={props.look} />
        </button>
      </Show>
      <Show when={open()}>
        <Portal>
          <WaitingDialog source={props.source} onClose={() => setOpen(false)} />
        </Portal>
      </Show>
    </>
  );
}
