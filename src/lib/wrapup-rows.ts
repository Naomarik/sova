// A baton session's wrap-up turn (§app.organizations/wrap-up) reads the participants' profiles: its
// prompt lists them, its thinking and its tool call quote them. The session pane is a screen an
// outsider may be looking at, so the thread folds that turn away behind the wrap-up's own card
// (which names fields, never values); the org page is where profiles are read. Pure, for tsx --test.

import type { TranscriptItem } from "../../shared/protocol";

type Row = Pick<TranscriptItem, "id"> & { batonMark?: { kind: string; phase?: string } | undefined };

/** Ids of the rows strictly between a wrap-up's start mark and its end mark (or the list's end,
    while it runs). The marks themselves stay: they are the cards. */
export function wrapupRowIds(items: readonly Row[]): Set<string> {
  const ids = new Set<string>();
  let inside = false;
  for (const it of items) {
    const m = it.batonMark;
    if (m?.kind === "wrapup") {
      inside = m.phase === "start";
      continue;
    }
    if (inside) ids.add(it.id);
  }
  return ids;
}
