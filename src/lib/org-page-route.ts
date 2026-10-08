// The org page's `start` and `tab` (§app.organizations/org-page), as memos the page owns. The
// route arrives through App's non-keyed `<Match>` accessor, which throws "Stale read" once the
// route has moved elsewhere. A ternary in a JSX prop compiles to a getter that creates a fresh
// memo on every read, and a read from an event handler (the start form's Cancel) creates one
// with no owner: nothing disposes it, so when the next session link clears the org route it
// re-runs, reads the stale accessor, and the throw aborts that whole route change. Memos made
// here are made once, under the page, and go with it.
import { createMemo, untrack, type Accessor } from "solid-js";
import { filtersKey, type HistoryFilters, type HistoryView } from "./org-history-route";
import type { OrgTab, OrgsRoute } from "./orgs-route";

export function orgPageRoute(route: Accessor<OrgsRoute>): { start: Accessor<string | undefined>; tab: Accessor<OrgTab | undefined>; history: Accessor<HistoryView | undefined> } {
  const start = createMemo(() => {
    const r = route();
    return r.kind === "org" ? r.start : undefined;
  });
  const tab = createMemo(() => {
    const r = route();
    return r.kind === "org" ? r.tab : undefined;
  });
  /** The History tab's view: a new object per address; the tab gates on its scalar keys itself. */
  const history = createMemo(() => {
    const r = route();
    return r.kind === "org" ? r.history : undefined;
  });
  return { start, tab, history };
}

/** The History tab's view as scalars behind equality-gated memos (a background re-read keeps
    the selection, the filters, open disclosures and focus). The route hands a new view
    object per hash change, and `on(() => view().event)` would re-fire on every one of them (CLAUDE.md,
    Method); these change only when the value does. `filters` stays the same object until the filter
    key changes. */
export function historyViewMemos(view: Accessor<HistoryView>): {
  filtersKey: Accessor<string>;
  filters: Accessor<HistoryFilters>;
  selected: Accessor<string | undefined>;
  chain: Accessor<boolean>;
} {
  const key = createMemo(() => filtersKey(view().filters));
  const filters = createMemo((): HistoryFilters => {
    key();
    return untrack(() => view().filters);
  });
  const selected = createMemo(() => view().event);
  const chain = createMemo(() => !!view().chain);
  return { filtersKey: key, filters, selected, chain };
}
