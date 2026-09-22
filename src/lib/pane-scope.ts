// Pane scope: what tells a session view whether it is THE view on the page or one pane of a
// workspace (spec/02-session-list.md §2 "Groups" → workspaces). Two things depend on it:
//
//   - DOM ids. `transcript`, `composer-input`, `model-listbox` and friends are singletons in the
//     single-session view and must stay exactly that (the skip link, aria-controls and every
//     `getElementById` in the app point at the bare id). Inside a workspace the same markup is on
//     screen N times, so each pane suffixes its ids with the pane's own id.
//   - Announcements. One status region serves the whole page, so a sentence from a pane says
//     which pane it came from ("Sonnet · Reply finished."); the single view says it bare.
//
// The default scope is the single view: id null, no label, nothing changes.

import { createContext, useContext } from "solid-js";
import { announce } from "./ui-state";

export interface PaneScope {
  /** Suffix for this pane's DOM ids, or null in the single-session view (ids stay bare). */
  id: string | null;
  /**
   * What this pane is CALLED — the pane's accessible name, byte for byte ("control · opus-5"),
   * or null in the single-session view. The prefix has to be that exact string: what AT says when
   * a turn finishes must match what it says the pane is, and the model alone is not a name when
   * two panes run the same model.
   */
  label: () => string | null;
}

const SINGLE: PaneScope = { id: null, label: () => null };

const PaneScopeContext = createContext<PaneScope>(SINGLE);

export const PaneScopeProvider = PaneScopeContext.Provider;

/** The scope of the view this component renders in; the single view unless a pane provided one. */
export const usePaneScope = (): PaneScope => useContext(PaneScopeContext);

/** `transcript` in the single view, `transcript-p2` in a pane. */
export const paneScopedId = (scope: PaneScope, base: string): string => (scope.id ? `${base}-${scope.id}` : base);

/** The id-maker for the current scope, for components that scope several ids. */
export function usePaneId(): (base: string) => string {
  const scope = usePaneScope();
  return (base) => paneScopedId(scope, base);
}

/**
 * `announce`, prefixed with the pane's name inside a workspace. One polite region serves the whole
 * page, so three panes finishing in the same second must read as three facts: "control · opus-5 —
 * Reply finished." The dash is the separator because the name itself contains " · ".
 */
export function usePaneAnnounce(): (text: string) => void {
  const scope = usePaneScope();
  return (text) => {
    const name = scope.label();
    announce(name ? `${name} — ${text}` : text);
  };
}
