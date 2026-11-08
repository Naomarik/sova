// Cards raised from outside the chat (a project's raised cards, the merge queue's cards) as thread rows, placed where
// they were raised (lib/transcript-placement). Shared by the chat and the read-only watch view.
import { createMemo, type Accessor } from "solid-js";
import type { TranscriptItem } from "../../shared/protocol";
import type { CardInfo } from "../../shared/transcript-cards";
import { outsideCardRowId, placeOutsideCards } from "./transcript-placement";

export function createOutsideCardRows(items: Accessor<TranscriptItem[] | null | undefined>, outsideCards: Accessor<CardInfo[]>): Accessor<TranscriptItem[] | null | undefined> {
  const outsideById = createMemo(() => new Map(outsideCards().map((c) => [c.id, c] as const)));
  /** Each outside card's row, one object for its life: the thread keys its rows by object, so a fresh
      one per update (a merge card's every step) drew the card anew, at its estimate for a frame, and
      the rows above it jumped. The row reads its card as it is now, by id (as CardContext.card does). */
  const outsideRows = new Map<string, TranscriptItem>();
  const outsideRow = (first: CardInfo): TranscriptItem => {
    const id = outsideCardRowId(first.id);
    let row = outsideRows.get(id);
    if (!row) {
      let last = first;
      const now = () => (last = outsideById().get(first.id) ?? last);
      row = {
        id,
        kind: "card",
        get at() {
          return now().at;
        },
        get card() {
          return now();
        },
      };
      outsideRows.set(id, row);
    }
    return row;
  };
  return createMemo(() => {
    const list = items();
    const outside = outsideCards();
    const ids = new Set(outside.map((c) => outsideCardRowId(c.id)));
    for (const id of outsideRows.keys()) if (!ids.has(id)) outsideRows.delete(id);
    return list && outside.length ? placeOutsideCards(list, outside, outsideRow) : list;
  });
}
