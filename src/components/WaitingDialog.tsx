import { createUniqueId, For, Show } from "solid-js";
import { ALIGN_STATUS_CHIP, alignStatusOf } from "../lib/align";
import { alignmentLine, newestFirst, waitingAlignments, waitingTitle } from "../lib/waiting";
import { OfferActions, OfferContext, OfferRows } from "./OfferCard";
import { Chip, Icon, trapFocus } from "./ui";
import type { WaitingSource } from "./WaitingBadge";

/**
 * The Waiting on you dialog (§chat.composer/waiting-dialog): the chat's open option cards, then its
 * open alignments, each a bordered card. An offer card's buttons are the card's own (OfferActions),
 * so a press answers the card in the chat; an alignment only offers Show in Chat. Escape, the
 * backdrop and the close button close it, and focus goes back to the badge.
 */
export function WaitingDialog(props: { source: WaitingSource; onClose(): void }) {
  const id = createUniqueId();
  const offers = () => newestFirst(props.source.offers?.open() ?? []);
  const overseer = () => [...props.source.overseerCards].reverse();
  const aligns = () => waitingAlignments(props.source.aligns);
  const cardCount = () => offers().length + overseer().length;
  const total = () => cardCount() + aligns().length;
  /** Close first, then jump, so the jump's scroll and highlight land on a thread nothing covers. */
  const show = (jump: () => void) => {
    props.onClose();
    queueMicrotask(jump);
  };
  return (
    <>
      <div class="scrim" onClick={() => props.onClose()} />
      <div
        class="modal waiting-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          props.onClose();
        }}
      >
        <div class="sheet-grip" aria-hidden="true" />
        <div class="modal-head waiting-dialog-head">
          <h2 class="modal-title" id={`${id}-title`}>
            {waitingTitle(total())}
          </h2>
          <button type="button" class="button button-icon button-ghost" aria-label="Close" title="Close" onClick={() => props.onClose()}>
            <Icon name="close" />
          </button>
        </div>
        <div class="modal-body waiting-dialog-body">
          <Show when={total() === 0}>
            <p class="waiting-empty">Nothing is waiting on you in this chat.</p>
          </Show>
          <Show when={cardCount() > 0}>
            <section class="waiting-group" aria-labelledby={`${id}-cards`}>
              <h3 class="waiting-group-label" id={`${id}-cards`}>
                Option cards
              </h3>
              <ul class="waiting-list">
                <OfferContext.Provider value={props.source.offers}>
                  <For each={offers()}>
                    {(card) => (
                      <li class="card waiting-item" data-waiting-offer={card.id}>
                        <div class="waiting-item-head">
                          <span class="text-mono waiting-item-id">{card.id}</span>
                          <h4 class="waiting-item-title" title={card.title}>
                            {card.title}
                          </h4>
                        </div>
                        <Show when={card.from}>{(f) => <p class="waiting-item-note">From {f().title}</p>}</Show>
                        <Show when={card.note}>{(n) => <p class="waiting-item-note">{n()}</p>}</Show>
                        <Show when={card.rows}>
                          <div class="overseer-confirm-items">
                            <OfferRows card={card} />
                          </div>
                        </Show>
                        <div class="waiting-item-foot">
                          <OfferActions card={card} />
                          <button type="button" class="button button-sm button-ghost waiting-show" onClick={() => show(() => props.source.jumpOffer(card))}>
                            Show in Chat
                          </button>
                        </div>
                      </li>
                    )}
                  </For>
                </OfferContext.Provider>
                <For each={overseer()}>
                  {(card) => (
                    <li class="card waiting-item" data-card-ref={card.id}>
                      <div class="waiting-item-head">
                        <span class="text-mono waiting-item-id">{card.id}</span>
                        <h4 class="waiting-item-title" title={card.title}>
                          {card.title}
                        </h4>
                      </div>
                      <div class="waiting-item-foot">
                        <button type="button" class="button button-sm waiting-show" onClick={() => show(() => props.source.jumpOverseerCard(card))}>
                          Show in Chat
                        </button>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>
          <Show when={aligns().length > 0}>
            <section class="waiting-group" aria-labelledby={`${id}-aligns`}>
              <h3 class="waiting-group-label" id={`${id}-aligns`}>
                Alignments
              </h3>
              <ul class="waiting-list">
                <For each={aligns()}>
                  {(entry) => {
                    const line = () => alignmentLine(entry.doc);
                    const status = () => ALIGN_STATUS_CHIP[alignStatusOf(entry.doc)];
                    return (
                      <li class="card waiting-item" data-align-ref={entry.doc.id}>
                        <div class="waiting-item-head">
                          <span class="text-mono waiting-item-id">{entry.doc.id}</span>
                          <h4 class="waiting-item-title" title={entry.doc.title}>
                            {entry.doc.title}
                          </h4>
                        </div>
                        <Show
                          when={line().live > 0}
                          fallback={
                            <div class="waiting-item-status">
                              <Chip tone={status().tone}>{status().label}</Chip>
                            </div>
                          }
                        >
                          <div class="meter waiting-meter">
                            <div class="meter-head">
                              <span class="meter-label">{line().next}</span>
                              <span class="meter-value text-num" aria-label={`${line().decided} of ${line().live} decided`}>
                                {line().decided}
                                <span class="meter-of">/{line().live}</span>
                              </span>
                            </div>
                            <div class="meter-track" aria-hidden="true">
                              <div class="meter-fill" style={{ "--meter-pct": `${Math.round((line().decided / line().live) * 100)}%` }} />
                            </div>
                          </div>
                        </Show>
                        <div class="waiting-item-foot">
                          <button type="button" class="button button-sm waiting-show" onClick={() => show(() => props.source.jumpAlign(entry))}>
                            Show in Chat
                          </button>
                        </div>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </section>
          </Show>
        </div>
      </div>
    </>
  );
}
