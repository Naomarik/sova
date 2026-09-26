// The org page's `start` and `tab` (§app.organizations/org-page), as memos the page owns. The
// route arrives through App's non-keyed `<Match>` accessor, which throws "Stale read" once the
// route has moved elsewhere. A ternary in a JSX prop compiles to a getter that creates a fresh
// memo on every read, and a read from an event handler (the start form's Cancel) creates one
// with no owner: nothing disposes it, so when the next session link clears the org route it
// re-runs, reads the stale accessor, and the throw aborts that whole route change. Memos made
// here are made once, under the page, and go with it.
import { createMemo, type Accessor } from "solid-js";
import type { OrgTab, OrgsRoute } from "./orgs-route";

export function orgPageRoute(route: Accessor<OrgsRoute>): { start: Accessor<string | undefined>; tab: Accessor<OrgTab | undefined> } {
  const start = createMemo(() => {
    const r = route();
    return r.kind === "org" ? r.start : undefined;
  });
  const tab = createMemo(() => {
    const r = route();
    return r.kind === "org" ? r.tab : undefined;
  });
  return { start, tab };
}
