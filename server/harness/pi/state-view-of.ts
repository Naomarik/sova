// The view over raw pi entries (§app.harness/state): the D4 thin-wrapper form, `(entries: readonly unknown[])`,
// that Sova's fold helpers keep while their callers still hold pi's entries. Pi-free at load (no pi import, no
// registry import), so a fold helper that the registry itself imports (session-loadout) can use it without a
// cycle through the writer or pi's runtime. `stateViewOf` is re-exported by ./state.ts.
import type { HEntry, StateView } from "../../../shared/harness";
import { stateView } from "../state-view";

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object";

/** A raw pi entry's state entry (as the reader's `toHEntry` makes one), an HEntry as is, else null. */
function stateEntryOf(e: unknown): HEntry | null {
  if (!isObj(e)) return null;
  if ("kind" in e) return e.kind === "state" ? (e as HEntry) : null;
  if (e.type !== "custom") return null;
  const h: Record<string, any> = { id: typeof e.id === "string" ? e.id : null, parentId: typeof e.parentId === "string" ? e.parentId : null };
  if (e.timestamp !== undefined) h.at = e.timestamp;
  h.kind = "state";
  h.key = e.customType;
  h.data = e.data;
  return h as HEntry;
}

/** A view over raw pi entries (a branch or a file as pi or `parseLines` gives them), HEntries, or a mix: the
    form today's fold helpers take (`(entries: readonly unknown[])`), so each folds through the view. */
export function stateViewOf(entries: readonly unknown[]): StateView {
  const out: HEntry[] = [];
  for (const e of entries) {
    const h = stateEntryOf(e);
    if (h) out.push(h);
  }
  return stateView(out);
}
