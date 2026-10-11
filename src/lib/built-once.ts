// A collapsed list's rows are built the first time it is open and kept after it closes, so a list never
// opened costs its head alone (§app.session-list/content-rules, open/closed state).
import { createMemo } from "solid-js";

/** True from the first time `open()` reads true, for good. Call inside a reactive owner (a component). */
export function builtOnceOpen(open: () => boolean): () => boolean {
  let built = false;
  return createMemo(() => built || (built = open()));
}
