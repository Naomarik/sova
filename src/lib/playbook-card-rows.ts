// A chat's playbook card as a row of its conversation: the setup card before Start, the run's record
// after it, placed where the card was opened (lib/playbook-card `cardPlace`, lib/transcript-placement).
// The page makes the row; the server sends none.
import { createMemo, type Accessor } from "solid-js";
import type { TranscriptItem } from "../../shared/protocol";
import type { PlaybookRunView } from "../../shared/playbook-run";
import { cardPlace, cardRowId } from "./playbook-card";
import { placeOutsideCards } from "./transcript-placement";

/** The rows with each card's row placed among them. `null` rows (not loaded yet) stay null: a card
    never stands alone before the conversation is known. */
export function createPlaybookCardRows(items: Accessor<TranscriptItem[] | null | undefined>, cards: Accessor<readonly PlaybookRunView[]>): Accessor<TranscriptItem[] | null | undefined> {
  const placeOf = createMemo(() => new Map(cards().map((r) => [r.id, cardPlace(r)] as const)));
  /** One row object per run for its life: the thread keys its rows by object, so a fresh one per
      view (every edit is a new view) would draw the card anew and lose what was being typed. The
      row reads its time as the run's place is now. */
  const rows = new Map<string, TranscriptItem>();
  const rowOf = (place: { id: string }): TranscriptItem => {
    const id = cardRowId(place.id);
    let row = rows.get(id);
    if (!row) {
      const run = place.id;
      row = {
        id,
        kind: "info",
        get at() {
          return placeOf().get(run)?.at || undefined;
        },
      };
      rows.set(id, row);
    }
    return row;
  };
  return createMemo(() => {
    const list = items();
    const places = [...placeOf().values()];
    const ids = new Set(places.map((p) => cardRowId(p.id)));
    for (const id of rows.keys()) if (!ids.has(id)) rows.delete(id);
    return list && places.length ? placeOutsideCards(list, places, rowOf) : list;
  });
}
